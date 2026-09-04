import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

test("MCP memory CRUD and knowledge lifecycle use an isolated store", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-mcp-"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory") }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { env: { ...process.env, REMME_CONFIG: join(root, "config.json"), REMME_DISABLE_EMBEDDING: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const created = await call(child, 1, "memory_write", { content: "SQLite decision 决策库", knowledgeType: "decision", status: "candidate", tags: ["sqlite"] });
    const path = JSON.parse(created.result.content[0].text).path;
    const promoted = await call(child, 2, "memory_promote", { path, status: "verified" });
    assert.equal(JSON.parse(promoted.result.content[0].text).status, "verified");
    const read = await call(child, 3, "memory_read", { path });
    assert.match(JSON.parse(read.result.content[0].text).content, /SQLite decision/);
    const searched = await call(child, 4, "memory_search", { query: "SQLite" });
    const searchResult = JSON.parse(searched.result.content[0].text);
    assert.equal(searchResult.mode, "fts-only");
    assert.equal(searchResult.results.length, 1);
    const cjk = await call(child, 5, "memory_search", { query: "库" });
    assert.equal(JSON.parse(cjk.result.content[0].text).results.length, 1);
  } finally { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); }
});
