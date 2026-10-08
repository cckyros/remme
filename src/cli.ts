#!/usr/bin/env node
import { homedir } from "node:os";
import { runMcp } from "./mcp-runtime.ts";
import { loadConfig, ensureConfigDirs } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { embed } from "./embedding.ts";
import { getImporter, availableImporters } from "./importer/registry.ts";
import type { ImportOptions } from "./importer/base.ts";
import { targets } from "./install/targets.ts";
import type { Ctx } from "./install/shared.ts";
import memoryRules from "./assets/agents-fragment.md";

const command = process.argv[2] ?? "mcp";
const subcommand = process.argv[3] ?? "";
const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const target = flag("target") ?? "";
const context: Ctx = { dir: flag("dir") ?? process.cwd(), home: homedir(), scope: flag("scope") === "global" ? "global" : "project", dryRun: process.argv.includes("--dry-run") };
if (command === "mcp") await runMcp();
else if (command === "reindex" || command === "status") { const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config); db.sync(); console.log(command === "status" ? JSON.stringify({ database: config.dbPath, memoryDir: config.memoryDir, chunks: db.rows().length }) : "reindexed"); db.close(); }
else if (command === "init") { const config = loadConfig(); ensureConfigDirs(config); console.log(JSON.stringify(config, null, 2)); console.log("\n--- Recommended AGENTS.md rules ---"); console.log(memoryRules); }
else if (command === "targets") { for (const t of targets) console.log(`${t.id.padEnd(14)} ${t.kind.padEnd(7)} ${t.scope.padEnd(8)} ${t.label}`); }
else if (command === "install" || command === "uninstall") {
  const ids = target.split(",").filter(Boolean);
  const unknown = ids.filter((id) => id !== "all" && !targets.some((t) => t.id === id));
  if (!ids.length || unknown.length) { console.error(unknown.length ? `unknown target: ${unknown.join(", ")} (see: remme targets)` : "usage: remme install|uninstall --target <id[,id]|all> [--scope project|global] [--dir <path>] [--dry-run]"); process.exitCode = 1; }
  else for (const t of targets.filter((x) => ids.includes("all") || ids.includes(x.id))) {
    const result = command === "install" ? t.install(context) : t.uninstall(context);
    console.log(`[${result.status}] ${t.label}: ${result.detail}`);
    if (result.status === "error") process.exitCode = 1;
  }
}
else if (command === "import") {
  if (subcommand === "list") { const config = loadConfig(); const db = new MemoryDatabase(config); console.log(JSON.stringify(db.importStatus(), null, 2)); db.close(); }
  else if (subcommand === "status") { const importId = process.argv[4] ?? ""; if (!importId) { console.error("import id required"); process.exitCode = 1; } else { const config = loadConfig(); const db = new MemoryDatabase(config); console.log(JSON.stringify(db.importStatus(importId), null, 2)); db.close(); } }
  else if (subcommand === "rollback") { const importId = process.argv[4] ?? ""; const confirm = process.argv.includes("--confirm"); if (!importId || !confirm) { console.error("usage: remme import rollback <import-id> --confirm"); process.exitCode = 1; } else { const config = loadConfig(); const db = new MemoryDatabase(config); const result = db.rollbackImport(importId); console.log(JSON.stringify({ importId, ...result }, null, 2)); db.close(); } }
  else if (subcommand === "types") { console.log(JSON.stringify(availableImporters(), null, 2)); }
  else {
    const sourceType = subcommand || "markdown";
    const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config);
    const sourceIdx = process.argv.indexOf("--source"); const source = sourceIdx >= 0 ? process.argv[sourceIdx + 1] : undefined;
    const dbIdx = process.argv.indexOf("--db"); const dbPath = dbIdx >= 0 ? process.argv[dbIdx + 1] : undefined;
    const embIdx = process.argv.indexOf("--embedding"); const embedding = embIdx >= 0 ? process.argv[embIdx + 1] : "skip";
    const dryRun = process.argv.includes("--dry-run"); const includeSystem = process.argv.includes("--include-system");
    if (!source && !dbPath) { console.error("at least one of --source or --db must be provided"); process.exitCode = 1; db.close(); }
    else {
      try {
        const importer = getImporter(sourceType, config, db, embed, { source, db: dbPath, embedding: embedding as "auto" | "reuse" | "rebuild" | "skip", dryRun, includeSystem });
        const result = await importer.import();
        console.log(JSON.stringify(result, null, 2));
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
      db.close();
    }
  }
}
else if (command === "embed") {
  const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config);
  const missing = db.db.prepare("SELECT id, text FROM memory_chunks WHERE embedding IS NULL").all() as { id: number; text: string }[];
  if (!missing.length) { console.log("all chunks already have embeddings"); db.close(); }
  else {
    console.log(`backfilling embeddings for ${missing.length} chunks...`);
    let done = 0; let failed = 0;
    for (const chunk of missing) {
      try { const vec = await embed(chunk.text, config.embeddingModel); db.setChunkEmbedding(chunk.id, vec, config.embeddingModel, vec.length); done++; if (done % 50 === 0) console.log(`  ${done}/${missing.length}`); }
      catch { failed++; }
    }
    console.log(`done: ${done}, failed: ${failed}`);
    db.close();
  }
}
else { console.error(`unknown command: ${command}`); process.exitCode = 1; }
