import { join } from "node:path";
import type Database from "better-sqlite3";
import { BaseImporter, type Classification, type ImportOptions, type EmbedFn } from "./base.ts";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";
import { chunkMarkdown, renderMarkdown } from "../chunker.ts";
import { classify as classifyOpenClaw } from "./classifier.ts";
import { detectSchema } from "./schema.ts";
import { hashContent } from "./manifest.ts";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export class OpenClawImporter extends BaseImporter {
  constructor(config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) { super(config, db, embed, options); }
  get sourceType(): string { return "openclaw"; }
  classify(filePath: string): Classification | null { return classifyOpenClaw(filePath, this.options.includeSystem); }

  async importSqliteRecords(sdb: Database.Database, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[], embeddingStats: { reused: number; rebuilt: number; skipped: number }): Promise<number> {
    const schema = detectSchema(sdb);
    if (!schema.compatible) throw new Error(`SQLite unreadable: ${schema.reason}`);
    let chunkCount = 0;
    const tableNames = (sdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    const chunksTable = tableNames.find((n) => n === "chunks" || n === "memory_chunks");
    if (!chunksTable) { warnings.push("SQLite has no chunks table, skipping record import"); return 0; }
    const rows = sdb.prepare(`SELECT * FROM ${chunksTable} LIMIT 10000`).all() as Record<string, unknown>[];
    for (const row of rows) {
      try {
        const text = String(row.text ?? row.content ?? "");
        if (!text.trim()) continue;
        const recordId = String(row.id ?? "");
        const sourceHash = hashContent(text);
        const existing = this.db.findImportRecord("sqlite", "sqlite", recordId, sourceHash);
        if (existing?.status === "imported") continue;
        const category = "technical";
        const targetDir = join(stagingDir, category);
        mkdirSync(targetDir, { recursive: true });
        const targetPath = join(targetDir, `sqlite-${recordId}.md`);
        const absTarget = resolve(targetPath);
        const metadata = { importance: 5, tags: ["openclaw", "sqlite"], knowledgeType: "observation", status: "candidate", project: "openclaw", agent: "openclaw", created: String(row.created_at ?? row.created ?? new Date().toISOString()), entities: [], origin: "imported" as const, importId, source: "openclaw", originalPath: "sqlite", category, originalRecordId: recordId };
        writeFileSync(targetPath, renderMarkdown(text, metadata, "openclaw"));
        const chunks = chunkMarkdown(text, metadata);
        const chunkIds: number[] = [];
        for (const chunk of chunks) {
          const hash = `${absTarget}:${sourceHash}:${importId}:${chunk.startLine}`;
          chunkIds.push(this.db.insertChunk(absTarget, chunk, hash));
          chunkCount++;
        }
        let embeddingMode = "skip";
        let embeddingDims: number | null = null;
        if (this.options.embedding !== "skip" && row.embedding) {
          const rawEmb = row.embedding as Buffer;
          if (rawEmb && rawEmb.length > 0) {
            const dims = rawEmb.length / 4;
            if (this.options.embedding === "reuse" || (this.options.embedding === "auto" && dims === 384)) {
              const emb = new Float32Array(rawEmb.buffer, rawEmb.byteOffset, dims);
              for (const cid of chunkIds) this.db.setChunkEmbedding(cid, emb, "openclaw-reuse", dims);
              embeddingMode = "reuse"; embeddingDims = dims; embeddingStats.reused += chunkIds.length;
            }
          }
        }
        if (embeddingMode === "skip") {
          if (this.options.embedding === "rebuild") {
            try {
              const emb = await this.embed(text, this.config.embeddingModel);
              for (const cid of chunkIds) this.db.setChunkEmbedding(cid, emb, this.config.embeddingModel, emb.length);
              embeddingMode = "rebuild"; embeddingDims = emb.length; embeddingStats.rebuilt += chunkIds.length;
            } catch { embeddingStats.skipped += chunkIds.length; }
          } else { embeddingStats.skipped += chunkIds.length; }
        }
        this.db.addSource(absTarget, "imported", importId, "sqlite", "sqlite", recordId, sourceHash, 0, text.length);
        this.db.addImportRecord(importId, "sqlite", "sqlite", recordId, sourceHash, null, chunkIds, embeddingMode, embeddingDims, "imported");
        fileCounts[category] = (fileCounts[category] ?? 0) + 1;
      } catch (e) {
        errors.push(`failed to import sqlite record ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return chunkCount;
  }
}
