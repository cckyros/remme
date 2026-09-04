import { BaseImporter, type ImportOptions, type EmbedFn } from "./base.ts";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";
import { MarkdownImporter } from "./markdown.ts";
import { OpenClawImporter } from "./openclaw.ts";

const importers: Record<string, (config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) => BaseImporter> = {
  markdown: (config, db, embed, options) => new MarkdownImporter(config, db, embed, options),
  openclaw: (config, db, embed, options) => new OpenClawImporter(config, db, embed, options),
};

export function getImporter(sourceType: string, config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions): BaseImporter {
  const factory = importers[sourceType];
  if (!factory) throw new Error(`unknown source type: ${sourceType}. Available: ${Object.keys(importers).join(", ")}`);
  return factory(config, db, embed, options);
}

export function availableImporters(): string[] { return Object.keys(importers); }
