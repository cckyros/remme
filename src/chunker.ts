export interface MemoryMetadata {
  importance: number;
  tags: string[];
  knowledgeType?: string;
  status: string;
  project?: string;
  agent: string;
  created: string;
  entities: string[];
  origin?: string;
  importId?: string;
  source?: string;
  originalPath?: string;
  category?: string;
  sourceId?: number;
  embeddingDims?: number;
  embeddingModel?: string;
  originalRecordId?: string;
}

export interface Chunk { text: string; startLine: number; endLine: number; metadata: MemoryMetadata; }

export function parseMarkdown(source: string, fallbackAgent = "unknown"): { metadata: MemoryMetadata; body: string } {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const raw = match?.[1] ?? "";
  const get = (key: string) => raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const list = (key: string) => {
    const value = get(key);
    if (!value) return [];
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return value.split(",").map((x) => x.trim()).filter(Boolean); }
  };
  const importance = Number(get("importance"));
  return {
    metadata: {
      importance: Number.isFinite(importance) ? Math.min(10, Math.max(1, importance)) : 5,
      tags: list("tags"), knowledgeType: get("knowledgeType"), status: get("status") ?? "candidate",
      project: get("project"), agent: get("agent") ?? fallbackAgent, created: get("created") ?? new Date().toISOString(), entities: list("entities"),
      origin: get("origin") ?? "native", importId: get("importId"), source: get("source"), originalPath: get("originalPath"), category: get("category"),
    },
    body: match?.[2] ?? source,
  };
}

export function renderMarkdown(content: string, metadata: Partial<MemoryMetadata>, agent: string): string {
  const created = metadata.created ?? new Date().toISOString();
  const lines = ["---", `importance: ${metadata.importance ?? 5}`, `tags: ${JSON.stringify(metadata.tags ?? [])}`, `knowledgeType: ${metadata.knowledgeType ?? "observation"}`, `status: ${metadata.status ?? "candidate"}`, `project: ${metadata.project ?? ""}`, `created: ${created}`, `agent: ${metadata.agent ?? agent}`, `entities: ${JSON.stringify(metadata.entities ?? [])}`];
  if (metadata.origin === "imported") { lines.push(`origin: imported`, `importId: ${metadata.importId ?? ""}`, `source: ${metadata.source ?? ""}`, `originalPath: ${metadata.originalPath ?? ""}`, `category: ${metadata.category ?? ""}`); }
  lines.push("---", "", content.trim(), "");
  return lines.join("\n");
}

export function chunkMarkdown(source: string, metadata: MemoryMetadata, maxChars = 1800): Chunk[] {
  const body = source.trim();
  if (!body) return [];
  const parts = body.match(new RegExp(`[\\s\\S]{1,${maxChars}}(?:\\n|$)`, "g")) ?? [body];
  let cursor = 1;
  return parts.map((text) => { const startLine = cursor; cursor += text.split("\n").length; return { text: text.trim(), startLine, endLine: cursor - 1, metadata }; });
}
