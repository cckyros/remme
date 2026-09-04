#!/usr/bin/env node
import { runMcp } from "./mcp-runtime.ts";
import { loadConfig, ensureConfigDirs } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { adapters } from "./framework/registry.ts";
import { embed } from "./embedding.ts";
import { getImporter, availableImporters } from "./importer/registry.ts";
import type { ImportOptions } from "./importer/base.ts";
const command = process.argv[2] ?? "mcp";
const subcommand = process.argv[3] ?? "";
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] ?? "" : "";
const context = { home: process.env.USERPROFILE ?? process.env.HOME ?? "", cwd: process.cwd(), dryRun: process.argv.includes("--dry-run") };
if (command === "mcp") await runMcp();
else if (command === "reindex" || command === "status") { const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config); db.sync(); console.log(command === "status" ? JSON.stringify({ database: config.dbPath, memoryDir: config.memoryDir, chunks: db.rows().length }) : "reindexed"); db.close(); }
else if (command === "init") { const config = loadConfig(); ensureConfigDirs(config); console.log(JSON.stringify(config, null, 2)); }
else if (command === "install" || command === "uninstall") { const selected = target === "all" || !target ? adapters : adapters.filter((a) => a.id === target); if (!selected.length) { console.error(`unknown target: ${target}`); process.exitCode = 1; } else for (const adapter of selected) { const result = command === "install" ? adapter.install(context) : adapter.uninstall(context); console.log(`${adapter.label}: ${result.status} - ${result.detail}`); } }
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
else { console.error(`unknown command: ${command}`); process.exitCode = 1; }
