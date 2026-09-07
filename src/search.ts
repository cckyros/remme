export interface SearchItem { id: number; path: string; snippet: string; score: number; vectorScore: number; textScore: number; importance: number; tags: string[]; status: string; knowledgeType?: string; project?: string; agent: string; startLine: number; endLine: number; }

function snippetWordSet(snippet: string): Set<string> {
  const normalized = snippet.normalize("NFKC").toLowerCase();
  const separated = normalized.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/gu, " $1 ");
  const words = new Set<string>();
  for (const token of separated.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) {
      const characters = Array.from(token);
      if (characters.length === 1) words.add(token);
      for (let index = 0; index < characters.length - 1; index++) words.add(characters[index] + characters[index + 1]);
    } else words.add(token);
  }
  if (words.size === 0) words.add(normalized.trim());
  return words;
}

export function rankResults(items: SearchItem[], mmrEnabled = true, limit = 100): SearchItem[] {
  const resultLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 100;
  if (resultLimit === 0) return [];
  const ranked = [...items].sort((a, b) => b.score - a.score);
  const jaccardDedupEnabled = mmrEnabled;
  if (!jaccardDedupEnabled) return ranked.slice(0, resultLimit);
  const out: SearchItem[] = [];
  const outWordSets: Set<string>[] = [];
  for (const item of ranked) {
    const words = snippetWordSet(item.snippet);
    let duplicate = false;
    for (const existing of outWordSets) {
      let intersection = 0;
      for (const w of words) if (existing.has(w)) intersection++;
      const union = words.size + existing.size - intersection;
      if (union > 0 && intersection / union > 0.85) { duplicate = true; break; }
    }
    if (!duplicate) { out.push(item); outWordSets.push(words); }
    if (out.length >= resultLimit) break;
  }
  return out;
}
