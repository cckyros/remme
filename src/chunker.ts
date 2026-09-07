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
  const match = source.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  const raw = match?.[1] ?? "";
  const get = (key: string): string | undefined => {
    const value = raw.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)`, "m"))?.[1]?.trim();
    if (!value) return undefined;
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" ? parsed : value; } catch { return value; }
  };
  const number = (key: string): number | undefined => {
    const value = get(key);
    if (value === undefined || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
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
      sourceId: number("sourceId"), embeddingDims: number("embeddingDims"), embeddingModel: get("embeddingModel"), originalRecordId: get("originalRecordId"),
    },
    body: match?.[2] ?? source,
  };
}

export function renderMarkdown(content: string, metadata: Partial<MemoryMetadata>, agent: string): string {
  const created = metadata.created ?? new Date().toISOString();
  const encode = (value: string | string[]) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const lines = ["---", `importance: ${metadata.importance ?? 5}`, `tags: ${encode(metadata.tags ?? [])}`, `knowledgeType: ${encode(metadata.knowledgeType ?? "observation")}`, `status: ${encode(metadata.status ?? "candidate")}`, `project: ${encode(metadata.project ?? "")}`, `created: ${encode(created)}`, `agent: ${encode(metadata.agent ?? agent)}`, `entities: ${encode(metadata.entities ?? [])}`];
  for (const key of ["origin", "importId", "source", "originalPath", "category", "embeddingModel", "originalRecordId"] as const) {
    const value = metadata[key];
    if (value !== undefined) lines.push(`${key}: ${encode(value)}`);
  }
  for (const key of ["sourceId", "embeddingDims"] as const) {
    const value = metadata[key];
    if (value !== undefined && Number.isFinite(value)) lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", content.trim(), "");
  return lines.join("\n");
}

export function chunkMarkdown(source: string, metadata: MemoryMetadata, maxChars = 1800): Chunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be a positive safe integer character count");
  const body = source.trim();
  if (!body) return [];
  const leadingLength = source.length - source.trimStart().length;
  let line = 1 + (source.slice(0, leadingLength).match(/\n/g)?.length ?? 0);
  const characters = Array.from(body);
  const chunks: Chunk[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = Math.min(offset + maxChars, characters.length);
    if (end < characters.length) {
      let boundary = -1;
      for (let index = end - 1; index >= offset; index--) {
        if (characters[index] === "\n") { boundary = index + 1; break; }
      }
      if (boundary < 0) {
        for (let index = end - 1; index > offset; index--) {
          if (/\s/u.test(characters[index])) { boundary = index + 1; break; }
        }
      }
      if (boundary > offset) end = boundary;
    }
    const text = characters.slice(offset, end).join("");
    const newlines = text.match(/\n/g)?.length ?? 0;
    chunks.push({ text, startLine: line, endLine: line + newlines - (text.endsWith("\n") ? 1 : 0), metadata });
    line += newlines;
    offset = end;
  }
  return chunks;
}
