#!/usr/bin/env node
import { runMcp } from "./mcp-runtime.ts";
import { loadConfig, ensureConfigDirs } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { adapters } from "./framework/registry.ts";
const command = process.argv[2] ?? "mcp";
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] ?? "" : "";
const context = { home: process.env.USERPROFILE ?? process.env.HOME ?? "", cwd: process.cwd(), dryRun: process.argv.includes("--dry-run") };
if (command === "mcp") await runMcp();
else if (command === "reindex" || command === "status") { const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config); db.sync(); console.log(command === "status" ? JSON.stringify({ database: config.dbPath, memoryDir: config.memoryDir, chunks: db.rows().length }) : "reindexed"); db.close(); }
else if (command === "init") { const config = loadConfig(); ensureConfigDirs(config); console.log(JSON.stringify(config, null, 2)); }
else if (command === "install" || command === "uninstall") { const selected = target === "all" || !target ? adapters : adapters.filter((a) => a.id === target); if (!selected.length) { console.error(`unknown target: ${target}`); process.exitCode = 1; } else for (const adapter of selected) { const result = command === "install" ? adapter.install(context) : adapter.uninstall(context); console.log(`${adapter.label}: ${result.status} - ${result.detail}`); } }
else { console.error(`unknown command: ${command}`); process.exitCode = 1; }
