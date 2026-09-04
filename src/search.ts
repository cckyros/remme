export interface SearchItem { id: number; path: string; snippet: string; score: number; vectorScore: number; textScore: number; importance: number; tags: string[]; status: string; knowledgeType?: string; project?: string; agent: string; startLine: number; endLine: number; }

export function rankResults(items: SearchItem[], mmrEnabled = true): SearchItem[] {
  const ranked = [...items].sort((a, b) => b.score - a.score);
  if (!mmrEnabled) return ranked;
  const out: SearchItem[] = [];
  const outWordSets: Set<string>[] = [];
  for (const item of ranked) {
    const words = new Set(item.snippet.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    let duplicate = false;
    for (const existing of outWordSets) {
      let intersection = 0;
      for (const w of words) if (existing.has(w)) intersection++;
      const union = words.size + existing.size - intersection;
      if (union > 0 && intersection / union > 0.85) { duplicate = true; break; }
    }
    if (!duplicate) { out.push(item); outWordSets.push(words); }
  }
  return out;
}
