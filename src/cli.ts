#!/usr/bin/env node
import { runMcp } from "./mcp-runtime.ts";
import { loadConfig, ensureConfigDirs } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { adapters } from "./framework/registry.ts";
import { embed } from "./embedding.ts";
import { getImporter, availableImporters } from "./importer/registry.ts";
import type { ImportOptions } from "./importer/base.ts";

const AGENTS_RULES = `## remme 记忆使用规则

### 查询时机（memory_search）
- 开始非平凡任务前：搜项目名 + 关键技术词，找历史决策和坑
- 遇到报错/bug 时：搜错误关键词，找已有解决方案
- 做技术选型/架构决策前：搜技术名，复用历史决策
- 用户提到过去的事：搜用户原话
- 开新项目/新模块前：搜项目名/领域词，找相关上下文
- 不查：简单问答、闲聊、当前 session 已做过的事

### 沉淀时机（memory_write）
- 解决非平凡 bug 后：写根因和方案（knowledgeType: solution）
- 做了架构/技术选型决策：写决策和理由（knowledgeType: decision）
- 发现了坑：写坑和避法（knowledgeType: pitfall）
- 确认可复用模式：写模式描述（knowledgeType: pattern）
- 用户明确要求时：按用户要求写
- 不沉淀：临时探索/调试过程、重复日常操作、未经验证的猜测

### 沉淀流程
- memory_write 写入时 status=candidate
- 确认可复用后 memory_promote 提升为 confirmed/verified
- 关联记忆用 memory_link 建立 derived_from/supports/corrects/supertypes/verifies/related_to
`;

const command = process.argv[2] ?? "mcp";
const subcommand = process.argv[3] ?? "";
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] ?? "" : "";
const context = { home: process.env.USERPROFILE ?? process.env.HOME ?? "", cwd: process.cwd(), dryRun: process.argv.includes("--dry-run") };
if (command === "mcp") await runMcp();
else if (command === "reindex" || command === "status") { const config = loadConfig(); ensureConfigDirs(config); const db = new MemoryDatabase(config); db.sync(); console.log(command === "status" ? JSON.stringify({ database: config.dbPath, memoryDir: config.memoryDir, chunks: db.rows().length }) : "reindexed"); db.close(); }
else if (command === "init") { const config = loadConfig(); ensureConfigDirs(config); console.log(JSON.stringify(config, null, 2)); console.log("\n--- Recommended AGENTS.md rules ---"); console.log(AGENTS_RULES); }
else if (command === "install" || command === "uninstall") { const selected = target === "all" || !target ? adapters : adapters.filter((a) => a.id === target); if (!selected.length) { console.error(`unknown target: ${target}`); process.exitCode = 1; } else for (const adapter of selected) { const result = command === "install" ? adapter.install(context) : adapter.uninstall(context); console.log(`${adapter.label}: ${result.status} - ${result.detail}`); } if (command === "install") { console.log("\n--- Recommended AGENTS.md rules ---"); console.log(AGENTS_RULES); } }
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
