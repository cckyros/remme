import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "../src/database.ts";
import { OpenClawImporter } from "../src/importer/openclaw.ts";
import type { Config } from "../src/config.ts";

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

test("dry-run reports files and chunks without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-dry-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  const importer = new OpenClawImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: true, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "dry-run");
  assert.ok(result.files.curated >= 1);
  assert.ok(result.files.daily >= 1);
  assert.ok(result.files.projects >= 1);
  assert.ok(result.files.technical >= 1);
  assert.ok(result.files.learnings >= 1);
  assert.ok(result.chunks > 0);
  assert.equal(existsSync(join(config.memoryDir, "imports")), false);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("markdown import creates indexed files and chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-md-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  const importer = new OpenClawImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "completed");
  assert.ok(result.chunks > 0);
  const rows = db.rows();
  const imported = rows.filter((r) => r.origin === "imported");
  assert.ok(imported.length > 0);
  assert.ok(imported.every((r) => r.import_id !== null));
  assert.ok(existsSync(join(config.memoryDir, "imports", "openclaw", "curated", "MEMORY.md")));
  assert.ok(existsSync(join(config.importsDir, "openclaw", "raw", "MEMORY.md")));
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("idempotent import does not duplicate chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-idem-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  const opts = { source, embedding: "skip" as const, dryRun: false, includeSystem: false };
  const first = await new OpenClawImporter(config, db, async () => new Float32Array(384), opts).import();
  assert.equal(first.status, "completed");
  const firstChunks = db.rows().filter((r) => r.origin === "imported").length;
  const second = await new OpenClawImporter(config, db, async () => new Float32Array(384), opts).import();
  assert.equal(second.status, "completed");
  const secondChunks = db.rows().filter((r) => r.origin === "imported").length;
  assert.equal(firstChunks, secondChunks);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("rollback removes imported chunks and preserves native memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-rollback-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  writeFileSync(join(config.memoryDir, "native.md"), "---\nimportance: 5\n---\nNative memory content.");
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  db.sync();
  const nativeBefore = db.rows().filter((r) => r.origin === "native").length;
  assert.ok(nativeBefore > 0);
  const importer = new OpenClawImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "completed");
  const importedBefore = db.rows().filter((r) => r.origin === "imported").length;
  assert.ok(importedBefore > 0);
  const rollback = db.rollbackImport(result.importId);
  assert.equal(rollback.removedChunks, importedBefore);
  const importedAfter = db.rows().filter((r) => r.origin === "imported").length;
  assert.equal(importedAfter, 0);
  const nativeAfter = db.rows().filter((r) => r.origin === "native").length;
  assert.equal(nativeAfter, nativeBefore);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("sync does not delete imported chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-sync-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  const importer = new OpenClawImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  await importer.import();
  const importedBefore = db.rows().filter((r) => r.origin === "imported").length;
  assert.ok(importedBefore > 0);
  db.sync();
  const importedAfter = db.rows().filter((r) => r.origin === "imported").length;
  assert.equal(importedAfter, importedBefore);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("imported content is searchable via memory_search", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-import-search-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeOpenClawSource(root);
  const db = new MemoryDatabase(config);
  const importer = new OpenClawImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  await importer.import();
  db.sync();
  const results = db.searchText("SQLite");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.origin === "imported"));
  db.close(); rmSync(root, { recursive: true, force: true });
});
