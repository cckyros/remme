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
