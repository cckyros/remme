import test, { after } from "node:test";
import Database from "better-sqlite3";
import { MarkdownImporter } from "../../src/importer/markdown.ts";
import { OpenClawImporter } from "../../src/importer/openclaw.ts";
import { readManifest } from "../../src/importer/manifest.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "../../src/database.ts";
import type { Config } from "../../src/config.ts";

const isolatedHome = mkdtempSync(join(tmpdir(), "remme-import-home-"));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = process.env.USERPROFILE = isolatedHome;
after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
});

function makeConfig(root: string): Config {
  return { dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"), embeddingModel: "test", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0, mmrEnabled: true, agent: "test-agent" };
}

function makeOpenClawSource(root: string): string {
  const source = join(root, "openclaw-source");
  mkdirSync(join(source, "memory", "projects"), { recursive: true });
  mkdirSync(join(source, "memory", "technical"), { recursive: true });
  mkdirSync(join(source, "memory", "learnings"), { recursive: true });
  writeFileSync(join(source, "MEMORY.md"), "---\nimportance: 7\ntags: [\"core\"]\n---\n# Memory Index\nThis is the main memory file.");
  writeFileSync(join(source, "memory/2026-09-04.md"), "---\nimportance: 5\n---\n# Daily Log\nWorked on remme today.");
  writeFileSync(join(source, "memory/projects/remme.md"), "---\nimportance: 8\n---\n# remme project\nBuilding a memory server.");
  writeFileSync(join(source, "memory/technical/sqlite.md"), "---\nimportance: 6\ntags: [\"sqlite\", \"vector\"]\n---\n# SQLite Technical\nUsing sqlite-vec for vectors.");
  writeFileSync(join(source, "memory/learnings/lesson.md"), "---\nimportance: 4\n---\n# Lesson Learned\nAlways test migrations.");
  return source;
}

function makeGenericSource(root: string): string {
  const source = join(root, "notes");
  mkdirSync(join(source, "work"), { recursive: true });
  mkdirSync(join(source, "personal"), { recursive: true });
  writeFileSync(join(source, "README.md"), "---\nimportance: 5\n---\n# My Notes\nA collection of notes.");
  writeFileSync(join(source, "work", "project-alpha.md"), "---\nimportance: 7\ntags: [\"work\"]\n---\n# Project Alpha\nImportant project details.");
  writeFileSync(join(source, "work", "meeting-notes.md"), "---\nimportance: 3\n---\n# Meeting 2026-09-04\nDiscussed roadmap.");
  writeFileSync(join(source, "personal", "ideas.md"), "---\nimportance: 6\n---\n# Ideas\nSide project ideas.");
  return source;
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "remme-import-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const db = new MemoryDatabase(config);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, db };
}

const skipOptions = { embedding: "skip" as const, dryRun: false, includeSystem: false };
const noEmbed = async () => new Float32Array(384);

function sqliteFixture(root: string, name = "source.db") {
  const path = join(root, name);
  const sqlite = new Database(path);
  sqlite.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT, embedding BLOB, embedding_model TEXT, embedding_dims INTEGER)");
  return { path, sqlite };
}

// ============================================================
// OpenClaw importer: dry-run
// ============================================================

test("OpenClaw dry-run: reports files and chunks without writing", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  const importer = new OpenClawImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: true, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "dry-run");
  assert.ok(result.files.curated >= 1);
  assert.ok(result.files.daily >= 1);
  assert.ok(result.files.projects >= 1);
  assert.ok(result.files.technical >= 1);
  assert.ok(result.files.learnings >= 1);
  assert.ok(result.chunks > 0);
  assert.equal(existsSync(join(config.memoryDir, "imports")), false);
});

// ============================================================
// OpenClaw importer: full import
// ============================================================

test("OpenClaw import: creates indexed files and chunks with import metadata", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  const importer = new OpenClawImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "completed");
  assert.ok(result.chunks > 0);
  const imported = db.rows().filter((r) => r.origin === "imported");
  assert.ok(imported.length > 0);
  assert.ok(imported.every((r) => r.import_id !== null));
  assert.ok(existsSync(join(config.memoryDir, "imports", "openclaw", result.importId, "curated", "markdown", "MEMORY.md")));
  assert.ok(existsSync(join(config.importsDir, "openclaw", result.importId, "raw", "markdown", "MEMORY.md")));
});

test("OpenClaw import: idempotent — second run does not duplicate chunks", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  const opts = { source, embedding: "skip" as const, dryRun: false, includeSystem: false };
  const first = await new OpenClawImporter(config, db, noEmbed, opts).import();
  assert.equal(first.status, "completed");
  const firstChunks = db.rows().filter((r) => r.origin === "imported").length;
  const second = await new OpenClawImporter(config, db, noEmbed, opts).import();
  assert.equal(second.status, "completed");
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, firstChunks);
});

test("OpenClaw import: rollback removes imported chunks, preserves native", async (t) => {
  const { root, config, db } = fixture(t);
  writeFileSync(join(config.memoryDir, "native.md"), "---\nimportance: 5\n---\nNative memory content.");
  const source = makeOpenClawSource(root);
  db.sync();
  const nativeBefore = db.rows().filter((r) => r.origin === "native").length;
  const importer = new OpenClawImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  const importedBefore = db.rows().filter((r) => r.origin === "imported").length;
  assert.ok(importedBefore > 0);
  const rollback = db.rollbackImport(result.importId);
  assert.equal(rollback.removedChunks, importedBefore);
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, 0);
  assert.equal(db.rows().filter((r) => r.origin === "native").length, nativeBefore);
});

test("OpenClaw import: sync does not delete imported chunks", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  await new OpenClawImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false }).import();
  const importedBefore = db.rows().filter((r) => r.origin === "imported").length;
  db.sync();
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, importedBefore);
});

test("OpenClaw import: imported content is searchable via searchText", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  await new OpenClawImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false }).import();
  db.sync();
  const results = db.searchText("SQLite");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.row.origin === "imported"));
});

// ============================================================
// OpenClaw importer: batch isolation and idempotence
// ============================================================

test("OpenClaw batch isolation: preserves relative filenames, archives and manifest", async (t) => {
  const { root, config, db } = fixture(t);
  const source = join(root, "notes");
  for (const dir of ["one", "two"]) { mkdirSync(join(source, dir), { recursive: true }); writeFileSync(join(source, dir, "same.md"), `Content from ${dir}`); }
  const first = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source }).import();
  const firstDir = join(config.memoryDir, "imports", "openclaw", first.importId);
  for (const dir of ["one", "two"]) assert.ok(existsSync(join(firstDir, "curated", "markdown", dir, "same.md")));
  const archive = join(config.importsDir, "openclaw", first.importId);
  const manifest = readManifest(archive)!;
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.files.every((file) => existsSync(file.targetPath) && !file.targetPath.includes(".staging-")));
  const before = readFileSync(join(archive, "raw", "markdown", "one", "same.md"), "utf8");
  writeFileSync(join(source, "one", "same.md"), "Changed content");
  const second = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source }).import();
  assert.notEqual(second.importId, first.importId);
  assert.equal(readFileSync(join(archive, "raw", "markdown", "one", "same.md"), "utf8"), before);
  assert.ok(readManifest(join(config.importsDir, "openclaw", second.importId)));
});

test("OpenClaw idempotence: canonical source and sourceType scope without changing relative paths", async (t) => {
  const { root, config, db } = fixture(t);
  const source = join(root, "first");
  const other = join(root, "second");
  for (const dir of [source, other]) { mkdirSync(dir); writeFileSync(join(dir, "MEMORY.md"), "Same content"); }
  const run = (dir: string) => new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source: dir }).import();
  assert.equal((await run(source)).chunks, 1);
  assert.equal((await run(join(source, "."))).chunks, 0);
  assert.equal((await run(other)).chunks, 1);
  assert.equal((await new MarkdownImporter(config, db, noEmbed, { ...skipOptions, source }).import()).chunks, 1);
  assert.ok(db.rows().every((row) => row.original_path === "MEMORY.md"));
});

// ============================================================
// OpenClaw importer: finalize and embedding preservation
// ============================================================

test("OpenClaw finalize: sync preserves chunk IDs and per-chunk rebuilt embeddings", async (t) => {
  const { root, config, db } = fixture(t);
  const source = join(root, "notes");
  mkdirSync(source);
  writeFileSync(join(source, "MEMORY.md"), Array.from({ length: 100 }, (_, i) => `Line ${i} ${"content ".repeat(8)}`).join("\n"));
  const calls: string[] = [];
  const embed = async (text: string) => { calls.push(text); return new Float32Array(384).fill(calls.length); };
  const result = await new OpenClawImporter(config, db, embed, { ...skipOptions, embedding: "rebuild", source }).import();
  const before = db.rows();
  assert.ok(before.length > 1);
  assert.deepEqual(calls, before.map((row) => row.text));
  assert.ok(before.every((row) => existsSync(row.path) && row.path.includes(result.importId) && !row.path.includes(".staging-")));
  db.sync();
  assert.deepEqual(db.rows().map((row) => [row.id, row.path, row.embedding?.toString("hex"), row.embedding_model]), before.map((row) => [row.id, row.path, row.embedding?.toString("hex"), row.embedding_model]));
});

// ============================================================
// OpenClaw importer: failure handling
// ============================================================

test("OpenClaw failure: partial record failure clears DB but retains raw archive", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  const original = db.addImportRecord.bind(db);
  let count = 0;
  db.addImportRecord = (...args: Parameters<MemoryDatabase["addImportRecord"]>) => { if (++count === 2) throw new Error("injected record failure"); original(...args); };
  const result = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source }).import();
  assert.equal(result.status, "failed");
  assert.equal(db.rows().length, 0);
  assert.equal(db.importRecords(result.importId).length, 0);
  assert.ok(existsSync(join(config.importsDir, "openclaw", result.importId, "raw", "markdown", "MEMORY.md")));
  assert.ok(!existsSync(join(config.memoryDir, "imports", "openclaw", result.importId)));
});

test("OpenClaw failure: after batch rename cleans DB and final batch, keeps archives and prior imports", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeOpenClawSource(root);
  const first = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source }).import();
  const before = db.rows().map((row) => [row.id, row.path]);
  writeFileSync(join(source, "MEMORY.md"), "Updated core memory");
  const original = db.moveImportPaths.bind(db);
  db.moveImportPaths = (...args: Parameters<MemoryDatabase["moveImportPaths"]>) => { original(...args); throw new Error("injected finalize failure"); };
  const result = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, source }).import();
  assert.equal(result.status, "failed");
  assert.deepEqual(db.rows().map((row) => [row.id, row.path]), before);
  assert.ok(!existsSync(join(config.memoryDir, "imports", "openclaw", result.importId)));
  assert.ok(existsSync(join(config.memoryDir, "imports", "openclaw", first.importId)));
});

test("OpenClaw dry-run: rejects missing paths and invalid SQLite schema", async (t) => {
  const { root, config, db } = fixture(t);
  const invalidDb = join(root, "invalid.db"); new Database(invalidDb).close();
  const invalidColumns = join(root, "invalid-columns.db");
  const sqlite = new Database(invalidColumns); sqlite.exec("CREATE TABLE chunks (id TEXT)"); sqlite.close();
  const invalidFile = join(root, "invalid-file.db"); writeFileSync(invalidFile, "Not SQLite");
  for (const options of [{ source: join(root, "missing") }, { source: invalidFile }, { db: join(root, "missing.db") }, { db: invalidDb }, { db: invalidColumns }, { db: invalidFile }]) {
    await assert.rejects(new OpenClawImporter(config, db, noEmbed, { ...skipOptions, ...options, dryRun: true }).import(), /not found|directory|schema|SQLite|database/i);
  }
  assert.equal(db.importStatus().length, 0);
  assert.equal(existsSync(join(config.memoryDir, "imports")), false);
});

// ============================================================
// OpenClaw SQLite import
// ============================================================

test("SQLite import: record IDs cannot traverse paths and separate source DBs do not deduplicate", async (t) => {
  const { root, config, db } = fixture(t);
  for (const name of ["first.db", "second.db"]) {
    const { path, sqlite } = sqliteFixture(root, name);
    sqlite.prepare("INSERT INTO chunks(id,text) VALUES (?,?)").run("../../outside\\escape", "Same SQLite content");
    sqlite.close();
    const result = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, db: path }).import();
    assert.equal(result.status, "completed");
    assert.equal(result.chunks, 1);
    const dir = join(config.memoryDir, "imports", "openclaw", result.importId, "technical", "sqlite");
    assert.match(readdirSync(dir)[0], /^[a-f0-9]+\.md$/);
    assert.ok(existsSync(join(config.importsDir, "openclaw", result.importId, "raw", "sqlite", name)));
  }
});

test("SQLite import: iterator imports records beyond 10000", async (t) => {
  const { root, config, db } = fixture(t);
  const { path, sqlite } = sqliteFixture(root);
  const insert = sqlite.prepare("INSERT INTO chunks(id,text) VALUES (?,?)");
  sqlite.transaction(() => { for (let i = 0; i < 10000; i++) insert.run(String(i), ""); insert.run("last", "Record beyond the old limit"); })();
  sqlite.close();
  const result = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, db: path }).import();
  assert.equal(result.status, "completed");
  assert.equal(result.chunks, 1);
});

for (const mode of ["auto", "reuse"] as const) {
  test(`SQLite ${mode}: requires explicit matching model and dimensions`, async (t) => {
    const { root, config, db } = fixture(t);
    config.embeddingModel = "Xenova/all-MiniLM-L6-v2";
    const { path, sqlite } = sqliteFixture(root);
    const insert = sqlite.prepare("INSERT INTO chunks VALUES (?,?,?,?,?)");
    const vector = Buffer.from(new Float32Array(384).fill(0.25).buffer);
    insert.run("unknown", "Unknown model", vector, null, 384);
    insert.run("different", "Different model", vector, "other-model", 384);
    insert.run("wrong-dim", "Wrong dimensions", Buffer.from(new Float32Array(128).buffer), config.embeddingModel, 128);
    insert.run("compatible", "Compatible embedding", vector, config.embeddingModel, 384);
    sqlite.close();
    const result = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, embedding: mode, db: path }).import();
    assert.equal(result.status, "completed");
    assert.equal(result.embeddings.reused, 1);
    assert.equal(result.embeddings.skipped, 3);
    assert.ok(result.warnings.length >= 3);
    const embedded = db.rows().filter((row) => row.embedding);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0].embedding_model, config.embeddingModel);
  });
}

test("SQLite split records: rebuild each chunk, never reuse one whole-record vector", async (t) => {
  const { root, config, db } = fixture(t);
  config.embeddingModel = "Xenova/all-MiniLM-L6-v2";
  const { path, sqlite } = sqliteFixture(root);
  const text = Array.from({ length: 100 }, (_, i) => `SQLite line ${i} ${"details ".repeat(8)}`).join("\n");
  sqlite.prepare("INSERT INTO chunks VALUES (?,?,?,?,?)").run("long", text, Buffer.from(new Float32Array(384).fill(1).buffer), config.embeddingModel, 384);
  sqlite.close();
  const reused = await new OpenClawImporter(config, db, noEmbed, { ...skipOptions, embedding: "reuse", db: path }).import();
  assert.ok(reused.chunks > 1);
  assert.equal(reused.embeddings.reused, 0);
  assert.equal(reused.embeddings.skipped, reused.chunks);
  assert.ok(reused.warnings.some((warning) => warning.includes("multiple chunks")));
  db.rollbackImport(reused.importId);
  const calls: string[] = [];
  const rebuilt = await new OpenClawImporter(config, db, async (chunk) => { calls.push(chunk); return new Float32Array(384).fill(calls.length); }, { ...skipOptions, embedding: "rebuild", db: path }).import();
  assert.equal(rebuilt.embeddings.rebuilt, rebuilt.chunks);
  assert.deepEqual(calls, db.rows().map((row) => row.text));
});

// ============================================================
// Markdown importer (generic)
// ============================================================

test("Markdown import: works for any directory structure", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeGenericSource(root);
  const importer = new MarkdownImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "completed");
  assert.equal(result.sourceType, "markdown");
  assert.ok(result.chunks > 0);
  assert.ok(result.files["general"] >= 1);
  assert.ok(result.files["work"] >= 2);
  assert.ok(result.files["personal"] >= 1);
  const imported = db.rows().filter((r) => r.origin === "imported");
  assert.ok(imported.every((r) => r.import_id !== null));
});

test("Markdown import: is searchable", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeGenericSource(root);
  await new MarkdownImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false }).import();
  db.sync();
  const results = db.searchText("Project Alpha");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.row.origin === "imported"));
});

test("Markdown import: is idempotent", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeGenericSource(root);
  const opts = { source, embedding: "skip" as const, dryRun: false, includeSystem: false };
  await new MarkdownImporter(config, db, noEmbed, opts).import();
  const firstChunks = db.rows().filter((r) => r.origin === "imported").length;
  await new MarkdownImporter(config, db, noEmbed, opts).import();
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, firstChunks);
});

test("Markdown import: rollback removes all imported data", async (t) => {
  const { root, config, db } = fixture(t);
  const source = makeGenericSource(root);
  const result = await new MarkdownImporter(config, db, noEmbed, { source, embedding: "skip", dryRun: false, includeSystem: false }).import();
  assert.ok(db.rows().filter((r) => r.origin === "imported").length > 0);
  db.rollbackImport(result.importId);
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, 0);
});
