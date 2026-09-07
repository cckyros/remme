import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImportId, hashContent, manifestPath, readManifest, writeManifest, type ImportManifest } from "../../src/importer/manifest.ts";

const roots: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "remme-manifest-")); roots.push(d); return d; }
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// ============================================================
// generateImportId
// ============================================================

test("generateImportId: includes sourceType prefix", () => {
  assert.ok(generateImportId("openclaw").startsWith("openclaw-"));
  assert.ok(generateImportId("markdown").startsWith("markdown-"));
});

test("generateImportId: produces unique values on each call", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(generateImportId("test"));
  assert.equal(ids.size, 100);
});

// ============================================================
// hashContent
// ============================================================

test("hashContent: deterministic for same content", () => {
  assert.equal(hashContent("hello"), hashContent("hello"));
});

test("hashContent: different for different content", () => {
  assert.notEqual(hashContent("hello"), hashContent("world"));
});

test("hashContent: returns 16-character hex string", () => {
  const hash = hashContent("test");
  assert.equal(hash.length, 16);
  assert.match(hash, /^[a-f0-9]+$/);
});

// ============================================================
// manifestPath
// ============================================================

test("manifestPath: joins directory with manifest.json", () => {
  assert.equal(manifestPath("/foo/bar"), join("/foo/bar", "manifest.json"));
  assert.equal(manifestPath("relative"), join("relative", "manifest.json"));
});

// ============================================================
// writeManifest / readManifest
// ============================================================

test("writeManifest/readManifest: round trip preserves all fields", () => {
  const dir = tempDir();
  const manifest: ImportManifest = {
    id: "test-123", sourceType: "openclaw", sourcePath: "/source", sourceDbPath: null,
    targetPath: "/target", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z",
    status: "completed", fileCount: 5, chunkCount: 10, errorCount: 0,
    options: { embedding: "skip" }, files: [{ originalPath: "a.md", category: "curated", targetPath: "/t/a.md", hash: "abc123", chunks: 2 }],
  };
  writeManifest(dir, manifest);
  assert.ok(existsSync(manifestPath(dir)));
  const read = readManifest(dir);
  assert.deepEqual(read, manifest);
});

test("readManifest: returns null when manifest does not exist", () => {
  assert.equal(readManifest(tempDir()), null);
});

test("readManifest: returns null for invalid JSON", () => {
  const dir = tempDir();
  writeFileSync(manifestPath(dir), "{ invalid json }");
  assert.equal(readManifest(dir), null);
});
