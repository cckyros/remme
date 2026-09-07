import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseMarkdown } from "../../src/chunker.ts";

async function call(child: ChildProcessWithoutNullStreams, id: number, name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
  const response = new Promise<any>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { child.stdout.off("data", onData); reject(new Error(`MCP timeout: ${name}`)); }, timeoutMs);
    const onData = (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.id === id) { child.stdout.off("data", onData); clearTimeout(timer); resolve(value); return; }
          /* skip notifications or responses with different id */
        } catch { /* skip non-JSON lines */ }
      }
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", onData);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return response;
}

async function withStore(run: (request: (name: string, args: Record<string, unknown>) => Promise<any>, child: ChildProcessWithoutNullStreams) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, HOME: root, USERPROFILE: root, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let id = 0;
  const request = async (name: string, args: Record<string, unknown>) => {
    const result = await call(child, ++id, name, args);
    assert.equal(result.result.isError, false, JSON.stringify(result));
    return JSON.parse(result.result.content[0].text);
  };
  try { await run(request, child); } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
}

// ============================================================
// MCP stdio: handshake and tool discovery
// ============================================================

test("MCP stdio: handshake and tool discovery", async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (x) => { output += x; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 300));
  child.kill(); await closed;
  assert.match(output, /"serverInfo"/);
  assert.match(output, /memory_search/);
});

// ============================================================
// MCP memory: CRUD and knowledge lifecycle
// ============================================================

test("MCP memory: CRUD lifecycle with knowledge promotion and linking", async () => {
  await withStore(async (request) => {
    const created = await request("memory_write", { content: "SQLite decision 决策库", knowledgeType: "decision", status: "candidate", tags: ["sqlite"], importance: 9, project: "remme", entities: ["database.ts"] });
    const original = parseMarkdown((await request("memory_read", { path: created.path })).content).metadata;
    const second = await request("memory_write", { content: "Other decision" });
    await request("memory_link", { source: created.path, target: second.path, relationType: "supports" });
    await request("memory_promote", { path: created.path, status: "verified" });
    const read = await request("memory_read", { path: created.path });
    const promoted = parseMarkdown(read.content).metadata;
    assert.deepEqual(promoted, { ...original, status: "verified" });
    assert.equal(read.relations.length, 1);
    assert.ok(read.provenance.some((event: any) => event.event_type === "status:verified"));
  });
});

test("MCP memory: search with project, tags and entity filters", async () => {
  await withStore(async (request) => {
    await request("memory_write", { content: "SQLite decision 决策库", knowledgeType: "decision", status: "candidate", tags: ["sqlite"], importance: 9, project: "remme", entities: ["database.ts"] });
    const search = await request("memory_search", { query: "SQLite", project: "remme", tags: ["sqlite"], entity: "database.ts" });
    assert.equal(search.mode, "text-only");
    assert.equal(search.results.length, 1);
    assert.equal((await request("memory_search", { query: "库" })).results.length, 1);
  });
});

test("MCP memory: update replaces content and preserves relations", async () => {
  await withStore(async (request) => {
    const created = await request("memory_write", { content: "SQLite decision" });
    const second = await request("memory_write", { content: "Other" });
    await request("memory_link", { source: created.path, target: second.path, relationType: "supports" });
    await request("memory_update", { path: created.path, content: "Replacement PostgreSQL decision" });
    assert.equal((await request("memory_search", { query: "SQLite" })).results.length, 0);
    assert.equal((await request("memory_read", { path: created.path })).relations.length, 1);
  });
});

// ============================================================
// MCP memory: filters and validation
// ============================================================

test("MCP memory: date, entity, project and list filters apply before limiting candidates", async () => {
  await withStore(async (request) => {
    for (let i = 0; i < 105; i++) await request("memory_write", { content: `sharedkeyword unique${i}`, project: "common" });
    const created = await request("memory_write", { content: "sharedkeyword rare record", project: "rare", entities: ["target.ts"] });
    const found = await request("memory_search", { query: "sharedkeyword", project: "rare" });
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].path, created.path);
    assert.equal((await request("memory_search", { query: "sharedkeyword", dateFrom: "2099-01-01" })).results.length, 0);
    assert.equal((await request("memory_search", { query: "sharedkeyword", entity: "missing" })).results.length, 0);
    assert.equal((await request("memory_search", { query: "sharedkeyword", entity: "target.ts" })).results.length, 1);
    assert.equal((await request("memory_list", { limit: 1, project: "rare" })).files.length, 1);
    assert.equal((await request("memory_list", { project: "missing" })).files.length, 0);
  });
});

test("MCP memory: validates required arguments and bounds before writing", async () => {
  await withStore(async (request, child) => {
    for (const [name, args] of [["memory_write", {}], ["memory_write", { content: "" }], ["memory_write", { content: 12 }], ["memory_search", { query: "test", limit: -1 }], ["memory_write", { content: "test", importance: 99 }], ["memory_promote", { path: "x", status: "invalid" }]] as const) {
      const result = await call(child, 500, name, args);
      assert.equal(result.result.isError, true, JSON.stringify(result));
    }
    assert.deepEqual((await request("memory_list", {})).files, []);
  });
});

// ============================================================
// MCP import: dry-run, import, status, search, rollback
// ============================================================

test("MCP import: dry-run, import, status, search, rollback workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-import-"));
  const source = join(root, "openclaw-source");
  mkdirSync(join(source, "memory", "technical"), { recursive: true });
  writeFileSync(join(source, "MEMORY.md"), "---\nimportance: 7\n---\n# OpenClaw Memory\nCore memory from OpenClaw.");
  writeFileSync(join(source, "memory/technical/sqlite.md"), "---\nimportance: 6\ntags: [\"sqlite\"]\n---\n# SQLite Setup\nUsing sqlite-vec for vector search.");
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, HOME: root, USERPROFILE: root, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const dryRun = await call(child, 1, "memory_import", { source, dryRun: true, embedding: "skip" });
    assert.equal(JSON.parse(dryRun.result.content[0].text).status, "dry-run");
    const importRes = await call(child, 2, "memory_import", { source, embedding: "skip" });
    const importResult = JSON.parse(importRes.result.content[0].text);
    assert.equal(importResult.status, "completed");
    const status = await call(child, 3, "memory_import_status", {});
    assert.equal(JSON.parse(status.result.content[0].text).imports[0].status, "completed");
    const search = await call(child, 4, "memory_search", { query: "SQLite" });
    assert.ok(JSON.parse(search.result.content[0].text).results.length > 0);
    const rollback = await call(child, 5, "memory_import_rollback", { importId: importResult.importId, confirm: true });
    assert.equal(JSON.parse(rollback.result.content[0].text).status, "rolled-back");
    const searchAfter = await call(child, 6, "memory_search", { query: "SQLite" });
    assert.equal(JSON.parse(searchAfter.result.content[0].text).results.length, 0);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});

test("MCP import rollback: requires confirm=true", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-rollback-"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, HOME: root, USERPROFILE: root, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const res = await call(child, 1, "memory_import_rollback", { importId: "test-123", confirm: false });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /confirm=true/);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});

// ============================================================
// MCP import: markdown sourceType via stdio
// ============================================================

test("MCP import: markdown sourceType works via stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-md-mcp-"));
  const source = join(root, "notes");
  mkdirSync(join(source, "work"), { recursive: true });
  writeFileSync(join(source, "README.md"), "---\nimportance: 5\n---\n# Notes\nGeneric notes directory.");
  writeFileSync(join(source, "work", "task.md"), "---\nimportance: 7\n---\n# Task\nFinish the report.");
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, HOME: root, USERPROFILE: root, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const importRes = await call(child, 1, "memory_import", { sourceType: "markdown", source, embedding: "skip" });
    const result = JSON.parse(importRes.result.content[0].text);
    assert.equal(result.status, "completed");
    assert.equal(result.sourceType, "markdown");
    assert.ok(result.chunks > 0);
    const search = await call(child, 2, "memory_search", { query: "report" });
    assert.ok(JSON.parse(search.result.content[0].text).results.length > 0);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});
