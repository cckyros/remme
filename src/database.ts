import Database from "better-sqlite3";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { cosine } from "./embedding.ts";
import type { Config } from "./config.ts";
import { chunkMarkdown, parseMarkdown, type Chunk } from "./chunker.ts";
import * as sqliteVec from "sqlite-vec";

export interface DbRow { id: number; path: string; text: string; embedding: Buffer | null; start_line: number; end_line: number; importance: number; tags: string; status: string; knowledge_type: string | null; project: string | null; agent: string; created: string; }

export class MemoryDatabase {
  readonly db: Database.Database;
  private readonly config: Config;
  private readonly fileState = new Map<string, { mtimeMs: number; size: number }>();
  constructor(config: Config) {
    this.config = config;
    if (existsSync(config.dbPath) && process.env.REMME_SKIP_BACKUP !== "1") copyFileSync(config.dbPath, `${config.dbPath}.bak`);
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    try { sqliteVec.load(this.db); this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[384])"); } catch { /* ponytail: JS cosine fallback keeps unsupported SQLite builds usable; upgrade when a compatible sqlite-vec binary is available. */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, importance REAL NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, knowledge_type TEXT, project TEXT, agent TEXT NOT NULL, created TEXT NOT NULL, hash TEXT NOT NULL UNIQUE); CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_chunks(path); CREATE INDEX IF NOT EXISTS idx_memory_filters ON memory_chunks(project, status, knowledge_type, agent); CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory_chunks', content_rowid='id', tokenize='trigram'); CREATE TABLE IF NOT EXISTS memory_relations (source_id INTEGER NOT NULL, relation_type TEXT NOT NULL, target_id INTEGER NOT NULL, agent TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, relation_type, target_id)); CREATE TABLE IF NOT EXISTS memory_provenance (id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL, event_type TEXT NOT NULL, agent TEXT NOT NULL, timestamp TEXT NOT NULL, source_id INTEGER, note TEXT);`);
  }
  close(): void { this.db.close(); }
  sync(): void {
    const files = new Set(readdirSync(this.config.memoryDir).filter((x) => x.endsWith(".md")));
    const existing = this.db.prepare("SELECT DISTINCT path FROM memory_chunks").all() as { path: string }[];
    const remove = this.db.prepare("DELETE FROM memory_chunks WHERE path = ?");
    for (const row of existing) if (!files.has(basename(row.path))) { remove.run(row.path); this.fileState.delete(row.path); }
    for (const file of files) {
      const path = join(this.config.memoryDir, file);
      const stat = statSync(path);
      const previous = this.fileState.get(path);
      if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
      const source = readFileSync(path, "utf8");
      const hash = `${path}:${BunHash(source)}`;
      const old = this.db.prepare("SELECT hash FROM memory_chunks WHERE path = ? LIMIT 1").get(path) as { hash?: string } | undefined;
      if (old?.hash?.startsWith(`${hash}:`)) { this.fileState.set(path, { mtimeMs: stat.mtimeMs, size: stat.size }); continue; }
      this.db.prepare("DELETE FROM memory_chunks WHERE path = ?").run(path);
      const parsed = parseMarkdown(source, this.config.agent);
      for (const chunk of chunkMarkdown(parsed.body, parsed.metadata)) this.insertChunk(path, chunk, `${hash}:${chunk.startLine}`);
      this.fileState.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  insertChunk(path: string, chunk: Chunk, hash: string, embedding: Float32Array | null = null): number {
    const r = this.db.prepare("INSERT INTO memory_chunks(path,text,embedding,start_line,end_line,importance,tags,status,knowledge_type,project,agent,created,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(path, chunk.text, embedding ? Buffer.from(embedding.buffer) : null, chunk.startLine, chunk.endLine, chunk.metadata.importance, JSON.stringify(chunk.metadata.tags), chunk.metadata.status, chunk.metadata.knowledgeType ?? null, chunk.metadata.project ?? null, chunk.metadata.agent, chunk.metadata.created, hash);
    const id = Number(r.lastInsertRowid); this.db.prepare("INSERT INTO memory_fts(rowid,text) VALUES (?,?)").run(id, chunk.text); return id;
  }
  rows(): DbRow[] { return this.db.prepare("SELECT * FROM memory_chunks").all() as DbRow[]; }
  findPath(path: string): DbRow | undefined { return this.db.prepare("SELECT * FROM memory_chunks WHERE path = ? LIMIT 1").get(path) as DbRow | undefined; }
  setEmbedding(path: string, embedding: Float32Array): void { const rows = this.db.prepare("SELECT id FROM memory_chunks WHERE path = ?").all(path) as { id: number }[]; const update = this.db.prepare("UPDATE memory_chunks SET embedding = ? WHERE id = ?"); const addVector = this.db.prepare("INSERT OR REPLACE INTO memory_vec(rowid, embedding) VALUES (?, ?)"); const tx = this.db.transaction(() => { for (const row of rows) { const buffer = Buffer.from(embedding.buffer); update.run(buffer, row.id); try { addVector.run(row.id, buffer); } catch { /* sqlite-vec optional */ } } }); tx(); }
  addRelation(source: number, type: string, target: number, agent: string): void { this.db.prepare("INSERT OR REPLACE INTO memory_relations VALUES (?,?,?,?,?)").run(source, type, target, agent, new Date().toISOString()); }
  addProvenance(memoryId: number, event: string, agent: string, sourceId: number | null, note = ""): void { this.db.prepare("INSERT INTO memory_provenance(memory_id,event_type,agent,timestamp,source_id,note) VALUES (?,?,?,?,?,?)").run(memoryId, event, agent, new Date().toISOString(), sourceId, note); }
  searchText(query: string): DbRow[] { const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(query); if (cjk && [...query].length < 3) return this.db.prepare("SELECT * FROM memory_chunks WHERE text LIKE ? LIMIT 100").all(`%${query}%`) as DbRow[]; const match = `"${query.replaceAll('"', '""')}"`; return this.db.prepare("SELECT c.* FROM memory_fts f JOIN memory_chunks c ON c.id=f.rowid WHERE memory_fts MATCH ? LIMIT 100").all(match) as DbRow[]; }
  searchVector(query: Float32Array): { row: DbRow; score: number }[] { return this.rows().filter((r) => r.embedding).map((row) => ({ row, score: cosine(query, new Float32Array(row.embedding!.buffer, row.embedding!.byteOffset, row.embedding!.byteLength / 4)) })).sort((a, b) => b.score - a.score); }
  relations(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_relations WHERE source_id = ? OR target_id = ?").all(id, id); }
  provenance(id: number): unknown[] { return this.db.prepare("SELECT * FROM memory_provenance WHERE memory_id = ? ORDER BY timestamp").all(id); }
}
function BunHash(value: string): string { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
