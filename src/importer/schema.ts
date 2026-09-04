import type Database from "better-sqlite3";

export interface SchemaInfo { compatible: boolean; tables: string[]; reason?: string; }

export function detectSchema(db: Database.Database): SchemaInfo {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const names = tables.map((t) => t.name);
  const hasSources = names.includes("sources") || names.includes("memory_sources");
  const hasChunks = names.includes("chunks") || names.includes("memory_chunks");
  if (!hasSources && !hasChunks) return { compatible: false, tables: names, reason: "no sources or chunks table found" };
  return { compatible: true, tables: names };
}
