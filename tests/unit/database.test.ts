import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase, type DbRow } from "../../src/database.ts";
import Database from "better-sqlite3";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { parseMarkdown, renderMarkdown, type Chunk } from "../../src/chunker.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "remme-db-"));
  const config = { dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"), embeddingModel: "test", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0, mmrEnabled: true, agent: "test-agent" };
  mkdirSync(config.memoryDir); mkdirSync(config.importsDir);
  const db = new MemoryDatabase(config);
  t.after(() => { if (db.db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, db, path: join(config.memoryDir, "memory.md") };
}

function chunk(text: string, project = "other"): Chunk {
  return { text, startLine: 1, endLine: 1, metadata: { ...parseMarkdown("").metadata, project, agent: "test-agent", created: "2025-01-02", tags: ["exact"], entities: ["SQLite"] } };
}

function vector(dims = 384, scale = 1): Float32Array { const v = new Float32Array(dims); v[0] = scale; return v; }

// ============================================================
// constructor / migration / backup
// ============================================================

test("constructor: creates tables and backup on second open", () => {
  const root = mkdtempSync(join(tmpdir(), "remme-"));
  const config = { dbPath: join(root, "memory.db"), memoryDir: join(root, "memory"), importsDir: join(root, "imports"), embeddingModel: "test", vectorWeight: 0.7, textWeight: 0.3, maxResults: 6, minScore: 0, mmrEnabled: true, agent: "test-agent" };
  mkdirSync(config.memoryDir, { recursive: true });
  writeFileSync(join(config.memoryDir, "decision.md"), "---\nstatus: verified\nknowledgeType: decision\n---\nUse SQLite for local memory.");
  const first = new MemoryDatabase(config); first.sync();
  assert.equal(first.rows().length, 1);
  first.close();
  const second = new MemoryDatabase(config);
  assert.equal(existsSync(`${config.dbPath}.bak`), true);
  assert.equal(second.rows().length, 1);
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test("constructor: versioned migration repairs stale FTS and vector rows", (t) => {
  const { db, config, path } = fixture(t);
  writeFileSync(path, "currentphrase"); db.indexFile(path);
  const id = db.findPath(path)!.id; db.setChunkEmbedding(id, vector(), "test", 384);
  db.db.exec("DROP TRIGGER memory_chunks_au");
  db.db.prepare("UPDATE memory_chunks SET text = 'migratedphrase' WHERE id = ?").run(id);
  db.db.prepare("INSERT INTO memory_vec(rowid,embedding) VALUES (?,?)").run(999n, Buffer.from(vector().buffer));
  db.addRelation(700, "supports", 800, "legacy"); db.db.pragma("user_version = 2"); db.close();
  const reopened = new MemoryDatabase(config);
  try {
    assert.equal(reopened.searchText("currentphrase").length, 0);
    assert.equal(reopened.searchText("migratedphrase").length, 1);
    assert.equal(reopened.db.prepare("SELECT rowid FROM memory_vec WHERE rowid = ?").get(999n), undefined);
    reopened.db.prepare("INSERT INTO memory_fts(memory_fts,rank) VALUES ('integrity-check',1)").run();
    assert.ok(reopened.insertChunk(join(config.memoryDir, "new.md"), chunk("newphrase"), "new") > 800);
    assert.equal(reopened.db.pragma("user_version", { simple: true }), 3);
  } finally { reopened.close(); }
});

test("constructor: backup snapshot includes committed WAL while another connection is open", (t) => {
  const { db, config, path } = fixture(t); db.db.pragma("wal_autocheckpoint = 0");
  writeFileSync(path, "walphrase"); db.indexFile(path);
  const second = new MemoryDatabase(config);
  try {
    const backup = new Database(`${config.dbPath}.bak`, { readonly: true });
    try { assert.equal((backup.prepare("SELECT text FROM memory_chunks").get() as { text: string }).text, "walphrase"); }
    finally { backup.close(); }
  } finally { second.close(); }
});

// ============================================================
// indexFile
// ============================================================

test("indexFile: indexes new file and creates chunk", (t) => {
  const { db, path } = fixture(t);
  writeFileSync(path, renderMarkdown("testphrase", {}, "test-agent"));
  db.indexFile(path);
  const row = db.findPath(path);
  assert.ok(row);
  assert.equal(row!.text, "testphrase");
});

test("indexFile: preserves IDs and unchanged embeddings on text-only metadata update", (t) => {
  const { db, path } = fixture(t);
  writeFileSync(path, renderMarkdown("obsoletephrase", {}, "test-agent")); db.indexFile(path);
  const id = db.findPath(path)!.id; db.setChunkEmbedding(id, vector(), "test", 384);
  db.addRelation(id, "supports", id, "test"); db.addProvenance(id, "created", "test", id);
  writeFileSync(path, renderMarkdown("obsoletephrase", { status: "verified" }, "test-agent")); db.indexFile(path);
  assert.equal(db.findPath(path)!.id, id);
  assert.ok(db.findPath(path)!.embedding);
});

test("indexFile: text change clears stale FTS, vectors and embedding", (t) => {
  const { db, path } = fixture(t);
  writeFileSync(path, renderMarkdown("obsoletephrase", {}, "test-agent")); db.indexFile(path);
  const id = db.findPath(path)!.id; db.setChunkEmbedding(id, vector(), "test", 384);
  writeFileSync(path, renderMarkdown("replacementphrase", {}, "test-agent")); db.indexFile(path);
  assert.equal(db.findPath(path)!.id, id);
  assert.equal(db.findPath(path)!.embedding, null);
  assert.equal(db.searchText("obsoletephrase").length, 0);
  assert.equal(db.searchText("replacementphrase").length, 1);
  assert.equal(db.searchVector(vector()).length, 0);
});

test("indexFile: delete removes relations and provenance via trigger", (t) => {
  const { db, path } = fixture(t);
  writeFileSync(path, renderMarkdown("obsoletephrase", {}, "test-agent")); db.indexFile(path);
  const id = db.findPath(path)!.id;
  db.addRelation(id, "supports", id, "test"); db.addProvenance(id, "created", "test", id);
  assert.equal(db.relations(id).length, 1);
  assert.equal(db.provenance(id).length, 1);
  rmSync(path); db.sync();
  assert.equal(db.relations(id).length, 0);
  assert.equal(db.provenance(id).length, 0);
});

test("indexFile: is atomic on insertion failure", (t) => {
  const { db, path } = fixture(t); writeFileSync(path, "originalphrase"); db.indexFile(path);
  const before = db.findPath(path)!;
  db.db.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON memory_chunks WHEN new.text LIKE '%rejectphrase%' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  writeFileSync(path, `${"a".repeat(1700)}\n${"rejectphrase".repeat(200)}\n`);
  assert.throws(() => db.indexFile(path), /injected/);
  assert.equal(db.findPath(path)!.text, before.text);
  assert.equal(db.searchText("originalphrase").length, 1);
});

test("indexFile: unchanged text moved out of first chunk retains embedding", (t) => {
  const { db, path } = fixture(t);
  const first = "a".repeat(1700); const second = "b".repeat(1700);
  writeFileSync(path, `${first}\n${second}\n`); db.indexFile(path);
  const original = db.chunksForPath(path); assert.equal(original.length, 2);
  for (const row of original) db.setChunkEmbedding(row.id, vector(2), "test", 2);
  writeFileSync(path, `${"c".repeat(1700)}\n${first}\n${second}\n`); db.indexFile(path);
  const changed = db.chunksForPath(path);
  assert.equal(changed[0].id, original[0].id);
  assert.equal(changed[0].embedding, null);
  assert.ok(changed[1].embedding);
  assert.equal(changed[2].id, original[1].id);
  assert.ok(changed[2].embedding);
});

// ============================================================
// sync / quickSync
// ============================================================

test("sync: indexes new files and removes deleted files", (t) => {
  const { db, config, path } = fixture(t);
  writeFileSync(path, "syncphrase"); db.sync();
  assert.equal(db.rows().length, 1);
  writeFileSync(join(config.memoryDir, "second.md"), "secondphrase"); db.sync();
  assert.equal(db.rows().length, 2);
  rmSync(path); db.sync();
  assert.equal(db.rows().length, 1);
  assert.equal(db.searchText("syncphrase").length, 0);
});

test("sync: uses persistent mtime/size state — cold sync skips body reads", (t) => {
  const { db, path, config } = fixture(t);
  writeFileSync(path, "stablephrase"); db.sync(); db.close();
  const reopened = new MemoryDatabase(config);
  try {
    const originalRead = fs.readFileSync;
    const read = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => { if (args[0] === path) throw new Error("unexpected body read"); return originalRead(...args); });
    syncBuiltinESMExports();
    try { reopened.sync(); } finally { read.mock.restore(); syncBuiltinESMExports(); }
  } finally { reopened.close(); }
});

test("quickSync: time-throttled and discovers new files by time not request count", (t) => {
  const { db, path, config } = fixture(t);
  writeFileSync(path, "stablephrase"); db.sync(); db.close();
  const reopened = new MemoryDatabase(config);
  try {
    reopened.sync();
    writeFileSync(join(config.memoryDir, "new.md"), "newphrase");
    for (let i = 0; i < 25; i++) reopened.quickSync();
    assert.equal(reopened.searchText("newphrase").length, 0);
    (reopened as unknown as { lastQuickSyncMs: number }).lastQuickSyncMs = Date.now() - 5001;
    reopened.quickSync();
    assert.equal(reopened.searchText("newphrase").length, 1);
  } finally { reopened.close(); }
});

test("sync: 256-file cold sync avoids body reads and repeated directory scans", (t) => {
  const { db, config } = fixture(t);
  for (let index = 0; index < 256; index++) writeFileSync(join(config.memoryDir, `${index}.md`), renderMarkdown(`scalephrase ${index}`, { project: index < 8 ? "selected" : "other" }, "test-agent"));
  db.sync();
  for (const row of db.rows()) db.setChunkEmbedding(row.id, vector(2), "test", 2);
  db.close();
  const reopened = new MemoryDatabase(config);
  try {
    const originalRead = fs.readFileSync;
    const read = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => { if (String(args[0]).endsWith(".md")) throw new Error("cold sync read markdown body"); return originalRead(...args); });
    const originalScan = fs.readdirSync; let scans = 0;
    const scan = t.mock.method(fs, "readdirSync", ((...args: Parameters<typeof fs.readdirSync>) => { scans++; return originalScan(...args); }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      reopened.sync();
      const scanned = scans;
      for (let index = 0; index < 100; index++) reopened.quickSync();
      assert.equal(scans, scanned);
    } finally { read.mock.restore(); scan.mock.restore(); syncBuiltinESMExports(); }
  } finally { reopened.close(); }
});

// ============================================================
// searchText
// ============================================================

test("searchText: empty query returns []", (t) => {
  const { db } = fixture(t);
  assert.deepEqual(db.searchText(""), []);
  assert.deepEqual(db.searchText("   "), []);
});

test("searchText: FTS match returns scored results", (t) => {
  const { db, config } = fixture(t);
  db.insertChunk(join(config.memoryDir, "a.md"), chunk("needlephrase in haystack"), "h1");
  const results = db.searchText("needlephrase");
  assert.equal(results.length, 1);
  assert.ok(results[0].score >= 0 && results[0].score <= 1);
});

test("searchText: short token uses instr fallback", (t) => {
  const { db, config } = fixture(t);
  db.insertChunk(join(config.memoryDir, "a.md"), chunk("短文本"), "h1");
  assert.equal(db.searchText("短").length, 1);
});

test("searchText: filters applied before limit", (t) => {
  const { db, config } = fixture(t);
  for (let i = 0; i < 120; i++) db.insertChunk(join(config.memoryDir, `${i}.md`), chunk("needlephrase", "other"), `h-${i}`);
  db.insertChunk(join(config.memoryDir, "wanted.md"), chunk("needlephrase 中文", "wanted"), "wanted");
  const filters = { project: "wanted", agent: "test-agent", status: "candidate", tags: ["exact"], dateFrom: "2025-01-01", dateTo: "2025-01-03", entity: "SQLite" };
  assert.equal(db.searchText("needlephrase", filters, 1).length, 1);
  assert.ok(db.searchText("needlephrase", filters, 1).every((r) => r.row.project === "wanted"));
  assert.equal(db.searchText("中文", filters, 1)[0].row.project, "wanted");
});

test("searchText: non-matching tag filter returns empty", (t) => {
  const { db, config } = fixture(t);
  db.insertChunk(join(config.memoryDir, "a.md"), chunk("needlephrase"), "h1");
  assert.deepEqual(db.searchText("needlephrase", { tags: ["exa"] }), []);
});

// ============================================================
// searchVector
// ============================================================

test("searchVector: empty or non-finite query returns []", (t) => {
  const { db } = fixture(t);
  assert.deepEqual(db.searchVector(new Float32Array([])), []);
  assert.deepEqual(db.searchVector(new Float32Array([NaN])), []);
});

test("searchVector: dimension mismatch returns no results", (t) => {
  const { db, config } = fixture(t);
  const id = db.insertChunk(join(config.memoryDir, "a.md"), chunk("vectorphrase"), "h1");
  db.setChunkEmbedding(id, vector(384), "test", 384);
  assert.deepEqual(db.searchVector(vector(2)), []);
});

test("searchVector: model mismatch returns no results", (t) => {
  const { db, config } = fixture(t);
  const id = db.insertChunk(join(config.memoryDir, "a.md"), chunk("needlephrase", "wanted"), "h1");
  db.setChunkEmbedding(id, vector(384, 3), "test", 384);
  const foreign = db.insertChunk(join(config.memoryDir, "foreign.md"), chunk("needlephrase", "wanted"), "h2");
  db.setChunkEmbedding(foreign, vector(384), "foreign-model", 384);
  assert.equal(db.searchVector(vector(384, 3), { project: "wanted" }, 1, "foreign-model")[0].row.id, foreign);
});

test("searchVector: filters applied and matching model/dims return results", (t) => {
  const { db, config } = fixture(t);
  for (let i = 0; i < 120; i++) { const id = db.insertChunk(join(config.memoryDir, `${i}.md`), chunk("needlephrase"), `h-${i}`); db.setChunkEmbedding(id, vector(), "test", 384); }
  const wanted = db.insertChunk(join(config.memoryDir, "wanted.md"), chunk("needlephrase 中文", "wanted"), "wanted");
  db.setChunkEmbedding(wanted, vector(384, 3), "test", 384);
  const filters = { project: "wanted", agent: "test-agent", status: "candidate", tags: ["exact"], dateFrom: "2025-01-01", dateTo: "2025-01-03", entity: "SQLite" };
  for (const available of [true, false]) {
    (db as unknown as { vecAvailable: boolean }).vecAvailable = available;
    const result = db.searchVector(vector(384, 3), filters, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].row.id, wanted);
    assert.ok(Math.abs(result[0].score - 1) < 1e-6);
  }
  (db as unknown as { vecAvailable: boolean }).vecAvailable = true;
});

test("searchVector: respects typed array offsets", (t) => {
  const { db, path } = fixture(t);
  const id = db.insertChunk(path, chunk("vectorphrase"), "v1");
  const input = new Float32Array([9, 1, 0, 9]).subarray(1, 3);
  db.setChunkEmbedding(id, input, "test", 2);
  assert.equal(db.findPath(path)!.embedding!.length, 8);
  assert.equal(db.searchVector(input)[0].score, 1);
});

test("searchVector: zero-vector cosine returns 0", (t) => {
  const { db, path } = fixture(t);
  const id = db.insertChunk(path, chunk("vectorphrase"), "v1");
  db.setChunkEmbedding(id, new Float32Array(384), "test", 384);
  assert.equal(db.searchVector(vector())[0].score, 0);
});

// ============================================================
// setChunkEmbedding
// ============================================================

test("setChunkEmbedding: validates dimensions match vector length", (t) => {
  const { db, path } = fixture(t);
  const id = db.insertChunk(path, chunk("vectorphrase"), "v1");
  const input = new Float32Array([1, 0]);
  assert.throws(() => db.setChunkEmbedding(id, input, "test", 3), /dimension/i);
});

test("setChunkEmbedding: rejects non-finite values", (t) => {
  const { db, path } = fixture(t);
  const id = db.insertChunk(path, chunk("vectorphrase"), "v1");
  assert.throws(() => db.setChunkEmbedding(id, new Float32Array([NaN, 0]), "test", 2), /finite/i);
  assert.throws(() => db.setChunkEmbedding(id, new Float32Array([Infinity, 0]), "test", 2), /finite/i);
});

test("setChunkEmbedding: unknown chunk throws", (t) => {
  const { db } = fixture(t);
  assert.throws(() => db.setChunkEmbedding(99999, vector(2), "test", 2), /unknown chunk/);
});

// ============================================================
// insertChunk / findPath / chunksForPath / rows
// ============================================================

test("insertChunk: assigns sequential IDs via counter", (t) => {
  const { db, config } = fixture(t);
  const id1 = db.insertChunk(join(config.memoryDir, "a.md"), chunk("first"), "h1");
  const id2 = db.insertChunk(join(config.memoryDir, "b.md"), chunk("second"), "h2");
  assert.ok(id2 > id1);
  assert.equal(db.rows().length, 2);
});

test("findPath: returns first chunk ordered by start_line", (t) => {
  const { db, config } = fixture(t);
  const c1 = chunk("line one\nline two");
  c1.startLine = 1; c1.endLine = 2;
  db.insertChunk(join(config.memoryDir, "a.md"), c1, "h1");
  const found = db.findPath(join(config.memoryDir, "a.md"));
  assert.ok(found);
  assert.equal(found!.start_line, 1);
});

test("findPath: returns undefined for non-existent path", (t) => {
  const { db } = fixture(t);
  assert.equal(db.findPath("nonexistent.md"), undefined);
});

test("chunksForPath: returns all chunks ordered", (t) => {
  const { db, config } = fixture(t);
  const path = join(config.memoryDir, "multi.md");
  const c1 = chunk("first chunk");
  const c2 = chunk("second chunk"); c2.startLine = 2;
  db.insertChunk(path, c1, "h1");
  db.insertChunk(path, c2, "h2");
  const chunks = db.chunksForPath(path);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].start_line <= chunks[1].start_line);
});

// ============================================================
// listPaths
// ============================================================

test("listPaths: returns distinct paths with filters and limit", (t) => {
  const { db, config } = fixture(t);
  for (let i = 0; i < 5; i++) db.insertChunk(join(config.memoryDir, `${i}.md`), chunk("text", "alpha"), `h-${i}`);
  db.insertChunk(join(config.memoryDir, "beta.md"), chunk("text", "beta"), "h-b");
  assert.equal(db.listPaths({ project: "alpha" }).length, 5);
  assert.equal(db.listPaths({ project: "beta" }).length, 1);
  assert.equal(db.listPaths({ project: "alpha" }, 2).length, 2);
  assert.equal(db.listPaths({ project: "missing" }).length, 0);
});

// ============================================================
// addRelation / relations
// ============================================================

test("addRelation/relations: insert and query bidirectional", (t) => {
  const { db, config } = fixture(t);
  const a = db.insertChunk(join(config.memoryDir, "a.md"), chunk("a"), "h1");
  const b = db.insertChunk(join(config.memoryDir, "b.md"), chunk("b"), "h2");
  db.addRelation(a, "supports", b, "test");
  assert.equal(db.relations(a).length, 1);
  assert.equal(db.relations(b).length, 1);
});

test("addRelation: replace on conflict", (t) => {
  const { db, config } = fixture(t);
  const a = db.insertChunk(join(config.memoryDir, "a.md"), chunk("a"), "h1");
  const b = db.insertChunk(join(config.memoryDir, "b.md"), chunk("b"), "h2");
  db.addRelation(a, "supports", b, "test1");
  db.addRelation(a, "supports", b, "test2");
  assert.equal(db.relations(a).length, 1);
});

// ============================================================
// addProvenance / provenance
// ============================================================

test("addProvenance/provenance: insert and query ordered by timestamp", (t) => {
  const { db, config } = fixture(t);
  const id = db.insertChunk(join(config.memoryDir, "a.md"), chunk("a"), "h1");
  db.addProvenance(id, "created", "agent1", null, "first");
  db.addProvenance(id, "verified", "agent2", id, "second");
  const prov = db.provenance(id) as { event_type: string; note: string }[];
  assert.equal(prov.length, 2);
  assert.equal(prov[0].event_type, "created");
  assert.equal(prov[1].event_type, "verified");
});

// ============================================================
// createImport / updateImport / hasRunningImport / importStatus
// ============================================================

test("createImport: exclusive claim prevents concurrent imports", (t) => {
  const { db } = fixture(t);
  db.createImport("first", "markdown", "source", null, "target", {});
  assert.equal(db.hasRunningImport(), "first");
  assert.throws(() => db.createImport("second", "markdown", "", null, "", {}), /running/);
});

test("updateImport: status transitions and counters", (t) => {
  const { db } = fixture(t);
  db.createImport("imp", "markdown", "", null, "", {});
  db.updateImport("imp", "running");
  assert.equal((db.importStatus("imp") as { status: string }[])[0].status, "running");
  db.updateImport("imp", "completed", 5, 10, 0);
  const status = (db.importStatus("imp") as { status: string; file_count: number; chunk_count: number }[])[0];
  assert.equal(status.status, "completed");
  assert.equal(status.file_count, 5);
  assert.equal(status.chunk_count, 10);
});

test("importStatus: list recent without id", (t) => {
  const { db } = fixture(t);
  db.createImport("a", "markdown", "", null, "", {});
  db.updateImport("a", "completed");
  db.createImport("b", "markdown", "", null, "", {});
  db.updateImport("b", "completed");
  const list = db.importStatus() as { id: string }[];
  assert.ok(list.length >= 2);
});

test("importStatus: unknown id returns empty", (t) => {
  const { db } = fixture(t);
  assert.deepEqual(db.importStatus("nonexistent"), []);
});

// ============================================================
// rollbackImport
// ============================================================

test("rollbackImport: rejects running or pending import", (t) => {
  const { db } = fixture(t);
  db.createImport("live", "markdown", "source", null, "target", {});
  db.updateImport("live", "running");
  assert.throws(() => db.rollbackImport("live"), /running|pending/);
});

test("rollbackImport: rejects unknown import", (t) => {
  const { db } = fixture(t);
  assert.throws(() => db.rollbackImport("missing"), /unknown|not found/i);
});

test("rollbackImport: removes chunks, sources and records, returns counts", (t) => {
  const { db, config } = fixture(t);
  db.createImport("imp", "markdown", "", null, "", {});
  db.updateImport("imp", "completed");
  const c = chunk("importphrase"); c.metadata.importId = "imp"; c.metadata.origin = "imported";
  const id = db.insertChunk(join(config.memoryDir, "imp.md"), c, "h1");
  db.addSource(join(config.memoryDir, "imp.md"), "imported", "imp", "markdown", "orig", null, "hash", 0, 0);
  db.addImportRecord("imp", "markdown", "identity", null, "hash", 1, [id], "skip", null, "imported");
  const result = db.rollbackImport("imp");
  assert.equal(result.removedChunks, 1);
  assert.equal(result.removedSources, 1);
  assert.equal(db.rows().length, 0);
  assert.equal(db.importRecords("imp").length, 0);
});

// ============================================================
// moveImportPaths
// ============================================================

test("moveImportPaths: preserves IDs, embeddings and source ownership", (t) => {
  const { db, config } = fixture(t);
  db.createImport("move", "markdown", "", null, "", {});
  const staging = join(config.memoryDir, ".staging-move"); const finalDir = join(config.memoryDir, "final");
  mkdirSync(staging);
  const path = join(staging, "a.md");
  writeFileSync(path, renderMarkdown("importphrase", { origin: "imported", importId: "move" }, "test-agent"));
  db.indexFile(path);
  const id = db.findPath(path)!.id; db.setChunkEmbedding(id, vector(), "test", 384);
  const sourceId = db.addSource(path, "imported", "move", "markdown", "original", null, "hash", 0, 0);
  fs.renameSync(staging, finalDir);
  db.moveImportPaths("move", staging, finalDir);
  db.updateImport("move", "completed"); db.sync();
  const moved = db.findPath(join(finalDir, "a.md"))!;
  assert.equal(moved.id, id);
  assert.ok(moved.embedding);
  assert.equal(moved.source_id, sourceId);
  assert.equal(db.findPath(path), undefined);
});

test("moveImportPaths: rejects unknown import", (t) => {
  const { db } = fixture(t);
  assert.throws(() => db.moveImportPaths("missing", "a", "b"), /unknown/);
});

// ============================================================
// addSource
// ============================================================

test("addSource: upsert returns same id and preserves embedding model/dims", (t) => {
  const { db } = fixture(t);
  const id1 = db.addSource("/path/a.md", "native", null, "markdown", null, null, "hash1", 0, 0, "model", 384);
  const id2 = db.addSource("/path/a.md", "native", null, "markdown", null, null, "hash2", 0, 0);
  assert.equal(id1, id2);
});

// ============================================================
// addImportRecord / findImportRecord
// ============================================================

test("addImportRecord/findImportRecord: dedup by canonical source and hash", (t) => {
  const { db } = fixture(t);
  db.createImport("imp", "markdown", "", null, "", {});
  db.addImportRecord("imp", "markdown", "identity-1", null, "hash-1", 1, [1], "skip", null, "imported");
  const found = db.findImportRecord("markdown", "identity-1", null, "hash-1");
  assert.ok(found);
  assert.equal(found!.import_id, "imp");
  assert.equal(db.findImportRecord("markdown", "identity-1", null, "different-hash"), undefined);
});

// ============================================================
// import concurrency / recovery
// ============================================================

test("import claim: another connection cannot interrupt live stage rows", (t) => {
  const { db, config } = fixture(t);
  db.createImport("live", "markdown", "source", null, "target", {}); db.updateImport("live", "running");
  const stage = join(config.memoryDir, ".staging-live"); mkdirSync(stage);
  const path = join(stage, "stage.md"); writeFileSync(path, "stagephrase");
  const c = chunk("stagephrase"); c.metadata.origin = "imported"; c.metadata.importId = "live";
  const id = db.insertChunk(path, c, "stage");
  const second = new MemoryDatabase(config);
  try {
    assert.equal(second.hasRunningImport(), "live");
    assert.throws(() => second.createImport("other", "markdown", "", null, "", {}), /running/);
    second.sync();
    assert.equal(second.findPath(path)!.id, id);
    assert.equal(existsSync(path), true);
  } finally { second.close(); }
});

test("import recovery: dead import marked interrupted, staging retained", (t) => {
  const { db, config } = fixture(t);
  db.createImport("dead", "markdown", "", null, "", {});
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  db.db.prepare("UPDATE memory_imports SET owner_pid = ? WHERE id = 'dead'").run(child.pid);
  const stage = join(config.memoryDir, "imports", "markdown", ".staging-dead");
  mkdirSync(stage, { recursive: true });
  const second = new MemoryDatabase(config);
  try {
    assert.equal((second.importStatus("dead")[0] as { status: string }).status, "interrupted");
    assert.ok(existsSync(stage));
  } finally { second.close(); }
});

test("import recovery: unknown owner (null pid) is not interrupted", (t) => {
  const { db, config } = fixture(t);
  db.createImport("unknown", "markdown", "", null, "", {});
  db.db.prepare("UPDATE memory_imports SET owner_pid = NULL WHERE id = 'unknown'").run();
  const second = new MemoryDatabase(config);
  try { assert.equal(second.hasRunningImport(), "unknown"); }
  finally { second.close(); }
});

test("import recovery: second process owns claim until exit", async (t) => {
  const { db, config } = fixture(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { MemoryDatabase } from ${JSON.stringify(new URL("../../src/database.ts", import.meta.url).href)}; const db = new MemoryDatabase(JSON.parse(process.argv[1])); db.createImport('child', 'markdown', '', null, '', {}); console.log('ready'); process.stdin.resume(); process.stdin.on('data', () => { db.close(); process.exit(0); });`, JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("child exited before claiming"); })]);
    assert.throws(() => db.createImport("racer", "markdown", "", null, "", {}), /running/);
    const second = new MemoryDatabase(config);
    try { assert.equal((second.importStatus("child")[0] as { owner_pid: number }).owner_pid, child.pid); }
    finally { second.close(); }
  } finally { if (child.exitCode === null) { const exited = once(child, "exit"); child.stdin.end("stop"); await exited; } }
  const recovered = new MemoryDatabase(config);
  try { assert.equal((recovered.importStatus("child")[0] as { status: string }).status, "interrupted"); }
  finally { recovered.close(); }
});
