import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";
import { parseMarkdown, renderMarkdown, chunkMarkdown, type Chunk } from "../chunker.ts";
import { generateImportId, hashContent, writeManifest, type ImportManifest } from "./manifest.ts";

export interface ImportOptions {
  source?: string;
  db?: string;
  embedding: "auto" | "reuse" | "rebuild" | "skip";
  dryRun: boolean;
  includeSystem: boolean;
}

export interface ImportResult {
  importId: string;
  status: string;
  sourceType: string;
  files: Record<string, number>;
  chunks: number;
  embeddings: { reused: number; rebuilt: number; skipped: number };
  warnings: string[];
  errors: string[];
}

export type EmbedFn = (text: string, model: string) => Promise<Float32Array>;

export interface Classification { category: string; knowledgeType: string; }

export abstract class BaseImporter {
  protected config: Config;
  protected db: MemoryDatabase;
  protected embed: EmbedFn;
  protected options: ImportOptions;
  protected manifestFiles: ImportManifest["files"] = [];
  constructor(config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) {
    this.config = config; this.db = db; this.embed = embed; this.options = options;
  }
  abstract get sourceType(): string;
  abstract classify(filePath: string): Classification | null;
  importSqliteRecords?(sdb: Database.Database, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[], embeddingStats: { reused: number; rebuilt: number; skipped: number }): Promise<number>;

  protected validateSqlite(_sdb: Database.Database): void {
    throw new Error(`SQLite import is not supported for ${this.sourceType}`);
  }

  protected sourceIdentity(path: string): string {
    const canonical = realpathSync(path);
    return JSON.stringify([this.sourceType, process.platform === "win32" ? canonical.toLowerCase() : canonical]);
  }

  private async openSqlite(path: string): Promise<Database.Database> {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`SQLite file not found: ${path}`);
    const Database = (await import("better-sqlite3")).default;
    const sdb = new Database(path, { readonly: true, fileMustExist: true });
    try {
      sdb.pragma("query_only = ON");
      this.validateSqlite(sdb);
      return sdb;
    } catch (error) { sdb.close(); throw error; }
  }

  private validateSource(source: string): void {
    if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`Source directory not found: ${source}`);
  }

  async import(): Promise<ImportResult> {
    const { source, db: dbPath } = this.options;
    if (!source && !dbPath) throw new Error("at least one of source or db must be provided");
    const importId = generateImportId(this.sourceType);
    const archiveDir = resolve(this.config.importsDir, this.sourceType, importId);
    const rawDir = join(archiveDir, "raw");
    const indexedBase = resolve(this.config.memoryDir, "imports", this.sourceType);
    const stagingDir = join(indexedBase, `.staging-${importId}`);
    const finalDir = join(indexedBase, importId);
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    const errors: string[] = [];
    const fileCounts: Record<string, number> = {};
    let chunkCount = 0;
    let finalized = false;
    const embeddingStats = { reused: 0, rebuilt: 0, skipped: 0 };
    this.manifestFiles = [];

    if (this.options.dryRun) return this.dryRun(importId, source, dbPath, warnings);

    const running = this.db.hasRunningImport();
    if (running) throw new Error(`another import is running: ${running}`);

    this.db.createImport(importId, this.sourceType, source ?? "", dbPath ?? null, archiveDir, { ...this.options });

    const manifest = (status: string): ImportManifest => ({ id: importId, sourceType: this.sourceType, sourcePath: source ?? "", sourceDbPath: dbPath ?? null, targetPath: archiveDir, startedAt, completedAt: new Date().toISOString(), status, fileCount: Object.values(fileCounts).reduce((a, b) => a + b, 0), chunkCount, errorCount: errors.length, options: { ...this.options }, files: this.manifestFiles.map((file) => ({ ...file, targetPath: join(finalDir, relative(stagingDir, file.targetPath)) })) });
    try {
      this.db.updateImport(importId, "running");
      if (source) this.validateSource(source);
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(stagingDir, { recursive: true });
      if (source) {
        chunkCount += await this.importMarkdown(source, join(rawDir, "markdown"), stagingDir, importId, fileCounts, warnings, errors, embeddingStats);
      }
      if (dbPath) {
        const sdb = await this.openSqlite(dbPath);
        try {
          mkdirSync(join(rawDir, "sqlite"), { recursive: true });
          await sdb.backup(join(rawDir, "sqlite", basename(dbPath)));
          chunkCount += await this.importSqliteRecords!(sdb, stagingDir, importId, fileCounts, warnings, errors, embeddingStats);
        } finally { sdb.close(); }
      }
      if (errors.length) throw new Error(`Import failed with ${errors.length} record error(s)`);
      this.finalizeStaging(stagingDir, finalDir);
      finalized = true;
      this.db.moveImportPaths(importId, stagingDir, finalDir);
      const completed = manifest("completed");
      writeManifest(archiveDir, completed);
      this.db.updateImport(importId, "completed", completed.fileCount, chunkCount, 0);
      return { importId, status: "completed", sourceType: this.sourceType, files: fileCounts, chunks: chunkCount, embeddings: embeddingStats, warnings, errors };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      this.db.updateImport(importId, "failed", 0, 0, errors.length);
      try { this.db.rollbackImport(importId); }
      catch (error) { errors.push(`Failed to clean import DB records: ${error instanceof Error ? error.message : String(error)}`); }
      this.db.updateImport(importId, "failed", 0, 0, errors.length);
      for (const dir of finalized ? [stagingDir, finalDir] : [stagingDir]) {
        try { rmSync(dir, { recursive: true, force: true }); }
        catch (error) { errors.push(`Failed to clean batch directory: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (existsSync(archiveDir)) {
        try { writeManifest(archiveDir, manifest("failed")); }
        catch (error) { warnings.push(`Failed to write failure manifest: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { importId, status: "failed", sourceType: this.sourceType, files: fileCounts, chunks: 0, embeddings: embeddingStats, warnings, errors };
    }
  }

  protected async dryRun(importId: string, source: string | undefined, dbPath: string | undefined, warnings: string[]): Promise<ImportResult> {
    const fileCounts: Record<string, number> = {};
    let chunks = 0;
    const embeddings = { reused: 0, rebuilt: 0, skipped: 0 };
    if (source) {
      this.validateSource(source);
      for (const file of this.scanMarkdown(source)) {
        const cls = this.classify(relative(source, file));
        if (!cls) continue;
        fileCounts[cls.category] = (fileCounts[cls.category] ?? 0) + 1;
        const content = readFileSync(file, "utf8");
        const parsed = parseMarkdown(content, this.sourceType);
        chunks += chunkMarkdown(parsed.body, parsed.metadata).length;
      }
    }
    if (dbPath) {
      const sdb = await this.openSqlite(dbPath);
      sdb.close();
      warnings.push("SQLite import dry-run: schema check only, no records read");
    }
    if (this.options.embedding !== "rebuild") embeddings.skipped = chunks; else embeddings.rebuilt = chunks;
    return { importId, status: "dry-run", sourceType: this.sourceType, files: fileCounts, chunks, embeddings, warnings, errors: [] };
  }

  protected async rebuildEmbeddings(chunks: Chunk[], chunkIds: number[], warnings: string[], stats: { rebuilt: number; skipped: number }): Promise<number | null> {
    let dims: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      let emb: Float32Array;
      try {
        emb = await this.embed(chunks[i].text, this.config.embeddingModel);
        if (!emb.length || !emb.every(Number.isFinite)) throw new Error("Invalid embedding vector");
      } catch (error) {
        stats.skipped++;
        warnings.push(`Embedding skipped: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      this.db.setChunkEmbedding(chunkIds[i], emb, this.config.embeddingModel, emb.length);
      dims = emb.length;
      stats.rebuilt++;
    }
    return dims;
  }

  protected async importMarkdown(sourceDir: string, rawDir: string, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[], embeddingStats: { reused: number; rebuilt: number; skipped: number }): Promise<number> {
    let chunkCount = 0;
    for (const file of this.scanMarkdown(sourceDir)) {
      const rel = relative(sourceDir, file);
      const cls = this.classify(rel);
      if (!cls) continue;
      try {
        const content = readFileSync(file, "utf8");
        const rawTarget = join(rawDir, rel);
        mkdirSync(dirname(rawTarget), { recursive: true });
        copyFileSync(file, rawTarget);
        const parsed = parseMarkdown(content, this.sourceType);
        const sourceHash = hashContent(content);
        const identity = this.sourceIdentity(file);
        const existing = this.db.findImportRecord("markdown", identity, null, sourceHash);
        if (existing?.status === "imported") continue;
        const targetPath = join(stagingDir, cls.category, "markdown", rel);
        mkdirSync(dirname(targetPath), { recursive: true });
        const metadata = { ...parsed.metadata, origin: "imported" as const, importId, source: this.sourceType, originalPath: rel, category: cls.category, knowledgeType: cls.knowledgeType, status: "candidate", project: parsed.metadata.project ?? this.sourceType, agent: parsed.metadata.agent ?? this.sourceType };
        writeFileSync(targetPath, renderMarkdown(parsed.body, metadata, this.sourceType));
        const absTarget = resolve(targetPath);
        const chunks = chunkMarkdown(parsed.body, metadata);
        const chunkIds: number[] = [];
        for (const chunk of chunks) {
          const hash = `${absTarget}:${sourceHash}:${importId}:${chunk.startLine}`;
          chunkIds.push(this.db.insertChunk(absTarget, chunk, hash));
          chunkCount++;
        }
        let embeddingMode = "skip";
        let embeddingDims: number | null = null;
        if (this.options.embedding === "rebuild" || this.options.embedding === "auto") {
          embeddingDims = await this.rebuildEmbeddings(chunks, chunkIds, warnings, embeddingStats);
          if (embeddingDims !== null) embeddingMode = "rebuild";
        } else { embeddingStats.skipped += chunkIds.length; }
        const stat = statSync(file);
        const sourceId = this.db.addSource(absTarget, "imported", importId, "markdown", rel, null, sourceHash, stat.mtimeMs, stat.size, embeddingDims === null ? undefined : this.config.embeddingModel, embeddingDims ?? undefined);
        this.db.addImportRecord(importId, "markdown", identity, null, sourceHash, sourceId, chunkIds, embeddingMode, embeddingDims, "imported");
        this.manifestFiles.push({ originalPath: rel, category: cls.category, targetPath: absTarget, hash: sourceHash, chunks: chunks.length });
        fileCounts[cls.category] = (fileCounts[cls.category] ?? 0) + 1;
      } catch (e) {
        errors.push(`failed to import ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return chunkCount;
  }

  protected scanMarkdown(dir: string): string[] {
    const result: string[] = [];
    if (!existsSync(dir)) return result;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && !this.options.includeSystem) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...this.scanMarkdown(full));
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full);
    }
    return result;
  }

  protected finalizeStaging(stagingDir: string, finalDir: string): void {
    if (existsSync(finalDir)) throw new Error(`Import batch directory already exists: ${finalDir}`);
    renameSync(stagingDir, finalDir);
  }
}
