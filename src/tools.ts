import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig, ensureConfigDirs, type Config } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { embed } from "./embedding.ts";
import { parseMarkdown, renderMarkdown } from "./chunker.ts";
import { rankResults, type SearchItem } from "./search.ts";
import { OpenClawImporter } from "./importer/openclaw.ts";
import { getImporter, availableImporters } from "./importer/registry.ts";

let state: { config: Config; db: MemoryDatabase } | null = null;
export function closeMemoryStore(): void { state?.db.close(); state = null; }
function getState() { if (!state) { const config = loadConfig(); ensureConfigDirs(config); state = { config, db: new MemoryDatabase(config) }; state.db.sync(); } return state; }
function safePath(config: Config, path: string): string { const root = resolve(config.memoryDir); const target = resolve(root, path); if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) throw new Error("path must stay inside memory directory"); return target; }
function parseTags(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }

export async function memorySearch(args: Record<string, unknown>): Promise<unknown> { const { config, db } = getState(); db.quickSync(); const query = String(args.query ?? ""); const q = await embed(query, config.embeddingModel).catch(() => null); const textRows = db.searchText(query); const textMap = new Map<number, { row: typeof textRows[number]; score: number }>(); for (let i = 0; i < textRows.length; i++) textMap.set(textRows[i].id, { row: textRows[i], score: 1 - i / 100 }); const vectorRows = q ? db.searchVector(q) : []; const vectorMap = new Map<number, { row: typeof vectorRows[number]["row"]; score: number }>(); for (const v of vectorRows) vectorMap.set(v.row.id, { row: v.row, score: v.score }); const ids = new Set<number>(); for (const id of textMap.keys()) ids.add(id); for (const id of vectorMap.keys()) ids.add(id); const items: SearchItem[] = [...ids].map((id) => { const row = (textMap.get(id)?.row ?? vectorMap.get(id)?.row)!; const vs = vectorMap.get(id)?.score ?? 0; const ts = textMap.get(id)?.score ?? 0; return { id, path: relative(config.memoryDir, row.path), snippet: row.text, score: (config.vectorWeight * vs + config.textWeight * ts) * (0.75 + row.importance * 0.05), vectorScore: vs, textScore: ts, importance: row.importance, tags: JSON.parse(row.tags), status: row.status, knowledgeType: row.knowledge_type ?? undefined, project: row.project ?? undefined, agent: row.agent, startLine: row.start_line, endLine: row.end_line }; }).filter((x) => x.score >= Number(args.threshold ?? config.minScore)).filter((x) => !args.project || x.project === args.project).filter((x) => !args.agent || x.agent === args.agent).filter((x) => !args.knowledgeType || x.knowledgeType === args.knowledgeType).filter((x) => !args.status || x.status === args.status).filter((x) => !args.tags || parseTags(args.tags).every((tag) => x.tags.includes(tag))); return { results: rankResults(items, config.mmrEnabled).slice(0, Number(args.limit ?? config.maxResults)), mode: q ? "hybrid" : "fts-only" }; }

export async function memoryWrite(args: Record<string, unknown>): Promise<unknown> { const { config, db } = getState(); const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}.md`; const path = join(config.memoryDir, name); writeFileSync(path, renderMarkdown(String(args.content ?? ""), { importance: Number(args.importance ?? 5), tags: parseTags(args.tags), knowledgeType: args.knowledgeType ? String(args.knowledgeType) : undefined, status: args.status ? String(args.status) : "candidate", project: args.project ? String(args.project) : undefined, entities: parseTags(args.entities) }, config.agent)); db.indexFile(path); await embed(String(args.content ?? ""), config.embeddingModel).then((vector) => db.setEmbedding(path, vector)).catch(() => {}); return { path: name, status: "created" }; }
export async function memoryUpdate(args: Record<string, unknown>): Promise<unknown> { const { config, db } = getState(); const path = safePath(config, String(args.path ?? "")); if (!existsSync(path)) throw new Error("memory file not found"); writeFileSync(path, renderMarkdown(String(args.content ?? ""), { importance: Number(args.importance ?? 5), tags: parseTags(args.tags), knowledgeType: args.knowledgeType ? String(args.knowledgeType) : undefined, status: args.status ? String(args.status) : "candidate", project: args.project ? String(args.project) : undefined, entities: parseTags(args.entities) }, config.agent)); db.indexFile(path); await embed(String(args.content ?? ""), config.embeddingModel).then((vector) => db.setEmbedding(path, vector)).catch(() => {}); return { path: String(args.path), status: "updated" }; }
export async function memoryRead(args: Record<string, unknown>): Promise<unknown> { const { config, db } = getState(); const path = String(args.path ?? ""); const full = safePath(config, path); if (!existsSync(full)) throw new Error("memory file not found"); const id = db.findPath(full)?.id ?? -1; return { path, content: readFileSync(full, "utf8"), relations: db.relations(id), provenance: db.provenance(id) }; }
export async function memoryList(): Promise<unknown> { const { config } = getState(); return { files: readdirSync(config.memoryDir).filter((x) => x.endsWith(".md")) }; }
export async function memoryPromote(args: Record<string, unknown>): Promise<unknown> { const { config, db } = getState(); const status = String(args.status ?? "confirmed"); const existing = safePath(config, String(args.path ?? "")); const content = args.content === undefined ? parseMarkdown(readFileSync(existing, "utf8"), config.agent).body : args.content; const result = await memoryUpdate({ ...args, content, status }) as { path: string; status: string }; const row = db.findPath(safePath(config, result.path)); if (row) db.addProvenance(row.id, `status:${status}`, config.agent, row.id); return { ...result, status }; }
export async function memoryLink(args: Record<string, unknown>): Promise<unknown> { const { db, config } = getState(); const find = (p: unknown) => db.findPath(safePath(config, String(p))); const a = find(args.source); const b = find(args.target); if (!a || !b) throw new Error("source or target memory not found"); db.addRelation(a.id, String(args.relationType), b.id, config.agent); return { source: args.source, target: args.target, relationType: args.relationType }; }
export async function memoryRestore(args: Record<string, unknown>): Promise<unknown> { if (args.confirm !== true) throw new Error("restore requires confirm=true"); const current = getState(); const backup = `${current.config.dbPath}.bak`; if (!existsSync(backup)) throw new Error("no SQLite backup exists"); current.db.close(); copyFileSync(backup, current.config.dbPath); state = null; process.env.REMME_SKIP_BACKUP = "1"; getState().db.sync(); delete process.env.REMME_SKIP_BACKUP; return { restored: true, path: current.config.dbPath }; }

function validateImportPath(path: string): string {
  const resolved = resolve(path);
  if (resolved.includes("..")) throw new Error("path must not contain parent directory traversal");
  return resolved;
}

export async function memoryImport(args: Record<string, unknown>): Promise<unknown> {
  const { config, db } = getState();
  const sourceType = String(args.sourceType ?? "markdown");
  const source = args.source ? validateImportPath(String(args.source)) : undefined;
  const dbPath = args.db ? validateImportPath(String(args.db)) : undefined;
  if (!source && !dbPath) throw new Error("at least one of source or db must be provided");
  const embedding = String(args.embedding ?? "skip") as "auto" | "reuse" | "rebuild" | "skip";
  const dryRun = args.dryRun === true;
  const includeSystem = args.includeSystem === true;
  const importer = getImporter(sourceType, config, db, embed, { source, db: dbPath, embedding, dryRun, includeSystem });
  return importer.import();
}

export async function memoryImportStatus(args: Record<string, unknown>): Promise<unknown> {
  const { db } = getState();
  const importId = args.importId ? String(args.importId) : undefined;
  return { imports: db.importStatus(importId) };
}

export async function memoryImportRollback(args: Record<string, unknown>): Promise<unknown> {
  if (args.confirm !== true) throw new Error("rollback requires confirm=true");
  const { config, db } = getState();
  const importId = String(args.importId ?? "");
  if (!importId) throw new Error("importId is required");
  const result = db.rollbackImport(importId);
  const imports = db.importStatus(importId) as { source_type: string }[];
  const sourceType = imports[0]?.source_type ?? "openclaw";
  const importDir = join(config.memoryDir, "imports", sourceType);
  if (existsSync(importDir)) rmSync(importDir, { recursive: true, force: true });
  return { importId, status: "rolled-back", removedChunks: result.removedChunks, removedSources: result.removedSources };
}
