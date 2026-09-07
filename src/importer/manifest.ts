import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ImportManifest {
  id: string;
  sourceType: string;
  sourcePath: string;
  sourceDbPath: string | null;
  targetPath: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  fileCount: number;
  chunkCount: number;
  errorCount: number;
  options: Record<string, unknown>;
  files: { originalPath: string; category: string; targetPath: string; hash: string; chunks: number }[];
}

export function manifestPath(archiveDir: string): string { return join(archiveDir, "manifest.json"); }

export function writeManifest(archiveDir: string, manifest: ImportManifest): void {
  writeFileSync(manifestPath(archiveDir), JSON.stringify(manifest, null, 2));
}

export function readManifest(archiveDir: string): ImportManifest | null {
  const p = manifestPath(archiveDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as ImportManifest; } catch { return null; }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function generateImportId(sourceType: string): string {
  const date = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const rand = randomUUID();
  return `${sourceType}-${date}-${rand}`;
}
