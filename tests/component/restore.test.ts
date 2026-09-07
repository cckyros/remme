import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================
// memory_restore: confirmation and offline safety
// ============================================================

test("memory_restore: requires confirm=true", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-restore-"));
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  process.env.REMME_CONFIG = join(root, "config.json");
  process.env.REMME_DISABLE_EMBEDDING = "1";
  const tools = await import("../../src/tools.ts");
  try {
    await tools.memoryWrite({ content: "original" });
    copyFileSync(join(root, "memory.db"), join(root, "memory.db.bak"));
    await assert.rejects(() => tools.memoryRestore({ confirm: false }), /confirm=true/);
  } finally { tools.closeMemoryStore(); delete process.env.REMME_CONFIG; delete process.env.REMME_DISABLE_EMBEDDING; rmSync(root, { recursive: true, force: true }); }
});

test("memory_restore: refuses unsafe online replacement and guides offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-restore-"));
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  process.env.REMME_CONFIG = join(root, "config.json");
  process.env.REMME_DISABLE_EMBEDDING = "1";
  const tools = await import("../../src/tools.ts");
  try {
    const first = await tools.memoryWrite({ content: "original" }) as { path: string };
    copyFileSync(join(root, "memory.db"), join(root, "memory.db.bak"));
    await tools.memoryWrite({ content: "later" });
    await assert.rejects(() => tools.memoryRestore({ confirm: true }), /in-process restore is disabled|offline/);
    assert.equal(existsSync(join(root, "memory.db.bak")), true);
    assert.match(first.path, /\.md$/);
  } finally { tools.closeMemoryStore(); delete process.env.REMME_CONFIG; delete process.env.REMME_DISABLE_EMBEDDING; rmSync(root, { recursive: true, force: true }); }
});

test("memory_restore: rejects when no backup exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "remme-restore-"));
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports") }));
  process.env.REMME_CONFIG = join(root, "config.json");
  process.env.REMME_DISABLE_EMBEDDING = "1";
  const tools = await import("../../src/tools.ts");
  try {
    await tools.memoryWrite({ content: "data" });
    if (existsSync(join(root, "memory.db.bak"))) rmSync(join(root, "memory.db.bak"));
    await assert.rejects(() => tools.memoryRestore({ confirm: true }), /no SQLite backup/);
  } finally { tools.closeMemoryStore(); delete process.env.REMME_CONFIG; delete process.env.REMME_DISABLE_EMBEDDING; rmSync(root, { recursive: true, force: true }); }
});
