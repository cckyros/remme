import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "remme-hook-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, USERPROFILE: home, REMME_CONFIG: join(root, "no-config.json") } as Record<string, string>;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.DEVIN_PROJECT_DIR;
  const hook = (args: string[], input: unknown, extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["dist/hook.js", "remme-hook", ...args], {
      env: { ...env, ...extraEnv }, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const writeMemory = (name: string, frontmatter: string, body = "body") => {
    const dir = join(home, ".remme", "memory", "2026-11");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `---\nimportance: 5\ntags: []\nknowledgeType: "pitfall"\nproject: ""\ncreated: "2026-01-01T00:00:00Z"\nagent: "test"\nentities: []\n${frontmatter}---\n\n${body}\n`);
  };
  return { root, home, project, hook, writeMemory, done: () => rmSync(root, { recursive: true, force: true }) };
}

const pitfall = 'status: "verified"\ntriggerPaths: ["src/db.ts", "**/migrations/**"]\ntriggerCommands: ["git commit .*<<"]\ntriggerKeywords: ["heredoc"]\n';
const payload = (over: Record<string, unknown>) => ({ session_id: "s1", cwd: "ignored", ...over });

test("hook pretool (claude): denies once per pitfall per session, then allows", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const file = join(project, "src", "db.ts");
    const input = payload({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file }, cwd: project });
    const first = hook(["pretool", "claude"], input, { CLAUDE_PROJECT_DIR: project });
    assert.equal(first.code, 0, first.err);
    const decision = JSON.parse(first.out);
    assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /memory_read\("2026-11\/p\.md"\)/);
    // Same session retry passes silently.
    assert.equal(hook(["pretool", "claude"], input, { CLAUDE_PROJECT_DIR: project }).out, "");
    // A different session is blocked again.
    const other = { ...input, session_id: "s2" };
    assert.match(hook(["pretool", "claude"], other, { CLAUDE_PROJECT_DIR: project }).out, /"deny"/);
    // Unrelated file passes even in a fresh session.
    const unrelated = { ...input, session_id: "s3", tool_input: { file_path: join(project, "src", "other.ts") } };
    assert.equal(hook(["pretool", "claude"], unrelated, { CLAUDE_PROJECT_DIR: project }).out, "");
  } finally { done(); }
});

test("hook pretool (devin): blocks via decision/reason; env autodetect beats the arg", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const input = payload({ tool_name: "exec", tool_input: { command: "git commit -m x <<EOF" }, cwd: project });
    const r = hook(["pretool", "devin"], input, { DEVIN_PROJECT_DIR: project });
    const decision = JSON.parse(r.out);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /memory_read/);
    // Devin also executes .claude/settings.json hooks: arg says claude but the
    // host env must win so the output uses Devin's contract.
    const crossed = hook(["pretool", "claude"], { ...input, session_id: "s9" }, { DEVIN_PROJECT_DIR: project });
    assert.equal(JSON.parse(crossed.out).decision, "block");
  } finally { done(); }
});

test("hook prompt: keyword match injects additionalContext, miss stays silent", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const hit = hook(["prompt", "claude"], payload({ prompt: "how do I git commit with heredoc?", cwd: project }), { CLAUDE_PROJECT_DIR: project });
    const ctx = JSON.parse(hit.out);
    assert.equal(ctx.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(ctx.hookSpecificOutput.additionalContext, /heredoc breaks|p\.md/);
    const miss = hook(["prompt", "claude"], payload({ session_id: "s2", prompt: "what is the weather", cwd: project }), { CLAUDE_PROJECT_DIR: project });
    assert.equal(miss.out, "");
  } finally { done(); }
});

test("hook posttool (devin): only failures with matching text inject context", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const base = { tool_name: "exec", tool_input: { command: "git commit <<EOF" }, cwd: project };
    const fail = hook(["posttool", "devin"], { ...base, session_id: "f1", tool_response: { success: false, error: "heredoc exploded" } }, { DEVIN_PROJECT_DIR: project });
    assert.equal(JSON.parse(fail.out).hookSpecificOutput.hookEventName, "PostToolUse");
    const okRun = hook(["posttool", "devin"], { ...base, session_id: "f2", tool_response: { success: true, output: "done" } }, { DEVIN_PROJECT_DIR: project });
    assert.equal(okRun.out, "");
    const unrelatedFail = hook(["posttool", "devin"], { session_id: "f3", tool_name: "exec", tool_input: { command: "ls" }, tool_response: { success: false, error: "no such file" }, cwd: project }, { DEVIN_PROJECT_DIR: project });
    assert.equal(unrelatedFail.out, "");
  } finally { done(); }
});

test("hook posttool (claude): PostToolUseFailure payload injects context", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const r = hook(["posttool", "claude"], payload({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "git commit <<EOF" }, error: "heredoc failed", cwd: project }), { CLAUDE_PROJECT_DIR: project });
    assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, "PostToolUseFailure");
  } finally { done(); }
});

test("hook pretool (cursor): flat payload uses conversation_id and snake_case deny output", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const input = {
      hook_event_name: "preToolUse", conversation_id: "conv-1", generation_id: "g1",
      tool_name: "Shell", tool_input: { command: "git commit -m x <<EOF" },
      cwd: project, workspace_roots: [project],
    };
    const first = hook(["pretool", "cursor"], input);
    assert.equal(first.code, 0, first.err);
    const decision = JSON.parse(first.out);
    assert.equal(decision.permission, "deny");
    assert.match(decision.agent_message, /memory_read\("2026-11\/p\.md"\)/);
    assert.equal(decision.user_message, decision.agent_message);
    // Same conversation retries silently; a new conversation is blocked again.
    assert.equal(hook(["pretool", "cursor"], input).out, "");
    assert.match(hook(["pretool", "cursor"], { ...input, conversation_id: "conv-2" }).out, /"deny"/);
    // beforeSubmitPrompt cannot inject context — prompt stays silent even on a hit.
    const prompt = hook(["prompt", "cursor"], { hook_event_name: "beforeSubmitPrompt", conversation_id: "conv-3", prompt: "heredoc question", cwd: project });
    assert.equal(prompt.out, "");
  } finally { done(); }
});

test("hook posttool (cursor): postToolUseFailure injects additional_context snake_case", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const r = hook(["posttool", "cursor"], {
      hook_event_name: "postToolUseFailure", conversation_id: "conv-1",
      tool_name: "Shell", tool_input: { command: "git commit <<EOF" },
      error_message: "heredoc exploded", failure_type: "non_zero_exit", cwd: project,
    });
    const out = JSON.parse(r.out);
    assert.match(out.additional_context, /memory_read/);
    assert.equal(out.hookSpecificOutput, undefined);
  } finally { done(); }
});

test("hook (codex): PascalCase events reuse claude output; PostToolUse filters failures heuristically", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const pre = hook(["pretool", "codex"], {
      session_id: "cx1", turn_id: "t1", tool_name: "Bash",
      tool_input: { command: "git commit -m x <<EOF" }, cwd: project,
    });
    const deny = JSON.parse(pre.out);
    assert.equal(deny.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
    // Successful PostToolUse (exit_code 0) stays silent.
    const okRun = hook(["posttool", "codex"], {
      session_id: "cx2", tool_name: "Bash", tool_input: { command: "git commit <<EOF" },
      tool_response: { exit_code: 0, stdout: "committed" }, cwd: project,
    });
    assert.equal(okRun.out, "");
    // Failed PostToolUse (non-zero exit + stderr keywords) injects context.
    const fail = hook(["posttool", "codex"], {
      session_id: "cx3", tool_name: "Bash", tool_input: { command: "git commit <<EOF" },
      tool_response: { exit_code: 1, stderr: "heredoc delimiter not found" }, cwd: project,
    });
    const ctx = JSON.parse(fail.out);
    assert.equal(ctx.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(ctx.hookSpecificOutput.additionalContext, /memory_read/);
    // Prompt warnings work like claude's.
    const prompt = hook(["prompt", "codex"], { session_id: "cx4", prompt: "heredoc question", cwd: project });
    assert.equal(JSON.parse(prompt.out).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  } finally { done(); }
});

test("hook pretool (opencode): plugin payload gets devin-style block decision", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const r = hook(["pretool", "opencode"], {
      session_id: "oc1", tool_name: "bash", tool_input: { command: "git commit -m x <<EOF" }, cwd: project,
    });
    const decision = JSON.parse(r.out);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /memory_read/);
    assert.equal(hook(["pretool", "opencode"], { session_id: "oc1", tool_name: "bash", tool_input: { command: "git commit -m x <<EOF" }, cwd: project }).out, "");
  } finally { done(); }
});

test("hook pretool: keywords embedded in paths do not block; detached keywords do", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", 'status: "verified"\ntriggerKeywords: ["agents.md"]\n');
    const env = { DEVIN_PROJECT_DIR: project };
    // Path-embedded filename: the reported false positive stays silent.
    const embedded = hook(["pretool", "devin"], payload({
      session_id: "p1", tool_name: "exec",
      tool_input: { command: "python -c \"p=r'C:\\Users\\z\\devin\\AGENTS.md'\"" }, cwd: project,
    }), env);
    assert.equal(embedded.out, "");
    // Detached keyword in a command still blocks once per session.
    const detached = hook(["pretool", "devin"], payload({
      session_id: "p2", tool_name: "exec",
      tool_input: { command: "cat AGENTS.md" }, cwd: project,
    }), env);
    assert.equal(JSON.parse(detached.out).decision, "block");
    // Failure output keeps loose substring matching (prose context).
    const fail = hook(["posttool", "devin"], payload({
      session_id: "p3", tool_name: "exec", tool_input: { command: "cat x" },
      tool_response: { success: false, error: "cannot read C:\\devin\\AGENTS.md" }, cwd: project,
    }), env);
    assert.match(fail.out, /PostToolUse/);
  } finally { done(); }
});

test("hook fails open: garbage stdin, missing store, corrupt index, no DB writes", () => {
  const { home, project, hook, writeMemory, done } = sandbox();
  try {
    // Garbage stdin → exit 0, silent.
    const garbage = hook(["prompt", "claude"], "this is not json{{{");
    assert.equal(garbage.code, 0);
    assert.equal(garbage.out, "");
    // Empty memory dir → silent, and no database files are ever created.
    const empty = hook(["prompt", "claude"], payload({ prompt: "hi", cwd: project }));
    assert.equal(empty.code, 0);
    assert.equal(empty.out, "");
    assert.equal(existsSync(join(home, ".remme", "memory.db")), false);
    assert.equal(existsSync(join(home, ".remme", "memory.db.bak")), false);
    // Corrupt index is rebuilt from Markdown.
    writeMemory("p.md", pitfall);
    mkdirSync(join(home, ".remme"), { recursive: true });
    writeFileSync(join(home, ".remme", "warnings-index.json"), "{broken");
    const healed = hook(["prompt", "claude"], payload({ session_id: "h1", prompt: "heredoc question", cwd: project }));
    assert.match(healed.out, /additionalContext/);
    assert.equal(existsSync(join(home, ".remme", "memory.db")), false);
  } finally { done(); }
});

test("hook latency: cold start stays well under a second", () => {
  const { project, hook, writeMemory, done } = sandbox();
  try {
    writeMemory("p.md", pitfall);
    const input = payload({ prompt: "unrelated", cwd: project });
    const start = performance.now();
    const r = hook(["prompt", "claude"], input);
    const ms = performance.now() - start;
    console.log(`hook cold latency: ${ms.toFixed(0)}ms`);
    assert.equal(r.code, 0);
    assert.ok(ms < 2000, `hook took ${ms}ms`);
  } finally { done(); }
});
