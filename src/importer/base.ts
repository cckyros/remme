import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import type { Config } from "../config.ts";
import type { MemoryDatabase } from "../database.ts";
import { parseMarkdown, renderMarkdown, chunkMarkdown } from "../chunker.ts";
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
  constructor(config: Config, db: MemoryDatabase, embed: EmbedFn, options: ImportOptions) {
    this.config = config; this.db = db; this.embed = embed; this.options = options;
  }
  abstract get sourceType(): string;
  abstract classify(filePath: string): Classification | null;
  importSqliteRecords?(sdb: import("better-sqlite3").Database, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[], embeddingStats: { reused: number; rebuilt: number; skipped: number }): Promise<number>;

  async import(): Promise<ImportResult> {
    const { source, db: dbPath } = this.options;
    if (!source && !dbPath) throw new Error("at least one of source or db must be provided");
    const importId = generateImportId(this.sourceType);
    const archiveDir = join(this.config.importsDir, this.sourceType);
    const rawDir = join(archiveDir, "raw");
    const indexedBase = join(this.config.memoryDir, "imports", this.sourceType);
    const stagingDir = join(indexedBase, `.staging-${importId}`);
    const warnings: string[] = [];
    const errors: string[] = [];
    const fileCounts: Record<string, number> = {};
    let chunkCount = 0;
    const embeddingStats = { reused: 0, rebuilt: 0, skipped: 0 };

    if (this.options.dryRun) return this.dryRun(importId, source, dbPath, warnings);

    const running = this.db.hasRunningImport();
    if (running) throw new Error(`another import is running: ${running}`);

    this.db.createImport(importId, this.sourceType, source ?? "", dbPath ?? null, archiveDir, { ...this.options });
    this.db.updateImport(importId, "running");

    try {
      if (source) {
        mkdirSync(rawDir, { recursive: true });
        mkdirSync(stagingDir, { recursive: true });
        chunkCount += this.importMarkdown(source, rawDir, stagingDir, importId, fileCounts, warnings, errors);
      }
      if (dbPath && this.importSqliteRecords) {
        if (!existsSync(dbPath)) throw new Error(`SQLite file not found: ${dbPath}`);
        const Database = (await import("better-sqlite3")).default;
        const sdb = new Database(dbPath, { readonly: true });
        sdb.pragma("query_only = ON");
        try {
          if (source) copyFileSync(dbPath, join(rawDir, basename(dbPath)));
          chunkCount += await this.importSqliteRecords(sdb, stagingDir, importId, fileCounts, warnings, errors, embeddingStats);
        } finally { sdb.close(); }
      }
      this.finalizeStaging(stagingDir, indexedBase);
      const fileCount = Object.values(fileCounts).reduce((a, b) => a + b, 0);
      this.db.updateImport(importId, "completed", fileCount, chunkCount, errors.length);
      const manifest: ImportManifest = { id: importId, sourceType: this.sourceType, sourcePath: source ?? "", sourceDbPath: dbPath ?? null, targetPath: archiveDir, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: "completed", fileCount, chunkCount, errorCount: errors.length, options: { ...this.options }, files: [] };
      writeManifest(archiveDir, manifest);
      return { importId, status: "completed", sourceType: this.sourceType, files: fileCounts, chunks: chunkCount, embeddings: embeddingStats, warnings, errors };
    } catch (e) {
      this.db.updateImport(importId, "failed", 0, chunkCount, errors.length + 1);
      rmSync(stagingDir, { recursive: true, force: true });
      errors.push(e instanceof Error ? e.message : String(e));
      return { importId, status: "failed", sourceType: this.sourceType, files: fileCounts, chunks: chunkCount, embeddings: embeddingStats, warnings, errors };
    }
  }

  protected dryRun(importId: string, source: string | undefined, dbPath: string | undefined, warnings: string[]): ImportResult {
    const fileCounts: Record<string, number> = {};
    let chunks = 0;
    const embeddings = { reused: 0, rebuilt: 0, skipped: 0 };
    if (source && existsSync(source)) {
      for (const file of this.scanMarkdown(source)) {
        const cls = this.classify(relative(source, file));
        if (!cls) continue;
        fileCounts[cls.category] = (fileCounts[cls.category] ?? 0) + 1;
        const content = readFileSync(file, "utf8");
        const parsed = parseMarkdown(content, this.sourceType);
        chunks += chunkMarkdown(parsed.body, parsed.metadata).length;
      }
    }
    if (dbPath && existsSync(dbPath)) warnings.push("SQLite import dry-run: schema check only, no records read");
    if (this.options.embedding !== "rebuild") embeddings.skipped = chunks; else embeddings.rebuilt = chunks;
    return { importId, status: "dry-run", sourceType: this.sourceType, files: fileCounts, chunks, embeddings, warnings, errors: [] };
  }

  protected importMarkdown(sourceDir: string, rawDir: string, stagingDir: string, importId: string, fileCounts: Record<string, number>, warnings: string[], errors: string[]): number {
    let chunkCount = 0;
    for (const file of this.scanMarkdown(sourceDir)) {
      const rel = relative(sourceDir, file);
      const cls = this.classify(rel);
      if (!cls) continue;
      try {
        const content = readFileSync(file, "utf8");
        const rawTarget = join(rawDir, rel);
        mkdirSync(join(rawTarget, ".."), { recursive: true });
        copyFileSync(file, rawTarget);
        const parsed = parseMarkdown(content, this.sourceType);
        const sourceHash = hashContent(content);
        const existing = this.db.findImportRecord("markdown", rel, null, sourceHash);
        if (existing?.status === "imported") continue;
        const targetDir = join(stagingDir, cls.category);
        mkdirSync(targetDir, { recursive: true });
        const targetPath = join(targetDir, basename(file));
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
        const stat = statSync(file);
        this.db.addSource(absTarget, "imported", importId, "markdown", rel, null, sourceHash, stat.mtimeMs, stat.size);
        this.db.addImportRecord(importId, "markdown", rel, null, sourceHash, null, chunkIds, this.options.embedding, null, "imported");
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
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...this.scanMarkdown(full));
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full);
    }
    return result;
  }

  protected finalizeStaging(stagingDir: string, indexedBase: string): void {
    if (!existsSync(stagingDir)) return;
    mkdirSync(indexedBase, { recursive: true });
    this.copyDirRecursive(stagingDir, indexedBase);
    rmSync(stagingDir, { recursive: true, force: true });
  }

  private copyDirRecursive(src: string, dst: string): void {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name);
      const d = join(dst, entry.name);
      if (entry.isDirectory()) { mkdirSync(d, { recursive: true }); this.copyDirRecursive(s, d); }
      else if (entry.isFile()) { mkdirSync(join(d, ".."), { recursive: true }); copyFileSync(s, d); }
    }
  }
}
