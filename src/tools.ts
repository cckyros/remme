import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { loadConfig, ensureConfigDirs, type Config } from "./config.ts";
import { MemoryDatabase, type SearchFilters } from "./database.ts";
import { embed } from "./embedding.ts";
import { parseMarkdown, renderMarkdown, type MemoryMetadata } from "./chunker.ts";
import { rankResults, type SearchItem } from "./search.ts";
import { getImporter } from "./importer/registry.ts";

let state: { config: Config; db: MemoryDatabase } | null = null;
export function closeMemoryStore(): void { state?.db.close(); state = null; }
function getState() {
  if (!state) {
    const config = loadConfig();
    ensureConfigDirs(config);
    const db = new MemoryDatabase(config);
    try { db.sync(); state = { config, db }; } catch (error) { db.close(); throw error; }
  }
  return state;
}
function safePath(config: Config, path: string): string {
  const root = realpathSync(config.memoryDir);
  const target = resolve(root, path);
  const actual = existsSync(target) ? realpathSync(target) : resolve(realpathSync(dirname(target)), target.slice(dirname(target).length + 1));
  const rel = relative(root, actual);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path must stay inside memory directory");
  return target;
}
function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`${key} must be a non-empty string`);
  return args[key];
}
function boundedInteger(value: unknown, fallback: number, max: number): number {
  const number = value === undefined ? fallback : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) throw new Error(`limit must be an integer between 1 and ${max}`);
  return number;
}
function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("tags/entities must be arrays of strings");
  return value;
}
function searchFilters(args: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  for (const key of ["project", "agent", "knowledgeType", "status", "entity", "dateFrom", "dateTo"] as const) {
    if (args[key] !== undefined) filters[key] = requiredString(args, key);
  }
  for (const key of ["dateFrom", "dateTo"] as const) {
    if (filters[key] && !Number.isFinite(Date.parse(filters[key]!))) throw new Error(`${key} must be an ISO date`);
  }
  if (filters.dateFrom && filters.dateTo && Date.parse(filters.dateFrom) > Date.parse(filters.dateTo)) throw new Error("dateFrom must not be after dateTo");
  if (args.tags !== undefined) filters.tags = parseTags(args.tags);
  return filters;
}
function metadataChanges(args: Record<string, unknown>): Partial<MemoryMetadata> {
  const metadata: Partial<MemoryMetadata> = {};
  if (args.importance !== undefined) {
    if (typeof args.importance !== "number" || !Number.isFinite(args.importance) || args.importance < 1 || args.importance > 10) throw new Error("importance must be between 1 and 10");
    metadata.importance = args.importance;
  }
  for (const key of ["tags", "entities"] as const) if (args[key] !== undefined) metadata[key] = parseTags(args[key]);
  for (const key of ["knowledgeType", "status", "project"] as const) if (args[key] !== undefined) {
    if (typeof args[key] !== "string") throw new Error(`${key} must be a string`);
    metadata[key] = args[key];
  }
  if (metadata.status && !["candidate", "confirmed", "verified", "superseded", "obsolete"].includes(metadata.status)) throw new Error("invalid knowledge status");
  if (metadata.knowledgeType && !["observation", "decision", "solution", "pitfall", "constraint", "pattern", "procedure", "question"].includes(metadata.knowledgeType)) throw new Error("invalid knowledgeType");
  if (args.relations !== undefined) throw new Error("use memory_link to create relations");
  return metadata;
}
function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}
async function embedFile(db: MemoryDatabase, config: Config, path: string): Promise<string> {
  const chunks = db.chunksForPath(path);
  try {
    for (const chunk of chunks) {
      if (chunk.embedding && chunk.embedding_model === config.embeddingModel) continue;
      const vector = await embed(chunk.text, config.embeddingModel);
      const current = db.chunksForPath(path).find((row) => row.id === chunk.id);
      if (current?.text === chunk.text) db.setChunkEmbedding(chunk.id, vector, config.embeddingModel, vector.length);
    }
    return "ready";
  } catch { return "unavailable"; }
}

export async function memorySearch(args: Record<string, unknown>): Promise<unknown> {
  const query = requiredString(args, "query");
  const filters = searchFilters(args);
  const { config, db } = getState();
  const limit = boundedInteger(args.limit, config.maxResults, 100);
  const threshold = args.threshold ?? config.minScore;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) throw new Error("threshold must be finite");
  db.quickSync();
  const candidateLimit = Math.min(500, Math.max(100, limit * 5));
  const queryVector = embed(query, config.embeddingModel).catch(() => null);
  const textRows = db.searchText(query, filters, candidateLimit);
  const q = await queryVector;
  const vectorRows = q ? db.searchVector(q, filters, candidateLimit, config.embeddingModel) : [];
  const textMap = new Map(textRows.map((item) => [item.row.id, item]));
  const vectorMap = new Map(vectorRows.map((item) => [item.row.id, item]));
  const ids = new Set([...textMap.keys(), ...vectorMap.keys()]);
  const items: SearchItem[] = [...ids].map((id) => {
    const row = (textMap.get(id)?.row ?? vectorMap.get(id)?.row)!;
    const vectorScore = vectorMap.get(id)?.score ?? 0;
    const textScore = textMap.get(id)?.score ?? 0;
    const score = (config.vectorWeight * vectorScore + config.textWeight * textScore) * (0.75 + row.importance * 0.05);
    return { id, path: relative(config.memoryDir, row.path), snippet: row.text, score, vectorScore, textScore, importance: row.importance, tags: JSON.parse(row.tags), status: row.status, knowledgeType: row.knowledge_type ?? undefined, project: row.project ?? undefined, agent: row.agent, created: row.created, startLine: row.start_line, endLine: row.end_line };
  }).filter((item) => item.score >= threshold);
  return { results: rankResults(items, config.mmrEnabled, limit), mode: q ? "hybrid" : "text-only", total: items.length, candidateLimit };
}

export async function memoryWrite(args: Record<string, unknown>): Promise<unknown> {
  const content = requiredString(args, "content");
  const metadata = metadataChanges(args);
  const { config, db } = getState();
  const month = new Date().toISOString().slice(0, 7);
  const monthDir = join(config.memoryDir, month);
  mkdirSync(monthDir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`;
  const path = safePath(config, join(month, name));
  atomicWrite(path, renderMarkdown(content, metadata, config.agent));
  db.indexFile(path);
  const row = db.findPath(path);
  if (row) db.addProvenance(row.id, "created", config.agent, null);
  return { path: join(month, name), status: "created", embedding: await embedFile(db, config, path) };
}
export async function memoryUpdate(args: Record<string, unknown>): Promise<unknown> {
  const requested = requiredString(args, "path");
  const content = requiredString(args, "content");
  const metadata = metadataChanges(args);
  const { config, db } = getState();
  const path = safePath(config, requested);
  if (!existsSync(path)) throw new Error("memory file not found");
  const existing = parseMarkdown(readFileSync(path, "utf8"), config.agent);
  atomicWrite(path, renderMarkdown(content, { ...existing.metadata, ...metadata }, config.agent));
  db.indexFile(path);
  const row = db.findPath(path);
  if (row) db.addProvenance(row.id, "updated", config.agent, null);
  return { path: requested, status: "updated", embedding: await embedFile(db, config, path) };
}
export async function memoryRead(args: Record<string, unknown>): Promise<unknown> {
  const path = requiredString(args, "path");
  const { config, db } = getState();
  const full = safePath(config, path);
  if (!existsSync(full)) throw new Error("memory file not found");
  db.quickSync();
  const id = db.findPath(full)?.id ?? -1;
  return { path, content: readFileSync(full, "utf8"), relations: db.relations(id), provenance: db.provenance(id) };
}
export async function memoryList(args: Record<string, unknown> = {}): Promise<unknown> {
  const filters = searchFilters(args);
  const limit = boundedInteger(args.limit, 1000, 10000);
  const { config, db } = getState();
  db.quickSync();
  return { files: db.listPaths(filters, limit).map((path) => relative(config.memoryDir, path)) };
}
export async function memoryPromote(args: Record<string, unknown>): Promise<unknown> {
  const path = requiredString(args, "path");
  const status = args.status ?? "confirmed";
  const changes = metadataChanges({ ...args, status });
  const { config, db } = getState();
  const full = safePath(config, path);
  const existing = parseMarkdown(readFileSync(full, "utf8"), config.agent);
  atomicWrite(full, renderMarkdown(existing.body, { ...existing.metadata, ...changes }, config.agent));
  db.indexFile(full);
  const row = db.findPath(full);
  if (row) db.addProvenance(row.id, `status:${status}`, config.agent, row.id);
  return { path, status };
}
export async function memoryLink(args: Record<string, unknown>): Promise<unknown> {
  const source = requiredString(args, "source");
  const target = requiredString(args, "target");
  const relationType = requiredString(args, "relationType");
  if (!["derived_from", "supports", "corrects", "supersedes", "verifies", "related_to"].includes(relationType)) throw new Error("invalid relationType");
  const { db, config } = getState();
  db.quickSync();
  const a = db.findPath(safePath(config, source));
  const b = db.findPath(safePath(config, target));
  if (!a || !b) throw new Error("source or target memory not found");
  db.addRelation(a.id, relationType, b.id, config.agent);
  return { source, target, relationType };
}
export async function memoryRestore(args: Record<string, unknown>): Promise<unknown> {
  if (args.confirm !== true) throw new Error("restore requires confirm=true");
  const current = getState();
  const backup = `${current.config.dbPath}.bak`;
  if (!existsSync(backup)) throw new Error("no SQLite backup exists");
  const snapshot = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    if (snapshot.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite backup failed integrity check");
  } finally { snapshot.close(); }
  throw new Error("in-process restore is disabled: stop all remme clients and restore the verified SQLite snapshot offline; Markdown files and later edits are not reverted");
}

function validateImportPath(path: string): string { return resolve(path); }
export async function memoryImport(args: Record<string, unknown>): Promise<unknown> {
  const sourceType = args.sourceType ?? "markdown";
  if (sourceType !== "markdown" && sourceType !== "openclaw") throw new Error("unknown sourceType");
  const source = args.source === undefined ? undefined : validateImportPath(requiredString(args, "source"));
  const dbPath = args.db === undefined ? undefined : validateImportPath(requiredString(args, "db"));
  if (!source && !dbPath) throw new Error("at least one of source or db must be provided");
  const embedding = args.embedding ?? "skip";
  if (embedding !== "auto" && embedding !== "reuse" && embedding !== "rebuild" && embedding !== "skip") throw new Error("invalid embedding mode");
  const { config, db } = getState();
  const importer = getImporter(sourceType, config, db, embed, { source, db: dbPath, embedding, dryRun: args.dryRun === true, includeSystem: args.includeSystem === true });
  return importer.import();
}
export async function memoryImportStatus(args: Record<string, unknown>): Promise<unknown> {
  const { db } = getState();
  return { imports: db.importStatus(args.importId === undefined ? undefined : requiredString(args, "importId")) };
}
export async function memoryImportRollback(args: Record<string, unknown>): Promise<unknown> {
  if (args.confirm !== true) throw new Error("rollback requires confirm=true");
  const importId = requiredString(args, "importId");
  const { config, db } = getState();
  const batch = db.importStatus(importId) as { status: string }[];
  if (!batch.length) throw new Error("import not found");
  if (["pending", "running"].includes(batch[0].status)) throw new Error("cannot rollback an active import");
  const paths = db.db.prepare("SELECT path FROM memory_chunks WHERE import_id = ? UNION SELECT path FROM memory_sources WHERE import_id = ?").all(importId, importId) as { path: string }[];
  const removable: string[] = [];
  for (const row of paths) {
    if (!existsSync(row.path)) continue;
    const path = safePath(config, row.path);
    const parsed = parseMarkdown(readFileSync(path, "utf8"), config.agent);
    if (parsed.metadata.importId === importId) removable.push(path);
  }
  for (const path of removable) rmSync(path);
  const result = db.rollbackImport(importId);
  return { importId, status: "rolled-back", removedChunks: result.removedChunks, removedSources: result.removedSources, removedFiles: removable.length };
}
