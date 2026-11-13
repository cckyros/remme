// remme-hook: lifecycle-hook entry point (dist/hook.js). Reads one hook payload
// on stdin, matches it against the warnings index and prints the platform's
// JSON response on stdout. Always exits 0 and stays silent on any problem —
// a hook must never block the agent.
//
// Usage: node dist/hook.js remme-hook <prompt|pretool|posttool> [claude|devin|cursor|codex|opencode]
// The "remme-hook" literal is the installer's ownership marker.
import { loadConfig } from "./config.ts";
import {
  formatBlockReason, formatWarnings, loadHookState, matchWarnings, saveHookState,
  sessionOf, warningsForHook, type WarningEntry,
} from "./triggers.ts";

const MAX_INPUT = 64_000;
const SELF_TIMEOUT_MS = 8_000;

type Platform = "claude" | "devin" | "cursor" | "codex" | "opencode";
type Event = "prompt" | "pretool" | "posttool";
const PLATFORMS: readonly string[] = ["claude", "devin", "cursor", "codex", "opencode"];

function detectPlatform(arg: string | undefined): Platform {
  // The host environment wins over the installed arg: Devin also executes
  // .claude/settings.json hooks, and DEVIN_PROJECT_DIR is set for hook commands.
  if (process.env.DEVIN_PROJECT_DIR) return "devin";
  if (process.env.CLAUDE_PROJECT_DIR) return "claude";
  return PLATFORMS.includes(arg ?? "") ? (arg as Platform) : "claude";
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
  if (event === "posttool") return platform === "claude" ? "PostToolUseFailure" : "PostToolUse";
  return "PreToolUse";
}

function additionalContext(platform: Platform, name: string, context: string): void {
  // Cursor output fields are snake_case and top-level; there is no event name.
  if (platform === "cursor") {
    process.stdout.write(JSON.stringify({ additional_context: context }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: name, additionalContext: context },
  }) + "\n");
}

function preToolDecision(platform: Platform, reason: string): void {
  if (platform === "cursor") {
    process.stdout.write(JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }) + "\n");
  } else if (platform === "devin" || platform === "opencode") {
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
  // Cursor sends conversation_id; the rest send session_id.
  const sessionId = str(input.session_id) ?? str(input.conversation_id) ?? "unknown";
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const cwd = str(input.cwd) ?? str(roots[0])
    ?? process.env.DEVIN_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
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
    // Cursor's beforeSubmitPrompt can only continue/block — it cannot inject
    // context, so prompt warnings are not wired for it.
    if (platform === "cursor") return;
    const text = str(input.prompt) ?? "";
    const hits = fresh(matchWarnings(entries, { text, cwd }), ctxSeen);
    if (!hits.length) return;
    for (const h of hits) { session.ctx.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    additionalContext(platform, eventName(platform, event), formatWarnings(hits));
  } else if (event === "pretool") {
    const hits = fresh(matchWarnings(entries, { paths, commands, text: toolText, cwd }), blkSeen);
    if (!hits.length) return;
    for (const h of hits) { session.blk.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    preToolDecision(platform, formatBlockReason(hits));
  } else {
    // posttool: Devin and Codex fire PostToolUse for every tool — only failures
    // matter. Claude Code and Cursor have dedicated failure-only events.
    if (!toolFailed(platform, input)) return;
    const response = isObj(input.tool_response) ? input.tool_response : {};
    const respText = typeof input.tool_response === "string" ? input.tool_response.slice(0, 2000) : "";
    // Codex's tool_response shape varies by tool — a truncated JSON dump keeps
    // error keywords (stderr/message/...) matchable regardless of field names.
    const respJson = isObj(input.tool_response) ? JSON.stringify(input.tool_response).slice(0, 1500) : "";
    const errorText = [str(input.error), str(input.error_message), str(response.error), str(response.output), respText, respJson]
      .filter(Boolean).join("\n").slice(0, 4000);
    const blob = `${str(input.tool_name) ?? ""}\n${JSON.stringify(input.tool_input ?? {}).slice(0, 2000)}\n${errorText}`;
    const hits = fresh(matchWarnings(entries, { paths, commands, text: blob, cwd }), ctxSeen);
    if (!hits.length) return;
    for (const h of hits) { session.ctx.push(h.path); dirty = true; }
    session.updatedAt = new Date().toISOString();
    additionalContext(platform, eventName(platform, event), formatWarnings(hits));
  }

  if (dirty) saveHookState(config, state);
}

/** Whether a posttool payload represents a failed tool call. Codex's
 *  tool_response shape is tool-specific, so only explicit failure markers
 *  count; anything ambiguous stays silent (fail-open). */
function toolFailed(platform: Platform, input: Record<string, unknown>): boolean {
  const response = input.tool_response;
  if (platform === "devin") return isObj(response) && response.success === false;
  if (platform !== "codex") return true; // claude PostToolUseFailure / cursor postToolUseFailure
  if (isObj(response)) {
    if (response.success === false || response.isError === true || response.is_error === true) return true;
    const code = response.exitCode ?? response.exit_code ?? response.exitStatus ?? response.statusCode;
    if (typeof code === "number" && code !== 0) return true;
    return typeof response.error === "string" && response.error.trim().length > 0;
  }
  if (typeof response === "string") {
    return /\b(exit(ed)? (with )?(code|status)\s*[1-9]\d*|command failed|failed with exit|error:|exception|traceback)\b/i.test(response);
  }
  return false;
}

// Fail-open: any unexpected error exits silently with status 0.
const guard = setTimeout(() => process.exit(0), SELF_TIMEOUT_MS);
guard.unref();
main().catch(() => {}).finally(() => process.exit(0));
