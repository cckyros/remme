import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWarningIndex, formatBlockReason, formatWarnings, globToRegExp, hasTriggers,
  indexPath, loadHookState, matchCommands, matchKeywords, matchPaths, matchWarnings,
  refreshWarningIndex, saveHookState, sessionOf, triggersOf, warningsForHook,
  type WarningEntry,
} from "../../src/triggers.ts";
import type { Config } from "../../src/config.ts";

function cfg(root: string): Config {
  return {
    dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"),
    embeddingModel: "m", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0,
    mmrEnabled: true, agent: "test",
  };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "remme-triggers-"));
  return { root, config: cfg(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

function memFile(status: string, knowledgeType: string, triggers: string, body = "body"): string {
  return `---\nimportance: 5\ntags: []\nknowledgeType: "${knowledgeType}"\nstatus: "${status}"\nproject: ""\ncreated: "2026-01-01T00:00:00Z"\nagent: "test"\nentities: []\n${triggers}---\n\n${body}\n`;
}

const entry = (over: Partial<WarningEntry> = {}): WarningEntry => ({
  path: "2026-01/p.md", status: "verified", knowledgeType: "pitfall",
  title: "a pitfall", triggers: { paths: [], commands: [], keywords: [] }, ...over,
});

// ---------------------------------------------------------------- glob/paths

test("matchPaths: exact, glob star, double-star and basename matching", () => {
  const cwd = "C:/proj";
  assert.equal(matchPaths(["src/db.ts"], ["C:/proj/src/db.ts"], cwd), true);
  assert.equal(matchPaths(["src/db.ts"], ["C:/proj/src/other.ts"], cwd), false);
  assert.equal(matchPaths(["src/*.ts"], ["src/a.ts"], cwd), true);
  assert.equal(matchPaths(["src/*.ts"], ["src/deep/a.ts"], cwd), false);
  assert.equal(matchPaths(["src/**"], ["src/deep/a.ts"], cwd), true);
  assert.equal(matchPaths(["**/migrations/**"], ["a/b/migrations/c.sql"], cwd), true);
  assert.equal(matchPaths(["db.ts"], ["x/y/db.ts"], cwd), true);
  assert.equal(matchPaths(["src/db.ts"], ["src\\db.ts"], cwd), true);
  assert.equal(matchPaths([], ["src/db.ts"], cwd), false);
  assert.equal(matchPaths(["src/db.ts"], [], cwd), false);
});

test("globToRegExp: ? matches one non-slash char", () => {
  assert.equal(matchPaths(["src/?.ts"], ["src/a.ts"], ""), true);
  assert.equal(matchPaths(["src/?.ts"], ["src/ab.ts"], ""), false);
});

// ---------------------------------------------------------------- commands/keywords

test("matchCommands: regex, case-insensitive, invalid patterns skipped", () => {
  assert.equal(matchCommands(["git commit .*<<"], ["git commit -m x <<EOF"]), true);
  assert.equal(matchCommands(["GIT COMMIT"], ["git commit -m x"]), true);
  assert.equal(matchCommands(["npm run build"], ["npm run test"]), false);
  assert.equal(matchCommands(["[[bad"], ["anything"]), false);
  assert.equal(matchCommands([], ["x"]), false);
});

test("matchKeywords: case-insensitive substring incl. CJK", () => {
  assert.equal(matchKeywords(["heredoc"], "use a HEREDOC here"), true);
  assert.equal(matchKeywords(["中文"], "这是中文内容"), true);
  assert.equal(matchKeywords(["missing"], "nothing here"), false);
  assert.equal(matchKeywords([], "x"), false);
});

// ---------------------------------------------------------------- matchWarnings

test("matchWarnings: hits via each trigger kind, capped at limit", () => {
  const e1 = entry({ path: "a.md", triggers: { paths: ["src/x.ts"], commands: [], keywords: [] } });
  const e2 = entry({ path: "b.md", triggers: { paths: [], commands: ["^deploy "], keywords: [] } });
  const e3 = entry({ path: "c.md", triggers: { paths: [], commands: [], keywords: ["heredoc"] } });
  const entries = [e1, e2, e3];
  assert.deepEqual(matchWarnings(entries, { paths: ["src/x.ts"], cwd: "" }).map((e) => e.path), ["a.md"]);
  assert.deepEqual(matchWarnings(entries, { commands: ["deploy prod"], cwd: "" }).map((e) => e.path), ["b.md"]);
  assert.deepEqual(matchWarnings(entries, { commands: ["deploy prod"], text: "please fix heredoc", cwd: "" }).map((e) => e.path), ["b.md", "c.md"]);
  assert.deepEqual(matchWarnings(entries, { text: "unrelated prompt", cwd: "" }), []);
  const many = Array.from({ length: 6 }, (_, i) => entry({ path: `${i}.md`, triggers: { paths: ["hit.ts"], commands: [], keywords: [] } }));
  assert.equal(matchWarnings(many, { paths: ["hit.ts"], cwd: "" }).length, 3);
});

// ---------------------------------------------------------------- index

test("buildWarningIndex: only confirmed/verified memories with triggers", () => {
  const { config, done } = sandbox();
  try {
    const dir = config.memoryDir;
    mkdirSync(join(dir, "2026-01"), { recursive: true });
    writeFileSync(join(dir, "2026-01", "verified-pitfall.md"), memFile("verified", "pitfall", 'triggerPaths: ["src/x.ts"]\n', "First body line\nsecond"));
    writeFileSync(join(dir, "2026-01", "confirmed-solution.md"), memFile("confirmed", "solution", 'triggerKeywords: ["oom"]\n'));
    writeFileSync(join(dir, "2026-01", "candidate-pitfall.md"), memFile("candidate", "pitfall", 'triggerPaths: ["src/y.ts"]\n'));
    writeFileSync(join(dir, "2026-01", "no-triggers.md"), memFile("verified", "pitfall", ""));
    writeFileSync(join(dir, "2026-01", "superseded.md"), memFile("superseded", "pitfall", 'triggerKeywords: ["old"]\n'));
    writeFileSync(join(dir, "2026-01", "notmarkdown.txt"), memFile("verified", "pitfall", 'triggerKeywords: ["x"]\n'));
    const entries = buildWarningIndex(config);
    assert.deepEqual(entries.map((e) => e.path).sort(), ["2026-01/confirmed-solution.md", "2026-01/verified-pitfall.md"]);
    const pitfall = entries.find((e) => e.path.includes("verified-pitfall"))!;
    assert.equal(pitfall.status, "verified");
    assert.equal(pitfall.title, "First body line");
    assert.deepEqual(pitfall.triggers.paths, ["src/x.ts"]);
  } finally { done(); }
});

test("warningsForHook: builds index, reuses fresh cache, rebuilds on corrupt/stale", () => {
  const { config, done } = sandbox();
  try {
    mkdirSync(config.memoryDir, { recursive: true });
    assert.deepEqual(warningsForHook(config), []);
    const file = indexPath(config);
    writeFileSync(join(config.memoryDir, "a.md"), memFile("confirmed", "pitfall", 'triggerKeywords: ["k"]\n'));
    // Stale index is ignored and rebuilt.
    writeFileSync(file, "{corrupt");
    assert.equal(warningsForHook(config).length, 1);
    // Fresh index is served from disk without rescanning.
    assert.equal(warningsForHook(config).length, 1);
    // Force staleness beyond the TTL.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, old, old);
    writeFileSync(join(config.memoryDir, "b.md"), memFile("confirmed", "pitfall", 'triggerKeywords: ["k2"]\n'));
    assert.equal(warningsForHook(config).length, 2);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.entries));
  } finally { done(); }
});

test("refreshWarningIndex: writes a valid index file and never throws", () => {
  const { config, done } = sandbox();
  try {
    mkdirSync(config.memoryDir, { recursive: true });
    writeFileSync(join(config.memoryDir, "a.md"), memFile("verified", "pitfall", 'triggerPaths: ["x.ts"]\n'));
    refreshWarningIndex(config);
    const data = JSON.parse(readFileSync(indexPath(config), "utf8"));
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].triggers.paths[0], "x.ts");
  } finally { done(); }
});

// ---------------------------------------------------------------- session state

test("hook state: per-session ctx/blk sets persist and prune", () => {
  const { config, done } = sandbox();
  try {
    const state = loadHookState(config);
    const s = sessionOf(state, "sess-1");
    s.ctx.push("a.md"); s.blk.push("b.md"); s.updatedAt = new Date().toISOString();
    saveHookState(config, state);
    const loaded = loadHookState(config);
    assert.deepEqual(loaded.sessions["sess-1"].ctx, ["a.md"]);
    assert.deepEqual(loaded.sessions["sess-1"].blk, ["b.md"]);
    // Old sessions are pruned on save.
    loaded.sessions["old"] = { ctx: [], blk: [], updatedAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() };
    saveHookState(config, loaded);
    assert.equal(loadHookState(config).sessions["old"], undefined);
  } finally { done(); }
});

// ---------------------------------------------------------------- formatting / helpers

test("formatWarnings/formatBlockReason mention memory_read and the path", () => {
  const e = entry({ path: "2026-01/x.md", title: "bad thing" });
  assert.match(formatWarnings([e]), /memory_read\("2026-01\/x\.md"\)/);
  assert.match(formatBlockReason([e]), /retrying the same call is allowed/);
});

test("triggersOf/hasTriggers read frontmatter-style metadata", () => {
  const m = { triggerPaths: ["a"], triggerCommands: [], triggerKeywords: ["k"] };
  assert.deepEqual(triggersOf(m), { paths: ["a"], commands: [], keywords: ["k"] });
  assert.equal(hasTriggers(triggersOf(m)), true);
  assert.equal(hasTriggers(triggersOf({})), false);
});
