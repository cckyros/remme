export interface Classification { category: string; knowledgeType: string; }

const systemDirs = new Set([".dreams", "dreaming", "pags", "prompt-templates"]);

export function classify(filePath: string, includeSystem = false): Classification | null {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const dir = parts.length > 1 ? parts[parts.length - 2] : "";
  const topDir = parts[0] ?? "";
  if (systemDirs.has(topDir) && !includeSystem) return null;
  if (name === "MEMORY.md" || name === "USER.md") return { category: "curated", knowledgeType: "observation" };
  if (/^\d{4}-\d{2}-\d{2}/.test(name)) return { category: "daily", knowledgeType: "observation" };
  if (dir === "projects" || topDir === "projects") return { category: "projects", knowledgeType: "observation" };
  if (dir === "technical" || topDir === "technical") return { category: "technical", knowledgeType: "observation" };
  if (dir === "learnings" || topDir === "learnings") return { category: "learnings", knowledgeType: "pattern" };
  if (systemDirs.has(topDir)) return { category: "system", knowledgeType: "observation" };
  return { category: "curated", knowledgeType: "observation" };
}
