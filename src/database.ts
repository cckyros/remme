import Database from "better-sqlite3";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cosine } from "./embedding.ts";
import type { Config } from "./config.ts";
import { chunkMarkdown, parseMarkdown, type Chunk } from "./chunker.ts";
import * as sqliteVec from "sqlite-vec";

export interface DbRow { id: number; path: string; text: string; embedding: Buffer | null; start_line: number; end_line: number; importance: number; tags: string; status: string; knowledge_type: string | null; project: string | null; agent: string; created: string; origin: string; import_id: string | null; source_id: number | null; category: string | null; original_path: string | null; original_record_id: string | null; embedding_dims: number | null; embedding_model: string | null; }

const SCHEMA_VERSION = 2;

export class MemoryDatabase {
  readonly db: Database.Database;
  private readonly config: Config;
  private readonly fileState = new Map<string, { mtimeMs: number; size: number }>();
  private vecAvailable = false;
  private syncDirty = true;
  private quickSyncCount = 0;
  private static readonly QUICK_SYNC_THRESHOLD = 20;
  constructor(config: Config) {
    this.config = config;
    if (existsSync(config.dbPath) && process.env.REMME_SKIP_BACKUP !== "1") copyFileSync(config.dbPath, `${config.dbPath}.bak`);
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    try { sqliteVec.load(this.db); this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[384])"); this.vecAvailable = true; } catch { /* ponytail: JS cosine fallback keeps unsupported SQLite builds usable; upgrade when a compatible sqlite-vec binary is available. */ }
    this.migrate();
    this.createTables();
    this.recoverInterruptedImports();
  }
  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    const tableExists = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks'").get() as { name: string } | undefined) !== undefined;
    if (tableExists) {
      const cols = (this.db.prepare("PRAGMA table_info(memory_chunks)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("origin")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'");
      if (!cols.includes("import_id")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN import_id TEXT");
      if (!cols.includes("source_id")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN source_id INTEGER");
      if (!cols.includes("category")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN category TEXT");
      if (!cols.includes("original_path")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN original_path TEXT");
      if (!cols.includes("original_record_id")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN original_record_id TEXT");
      if (!cols.includes("embedding_dims")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN embedding_dims INTEGER");
      if (!cols.includes("embedding_model")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN embedding_model TEXT");
    }
    if (current < SCHEMA_VERSION) this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  private createTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, importance REAL NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, knowledge_type TEXT, project TEXT, agent TEXT NOT NULL, created TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL DEFAULT 'native', import_id TEXT, source_id INTEGER, category TEXT, original_path TEXT, original_record_id TEXT, embedding_dims INTEGER, embedding_model TEXT)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_chunks(path)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_filters ON memory_chunks(project, status, knowledge_type, agent)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_import ON memory_chunks(import_id)");
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory_chunks', content_rowid='id', tokenize='trigram')");
    this.db.exec("CREATE TABLE IF NOT EXISTS memory_relations (source_id INTEGER NOT NULL, relation_type TEXT NOT NULL, target_id INTEGER NOT NULL, agent TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, relation_type, target_id))");
    this.db.exec("CREATE TABLE IF NOT EXISTS memory_provenance (id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL, event_type TEXT NOT NULL, agent TEXT NOT NULL, timestamp TEXT NOT NULL, source_id INTEGER, note TEXT)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_imports (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_path TEXT, source_db_path TEXT, target_path TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, options_json TEXT NOT NULL DEFAULT '{}', manifest_hash TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_sources (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, origin TEXT NOT NULL DEFAULT 'native', import_id TEXT, source_type TEXT NOT NULL DEFAULT 'markdown', original_path TEXT, original_record_id TEXT, hash TEXT NOT NULL, mtime REAL NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, embedding_model TEXT, embedding_dims INTEGER, FOREIGN KEY(import_id) REFERENCES memory_imports(id) ON DELETE CASCADE)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_import_records (id INTEGER PRIMARY KEY, import_id TEXT NOT NULL, source_kind TEXT NOT NULL, original_path TEXT NOT NULL, original_record_id TEXT, source_hash TEXT NOT NULL, target_source_id INTEGER, target_chunk_ids TEXT NOT NULL DEFAULT '[]', embedding_mode TEXT NOT NULL DEFAULT 'skip', embedding_dims INTEGER, status TEXT NOT NULL, FOREIGN KEY(import_id) REFERENCES memory_imports(id) ON DELETE CASCADE)`);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_import_dedup ON memory_import_records(source_kind, original_path, COALESCE(original_record_id, ''), source_hash)");
  }
  private recoverInterruptedImports(): void {
    this.db.prepare("UPDATE memory_imports SET status = 'interrupted' WHERE status IN ('pending','running')").run();
    const interrupted = this.db.prepare("SELECT id, source_type FROM memory_imports WHERE status = 'interrupted'").all() as { id: string; source_type: string }[];
    for (const imp of interrupted) {
      const stagingDir = join(this.config.memoryDir, "imports", imp.source_type, `.staging-${imp.id}`);
      if (existsSync(stagingDir)) { try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
  close(): void { this.db.close(); }
  private scanMarkdownRecursive(dir: string): string[] {
    const result: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".staging-") || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...this.scanMarkdownRecursive(full));
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full);
    }
    return result;
  }
  sync(): void {
    const files = new Set(this.scanMarkdownRecursive(this.config.memoryDir).map((p) => relative(this.config.memoryDir, p)));
    const existing = this.db.prepare("SELECT DISTINCT path, origin FROM memory_chunks").all() as { path: string; origin: string }[];
    const removeChunk = this.db.prepare("DELETE FROM memory_chunks WHERE path = ?");
    const removeFts = this.db.prepare("DELETE FROM memory_fts WHERE rowid IN (SELECT id FROM memory_chunks WHERE path = ?)");
    for (const row of existing) {
      const rel = relative(this.config.memoryDir, row.path);
      if (row.origin === "native" && !files.has(rel)) { removeFts.run(row.path); removeChunk.run(row.path); this.fileState.delete(row.path); }
      else if (row.origin === "imported" && !existsSync(row.path)) { removeFts.run(row.path); removeChunk.run(row.path); this.fileState.delete(row.path); }
    }
    this.syncDirty = false;
    for (const file of files) {
      const path = join(this.config.memoryDir, file);
      const stat = statSync(path);
      const previous = this.fileState.get(path);
      if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
      const source = readFileSync(path, "utf8");
      const parsed = parseMarkdown(source, this.config.agent);
      const isImported = parsed.metadata.origin === "imported";
      const hashBase = isImported && parsed.metadata.importId ? `${path}:${BunHash(source)}:${parsed.metadata.importId}` : `${path}:${BunHash(source)}`;
      const old = this.db.prepare("SELECT hash FROM memory_chunks WHERE path = ? LIMIT 1").get(path) as { hash?: string } | undefined;
      if (old?.hash?.startsWith(`${hashBase}:`)) { this.fileState.set(path, { mtimeMs: stat.mtimeMs, size: stat.size }); continue; }
      this.db.prepare("DELETE FROM memory_chunks WHERE path = ?").run(path);
      for (const chunk of chunkMarkdown(parsed.body, parsed.metadata)) this.insertChunk(path, chunk, `${hashBase}:${chunk.startLine}`);
      this.fileState.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  quickSync(): void {
    if (this.syncDirty || ++this.quickSyncCount >= MemoryDatabase.QUICK_SYNC_THRESHOLD) { this.quickSyncCount = 0; this.sync(); return; }
    for (const [path, prev] of this.fileState) {
      try { const stat = statSync(path); if (stat.mtimeMs !== prev.mtimeMs || stat.size !== prev.size) { this.quickSyncCount = 0; this.sync(); return; } }
      catch { this.quickSyncCount = 0; this.sync(); return; }
    }
  }
  insertChunk(path: string, chunk: Chunk, hash: string, embedding: Float32Array | null = null): number {
    const m = chunk.metadata;
    const r = this.db.prepare("INSERT INTO memory_chunks(path,text,embedding,start_line,end_line,importance,tags,status,knowledge_type,project,agent,created,hash,origin,import_id,source_id,category,original_path,original_record_id,embedding_dims,embedding_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(path, chunk.text, embedding ? Buffer.from(embedding.buffer) : null, chunk.startLine, chunk.endLine, m.importance, JSON.stringify(m.tags), m.status, m.knowledgeType ?? null, m.project ?? null, m.agent, m.created, hash, m.origin ?? "native", m.importId ?? null, m.sourceId ?? null, m.category ?? null, m.originalPath ?? null, m.originalRecordId ?? null, m.embeddingDims ?? null, m.embeddingModel ?? null);
    const id = Number(r.lastInsertRowid); this.db.prepare("INSERT INTO memory_fts(rowid,text) VALUES (?,?)").run(id, chunk.text); return id;
  }
  rows(): DbRow[] { return this.db.prepare("SELECT * FROM memory_chunks").all() as DbRow[]; }
  findPath(path: string): DbRow | undefined { return this.db.prepare("SELECT * FROM memory_chunks WHERE path = ? LIMIT 1").get(path) as DbRow | undefined; }
  setEmbedding(path: string, embedding: Float32Array): void { const rows = this.db.prepare("SELECT id FROM memory_chunks WHERE path = ?").all(path) as { id: number }[]; const tx = this.db.transaction(() => { for (const row of rows) this.setChunkEmbedding(row.id, embedding, this.config.embeddingModel, embedding.length); }); tx(); }
  setChunkEmbedding(chunkId: number, embedding: Float32Array, model: string, dims: number): void {
    const buffer = Buffer.from(embedding.buffer);
    this.db.prepare("UPDATE memory_chunks SET embedding = ?, embedding_model = ?, embedding_dims = ? WHERE id = ?").run(buffer, model, dims, chunkId);
    if (dims === 384 && this.vecAvailable) { try { this.db.prepare("INSERT OR REPLACE INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(chunkId, buffer); } catch { /* sqlite-vec optional */ } }
  }
  addRelation(source: number, type: string, target: number, agent: string): void { this.db.prepare("INSERT OR REPLACE INTO memory_relations VALUES (?,?,?,?,?)").run(source, type, target, agent, new Date().toISOString()); }
  addProvenance(memoryId: number, event: string, agent: string, sourceId: number | null, note = ""): void { this.db.prepare("INSERT INTO memory_provenance(memory_id,event_type,agent,timestamp,source_id,note) VALUES (?,?,?,?,?,?)").run(memoryId, event, agent, new Date().toISOString(), sourceId, note); }
  searchText(query: string): DbRow[] { const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(query); if (cjk && [...query].length < 3) return this.db.prepare("SELECT * FROM memory_chunks WHERE text LIKE ? LIMIT 100").all(`%${query}%`) as DbRow[]; const match = `"${query.replaceAll('"', '""')}"`; return this.db.prepare("SELECT c.* FROM memory_fts f JOIN memory_chunks c ON c.id=f.rowid WHERE memory_fts MATCH ? LIMIT 100").all(match) as DbRow[]; }
  searchVector(query: Float32Array): { row: DbRow; score: number }[] {
    const dims = query.length;
    if (dims === 384 && this.vecAvailable) {
      try {
        const rows = this.db.prepare("SELECT c.*, v.distance as distance FROM memory_vec v JOIN memory_chunks c ON c.id = v.rowid WHERE v.embedding MATCH ? AND k = 100 ORDER BY v.distance").all(Buffer.from(query.buffer)) as (DbRow & { distance: number })[];
        return rows.map((row) => ({ row, score: 1 - row.distance / 2 }));
      } catch { /* fall through to JS cosine */ }
    }
    const rows = this.db.prepare("SELECT * FROM memory_chunks WHERE embedding IS NOT NULL AND embedding_dims = ?").all(dims) as DbRow[];
    return rows.map((row) => ({ row, score: cosine(query, new Float32Array(row.embedding!.buffer, row.embedding!.byteOffset, row.embedding!.byteLength / 4)) })).sort((a, b) => b.score - a.score);
  }
  relations(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_relations WHERE source_id = ? OR target_id = ?").all(id, id); }
  provenance(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_provenance WHERE memory_id = ? ORDER BY timestamp").all(id); }
  importStatus(importId?: string): unknown[] { return importId ? this.db.prepare("SELECT * FROM memory_imports WHERE id = ?").all(importId) : this.db.prepare("SELECT * FROM memory_imports ORDER BY started_at DESC LIMIT 50").all(); }
  createImport(id: string, sourceType: string, sourcePath: string, sourceDbPath: string | null, targetPath: string, options: Record<string, unknown>): void { this.db.prepare("INSERT INTO memory_imports(id,source_type,source_path,source_db_path,target_path,started_at,status,options_json) VALUES (?,?,?,?,?,?,?,?)").run(id, sourceType, sourcePath, sourceDbPath, targetPath, new Date().toISOString(), "pending", JSON.stringify(options)); }
  updateImport(id: string, status: string, fileCount?: number, chunkCount?: number, errorCount?: number): void { const sets: string[] = ["status = ?"]; const vals: unknown[] = [status]; if (fileCount !== undefined) { sets.push("file_count = ?"); vals.push(fileCount); } if (chunkCount !== undefined) { sets.push("chunk_count = ?"); vals.push(chunkCount); } if (errorCount !== undefined) { sets.push("error_count = ?"); vals.push(errorCount); } if (status === "completed" || status === "failed") { sets.push("completed_at = ?"); vals.push(new Date().toISOString()); } vals.push(id); this.db.prepare(`UPDATE memory_imports SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  hasRunningImport(): string | null { const row = this.db.prepare("SELECT id FROM memory_imports WHERE status IN ('pending','running') LIMIT 1").get() as { id: string } | undefined; return row?.id ?? null; }
  importRecords(importId: string): unknown[] { return this.db.prepare("SELECT * FROM memory_import_records WHERE import_id = ?").all(importId); }
  findImportRecord(sourceKind: string, originalPath: string, originalRecordId: string | null, sourceHash: string): { import_id: string; status: string; target_chunk_ids: string } | undefined { return this.db.prepare("SELECT import_id, status, target_chunk_ids FROM memory_import_records WHERE source_kind = ? AND original_path = ? AND COALESCE(original_record_id, '') = COALESCE(?, '') AND source_hash = ? LIMIT 1").get(sourceKind, originalPath, originalRecordId, sourceHash) as { import_id: string; status: string; target_chunk_ids: string } | undefined; }
  addImportRecord(importId: string, sourceKind: string, originalPath: string, originalRecordId: string | null, sourceHash: string, targetSourceId: number | null, chunkIds: number[], embeddingMode: string, embeddingDims: number | null, status: string): void { this.db.prepare("INSERT INTO memory_import_records(import_id,source_kind,original_path,original_record_id,source_hash,target_source_id,target_chunk_ids,embedding_mode,embedding_dims,status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(importId, sourceKind, originalPath, originalRecordId, sourceHash, targetSourceId, JSON.stringify(chunkIds), embeddingMode, embeddingDims, status); }
  addSource(path: string, origin: string, importId: string | null, sourceType: string, originalPath: string | null, originalRecordId: string | null, hash: string, mtime: number, size: number, embeddingModel?: string, embeddingDims?: number): number { const r = this.db.prepare("INSERT OR REPLACE INTO memory_sources(path,origin,import_id,source_type,original_path,original_record_id,hash,mtime,size,embedding_model,embedding_dims) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(path, origin, importId, sourceType, originalPath, originalRecordId, hash, mtime, size, embeddingModel ?? null, embeddingDims ?? null); return Number(r.lastInsertRowid); }
  rollbackImport(importId: string): { removedChunks: number; removedSources: number } {
    const chunkIds = this.db.prepare("SELECT id FROM memory_chunks WHERE import_id = ?").all(importId) as { id: number }[];
    const ids = chunkIds.map((c) => c.id);
    const tx = this.db.transaction(() => {
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM memory_fts WHERE rowid IN (${placeholders})`).run(...ids);
        if (this.vecAvailable) { try { this.db.prepare(`DELETE FROM memory_vec WHERE rowid IN (${placeholders})`).run(...ids); } catch { /* vec optional */ } }
        this.db.prepare(`DELETE FROM memory_provenance WHERE memory_id IN (${placeholders})`).run(...ids);
        this.db.prepare(`DELETE FROM memory_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...ids, ...ids);
      }
      this.db.prepare("DELETE FROM memory_chunks WHERE import_id = ?").run(importId);
      this.db.prepare("DELETE FROM memory_sources WHERE import_id = ?").run(importId);
      this.db.prepare("DELETE FROM memory_import_records WHERE import_id = ?").run(importId);
      this.db.prepare("UPDATE memory_imports SET status = 'rolled-back', completed_at = ? WHERE id = ?").run(new Date().toISOString(), importId);
    });
    tx();
    return { removedChunks: ids.length, removedSources: 0 };
  }
}
function BunHash(value: string): string { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
