import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "../src/database.ts";
import { MarkdownImporter } from "../src/importer/markdown.ts";
import type { Config } from "../src/config.ts";

function makeConfig(root: string): Config {
  return { dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"), embeddingModel: "test", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0, mmrEnabled: true, agent: "test-agent" };
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

test("generic markdown import works for any directory structure", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-generic-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeGenericSource(root);
  const db = new MemoryDatabase(config);
  const importer = new MarkdownImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.equal(result.status, "completed");
  assert.equal(result.sourceType, "markdown");
  assert.ok(result.chunks > 0);
  assert.ok(result.files["general"] >= 1);
  assert.ok(result.files["work"] >= 2);
  assert.ok(result.files["personal"] >= 1);
  const imported = db.rows().filter((r) => r.origin === "imported");
  assert.ok(imported.length > 0);
  assert.ok(imported.every((r) => r.import_id !== null));
  assert.ok(imported.every((r) => r.source_id === null || r.source_id !== undefined));
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("generic markdown import is searchable", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-search-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeGenericSource(root);
  const db = new MemoryDatabase(config);
  const importer = new MarkdownImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  await importer.import();
  db.sync();
  const results = db.searchText("Project Alpha");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.origin === "imported"));
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("generic markdown import is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-idem-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeGenericSource(root);
  const db = new MemoryDatabase(config);
  const opts = { source, embedding: "skip" as const, dryRun: false, includeSystem: false };
  const first = await new MarkdownImporter(config, db, async () => new Float32Array(384), opts).import();
  assert.equal(first.status, "completed");
  const firstChunks = db.rows().filter((r) => r.origin === "imported").length;
  const second = await new MarkdownImporter(config, db, async () => new Float32Array(384), opts).import();
  assert.equal(second.status, "completed");
  const secondChunks = db.rows().filter((r) => r.origin === "imported").length;
  assert.equal(firstChunks, secondChunks);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("generic markdown rollback removes all imported data", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-rollback-"));
  const config = makeConfig(root);
  mkdirSync(config.memoryDir, { recursive: true });
  const source = makeGenericSource(root);
  const db = new MemoryDatabase(config);
  const importer = new MarkdownImporter(config, db, async () => new Float32Array(384), { source, embedding: "skip", dryRun: false, includeSystem: false });
  const result = await importer.import();
  assert.ok(db.rows().filter((r) => r.origin === "imported").length > 0);
  db.rollbackImport(result.importId);
  assert.equal(db.rows().filter((r) => r.origin === "imported").length, 0);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("MCP import with sourceType=markdown works via stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-mcp-"));
  const source = join(root, "notes");
  mkdirSync(join(source, "work"), { recursive: true });
  writeFileSync(join(source, "README.md"), "---\nimportance: 5\n---\n# Notes\nGeneric notes directory.");
  writeFileSync(join(source, "work", "task.md"), "---\nimportance: 7\n---\n# Task\nFinish the report.");
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory") }));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const call = (id: number, name: string, args: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: string) => { buffer += chunk; const line = buffer.split(/\r?\n/)[0]; if (!line) return; child.stdout.off("data", onData); try { resolve(JSON.parse(line)); } catch (e) { reject(e); } };
      child.stdout.setEncoding("utf8"); child.stdout.on("data", onData);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
    const importRes = await call(1, "memory_import", { sourceType: "markdown", source, embedding: "skip" });
    const result = JSON.parse(importRes.result.content[0].text);
    assert.equal(result.status, "completed");
    assert.equal(result.sourceType, "markdown");
    assert.ok(result.chunks > 0);
    const search = await call(2, "memory_search", { query: "report" });
    const searchResult = JSON.parse(search.result.content[0].text);
    assert.ok(searchResult.results.length > 0);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});
