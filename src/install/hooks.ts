// Lifecycle-hook installation for targets that support it (Claude Code,
// Devin). Entries are identified by the "remme-hook" literal in the command,
// merged into the client's existing hooks config, and removed on uninstall.
// Foreign hook entries and unparseable files are always preserved/reported.
import { hookPath, manual, ok, read, write } from "./shared.ts";
import type { Result } from "./shared.ts";

const MARK = "remme-hook";
const TIMEOUT_SEC = 10;

type Platform = "claude" | "devin";
interface Spec { event: string; matcher?: string; platform: Platform; arg: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function command(spec: Spec): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)} ${MARK} ${spec.arg} ${spec.platform}`;
}

function specs(platform: Platform): Spec[] {
  if (platform === "claude") {
    return [
      { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", platform, arg: "pretool" },
      { event: "UserPromptSubmit", platform, arg: "prompt" },
      { event: "PostToolUseFailure", platform, arg: "posttool" },
    ];
  }
  return [
    { event: "PreToolUse", matcher: "^(edit|write|apply_patch|notebook_edit|exec)$", platform, arg: "pretool" },
    { event: "UserPromptSubmit", platform, arg: "prompt" },
    // Devin has no PostToolUseFailure event; PostToolUse fires for every tool
    // and the hook itself ignores successes.
    { event: "PostToolUse", matcher: "^(exec|edit|write|apply_patch|notebook_edit|mcp__.*)$", platform, arg: "posttool" },
  ];
}

const OURS = (entry: unknown): boolean =>
  isObj(entry) && Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => isObj(h) && typeof h.command === "string" && h.command.includes(MARK));

/** Merge our hook entries into `file`. `wrapped` = hooks live under a "hooks"
 *  key (settings.json / config.json); false = the file IS the hooks object
 *  (.devin/hooks.v1.json). */
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
  const hooksObj = (wrapped ? data.hooks : data) as Record<string, unknown>;
  let changed = 0;
  for (const spec of specs(platform)) {
    const arr = hooksObj[spec.event];
    if (arr !== undefined && !Array.isArray(arr)) return manual(`${file}: "hooks.${spec.event}" is not an array — hooks left untouched`);
    const list = ((arr ?? []) as unknown[]).filter((entry) => !OURS(entry));
    const entry: Record<string, unknown> = { hooks: [{ type: "command", command: command(spec), timeout: TIMEOUT_SEC }] };
    if (spec.matcher !== undefined) entry.matcher = spec.matcher;
    // Exactly one remme entry per event: duplicates collapse, stale paths heal.
    if (arr !== undefined && JSON.stringify(list.concat(entry)) === JSON.stringify(arr)) continue;
    list.push(entry);
    hooksObj[spec.event] = list;
    changed++;
  }
  if (!changed) return ok(`${file}: remme hooks already configured (idempotent)`);
  return ok(`${file}: ${write(file, JSON.stringify(data, null, 2) + "\n", dryRun)}`);
}

/** Remove every hook entry whose command carries the remme marker. */
export function uninstallHooks(file: string, wrapped: boolean, dryRun: boolean): Result {
  const raw = read(file);
  if (raw === null) return ok(`${file}: not present`);
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; } catch { return manual(`${file} is not valid JSON — hooks left untouched`); }
  if (!isObj(data)) return ok(`${file}: no remme hooks`);
  const hooksObj = (wrapped ? data.hooks : data) as Record<string, unknown> | undefined;
  if (!isObj(hooksObj)) return ok(`${file}: no remme hooks`);
  let removed = 0;
  for (const event of ["PreToolUse", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]) {
    const arr = hooksObj[event];
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
