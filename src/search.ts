import { cosine } from "./embedding.ts";

export interface SearchItem { id: number; path: string; snippet: string; score: number; vectorScore: number; textScore: number; importance: number; tags: string[]; status: string; knowledgeType?: string; project?: string; agent: string; startLine: number; endLine: number; }

export function rankResults(items: SearchItem[], mmrEnabled = true): SearchItem[] {
  const ranked = [...items].sort((a, b) => b.score - a.score);
  if (!mmrEnabled) return ranked;
  const out: SearchItem[] = [];
  for (const item of ranked) {
    const duplicate = out.some((existing) => cosine(new Float32Array([...existing.snippet].map((c) => c.charCodeAt(0))), new Float32Array([...item.snippet].map((c) => c.charCodeAt(0)))) > 0.98);
    if (!duplicate) out.push(item);
  }
  return out;
}
