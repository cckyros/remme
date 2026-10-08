# remme — 全平台插件适配文档

## 概述

remme 需要作为一个 MCP 插件适配到所有主流 AI agent 平台。本文档定义了适配架构、目标平台清单、每个平台的适配策略，以及实现路径。

> **范围说明**：22 个目标均已在 `src/install/targets.ts` 实现（native 8、skill 4、plugin 10）。自动写入的目标由组件测试覆盖配置格式；需要外部 CLI 或手动操作的目标返回具体步骤。各目标的自动化程度见 README 平台表。

参考实现：`goal-acceptance`，其框架层（`src/framework/`）提供了完整的插件适配基础设施，业务层（`src/plugin/`）提供身份声明和工具定义。

## 核心架构

### 分层设计

```
┌─────────────────────────────────────────┐
│  业务层 (src/plugin/)                    │
│  manifest.ts  — 身份声明（唯一来源）       │
│  tools.ts     — MCP 工具定义              │
│  targets/     — 各平台适配器              │
├─────────────────────────────────────────┤
│  安装层 (src/install/)                   │
│  manifest.ts  — PluginManifest 类型定义   │
│  registry.ts  — TargetAdapter 契约 + 调度 │
│  cli.ts       — CLI 骨架（install/uninstall/config/mcp） │
│  wizard.ts    — 交互式安装向导             │
│  config.ts    — 配置系统（env > project > global > default） │
│  mcp-runtime.ts — stdio MCP server       │
│  paths.ts     — 包路径解析                │
│  safe-fs.ts   — 安全文件操作（marker/backup） │
│  hooksettings.ts — Claude Code hook 配置  │
└─────────────────────────────────────────┘
```

### 身份声明（Single Source of Truth）

`manifest.ts` 是 remme 身份的唯一来源。所有其他身份文件（`plugin.json`、`mcp.json`、`.mcp.json`、`marketplace.json`）由 `build.mjs` 从 manifest 生成，提交到 git，使 repo 本身就是有效的插件安装源。

remme 的 manifest：

```typescript
export const manifest: PluginManifest = {
  name: "remme",
  version: "0.1.0",
  brand: "remme",
  description: "Lightweight local MCP memory server with SQLite vector search.",
  githubSlug: "user/remme",

  markers: {
    hook: "remme-hook",
    hookCommand: "remme-hook",
    skill: "remme:skill",
    command: "remme:command",
    commandFile: "remme.md",
    skillDir: "remme",
    configDir: ".remme",
    cursorDir: "remme",
    cursorMarkerFile: ".remme-managed",
    cursorMarker: "remme:managed",
    agentsStart: "<!-- remme:start -->",
    agentsEnd: "<!-- remme:end -->",
  },

  config: [
    { key: "dbPath", label: "SQLite database path", type: "string", env: "REMME_DB_PATH", default: "", placeholder: "~/.remme/memory.db" },
    { key: "memoryDir", label: "Memory markdown directory", type: "string", env: "REMME_MEMORY_DIR", default: "", placeholder: "~/.remme/memory/" },
    { key: "embeddingModel", label: "Embedding model", type: "string", env: "REMME_EMBEDDING_MODEL", default: "Xenova/all-MiniLM-L6-v2" },
    { key: "vectorWeight", label: "Vector search weight", type: "number", env: "REMME_VECTOR_WEIGHT", default: 0.7 },
    { key: "textWeight", label: "Keyword search weight", type: "number", env: "REMME_TEXT_WEIGHT", default: 0.3 },
    { key: "maxResults", label: "Max search results", type: "number", env: "REMME_MAX_RESULTS", default: 6 },
    { key: "minScore", label: "Min similarity threshold", type: "number", env: "REMME_MIN_SCORE", default: 0.0 },
    { key: "ftsTokenizer", label: "FTS5 tokenizer", type: "string", env: "REMME_FTS_TOKENIZER", default: "trigram" },
    { key: "mmrLambda", label: "MMR lambda", type: "number", env: "REMME_MMR_LAMBDA", default: 0.7 },
    { key: "mmrEnabled", label: "Enable MMR diversity", type: "boolean", env: "REMME_MMR_ENABLED", default: true },
  ],

  tools, // 从 tools.ts 导入

  skill: { filename: "SKILL.md" },
  // remme 不需要 hook（纯工具驱动，无 PreToolUse 拦截）
};
```

### TargetAdapter 契约

每个平台对应一个 `TargetAdapter`，实现统一接口：

```typescript
export interface TargetAdapter {
  id: string;                    // 唯一标识，如 "claude"、"codex"
  kind: TargetKind;              // "native" | "skill" | "plugin"
  label: string;                 // 向导菜单显示名
  scope: Scope;                  // "project" | "global" | "both"
  detect: (ctx: InstallContext) => DetectStatus | Promise<DetectStatus>;
  install: (ctx: InstallContext) => TargetResult | Promise<TargetResult>;
  uninstall: (ctx: InstallContext) => TargetResult | Promise<TargetResult>;
  manualHint?: string;           // 未检测到时显示的安装提示
}
```

三种 kind 的含义：
- **native**：agent 有自己的 MCP 配置格式，适配器直接写配置文件（Claude Code 的 settings.json、Codex 的 config.toml）
- **skill**：agent 读 Agent Skills 但不实现 Agent Plugins 标准，适配器复制 skill 到 `.agents/skills/`
- **plugin**：agent 实现 Agent Plugins 开放标准（agent-plugins.org），适配器物化共享插件目录

### 安全规则（所有适配器必须遵守）

1. **marker 检查**：写文件前检查是否包含 remme 的 marker，有才覆盖，没有则不碰用户文件
2. **备份**：覆盖前 `backupFile()`，保留原始文件
3. **幂等**：重复安装不产生副作用，检测到已有配置则报告 "idempotent, no change"
4. **隔离失败**：一个平台安装失败不阻塞其他平台
5. **dry-run**：支持 `--dry-run`，只报告不写入
6. **卸载安全**：只移除带 marker 的内容，不碰用户其他配置

## 目标平台清单

### Native 适配器（8 个，已实现）

这些 agent 有自己的 MCP 配置格式，适配器直接写入文档化的配置文件。

| ID | Label | 配置位置 | 配置格式 | scope |
|----|-------|---------|---------|-------|
| `claude` | Claude Code | `.claude/settings.json` | JSON, mcpServers | both |
| `codex` | Codex | `.codex/config.toml` | TOML, [mcp_servers] | both |
| `opencode` | OpenCode | `.opencode/config.json` | JSON, mcp.local | project |
| `qwen` | Qwen CLI | `~/.qwen/config.json` | JSON, mcpServers | global |
| `reasonix` | Reasonix | `~/.reasonix/config.json` | JSON, mcpServers | global |
| `kilo` | Kilo Code | `.kilo/config.json` | JSON, mcp.local | project |
| `workbuddy` | WorkBuddy | `~/.workbuddy/config.json` | JSON, mcp.stdio | global |
| `devin` | Devin | `~/.devin/config.json` | JSON, mcpServers | global |

### Skill 适配器（4 个，已实现）

这些 agent 读 Agent Skills 但不实现 Agent Plugins 标准。适配器复制 SKILL.md 到共享 `.agents/skills/remme/`，并打印手动安装命令。skill 复制由共享安装逻辑完成；客户端无法自动配置 MCP 时返回手动步骤。

| ID | Label | skill 位置 | MCP 配置 | scope |
|----|-------|-----------|---------|-------|
| `trae` | Trae | `.trae/skills/remme/` | 手动（IDE GUI） | project |
| `pi` | pi | `.agents/skills/remme/` | `~/.pi/agent/mcp.json`（可选） | project |
| `omp` | OMP | `.agents/skills/remme/` | 自动注册 `.mcp.json` | project |
| `dsh` | DSH | `.agents/skills/remme/` | `dsh plugin add` 命令 | project |

### Plugin 适配器（10 个，已实现）

这些 agent 实现 Agent Plugins 开放标准（agent-plugins.org）。适配器物化一个共享插件目录（`~/.remme/plugin/`），包含 `plugin.json` + `mcp.json` + `.mcp.json` + `skills/`，然后按各平台方式注册。Cursor、VS Code 直接写入配置；Copilot、Hermes、Grok、ChatGPT & Codex、NanoClaw 在对应 CLI 存在时执行其插件命令；Kiro、OpenClaw、other 为手动指引。

| ID | Label | 注册方式 | scope |
|----|-------|---------|-------|
| `copilot` | GitHub Copilot | `copilot plugin install` 或 `enabledPlugins` | global |
| `cursor` | Cursor | 复制到 `~/.cursor/plugins/remme/` | global |
| `kiro` | Kiro | 手动导入 | global |
| `openclaw` | OpenClaw | `openclaw.plugin.json` + `openclaw-dist/` | global |
| `hermes` | Hermes | `hermes plugin install` | global |
| `vscode` | VS Code | settings.json MCP 配置 | global |
| `chatgpt-codex` | ChatGPT Codex | codex marketplace shim | global |
| `grok` | Grok | `grok plugin install` | global |
| `nanoclaw` | NanoClaw | `ncl groups create --template` | global |
| `other` | Other | 手动指导 | global |

**合计 22 个目标平台，全部已实现于 `src/install/targets.ts`。** 本文档中的 `native-*.ts`、`plugin-agents.ts` 等文件名沿用参考实现 goal-acceptance 的命名；remme 将它们合并在 `src/install/` 下。

## 适配器实现细节

### 1. Claude Code（`native-claude.ts`）

**安装内容**：
- `.claude/settings.json`：`mcpServers.remme` 条目（`node <dist/cli.js> mcp`，绝对路径）
- `.claude/skills/remme/SKILL.md`：skill 文件

**MCP 配置格式**：
```json
{
  "mcpServers": {
    "remme": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/remme/dist/cli.js", "mcp"]
    }
  }
}
```

**remme 特殊处理**：remme 不需要 hook（纯工具驱动，无 PreToolUse 拦截），所以跳过 hook bundle 写入。只写 MCP 配置 + skill。

### 2. Codex（`native-codex.ts`）

**安装内容**：
- `config.toml`（项目：`.codex/config.toml`，全局：`~/.codex/config.toml`）：`[mcp_servers."remme"]` 受管块（`# remme:start` ... `# remme:end`）
- `AGENTS.md`（项目：仓库根目录，全局：`~/.codex/AGENTS.md`）：记忆规则受管块（`<!-- remme:start -->` ... `<!-- remme:end -->`）
- `.agents/skills/remme/SKILL.md`：共享 skill（project scope only）

**TOML 配置格式**：
```toml
[mcp_servers."remme"]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/remme/dist/cli.js", "mcp"]
tool_timeout_sec = 180
```

**特殊处理**：Codex 的 `models.json` 有一个 bug（openai/codex#36382），`supports_search_tool: true` 会隐藏所有 `mcp__*` 工具。适配器自动将其翻转为 `false`。

### 3. OpenCode（`native-opencode.ts`）

**配置格式**（command 是数组）：
```json
{
  "mcp": {
    "local": {
      "remme": {
        "type": "local",
        "command": ["/absolute/path/to/node", "/absolute/path/to/remme/dist/cli.js", "mcp"],
        "enabled": true
      }
    }
  }
}
```

### 4. GitHub Copilot（`plugin-agents.ts`）

**安装方式**：
- 首选：`copilot plugin install <物化插件目录>`（`~/.remme/plugin/`，CLI 不存在时打印步骤）
- Fallback：写入 `~/.copilot/settings.json` 的 `enabledPlugins` 数组

**物化目录**：`~/.remme/plugin/`，包含 6 个文件：
```
plugin.json    — Agent Plugins 标准身份
mcp.json       — MCP 配置（Claude 格式）
.mcp.json      — Copilot 原生 MCP 约定（与 mcp.json 字节一致）
skills/        — SKILL.md + references/
openclaw.plugin.json — OpenClaw 原生插件身份
openclaw-dist/ — OpenClaw 编译产物
```

### 5. Cursor（`plugin-agents.ts`）

**安装方式**：复制物化目录到 `~/.cursor/plugins/remme/`，写入 marker 文件 `.remme-managed`。

### 6. Trae（`skill-agents.ts`）

**安装方式**：复制 skill 到 `.trae/skills/remme/`，返回 `manual` 状态 + GUI 导入指导（Trae 是 IDE，无 CLI）。

### 7. Devin（`native-cliagents.ts`）

**配置位置**：`~/.devin/config.json`
**配置格式**：JSON, mcpServers（与 Claude Code 相同格式）

## 框架层组件

> 当前实现：`src/install/shared.ts`（安全写入、JSON 路径合并、文本块、skill、plugin 物化、CLI 探测）与 `src/install/targets.ts`（22 个适配器）。旧的 `src/framework/`（5 目标桩实现）已删除，由 `src/install/` 取代。

### CLI 命令（`cli.ts`）

```
remme install [--target <id>] [--scope project|global|both] [--dry-run] [--non-interactive]
remme uninstall [--target <id>] [--scope ...] [--dry-run]
remme config get [key]
remme config set <key> <value> [--global]
remme mcp                    # 启动 stdio MCP server
remme doctor                 # 诊断检查
remme version
remme init                   # 交互式初始化（remme 扩展）
remme reindex                # 重建索引（remme 扩展）
remme status                 # 索引状态（remme 扩展）
remme restore                # 从备份恢复（remme 扩展）
```

`install` 无 `--target` 时进入向导模式，自动检测已安装的 agent，让用户多选要适配的平台。

### 安装向导（`wizard.ts`）

零依赖，基于 `node:readline/promises`：
1. 检测所有平台（`detectAll`）
2. 显示多选菜单（检测到的平台默认选中）
3. 询问 scope（project/global/both）
4. 逐个配置项询问（有默认值，Enter 接受）
5. 逐平台安装，汇总结果

### 配置系统（`config.ts`）

优先级：`env > project (.remme/config.json) > global (~/.remme/config.json) > built-in defaults`

与 SPEC.md 的配置设计一致。manifest.config 声明字段，框架自动处理文件布局、env 覆盖、优先级。

### MCP Server（`mcp-runtime.ts`）

手写的 stdio JSON-RPC 2.0 server，零依赖：
- `initialize` → 返回 serverInfo
- `tools/list` → 从 manifest.tools 返回工具清单
- `tools/call` → 调用对应 tool handler
- stdout 只走协议消息，其他走 stderr

### 安全文件操作（`safe-fs.ts`）

- `writeTextFile` / `readTextFile`：基础读写
- `backupFile`：覆盖前备份（`.bak` 后缀）
- `upsertJsonKey`：JSON 文件 key 级 upsert（deep-merge，不碰其他 key）
- `upsertManagedBlock`：marker 包裹的 managed block upsert
- `upsertTomlSection`：TOML section upsert
- `fillTemplate`：`{{placeholder}}` 模板填充

### 路径解析（`paths.ts`）

- `packageRoot()`：从 `import.meta.url` 解析包根目录
- `pluginDir()`：`~/.remme/plugin/`（Agent Plugins 物化目录）
- `packagedSkillPath()`：`skills/remme/SKILL.md`

## Windows 平台特殊处理

### PATH 探测

Windows npm globals 为每个 CLI 创建三个 shim（`.exe`、`.cmd`、`.bat`、`.ps1`）。`which()` 按 PATHEXT 顺序探测：

```typescript
function shimCandidates(name: string): string[] {
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`, name];
}
```

### .cmd/.bat 执行

Node.js 无法直接 exec `.cmd` 文件（EINVAL）。`runCli()` 通过 `cmd.exe` + `shell:true` 执行，参数用 `winQuote()` 转义：

```typescript
if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
  cmd = `"${bin}"${args.map((a) => ` ${winQuote(a)}`).join("")}`;
  argv = [];
  shell = true;
}
```

### 路径分隔符

所有路径用 `node:path.join()`，自动处理 `\` vs `/`。配置文件中写入的路径用正斜杠（跨平台兼容）。

### VS Code 设置路径

```typescript
function vscodeUserSettingsPath(home: string): string {
  const base = process.platform === "win32"
    ? join(home, "AppData", "Roaming")
    : join(home, ".config");
  return join(base, "Code", "User", "settings.json");
}
```

### Trae 配置目录

```typescript
function traeConfigDir(home: string): string {
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Trae");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Trae");
  return join(home, ".config", "Trae");
}
```

## 构建流程（`build.mjs`）

```
src/cli-entry.ts → dist/cli.js          (ESM, bundled)
src/hook-entry.ts → dist/hook.cjs        (CJS, banner marker) [remme 不需要]
src/plugin/dsh-plugin.ts → dist/dsh-plugin.js  [remme 不需要]
src/plugin/openclaw-plugin.ts → openclaw-dist/  [remme 按需]
```

**身份文件生成**（从 manifest）：
- `plugin.json` — Agent Plugins 标准
- `mcp.json` / `.mcp.json` — MCP 配置
- `marketplace.json` — Codex marketplace
- `openclaw.plugin.json` — OpenClaw 插件身份

**skill 同步**：`src/assets/SKILL.md` → `skills/remme/SKILL.md` + `references/`

**remme 简化**：不需要 hook bundle（无 PreToolUse 拦截）和 dsh cordis plugin（remme 不是 dsh 插件）。只需要 CLI bundle + identity files + skill sync。

## 实现路径

### 阶段 1：框架层移植

（原计划，已由 `src/install/` 实现取代）从 `goal-acceptance/src/framework/` 移植以下文件，remme 不需要 hook 相关的文件：

- `manifest.ts` — 类型定义（原样复制）
- `registry.ts` — TargetAdapter 契约 + 调度（原样复制）
- `cli.ts` — CLI 骨架（添加 remme 扩展命令：init/reindex/status/restore）
- `wizard.ts` — 交互式向导（原样复制）
- `config.ts` — 配置系统（原样复制）
- `mcp-runtime.ts` — stdio MCP server（原样复制）
- `paths.ts` — 路径解析（原样复制）
- `safe-fs.ts` — 安全文件操作（原样复制）
- `doctor-runtime.ts` — 诊断检查（简化，添加 remme 特有检查：SQLite/sqlite-vec/embedding 模型）

**不需要的文件**：
- `hook-runtime.ts` — remme 无 hook
- `hooksettings.ts` — remme 无 hook

### 阶段 2：业务层实现

- `src/plugin/manifest.ts` — remme 身份声明（见上文）
- `src/plugin/tools.ts` — MCP 工具定义（规划 11 个：search/write/update/promote/link/read/list/restore/import/import_status/import_rollback；当前实现位于 `src/tools.ts`）
- `src/install/targets.ts` — 适配器注册（22 个，已完成）
- native / skill / plugin 适配器：已完成（8 + 4 + 10）
- `src/install/shared.ts` — 共享 helpers

### 阶段 3：核心功能实现

- `src/database.ts` — SQLite + sqlite-vec + FTS5
- `src/embedding.ts` — Transformers.js embedding
- `src/search.ts` — hybrid search 管线
- `src/chunker.ts` — Markdown 分块 + frontmatter 解析
- `src/backup.ts` — 备份和恢复（实际集成在 `database.ts` 中，无独立文件）

### 阶段 4：构建和测试

- `build.mjs` — esbuild 打包 + 身份文件生成 + skill 同步
- `tests/` — node:test 测试套件

## 测试策略

### 适配器测试

每个适配器用 `spawn` 执行 built CLI，用 fake home 目录（`TMPDIR/remme-test-home/`），验证：
- 安装后配置文件包含正确条目
- 重复安装幂等
- 卸载后配置文件恢复原状
- marker 检查：用户文件不被触碰

`has(id)` self-skip：测试检测当前环境是否有对应 agent，没有则跳过（如没有 Cursor 就跳过 cursor 测试）。

### 框架层测试

- `config.ts`：优先级解析（env > project > global > default）
- `registry.ts`：installAll/uninstallAll 聚合、隔离失败
- `safe-fs.ts`：marker 检查、备份、幂等
- `mcp-runtime.ts`：JSON-RPC 协议、tools/list、tools/call

## 与 SPEC.md 的关系

本文档是 SPEC.md 的扩展，专注于"全平台插件适配"层面。SPEC.md 定义 remme 的核心功能（记忆存储、搜索、embedding），本文档定义目标适配架构和当前/后续平台范围。22 个目标均已实现；实机验证范围见 README 平台表。

SPEC.md 中的配置系统（`~/.remme/config.json`）与本适配框架的配置系统统一：manifest.config 声明字段，`config.ts` 处理优先级，CLI 的 `config get/set` 命令操作。

SPEC.md 中的 CLI 命令（`remme init`、`remme reindex`、`remme status`、`remme restore`）作为 `bizCli` 扩展挂载到框架 CLI 骨架上。
