// Lifecycle-hook installation for targets that support it (Claude Code,
// Devin, Cursor, Codex, OpenCode). JSON-hook entries are identified by the
// "remme-hook" literal in the command, merged into the client's existing
// hooks config, and removed on uninstall. OpenCode has no JSON hook file —
// it gets a generated plugin under <config>/plugins/ instead. Foreign hook
// entries and unparseable files are always preserved/reported.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { hookPath, manual, ok, read, skipped, write } from "./shared.ts";
import type { Result } from "./shared.ts";

const MARK = "remme-hook";
const TIMEOUT_SEC = 10;

type Platform = "claude" | "devin" | "cursor" | "codex" | "opencode";
interface Spec { event: string; matcher?: string; platform: Platform; arg: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function command(spec: Spec): string {
  const tail = `${MARK} ${spec.arg} ${spec.platform}`;
  // Codex on Windows feeds hook commands through PowerShell, where a leading
  // quoted string parses as a literal expression instead of a command — the
  // hook then fails to spawn. cmd /c ""exe" "script" args" is the form that
  // survives that runner (verified against codex-cli 0.169.0).
  if (spec.platform === "codex" && process.platform === "win32") {
    return `cmd /c ""${process.execPath}" "${hookPath}" ${tail}"`;
  }
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)} ${tail}`;
}

function specs(platform: Platform): Spec[] {
  switch (platform) {
    case "claude":
      return [
        { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", platform, arg: "pretool" },
        { event: "UserPromptSubmit", platform, arg: "prompt" },
        { event: "PostToolUseFailure", platform, arg: "posttool" },
      ];
    case "devin":
      return [
        { event: "PreToolUse", matcher: "^(edit|write|apply_patch|notebook_edit|exec)$", platform, arg: "pretool" },
        { event: "UserPromptSubmit", platform, arg: "prompt" },
        // Devin has no PostToolUseFailure event; PostToolUse fires for every tool
        // and the hook itself ignores successes.
        { event: "PostToolUse", matcher: "^(exec|edit|write|apply_patch|notebook_edit|mcp__.*)$", platform, arg: "posttool" },
      ];
    case "codex":
      // Codex uses the same nested entry shape as Claude Code. PostToolUse
      // fires for successes too — the hook filters via tool_response.
      return [
        { event: "PreToolUse", matcher: "Bash|apply_patch|Edit|Write|mcp__", platform, arg: "pretool" },
        { event: "UserPromptSubmit", platform, arg: "prompt" },
        { event: "PostToolUse", matcher: "Bash|apply_patch|Edit|Write|mcp__", platform, arg: "posttool" },
      ];
    case "cursor":
      // Cursor hooks.json uses flat entries and camelCase events. There is no
      // prompt-context event worth wiring (beforeSubmitPrompt cannot inject).
      return [
        { event: "preToolUse", matcher: "^(Shell|Read|Write|Delete|Task|MCP:.*)$", platform, arg: "pretool" },
        { event: "postToolUseFailure", matcher: "^(Shell|Read|Write|Delete|Task|MCP:.*)$", platform, arg: "posttool" },
      ];
    default:
      return []; // opencode: plugin file, not JSON hooks
  }
}

/** Claude/Devin/Codex nest handlers under entry.hooks[]; Cursor entries are flat. */
const OURS = (entry: unknown): boolean => {
  if (!isObj(entry)) return false;
  if (typeof entry.command === "string" && entry.command.includes(MARK)) return true;
  return Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isObj(h) && typeof h.command === "string" && h.command.includes(MARK));
};

function entryFor(spec: Spec): Record<string, unknown> {
  const cmd = command(spec);
  if (spec.platform === "cursor") {
    const entry: Record<string, unknown> = { command: cmd, timeout: TIMEOUT_SEC };
    if (spec.matcher !== undefined) entry.matcher = spec.matcher;
    return entry;
  }
  const entry: Record<string, unknown> = { hooks: [{ type: "command", command: cmd, timeout: TIMEOUT_SEC }] };
  if (spec.matcher !== undefined) entry.matcher = spec.matcher;
  return entry;
}

/** Merge our hook entries into `file`. `wrapped` = hooks live under a "hooks"
 *  key (settings.json / config.json / hooks.json); false = the file IS the
 *  hooks object (.devin/hooks.v1.json). Cursor files also need version: 1. */
export function installHooks(file: string, platform: Platform, wrapped: boolean, dryRun: boolean): Result {
  const raw = read(file);
  let data: Record<string, unknown> = {};
  if (raw !== null) {
    try { data = JSON.parse(raw) as Record<string, unknown>; } catch { return manual(`${file} is not valid JSON — hooks left untouched`); }
    if (!isObj(data)) return manual(`${file} is not a JSON object — hooks left untouched`);
  }
  if (wrapped) {
    if (data.hooks !== undefined && !isObj(data.hooks)) return manual(`${file}: "hooks" is not an object — hooks left untouched`);
    data.hooks ??= {};
  }
  if (platform === "cursor") data.version ??= 1;
  const hooksObj = (wrapped ? data.hooks : data) as Record<string, unknown>;
  let changed = 0;
  for (const spec of specs(platform)) {
    const arr = hooksObj[spec.event];
    if (arr !== undefined && !Array.isArray(arr)) return manual(`${file}: "hooks.${spec.event}" is not an array — hooks left untouched`);
    const list = ((arr ?? []) as unknown[]).filter((entry) => !OURS(entry));
    const entry = entryFor(spec);
    // Exactly one remme entry per event: duplicates collapse, stale paths heal.
    if (arr !== undefined && JSON.stringify(list.concat(entry)) === JSON.stringify(arr)) continue;
    list.push(entry);
    hooksObj[spec.event] = list;
    changed++;
  }
  if (!changed) return ok(`${file}: remme hooks already configured (idempotent)`);
  return ok(`${file}: ${write(file, JSON.stringify(data, null, 2) + "\n", dryRun)}`);
}

/** Remove every hook entry whose command carries the remme marker. Event names
 *  differ per platform, so every array under "hooks" is scanned. */
export function uninstallHooks(file: string, wrapped: boolean, dryRun: boolean): Result {
  const raw = read(file);
  if (raw === null) return ok(`${file}: not present`);
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; } catch { return manual(`${file} is not valid JSON — hooks left untouched`); }
  if (!isObj(data)) return ok(`${file}: no remme hooks`);
  const hooksObj = (wrapped ? data.hooks : data) as Record<string, unknown> | undefined;
  if (!isObj(hooksObj)) return ok(`${file}: no remme hooks`);
  let removed = 0;
  for (const [event, arr] of Object.entries(hooksObj)) {
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((entry) => { if (OURS(entry)) removed++; return !OURS(entry); });
    if (kept.length !== arr.length) hooksObj[event] = kept;
  }
  if (!removed) return ok(`${file}: no remme hooks`);
  if (wrapped && isObj(hooksObj) && Object.keys(hooksObj).length === 0) delete data.hooks;
  return ok(`${file}: removed ${removed} remme hook entr${removed === 1 ? "y" : "ies"} ${write(file, JSON.stringify(data, null, 2) + "\n", dryRun)}`);
}

// ---------------------------------------------------------------- per-target

export function installClaudeHooks(file: string, dryRun: boolean): Result {
  return installHooks(file, "claude", true, dryRun);
}
export function uninstallClaudeHooks(file: string, dryRun: boolean): Result {
  return uninstallHooks(file, true, dryRun);
}

/** Devin project scope uses .devin/hooks.v1.json (bare object); global scope
 *  uses the "hooks" key of the user config.json. */
export function installDevinHooks(file: string, wrapped: boolean, dryRun: boolean): Result {
  return installHooks(file, "devin", wrapped, dryRun);
}
export function uninstallDevinHooks(file: string, wrapped: boolean, dryRun: boolean): Result {
  return uninstallHooks(file, wrapped, dryRun);
}

/** Cursor: <project>/.cursor/hooks.json or ~/.cursor/hooks.json — flat entries
 *  under "hooks" plus a top-level "version": 1. */
export function installCursorHooks(file: string, dryRun: boolean): Result {
  return installHooks(file, "cursor", true, dryRun);
}
export function uninstallCursorHooks(file: string, dryRun: boolean): Result {
  return uninstallHooks(file, true, dryRun);
}

/** Codex: <repo>/.codex/hooks.json or ~/.codex/hooks.json — Claude-style nested
 *  entries. Non-managed hooks stay inactive until trusted via /hooks. */
export function installCodexHooks(file: string, dryRun: boolean): Result {
  return installHooks(file, "codex", true, dryRun);
}
export function uninstallCodexHooks(file: string, dryRun: boolean): Result {
  return uninstallHooks(file, true, dryRun);
}

// ---------------------------------------------------------------- OpenCode

const OPENCODE_PLUGIN = "remme.js";

/** OpenCode has no JSON hook config: warnings come from a V2 plugin that
 *  forwards tool.execute.before events to `hook.js` and throws on a block.
 *  Plain default export — no @opencode/plugin import, which local plugins
 *  cannot resolve (opencode#50434). Only node: builtins are used. */
function opencodePluginSource(): string {
  return `// ${MARK}: pitfall-warning plugin for OpenCode (managed by \`remme install --hooks\`).
// Blocks a tool call once per session when it matches a recorded remme pitfall.
import { spawnSync } from "node:child_process";

const NODE = ${JSON.stringify(process.execPath)};
const HOOK = ${JSON.stringify(hookPath)};

export default {
  id: "remme",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const input = event.input && typeof event.input === "object" ? event.input : {};
      const payload = JSON.stringify({
        session_id: event.sessionID || event.session_id || "pid-" + process.pid,
        tool_name: event.tool,
        tool_input: input,
        cwd: process.cwd(),
      });
      let res;
      try {
        res = spawnSync(NODE, [HOOK, "${MARK}", "pretool", "opencode"], {
          input: payload, encoding: "utf8", timeout: 10000, windowsHide: true,
        });
      } catch { return; }
      const lines = String(res.stdout || "").trim().split("\\n").filter(Boolean);
      if (!lines.length) return;
      let parsed;
      try { parsed = JSON.parse(lines[lines.length - 1]); } catch { return; }
      if (parsed && parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason) {
        throw new Error(parsed.reason);
      }
    });
  },
};
`;
}

/** `dir` is the OpenCode config root that contains plugins/ (.opencode for
 *  project scope, ~/.config/opencode for global). */
export function installOpenCodePlugin(dir: string, dryRun: boolean): Result {
  const file = join(dir, "plugins", OPENCODE_PLUGIN);
  const content = opencodePluginSource();
  const existing = read(file);
  if (existing !== null && !existing.includes(MARK)) {
    return manual(`${file} exists without the ${MARK} marker — left untouched; remove or rename it first`);
  }
  if (existing === content) return ok(`${file}: already installed (idempotent)`);
  return ok(`${file}: ${write(file, content, dryRun)}`);
}

export function uninstallOpenCodePlugin(dir: string, dryRun: boolean): Result {
  const file = join(dir, "plugins", OPENCODE_PLUGIN);
  const existing = read(file);
  if (existing === null) return ok(`${file}: not present`);
  if (!existing.includes(MARK)) return skipped(`${file} has no ${MARK} marker — user-authored, kept`);
  if (!dryRun) rmSync(file, { force: true });
  return ok(`${dryRun ? "would remove" : "removed"} ${file}`);
}
