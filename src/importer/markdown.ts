import { BaseImporter, type Classification, type ImportOptions, type EmbedFn } from "./base.ts";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";

export class MarkdownImporter extends BaseImporter {
  constructor(config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) { super(config, db, embed, options); }
  get sourceType(): string { return "markdown"; }
  classify(filePath: string): Classification | null {
    const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 1) return { category: "general", knowledgeType: "observation" };
    const dir = parts[0];
    if (dir.startsWith(".") && !this.options.includeSystem) return null;
    return { category: dir, knowledgeType: "observation" };
  }
}
