// remme-hook: lifecycle-hook entry point (dist/hook.js). Reads one hook payload
// on stdin, matches it against the warnings index and prints the platform's
// JSON response on stdout. Always exits 0 and stays silent on any problem —
// a hook must never block the agent.
//
// Usage: node dist/hook.js remme-hook <prompt|pretool|posttool> [claude|devin]
// The "remme-hook" literal is the installer's ownership marker.
import { loadConfig } from "./config.ts";
import {
  formatBlockReason, formatWarnings, loadHookState, matchWarnings, saveHookState,
  sessionOf, warningsForHook, type WarningEntry,
} from "./triggers.ts";

const MAX_INPUT = 64_000;
const SELF_TIMEOUT_MS = 8_000;

type Platform = "claude" | "devin";
type Event = "prompt" | "pretool" | "posttool";

function detectPlatform(arg: string | undefined): Platform {
  // The host environment wins over the installed arg: Devin also executes
  // .claude/settings.json hooks, and DEVIN_PROJECT_DIR is set for hook commands.
  if (process.env.DEVIN_PROJECT_DIR) return "devin";
  if (process.env.CLAUDE_PROJECT_DIR) return "claude";
  return arg === "devin" ? "devin" : "claude";
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_INPUT) { process.stdin.destroy(); resolve(data.slice(0, MAX_INPUT)); }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Collect candidate file paths and command strings from a tool_input object. */
function toolIO(input: Record<string, unknown>): { paths: string[]; commands: string[] } {
  const toolInput = isObj(input.tool_input) ? input.tool_input : {};
  const paths: string[] = [];
  const commands: string[] = [];
  const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path", "filename", "target_file", "file"];
  const CMD_KEYS = ["command", "cmd", "shell_command", "script"];
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === "string") {
      if (PATH_KEYS.includes(key)) paths.push(value);
      if (CMD_KEYS.includes(key)) commands.push(value);
      // Nested shapes like {file: {path: ...}} are covered by the flat keys above;
      // arrays of paths (multi-file edits) are handled below.
      if ((key === "files" || key === "file_paths" || key === "paths") && Array.isArray(value)) {
        for (const item of value) if (typeof item === "string") paths.push(item);
      }
    }
  }
  return { paths, commands };
}

function eventName(platform: Platform, event: Event): string {
  if (event === "prompt") return "UserPromptSubmit";
  if (event === "posttool") return platform === "devin" ? "PostToolUse" : "PostToolUseFailure";
  return "PreToolUse";
}

function additionalContext(name: string, context: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: name, additionalContext: context },
  }) + "\n");
}

function preToolDecision(platform: Platform, reason: string): void {
  if (platform === "devin") {
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }) + "\n");
  }
}

/** Partition fresh matches from ones already surfaced to this session. */
function fresh(entries: WarningEntry[], seen: Set<string>): WarningEntry[] {
  return entries.filter((e) => !seen.has(e.path));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "remme-hook") argv.shift();
  const event = argv[0] as Event | undefined;
  if (event !== "prompt" && event !== "pretool" && event !== "posttool") return;
  const platform = detectPlatform(argv[1]);

  const raw = await readStdin();
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) return;
    input = parsed;
  } catch { return; }

  const config = loadConfig();
  const sessionId = str(input.session_id) ?? "unknown";
  const cwd = str(input.cwd) ?? process.env.DEVIN_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const entries = warningsForHook(config);
  if (!entries.length) return;

  const state = loadHookState(config);
  const session = sessionOf(state, sessionId);
  const ctxSeen = new Set(session.ctx);
  const blkSeen = new Set(session.blk);
  let dirty = false;

  const { paths, commands } = toolIO(input);
  const toolText = commands.join("\n");

  if (event === "prompt") {
    const text = str(input.prompt) ?? "";
    const hits = fresh(matchWarnings(entries, { text, cwd }), ctxSeen);
    if (!hits.length) return;
    for (const h of hits) { session.ctx.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    additionalContext(eventName(platform, event), formatWarnings(hits));
  } else if (event === "pretool") {
    const hits = fresh(matchWarnings(entries, { paths, commands, text: toolText, cwd }), blkSeen);
    if (!hits.length) return;
    for (const h of hits) { session.blk.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    preToolDecision(platform, formatBlockReason(hits));
  } else {
    // posttool: Devin fires PostToolUse for every tool — only failures matter.
    // Claude Code has a dedicated PostToolUseFailure event (always a failure).
    if (platform === "devin") {
      const response = isObj(input.tool_response) ? input.tool_response : {};
      if (response.success !== false) return;
    }
    const response = isObj(input.tool_response) ? input.tool_response : {};
    const errorText = [str(input.error), str(response.error), str(response.output)]
      .filter(Boolean).join("\n").slice(0, 4000);
    const blob = `${str(input.tool_name) ?? ""}\n${JSON.stringify(input.tool_input ?? {}).slice(0, 2000)}\n${errorText}`;
    const hits = fresh(matchWarnings(entries, { paths, commands, text: blob, cwd }), ctxSeen);
    if (!hits.length) return;
    for (const h of hits) { session.ctx.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    additionalContext(eventName(platform, event), formatWarnings(hits));
  }

  if (dirty) saveHookState(config, state);
}

// Fail-open: any unexpected error exits silently with status 0.
const guard = setTimeout(() => process.exit(0), SELF_TIMEOUT_MS);
guard.unref();
main().catch(() => {}).finally(() => process.exit(0));
