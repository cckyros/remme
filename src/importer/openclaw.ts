import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { BaseImporter, type Classification, type ImportOptions, type EmbedFn } from "./base.ts";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";
import { chunkMarkdown, renderMarkdown } from "../chunker.ts";
import { classify as classifyOpenClaw } from "./classifier.ts";
import { detectSchema } from "./schema.ts";
import { hashContent } from "./manifest.ts";
import { mkdirSync, writeFileSync } from "node:fs";

export class OpenClawImporter extends BaseImporter {
  constructor(config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) { super(config, db, embed, options); }
  get sourceType(): string { return "openclaw"; }
  classify(filePath: string): Classification | null { return classifyOpenClaw(filePath, this.options.includeSystem); }

  private chunksTable(sdb: Database.Database): string {
    const schema = detectSchema(sdb);
    if (!schema.compatible) throw new Error(`SQLite unreadable: ${schema.reason}`);
    const table = schema.tables.find((name) => name === "chunks" || name === "memory_chunks");
    if (!table) throw new Error("SQLite schema has no readable chunks table");
    const columns = (sdb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("id") || (!columns.includes("text") && !columns.includes("content"))) {
      throw new Error("SQLite schema requires chunk id and text/content columns");
    }
    return table;
  }

  protected validateSqlite(sdb: Database.Database): void { this.chunksTable(sdb); }

  private reusableEmbedding(row: Record<string, unknown>, chunkCount: number, warnings: string[]): Float32Array | null {
    const model = row.embedding_model ?? row.model;
    const targetDims = this.config.embeddingModel === "Xenova/all-MiniLM-L6-v2" ? 384 : null;
    let embedding: Float32Array | null = null;
    const raw = row.embedding;
    if (Buffer.isBuffer(raw) && raw.byteLength > 0 && raw.byteLength % 4 === 0) {
      embedding = new Float32Array(raw.byteLength / 4);
      for (let i = 0; i < embedding.length; i++) embedding[i] = raw.readFloatLE(i * 4);
    } else if (typeof raw === "string") {
      try {
        const values: unknown = JSON.parse(raw);
        if (Array.isArray(values) && values.length && values.every((value) => typeof value === "number" && Number.isFinite(value))) embedding = Float32Array.from(values);
      } catch { embedding = null; }
    }
    if (typeof model !== "string" || !model.trim()) {
      warnings.push(`SQLite record ${row.id}: unknown embedding model; skipping reuse`);
    } else if (model !== this.config.embeddingModel || targetDims === null) {
      warnings.push(`SQLite record ${row.id}: incompatible or unverified embedding model ${model}; skipping reuse`);
    } else if (!embedding || !embedding.every(Number.isFinite) || embedding.length !== targetDims || (row.embedding_dims != null && Number(row.embedding_dims) !== embedding.length)) {
      warnings.push(`SQLite record ${row.id}: incompatible embedding dimensions or invalid vector; skipping reuse`);
    } else if (chunkCount !== 1) {
      warnings.push(`SQLite record ${row.id}: record split into multiple chunks; skipping whole-record embedding reuse`);
    } else {
      return embedding;
    }
    return null;
  }

  async importSqliteRecords(sdb: Database.Database, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[], embeddingStats: { reused: number; rebuilt: number; skipped: number }): Promise<number> {
    const table = this.chunksTable(sdb);
    const identity = this.sourceIdentity(this.options.db ?? sdb.name);
    let chunkCount = 0;
    const rows = sdb.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      try {
        const text = String(row.text ?? row.content ?? "");
        if (!text.trim()) continue;
        if (row.id == null) throw new Error("SQLite record has no id");
        const recordId = String(row.id);
        const sourceHash = hashContent(text);
        const existing = this.db.findImportRecord("sqlite", identity, recordId, sourceHash);
        if (existing?.status === "imported") continue;
        const category = "technical";
        const targetDir = join(stagingDir, category, "sqlite");
        mkdirSync(targetDir, { recursive: true });
        const filename = createHash("sha256").update(JSON.stringify([recordId, sourceHash])).digest("hex");
        const targetPath = join(targetDir, `${filename}.md`);
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
        if (this.options.embedding === "rebuild") {
          embeddingDims = await this.rebuildEmbeddings(chunks, chunkIds, warnings, embeddingStats);
          if (embeddingDims !== null) embeddingMode = "rebuild";
        } else if (this.options.embedding === "auto" || this.options.embedding === "reuse") {
          const emb = this.reusableEmbedding(row, chunks.length, warnings);
          if (emb) {
            this.db.setChunkEmbedding(chunkIds[0], emb, this.config.embeddingModel, emb.length);
            embeddingMode = "reuse"; embeddingDims = emb.length; embeddingStats.reused++;
          } else { embeddingStats.skipped += chunkIds.length; }
        } else { embeddingStats.skipped += chunkIds.length; }
        const sourceId = this.db.addSource(absTarget, "imported", importId, "sqlite", "sqlite", recordId, sourceHash, 0, Buffer.byteLength(text), embeddingDims === null ? undefined : this.config.embeddingModel, embeddingDims ?? undefined);
        this.db.addImportRecord(importId, "sqlite", identity, recordId, sourceHash, sourceId, chunkIds, embeddingMode, embeddingDims, "imported");
        this.manifestFiles.push({ originalPath: `sqlite:${recordId}`, category, targetPath: absTarget, hash: sourceHash, chunks: chunks.length });
        fileCounts[category] = (fileCounts[category] ?? 0) + 1;
      } catch (e) {
        errors.push(`failed to import sqlite record ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return chunkCount;
  }
}
