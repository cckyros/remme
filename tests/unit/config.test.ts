import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureConfigDirs } from "../../src/config.ts";

const previousConfig = process.env.REMME_CONFIG;
const previousAgent = process.env.REMME_AGENT;
const roots: string[] = [];

after(() => {
  if (previousConfig === undefined) delete process.env.REMME_CONFIG; else process.env.REMME_CONFIG = previousConfig;
  if (previousAgent === undefined) delete process.env.REMME_AGENT; else process.env.REMME_AGENT = previousAgent;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "remme-config-"));
  roots.push(root);
  return root;
}

// ============================================================
// loadConfig
// ============================================================

test("loadConfig: returns defaults when no config file exists", () => {
  delete process.env.REMME_CONFIG;
  const root = tempRoot();
  const config = loadConfig(root);
  assert.equal(config.embeddingModel, "Xenova/all-MiniLM-L6-v2");
  assert.equal(config.vectorWeight, 0.7);
  assert.equal(config.textWeight, 0.3);
  assert.equal(config.maxResults, 6);
  assert.equal(config.minScore, 0);
  assert.equal(config.mmrEnabled, true);
  assert.ok(config.dbPath.endsWith("memory.db"));
  assert.ok(config.memoryDir.endsWith("memory"));
  assert.ok(config.importsDir.endsWith("imports"));
});

test("loadConfig: file override merges with defaults", () => {
  delete process.env.REMME_CONFIG;
  const root = tempRoot();
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ embeddingModel: "custom-model", maxResults: 10, vectorWeight: 0.5 }));
  process.env.REMME_CONFIG = configPath;
  const config = loadConfig(root);
  assert.equal(config.embeddingModel, "custom-model");
  assert.equal(config.maxResults, 10);
  assert.equal(config.vectorWeight, 0.5);
  assert.equal(config.textWeight, 0.3);
});

test("loadConfig: REMME_AGENT overrides agent", () => {
  delete process.env.REMME_CONFIG;
  process.env.REMME_AGENT = "test-override";
  const config = loadConfig(tempRoot());
  assert.equal(config.agent, "test-override");
  delete process.env.REMME_AGENT;
});

test("loadConfig: invalid JSON falls back to defaults", () => {
  const root = tempRoot();
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{ invalid json }");
  process.env.REMME_CONFIG = configPath;
  const config = loadConfig(root);
  assert.equal(config.embeddingModel, "Xenova/all-MiniLM-L6-v2");
});

test("loadConfig: paths are resolved to absolute", () => {
  delete process.env.REMME_CONFIG;
  const root = tempRoot();
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ dbPath: "relative/db.db", memoryDir: "relative/mem", importsDir: "relative/imp" }));
  process.env.REMME_CONFIG = configPath;
  const config = loadConfig(root);
  assert.ok(config.dbPath.includes("relative"));
  assert.ok(config.memoryDir.includes("relative"));
  assert.ok(config.importsDir.includes("relative"));
});

// ============================================================
// ensureConfigDirs
// ============================================================

test("ensureConfigDirs: creates memory, imports and db parent directories", () => {
  delete process.env.REMME_CONFIG;
  const root = tempRoot();
  const config = loadConfig(root);
  ensureConfigDirs(config);
  assert.ok(existsSync(config.memoryDir));
  assert.ok(existsSync(config.importsDir));
  assert.ok(existsSync(join(config.dbPath, "..")));
});

test("ensureConfigDirs: is idempotent when directories already exist", () => {
  delete process.env.REMME_CONFIG;
  const root = tempRoot();
  const config = loadConfig(root);
  ensureConfigDirs(config);
  ensureConfigDirs(config);
  assert.ok(existsSync(config.memoryDir));
});
