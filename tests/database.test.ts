import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "../src/database.ts";

test("database indexes markdown and preserves relations and provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "remme-"));
  const config = { dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"), embeddingModel: "test", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0, mmrEnabled: true, agent: "test-agent" };
  const path = join(config.memoryDir, "decision.md");
  mkdirSync(config.memoryDir, { recursive: true });
  writeFileSync(path, "---\nstatus: verified\nknowledgeType: decision\n---\nUse SQLite for local memory.");
  const first = new MemoryDatabase(config); first.sync(); const row = first.rows()[0]; assert.equal(row.status, "verified"); first.addProvenance(row.id, "verified", "test-agent", row.id); first.close();
  const second = new MemoryDatabase(config); assert.equal(existsSync(`${config.dbPath}.bak`), true); assert.equal((second.db.prepare("SELECT count(*) AS count FROM memory_provenance").get() as { count: number }).count, 1); second.close(); rmSync(root, { recursive: true, force: true });
});
