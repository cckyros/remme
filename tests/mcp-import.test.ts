import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function call(child: any, id: number, name: string, args: Record<string, unknown>): Promise<any> {
  const response = new Promise<any>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string) => { buffer += chunk; const line = buffer.split(/\r?\n/)[0]; if (!line) return; child.stdout.off("data", onData); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", onData);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return response;
}

test("MCP import tools: dry-run, import, status, search, rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-import-"));
  const source = join(root, "openclaw-source");
  mkdirSync(join(source, "memory", "technical"), { recursive: true });
  writeFileSync(join(source, "MEMORY.md"), "---\nimportance: 7\n---\n# OpenClaw Memory\nCore memory from OpenClaw.");
  writeFileSync(join(source, "memory/technical/sqlite.md"), "---\nimportance: 6\ntags: [\"sqlite\"]\n---\n# SQLite Setup\nUsing sqlite-vec for vector search.");
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const dryRun = await call(child, 1, "memory_import", { source, dryRun: true, embedding: "skip" });
    const dryResult = JSON.parse(dryRun.result.content[0].text);
    assert.equal(dryResult.status, "dry-run");
    assert.ok(dryResult.chunks > 0);

    const importRes = await call(child, 2, "memory_import", { source, embedding: "skip" });
    const importResult = JSON.parse(importRes.result.content[0].text);
    assert.equal(importResult.status, "completed");
    assert.ok(importResult.importId);

    const status = await call(child, 3, "memory_import_status", {});
    const statusResult = JSON.parse(status.result.content[0].text);
    assert.ok(statusResult.imports.length > 0);
    assert.equal(statusResult.imports[0].status, "completed");

    const search = await call(child, 4, "memory_search", { query: "SQLite" });
    const searchResult = JSON.parse(search.result.content[0].text);
    assert.ok(searchResult.results.length > 0);

    const rollback = await call(child, 5, "memory_import_rollback", { importId: importResult.importId, confirm: true });
    const rollbackResult = JSON.parse(rollback.result.content[0].text);
    assert.equal(rollbackResult.status, "rolled-back");
    assert.ok(rollbackResult.removedChunks > 0);

    const searchAfter = await call(child, 6, "memory_search", { query: "SQLite" });
    const searchAfterResult = JSON.parse(searchAfter.result.content[0].text);
    assert.equal(searchAfterResult.results.length, 0);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});

test("MCP import rollback requires confirm", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-rollback-confirm-"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const res = await call(child, 1, "memory_import_rollback", { importId: "test-123", confirm: false });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /confirm=true/);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});
