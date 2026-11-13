import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "remme-install-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, REMME_CONFIG: join(root, "config.json") };
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ["dist/cli.js", ...args, "--dir", project], { env, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { root, home, project, cli, done: () => rmSync(root, { recursive: true, force: true }) };
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("install targets: 22 targets in native, skill and plugin kinds", () => {
  const { cli, done } = sandbox();
  try {
    const lines = cli(["targets"]).out.trim().split("\n");
    assert.equal(lines.length, 22);
    const kinds = lines.map((line) => line.trim().split(/\s+/)[1]);
    assert.equal(kinds.filter((k) => k === "native").length, 8);
    assert.equal(kinds.filter((k) => k === "skill").length, 4);
    assert.equal(kinds.filter((k) => k === "plugin").length, 10);
  } finally { done(); }
});

test("install: dry-run writes nothing", () => {
  const { home, project, cli, done } = sandbox();
  try {
    const r = cli(["install", "--target", "claude,codex,cursor,vscode", "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readdirSync(project), []);
    assert.equal(existsSync(join(home, ".remme")), false);
  } finally { done(); }
});

test("install: claude keeps user keys, is idempotent, uninstall restores user keys", () => {
  const { project, cli, done } = sandbox();
  try {
    const settings = join(project, ".claude", "settings.json");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other-server" } } }));

    assert.equal(cli(["install", "--target", "claude"]).code, 0);
    const first = json(settings);
    assert.equal(first.theme, "dark");
    assert.deepEqual(first.mcpServers.other, { command: "other-server" });
    assert.equal(isAbsolute(first.mcpServers.remme.args[0]), true);
    assert.equal(first.mcpServers.remme.args[1], "mcp");

    const again = cli(["install", "--target", "claude"]);
    assert.match(again.out, /already configured \(idempotent\)/);

    assert.equal(cli(["uninstall", "--target", "claude"]).code, 0);
    const after = json(settings);
    assert.equal(after.theme, "dark");
    assert.deepEqual(after.mcpServers, { other: { command: "other-server" } });
    assert.equal(existsSync(join(project, ".claude", "skills", "remme", "SKILL.md")), false);
  } finally { done(); }
});

test("install: all targets run without errors and never use the unrelated npm name", () => {
  const { project, home, cli, done } = sandbox();
  try {
    const r = cli(["install", "--target", "all"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[manual\] GitHub Copilot/);
    assert.match(r.out, /\[ok\] Claude Code/);
    assert.doesNotMatch(r.out, /\[error\]/);
    const written = [project, join(home, ".remme")].flatMap((dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);
    assert.ok(written.length > 0);
    for (const rel of [join(".remme", "plugin", "mcp.json"), join(".remme", "plugin", ".mcp.json")]) {
      const file = join(home, rel);
      if (existsSync(file)) assert.doesNotMatch(readFileSync(file, "utf8"), /"npx"/);
    }
    assert.doesNotMatch(readFileSync(join(project, ".claude", "settings.json"), "utf8"), /"npx"/);
  } finally { done(); }
});

test("install: codex writes a managed TOML block and AGENTS.md block, both idempotent and removable", () => {
  const { project, cli, done } = sandbox();
  try {
    assert.equal(cli(["install", "--target", "codex"]).code, 0);
    assert.equal(cli(["install", "--target", "codex"]).code, 0);
    const toml = readFileSync(join(project, ".codex", "config.toml"), "utf8");
    assert.equal(toml.split("# remme:start").length - 1, 1);
    assert.match(toml, /\[mcp_servers\."remme"\]/);
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    assert.equal(agents.split("<!-- remme:start -->").length - 1, 1);
    assert.match(agents, /memory_search/);

    assert.equal(cli(["uninstall", "--target", "codex"]).code, 0);
    assert.doesNotMatch(readFileSync(join(project, ".codex", "config.toml"), "utf8"), /remme/);
    assert.doesNotMatch(readFileSync(join(project, "AGENTS.md"), "utf8"), /remme:start/);
  } finally { done(); }
});

test("install: user-authored SKILL.md without our marker is never overwritten", () => {
  const { project, cli, done } = sandbox();
  try {
    const skill = join(project, ".claude", "skills", "remme", "SKILL.md");
    mkdirSync(join(project, ".claude", "skills", "remme"), { recursive: true });
    writeFileSync(skill, "my own notes");
    const r = cli(["install", "--target", "claude"]);
    assert.match(r.out, /\[skipped\] Claude Code/);
    assert.equal(readFileSync(skill, "utf8"), "my own notes");
  } finally { done(); }
});

test("install: unparseable JSON is reported as manual and left untouched", () => {
  const { project, cli, done } = sandbox();
  try {
    const file = join(project, "opencode.json");
    writeFileSync(file, "{ // jsonc comments\n}");
    const r = cli(["install", "--target", "opencode"]);
    assert.match(r.out, /\[manual\] OpenCode/);
    assert.equal(readFileSync(file, "utf8"), "{ // jsonc comments\n}");
  } finally { done(); }
});

test("install: cursor copies the materialized plugin with an absolute MCP entry", () => {
  const { home, cli, done } = sandbox();
  try {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    assert.equal(cli(["install", "--target", "cursor"]).code, 0);
    const dest = join(home, ".cursor", "plugins", "local", "remme");
    assert.equal(existsSync(join(dest, ".remme-managed")), true);
    assert.equal(json(join(dest, "plugin.json")).name, "remme");
    assert.equal(isAbsolute(json(join(dest, "mcp.json")).mcpServers.remme.args[0]), true);
    assert.equal(cli(["uninstall", "--target", "cursor"]).code, 0);
    assert.equal(existsSync(dest), false);
  } finally { done(); }
});

test("install --hooks: claude settings.json gains remme hook entries, idempotent, uninstall removes only ours", () => {
  const { project, cli, done } = sandbox();
  try {
    const settings = join(project, ".claude", "settings.json");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "other-hook" }] }] },
    }));

    assert.equal(cli(["install", "--target", "claude", "--hooks"]).code, 0);
    const installed = json(settings);
    const ours = (event: string) => (installed.hooks[event] ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook"));
    assert.equal(ours("PreToolUse").length, 1);
    assert.equal(ours("UserPromptSubmit").length, 1);
    assert.equal(ours("PostToolUseFailure").length, 1);
    assert.match(JSON.stringify(installed.hooks.PreToolUse), /remme-hook pretool claude/);
    // Foreign entries preserved.
    assert.ok(JSON.stringify(installed.hooks.PreToolUse).includes("other-hook"));

    // Idempotent: still exactly one remme entry per event.
    cli(["install", "--target", "claude", "--hooks"]);
    const again = json(settings);
    for (const event of ["PreToolUse", "UserPromptSubmit", "PostToolUseFailure"]) {
      assert.equal((again.hooks[event] ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    }

    // Uninstall (without --hooks) still removes our hook entries only.
    assert.equal(cli(["uninstall", "--target", "claude"]).code, 0);
    const after = json(settings);
    assert.equal(JSON.stringify(after).includes("remme-hook"), false);
    assert.ok(JSON.stringify(after.hooks.PreToolUse).includes("other-hook"));
  } finally { done(); }
});

test("install without --hooks writes no hook entries; devin --hooks writes hooks.v1.json", () => {
  const { project, cli, done } = sandbox();
  try {
    assert.equal(cli(["install", "--target", "claude"]).code, 0);
    assert.equal(json(join(project, ".claude", "settings.json")).hooks, undefined);

    assert.equal(cli(["install", "--target", "devin", "--hooks"]).code, 0);
    const hooksFile = join(project, ".devin", "hooks.v1.json");
    const hooks = json(hooksFile);
    // hooks.v1.json is the bare hooks object (no "hooks" wrapper).
    assert.equal(hooks.hooks, undefined);
    assert.equal((hooks.PreToolUse ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    assert.equal((hooks.UserPromptSubmit ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    assert.equal((hooks.PostToolUse ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    assert.match(JSON.stringify(hooks.PreToolUse), /remme-hook pretool devin/);
    assert.ok(existsSync(join(project, ".devin", "mcp_config.json")));

    cli(["uninstall", "--target", "devin"]);
    const after = json(hooksFile);
    assert.equal(JSON.stringify(after).includes("remme-hook"), false);
  } finally { done(); }
});

test("install --hooks: codex hooks.json uses nested entries and preserves foreign hooks", () => {
  const { project, cli, done } = sandbox();
  try {
    const file = join(project, ".codex", "hooks.json");
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-codex-hook" }] }] },
    }));

    const installOut = cli(["install", "--target", "codex", "--hooks"]).out;
    assert.match(installOut, /\/hooks/);
    const installed = json(file);
    const ours = (event: string) => (installed.hooks[event] ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook"));
    assert.equal(ours("PreToolUse").length, 1);
    assert.equal(ours("UserPromptSubmit").length, 1);
    assert.equal(ours("PostToolUse").length, 1);
    assert.match(JSON.stringify(installed.hooks.PreToolUse), /remme-hook pretool codex/);
    assert.ok(JSON.stringify(installed.hooks.PreToolUse).includes("other-codex-hook"));

    cli(["install", "--target", "codex", "--hooks"]);
    const again = json(file);
    for (const event of ["PreToolUse", "UserPromptSubmit", "PostToolUse"]) {
      assert.equal((again.hooks[event] ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    }

    assert.equal(cli(["uninstall", "--target", "codex"]).code, 0);
    const after = json(file);
    assert.equal(JSON.stringify(after).includes("remme-hook"), false);
    assert.ok(JSON.stringify(after.hooks.PreToolUse).includes("other-codex-hook"));
  } finally { done(); }
});

test("install --hooks: cursor hooks.json is versioned with flat snake_case-free entries", () => {
  const { home, cli, done } = sandbox();
  try {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    assert.equal(cli(["install", "--target", "cursor", "--hooks", "--scope", "global"]).code, 0);
    const file = join(home, ".cursor", "hooks.json");
    const hooks = json(file);
    assert.equal(hooks.version, 1);
    const pre = (hooks.hooks.preToolUse ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook"));
    assert.equal(pre.length, 1);
    // Flat entry shape: {command, timeout, matcher} — no nested hooks array.
    assert.equal(pre[0].hooks, undefined);
    assert.equal(typeof pre[0].command, "string");
    assert.match(pre[0].command, /remme-hook pretool cursor/);
    assert.equal(typeof pre[0].matcher, "string");
    assert.equal((hooks.hooks.postToolUseFailure ?? []).filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);
    // No prompt event is wired for cursor.
    assert.equal(hooks.hooks.beforeSubmitPrompt, undefined);

    cli(["install", "--target", "cursor", "--hooks", "--scope", "global"]);
    assert.equal(json(file).hooks.preToolUse.filter((e: any) => JSON.stringify(e).includes("remme-hook")).length, 1);

    assert.equal(cli(["uninstall", "--target", "cursor", "--scope", "global"]).code, 0);
    const after = json(file);
    assert.equal(JSON.stringify(after).includes("remme-hook"), false);
  } finally { done(); }
});

test("install --hooks: opencode writes a plugin file; foreign remme.js is preserved", () => {
  const { project, cli, done } = sandbox();
  try {
    // Without --hooks no plugin file appears.
    assert.equal(cli(["install", "--target", "opencode"]).code, 0);
    assert.equal(existsSync(join(project, ".opencode", "plugins", "remme.js")), false);

    assert.equal(cli(["install", "--target", "opencode", "--hooks"]).code, 0);
    const plugin = join(project, ".opencode", "plugins", "remme.js");
    assert.equal(existsSync(plugin), true);
    const src = readFileSync(plugin, "utf8");
    assert.match(src, /remme-hook/);
    assert.match(src, /"pretool", "opencode"/);
    assert.match(src, /execute\.before/);
    assert.match(src, /export default/);

    // Idempotent.
    cli(["install", "--target", "opencode", "--hooks"]);
    assert.equal(readFileSync(plugin, "utf8"), src);

    assert.equal(cli(["uninstall", "--target", "opencode"]).code, 0);
    assert.equal(existsSync(plugin), false);

    // A user-authored remme.js without our marker is never removed.
    mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(plugin, "export default { id: 'mine' };\n");
    cli(["install", "--target", "opencode", "--hooks"]);
    assert.equal(readFileSync(plugin, "utf8"), "export default { id: 'mine' };\n");
    cli(["uninstall", "--target", "opencode"]);
    assert.equal(readFileSync(plugin, "utf8"), "export default { id: 'mine' };\n");
  } finally { done(); }
});

test("install: unknown target and missing --target fail with a clear message", () => {
  const { cli, done } = sandbox();
  try {
    const unknown = cli(["install", "--target", "nope"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /unknown target: nope/);
    const missing = cli(["install"]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /usage: remme install/);
  } finally { done(); }
});
