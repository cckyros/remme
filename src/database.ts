import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cosine } from "./embedding.ts";
import type { Config } from "./config.ts";
import { chunkMarkdown, parseMarkdown, type Chunk } from "./chunker.ts";
import * as sqliteVec from "sqlite-vec";

export interface DbRow { id: number; path: string; text: string; embedding: Buffer | null; start_line: number; end_line: number; importance: number; tags: string; status: string; knowledge_type: string | null; project: string | null; agent: string; created: string; origin: string; import_id: string | null; source_id: number | null; category: string | null; original_path: string | null; original_record_id: string | null; embedding_dims: number | null; embedding_model: string | null; }

export interface SearchFilters { project?: string; agent?: string; knowledgeType?: string; status?: string; tags?: string[]; dateFrom?: string; dateTo?: string; entity?: string; }

const SCHEMA_VERSION = 3;

export class MemoryDatabase {
  readonly db: Database.Database;
  private readonly config: Config;
  private vecAvailable = false;
  private syncDirty = true;
  private lastQuickSyncMs = 0;
  private static readonly QUICK_SYNC_MIN_INTERVAL_MS = 5000;
  constructor(config: Config) {
    this.config = config;
    const backup = existsSync(config.dbPath) && process.env.REMME_SKIP_BACKUP !== "1";
    this.db = new Database(config.dbPath);
    try {
      if (backup) {
        const temporary = `${config.dbPath}.bak.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, this.db.serialize());
        renameSync(temporary, `${config.dbPath}.bak`);
      }
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      try { sqliteVec.load(this.db); this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[384])"); this.vecAvailable = true; } catch { /* ponytail: JS cosine fallback keeps unsupported SQLite builds usable; upgrade when a compatible sqlite-vec binary is available. */ }
      this.db.function("remme_cosine", { deterministic: true }, (a: Buffer, b: Buffer) => cosine(decodeVector(a), decodeVector(b)));
      this.db.transaction(() => { this.migrate(); this.createTables(); this.migrateIndexes(); }).immediate();
      this.recoverInterruptedImports();
    } catch (error) { this.db.close(); throw error; }
  }
  private migrate(): void {
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
      if (!cols.includes("entities")) this.db.exec("ALTER TABLE memory_chunks ADD COLUMN entities TEXT NOT NULL DEFAULT '[]'");
    }
  }
  private createTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, importance REAL NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, knowledge_type TEXT, project TEXT, agent TEXT NOT NULL, created TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL DEFAULT 'native', import_id TEXT, source_id INTEGER, category TEXT, original_path TEXT, original_record_id TEXT, embedding_dims INTEGER, embedding_model TEXT, entities TEXT NOT NULL DEFAULT '[]')`);
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
  private migrateIndexes(): void {
    const columns = this.db.prepare("PRAGMA table_info(memory_imports)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "owner_pid")) this.db.exec("ALTER TABLE memory_imports ADD COLUMN owner_pid INTEGER");
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_id_counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO memory_id_counter VALUES ('chunks', 0);
      CREATE INDEX IF NOT EXISTS idx_memory_embedding ON memory_chunks(embedding_model, embedding_dims);
      CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
        INSERT INTO memory_fts(rowid,text) VALUES (new.id,new.text);
        UPDATE memory_id_counter SET value = MAX(value,new.id) WHERE name = 'chunks';
      END;
      CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE OF text ON memory_chunks WHEN old.text != new.text BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,text) VALUES ('delete',old.id,old.text);
        INSERT INTO memory_fts(rowid,text) VALUES (new.id,new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,text) VALUES ('delete',old.id,old.text);
        DELETE FROM memory_relations WHERE source_id = old.id OR target_id = old.id;
        DELETE FROM memory_provenance WHERE memory_id = old.id;
        UPDATE memory_provenance SET source_id = NULL WHERE source_id = old.id;
      END;`);
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current < SCHEMA_VERSION) {
      this.db.exec(`UPDATE memory_id_counter SET value = MAX(value, COALESCE((SELECT MAX(id) FROM (
        SELECT id FROM memory_chunks UNION ALL SELECT source_id FROM memory_relations UNION ALL SELECT target_id FROM memory_relations
        UNION ALL SELECT memory_id FROM memory_provenance UNION ALL SELECT source_id FROM memory_provenance
        UNION ALL SELECT CAST(j.value AS INTEGER) FROM memory_import_records r, json_each(r.target_chunk_ids) j)), 0)) WHERE name = 'chunks'`);
      this.db.exec("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
      if (this.vecAvailable) {
        this.db.exec("DELETE FROM memory_vec");
        this.db.exec("INSERT INTO memory_vec(rowid,embedding) SELECT id,embedding FROM memory_chunks WHERE embedding_dims = 384 AND length(embedding) = 1536 AND embedding_model IS NOT NULL");
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }
  private recoverInterruptedImports(): void {
    const pending = this.db.prepare("SELECT id, owner_pid FROM memory_imports WHERE status IN ('pending','running')").all() as { id: string; owner_pid: number | null }[];
    for (const imp of pending) {
      if (!imp.owner_pid || imp.owner_pid <= 0) continue;
      try { process.kill(imp.owner_pid, 0); } catch (error) {
        /* best effort */
        if ((error as NodeJS.ErrnoException).code === "ESRCH") this.db.prepare("UPDATE memory_imports SET status = 'interrupted' WHERE id = ? AND owner_pid = ? AND status IN ('pending','running')").run(imp.id, imp.owner_pid);
      }
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
    const files = new Set(this.scanMarkdownRecursive(this.config.memoryDir));
    const existing = this.db.prepare("SELECT path FROM memory_sources UNION SELECT path FROM memory_chunks").all() as { path: string }[];
    for (const { path } of existing) {
      if (files.has(path)) continue;
      this.db.transaction(() => {
        const active = this.db.prepare(`SELECT 1 FROM memory_imports i WHERE i.status IN ('pending','running','interrupted') AND
          (EXISTS (SELECT 1 FROM memory_chunks c WHERE c.path = ? AND c.import_id = i.id) OR EXISTS (SELECT 1 FROM memory_sources s WHERE s.path = ? AND s.import_id = i.id))`).get(path, path);
        if (active || existsSync(path)) return;
        this.deleteChunks("path = ?", [path]);
        this.db.prepare("DELETE FROM memory_sources WHERE path = ?").run(path);
      }).immediate();
    }
    const state = this.db.prepare("SELECT mtime, size FROM memory_sources WHERE path = ?");
    for (const path of files) {
      const stat = statSync(path);
      const previous = state.get(path) as { mtime: number; size: number } | undefined;
      if (previous?.mtime === stat.mtimeMs && previous.size === stat.size) continue;
      this.indexFile(path);
    }
    this.syncDirty = false;
    this.lastQuickSyncMs = Date.now();
  }
  indexFile(absPath: string): void {
    absPath = resolve(absPath);
    this.db.transaction(() => {
      const stat = statSync(absPath);
      const source = readFileSync(absPath, "utf8");
      const after = statSync(absPath);
      if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) throw new Error(`file changed during indexing: ${absPath}`);
      const hash = BunHash(source);
      const previous = this.db.prepare("SELECT * FROM memory_sources WHERE path = ?").get(absPath) as { id: number; hash: string; origin: string; import_id: string | null; source_type: string; original_path: string | null; original_record_id: string | null } | undefined;
      if (previous?.hash === hash) { this.db.prepare("UPDATE memory_sources SET mtime = ?, size = ? WHERE id = ?").run(stat.mtimeMs, stat.size, previous.id); return; }
      const parsed = parseMarkdown(source, this.config.agent);
      const old = this.chunksForPath(absPath);
      const m = parsed.metadata;
      m.origin = previous?.origin ?? old[0]?.origin ?? m.origin;
      m.importId = previous?.import_id ?? old[0]?.import_id ?? m.importId;
      m.originalPath = previous?.original_path ?? old[0]?.original_path ?? m.originalPath;
      m.originalRecordId = previous?.original_record_id ?? old[0]?.original_record_id ?? m.originalRecordId;
      const sourceId = this.addSource(absPath, m.origin ?? "native", m.importId ?? null, previous?.source_type ?? m.source ?? "markdown", m.originalPath ?? null, m.originalRecordId ?? null, hash, stat.mtimeMs, stat.size);
      m.sourceId = sourceId;
      const chunks = chunkMarkdown(parsed.body, m);
      const available = new Map<string, DbRow[]>();
      for (const row of old.slice(1).reverse()) {
        const matches = available.get(row.text) ?? []; matches.push(row); available.set(row.text, matches);
      }
      const retained = new Set<number>();
      const temporary = randomUUID();
      this.db.prepare("UPDATE memory_chunks SET hash = ? || ':' || id WHERE path = ?").run(temporary, absPath);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const matched = index === 0 ? old[0] : available.get(chunk.text)?.pop();
        const nextHash = `${absPath}:${hash}:${index}`;
        if (!matched) {
          const id = this.insertChunk(absPath, chunk, nextHash);
          const moved = old[0]?.text === chunk.text ? old[0] : undefined;
          if (moved?.embedding && moved.embedding_model && moved.embedding_dims === moved.embedding.length / 4) this.setChunkEmbedding(id, decodeVector(moved.embedding), moved.embedding_model, moved.embedding_dims);
          continue;
        }
        retained.add(matched.id);
        if (matched.text !== chunk.text) this.clearVector(matched.id);
        this.db.prepare(`UPDATE memory_chunks SET text=?,start_line=?,end_line=?,importance=?,tags=?,status=?,knowledge_type=?,project=?,agent=?,created=?,hash=?,origin=?,import_id=?,source_id=?,category=?,original_path=?,original_record_id=?,entities=?,
          embedding=CASE WHEN text=? THEN embedding ELSE NULL END, embedding_dims=CASE WHEN text=? THEN embedding_dims ELSE NULL END, embedding_model=CASE WHEN text=? THEN embedding_model ELSE NULL END WHERE id=?`)
          .run(chunk.text, chunk.startLine, chunk.endLine, m.importance, JSON.stringify(m.tags), m.status, m.knowledgeType ?? null, m.project ?? null, m.agent, m.created, nextHash, m.origin ?? "native", m.importId ?? null, sourceId, m.category ?? null, m.originalPath ?? null, m.originalRecordId ?? null, JSON.stringify(m.entities), chunk.text, chunk.text, chunk.text, matched.id);
      }
      for (const row of old) if (!retained.has(row.id)) this.deleteChunks("id = ?", [row.id]);
    }).immediate();
  }
  quickSync(): void {
    if (this.syncDirty || Date.now() - this.lastQuickSyncMs >= MemoryDatabase.QUICK_SYNC_MIN_INTERVAL_MS) this.sync();
  }
  insertChunk(path: string, chunk: Chunk, hash: string, embedding: Float32Array | null = null): number {
    return this.db.transaction(() => {
      const m = chunk.metadata;
      const { value: id } = this.db.prepare("UPDATE memory_id_counter SET value = value + 1 WHERE name = 'chunks' RETURNING value").get() as { value: number };
      this.db.prepare("INSERT INTO memory_chunks(id,path,text,start_line,end_line,importance,tags,status,knowledge_type,project,agent,created,hash,origin,import_id,source_id,category,original_path,original_record_id,entities) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, resolve(path), chunk.text, chunk.startLine, chunk.endLine, m.importance, JSON.stringify(m.tags), m.status, m.knowledgeType ?? null, m.project ?? null, m.agent, m.created, hash, m.origin ?? "native", m.importId ?? null, m.sourceId ?? null, m.category ?? null, m.originalPath ?? null, m.originalRecordId ?? null, JSON.stringify(m.entities ?? []));
      if (embedding) this.setChunkEmbedding(id, embedding, m.embeddingModel ?? this.config.embeddingModel, m.embeddingDims ?? embedding.length);
      return id;
    }).immediate();
  }
  private clearVector(id: number): void {
    if (this.vecAvailable) this.db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(BigInt(id));
  }
  private deleteChunks(where: string, values: (string | number)[]): number {
    const ids = this.db.prepare(`SELECT id FROM memory_chunks WHERE ${where}`).all(...values) as { id: number }[];
    for (const { id } of ids) this.clearVector(id);
    return this.db.prepare(`DELETE FROM memory_chunks WHERE ${where}`).run(...values).changes;
  }
  rows(): DbRow[] { return this.db.prepare("SELECT * FROM memory_chunks").all() as DbRow[]; }
  findPath(path: string): DbRow | undefined { return this.db.prepare("SELECT * FROM memory_chunks WHERE path = ? ORDER BY start_line, id LIMIT 1").get(resolve(path)) as DbRow | undefined; }
  chunksForPath(path: string): DbRow[] { return this.db.prepare("SELECT * FROM memory_chunks WHERE path = ? ORDER BY start_line, id").all(resolve(path)) as DbRow[]; }
  listPaths(filters: SearchFilters = {}, limit = 1000): string[] {
    const { sql, values } = this.filterSql(filters);
    return (this.db.prepare(`SELECT DISTINCT c.path FROM memory_chunks c WHERE ${sql} ORDER BY c.path LIMIT ?`).all(...values, boundedLimit(limit, 1000)) as { path: string }[]).map((row) => row.path);
  }
  private filterSql(filters: SearchFilters): { sql: string; values: string[] } {
    const clauses: string[] = ["1=1"]; const values: string[] = [];
    for (const [key, column] of [["project", "project"], ["agent", "agent"], ["knowledgeType", "knowledge_type"], ["status", "status"]] as const) {
      if (filters[key] !== undefined) { clauses.push(`c.${column} = ?`); values.push(filters[key]); }
    }
    for (const tag of filters.tags ?? []) { clauses.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)"); values.push(tag); }
    if (filters.entity !== undefined) { clauses.push("EXISTS (SELECT 1 FROM json_each(c.entities) WHERE value = ?)"); values.push(filters.entity); }
    if (filters.dateFrom !== undefined) { clauses.push("c.created >= ?"); values.push(filters.dateFrom); }
    if (filters.dateTo !== undefined) { clauses.push("c.created <= ?"); values.push(filters.dateTo); }
    return { sql: clauses.join(" AND "), values };
  }
  setEmbedding(path: string, embedding: Float32Array): void { const rows = this.db.prepare("SELECT id FROM memory_chunks WHERE path = ?").all(path) as { id: number }[]; const tx = this.db.transaction(() => { for (const row of rows) this.setChunkEmbedding(row.id, embedding, this.config.embeddingModel, embedding.length); }); tx(); }
  setChunkEmbedding(chunkId: number, embedding: Float32Array, model: string, dims: number): void {
    if (!Number.isInteger(dims) || dims <= 0 || dims !== embedding.length) throw new Error("embedding dimensions must match the vector length");
    if (!embedding.every(Number.isFinite)) throw new Error("embedding must contain finite numbers");
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE memory_chunks SET embedding = ?, embedding_model = ?, embedding_dims = ? WHERE id = ?").run(buffer, model, dims, chunkId);
      if (!result.changes) throw new Error(`unknown chunk: ${chunkId}`);
      this.clearVector(chunkId);
      if (dims === 384 && this.vecAvailable) { try { this.db.prepare("INSERT OR REPLACE INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(chunkId), buffer); } catch { /* sqlite-vec optional */ } }
    }).immediate();
  }
  addRelation(source: number, type: string, target: number, agent: string): void { this.db.prepare("INSERT OR REPLACE INTO memory_relations VALUES (?,?,?,?,?)").run(source, type, target, agent, new Date().toISOString()); }
  addProvenance(memoryId: number, event: string, agent: string, sourceId: number | null, note = ""): void { this.db.prepare("INSERT INTO memory_provenance(memory_id,event_type,agent,timestamp,source_id,note) VALUES (?,?,?,?,?,?)").run(memoryId, event, agent, new Date().toISOString(), sourceId, note); }
  searchText(query: string, filters: SearchFilters = {}, limit = 100): { row: DbRow; score: number }[] {
    if (!query.trim()) return [];
    const { sql, values } = this.filterSql(filters); const count = boundedLimit(limit, 100);
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => [...token].length < 3)) {
      const rows = this.db.prepare(`SELECT c.* FROM memory_chunks c WHERE ${sql} AND ${tokens.map(() => "instr(lower(c.text), lower(?)) > 0").join(" AND ")} ORDER BY c.id LIMIT ?`).all(...values, ...tokens, count) as DbRow[];
      return rows.map((row, index) => ({ row, score: 1 - index / Math.max(1, count) }));
    }
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
    const rows = this.db.prepare(`SELECT c.*, bm25(memory_fts) AS bm25 FROM memory_fts JOIN memory_chunks c ON c.id=memory_fts.rowid WHERE memory_fts MATCH ? AND ${sql} ORDER BY bm25(memory_fts), c.id LIMIT ?`).all(match, ...values, count) as (DbRow & { bm25: number })[];
    if (!rows.length) return [];
    const worst = rows[rows.length - 1].bm25; const range = rows[0].bm25 - worst;
    return rows.map((row) => ({ row, score: range === 0 ? 1 : (row.bm25 - worst) / range }));
  }
  searchVector(query: Float32Array, filters: SearchFilters = {}, limit = 100, model = this.config.embeddingModel): { row: DbRow; score: number }[] {
    if (!query.length || !query.every(Number.isFinite)) return [];
    const { sql, values } = this.filterSql(filters);
    const buffer = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    const execute = (expression: string) => {
      const rows = this.db.prepare(`SELECT c.*, ${expression} AS score FROM memory_chunks c WHERE c.embedding IS NOT NULL AND c.embedding_dims = ? AND c.embedding_model = ? AND length(c.embedding) = ? AND ${sql} ORDER BY score DESC, c.id LIMIT ?`)
        .all(buffer, query.length, model, query.byteLength, ...values, boundedLimit(limit, 100)) as (DbRow & { score: number })[];
      return rows.map((row) => ({ row, score: row.score }));
    };
    if (this.vecAvailable) {
      try {
        const rows = execute("COALESCE(1 - vec_distance_cosine(c.embedding, ?), 0)");
        if (rows.length > 0) return rows;
        /* empty result: fall through to JS cosine instead of returning empty */
      } catch { /* fall through to JS cosine */ }
    }
    return execute("remme_cosine(c.embedding, ?)");
  }
  relations(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_relations WHERE source_id = ? OR target_id = ?").all(id, id); }
  provenance(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_provenance WHERE memory_id = ? ORDER BY timestamp").all(id); }
  importStatus(importId?: string): unknown[] { return importId ? this.db.prepare("SELECT * FROM memory_imports WHERE id = ?").all(importId) : this.db.prepare("SELECT * FROM memory_imports ORDER BY started_at DESC LIMIT 50").all(); }
  createImport(id: string, sourceType: string, sourcePath: string, sourceDbPath: string | null, targetPath: string, options: Record<string, unknown>): void {
    this.db.transaction(() => {
      this.recoverInterruptedImports();
      const running = this.hasRunningImport(); if (running) throw new Error(`another import is running: ${running}`);
      this.db.prepare("INSERT INTO memory_imports(id,source_type,source_path,source_db_path,target_path,started_at,status,options_json,owner_pid) VALUES (?,?,?,?,?,?,?,?,?)").run(id, sourceType, sourcePath, sourceDbPath, targetPath, new Date().toISOString(), "pending", JSON.stringify(options), process.pid);
    }).immediate();
  }
  updateImport(id: string, status: string, fileCount?: number, chunkCount?: number, errorCount?: number): void { const sets: string[] = ["status = ?"]; const vals: unknown[] = [status]; if (fileCount !== undefined) { sets.push("file_count = ?"); vals.push(fileCount); } if (chunkCount !== undefined) { sets.push("chunk_count = ?"); vals.push(chunkCount); } if (errorCount !== undefined) { sets.push("error_count = ?"); vals.push(errorCount); } if (status === "completed" || status === "failed") { sets.push("completed_at = ?"); vals.push(new Date().toISOString()); } vals.push(id); this.db.prepare(`UPDATE memory_imports SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  hasRunningImport(): string | null { const row = this.db.prepare("SELECT id FROM memory_imports WHERE status IN ('pending','running') LIMIT 1").get() as { id: string } | undefined; return row?.id ?? null; }
  importRecords(importId: string): unknown[] { return this.db.prepare("SELECT * FROM memory_import_records WHERE import_id = ?").all(importId); }
  findImportRecord(sourceKind: string, originalPath: string, originalRecordId: string | null, sourceHash: string): { import_id: string; status: string; target_chunk_ids: string } | undefined { return this.db.prepare("SELECT import_id, status, target_chunk_ids FROM memory_import_records WHERE source_kind = ? AND original_path = ? AND COALESCE(original_record_id, '') = COALESCE(?, '') AND source_hash = ? LIMIT 1").get(sourceKind, originalPath, originalRecordId, sourceHash) as { import_id: string; status: string; target_chunk_ids: string } | undefined; }
  addImportRecord(importId: string, sourceKind: string, originalPath: string, originalRecordId: string | null, sourceHash: string, targetSourceId: number | null, chunkIds: number[], embeddingMode: string, embeddingDims: number | null, status: string): void { this.db.prepare("INSERT INTO memory_import_records(import_id,source_kind,original_path,original_record_id,source_hash,target_source_id,target_chunk_ids,embedding_mode,embedding_dims,status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(importId, sourceKind, originalPath, originalRecordId, sourceHash, targetSourceId, JSON.stringify(chunkIds), embeddingMode, embeddingDims, status); }
  addSource(path: string, origin: string, importId: string | null, sourceType: string, originalPath: string | null, originalRecordId: string | null, hash: string, mtime: number, size: number, embeddingModel?: string, embeddingDims?: number): number {
    return this.db.transaction(() => {
      const row = this.db.prepare(`INSERT INTO memory_sources(path,origin,import_id,source_type,original_path,original_record_id,hash,mtime,size,embedding_model,embedding_dims) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET origin=excluded.origin,import_id=excluded.import_id,source_type=excluded.source_type,original_path=excluded.original_path,original_record_id=excluded.original_record_id,hash=excluded.hash,mtime=excluded.mtime,size=excluded.size,
        embedding_model=COALESCE(excluded.embedding_model,memory_sources.embedding_model),embedding_dims=COALESCE(excluded.embedding_dims,memory_sources.embedding_dims) RETURNING id`)
        .get(resolve(path), origin, importId, sourceType, originalPath, originalRecordId, hash, mtime, size, embeddingModel ?? null, embeddingDims ?? null) as { id: number };
      this.db.prepare("UPDATE memory_chunks SET source_id = ? WHERE path = ? AND import_id IS ?").run(row.id, resolve(path), importId);
      return row.id;
    }).immediate();
  }
  moveImportPaths(importId: string, stagingDir: string, finalDir: string): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM memory_imports WHERE id = ?").get(importId)) throw new Error(`unknown import: ${importId}`);
      const paths = this.db.prepare("SELECT path FROM memory_chunks WHERE import_id = ? UNION SELECT path FROM memory_sources WHERE import_id = ?").all(importId, importId) as { path: string }[];
      for (const { path } of paths) {
        const suffix = relative(resolve(stagingDir), resolve(path));
        if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error(`import path is outside staging directory: ${path}`);
        const target = resolve(finalDir, suffix);
        if (target !== path && (this.db.prepare("SELECT 1 FROM memory_chunks WHERE path = ? UNION SELECT 1 FROM memory_sources WHERE path = ?").get(target, target))) throw new Error(`import target already indexed: ${target}`);
        this.db.prepare("UPDATE memory_chunks SET path = ? WHERE path = ? AND import_id = ?").run(target, path, importId);
        this.db.prepare("UPDATE memory_sources SET path = ?, hash = '' WHERE path = ? AND import_id = ?").run(target, path, importId);
        this.indexFile(target);
      }
    }).immediate();
  }
  rollbackImport(importId: string): { removedChunks: number; removedSources: number } {
    return this.db.transaction(() => {
      const imp = this.db.prepare("SELECT status FROM memory_imports WHERE id = ?").get(importId) as { status: string } | undefined;
      if (!imp) throw new Error(`unknown import: ${importId}`);
      if (imp.status === "running" || imp.status === "pending") throw new Error(`cannot roll back ${imp.status} import: ${importId}`);
      /* vec optional */
      const removedChunks = this.deleteChunks("import_id = ?", [importId]);
      const removedSources = this.db.prepare("DELETE FROM memory_sources WHERE import_id = ?").run(importId).changes;
      this.db.prepare("DELETE FROM memory_import_records WHERE import_id = ?").run(importId);
      this.db.prepare("UPDATE memory_imports SET status = 'rolled-back', completed_at = ? WHERE id = ?").run(new Date().toISOString(), importId);
      return { removedChunks, removedSources };
    }).immediate();
  }
}
function BunHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function decodeVector(buffer: Buffer): Float32Array {
  const vector = new Float32Array(buffer.byteLength / 4);
  for (let index = 0; index < vector.length; index++) vector[index] = buffer.readFloatLE(index * 4);
  return vector;
}
function boundedLimit(limit: number, fallback: number): number { return Number.isFinite(limit) ? Math.min(10000, Math.max(0, Math.floor(limit))) : fallback; }
