# remme

**你的 Agent 每次都会忘掉一切。remme 是它们共同的记忆。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥22.18](https://img.shields.io/badge/node-%3E%3D22.18-339933)](package.json)
[![Agent 目标: 22](https://img.shields.io/badge/agent%20targets-22-informational)](#平台支持)

[English](README.md) | **简体中文**

[安装](#安装) · [工作原理](#工作原理) · [平台支持](#平台支持) · [记忆规则](#记忆规则) · [MCP 工具](#mcp-工具)

> 状态：pre-alpha。MCP 服务可用并有 stdio 测试覆盖；安装器的主要配置格式有组件测试覆盖，但并非每个客户端都做过实机验证。

## 为什么需要 remme

每次开新会话，你的 Agent 都是一张白纸。上周一起修好的 bug、争论过的架构决策、踩过的坑：全没了。于是你再讲一遍，它再学一遍，同样的工作做两次。

如果你同时用多个 Agent，每个还各记各的，或者什么都不记。

remme 在你本机维护**一份所有 Agent 共享的记忆**，格式由你掌控：可以直接读、改、diff、提交 git 的纯 Markdown 文件。Agent 开工前检索它，做完后把值得留的写回去。你在 Claude Code 里积累的上下文，打开 Codex、Cursor 或 Devin 时还在。

## 工作原理

三层结构，每层都可替换：

| 层 | 是什么 | 为什么 |
|----|--------|--------|
| **Markdown** | 每条记忆一个 `.md` 文件，YAML frontmatter 存元数据 | 事实来源。人类可读、可进 git、不依赖任何工具存活 |
| **SQLite** | FTS5 关键词索引 + 可选本地向量（sqlite-vec / Transformers.js） | 可重建的检索索引。删掉后用 `reindex` 从 Markdown 重建 |
| **MCP** | 一个 stdio 服务，暴露 11 个工具 | 同一份记忆接入 22 个 Agent 客户端 |

记忆文件长这样：

```markdown
---
importance: 7
tags: ["sqlite", "better-sqlite3"]
knowledgeType: "pitfall"
status: "verified"
project: "my-app"
agent: "claude"
entities: ["better-sqlite3"]
---

better-sqlite3 每条语句都在主线程同步执行。迁移必须用
db.transaction(...).immediate() 包起来：一次失败的 CREATE 曾让
这个项目的索引只建了一半。对外提供服务前先校验 schema_version。
```

`memory_search` 返回排序后可过滤的结果：

```json
{
  "results": [
    {
      "path": "2026-09/2026-09-04T10-19-29-675Z-9or6p.md",
      "snippet": "better-sqlite3 runs every statement synchronously…",
      "score": 0.82,
      "vectorScore": 0.77,
      "textScore": 0.90,
      "importance": 7,
      "tags": ["sqlite", "better-sqlite3"],
      "status": "verified",
      "knowledgeType": "pitfall",
      "project": "my-app",
      "agent": "claude"
    }
  ],
  "mode": "hybrid",
  "total": 3
}
```

分数融合关键词与向量匹配，按重要度加权，并可按项目、Agent、标签、状态、知识类型、实体或日期范围过滤。

## 安装

> 不要执行 `npx remme`。npm 上的 `remme` 包名属于另一个无关项目。请从本仓库安装。

### 方式一：手动安装

```bash
git clone https://github.com/cckyros/remme.git
cd remme
npm install
npm run build
node dist/cli.js targets          # 查看全部 22 个目标
node dist/cli.js install --target claude,codex --dir /path/to/your/project --dry-run
node dist/cli.js install --target claude,codex --dir /path/to/your/project
```

安装器写入的是绝对路径的 `node` + `dist/cli.js` 入口，因此克隆目录需要保持不动。重复执行安装是幂等的；`uninstall --target <id>` 只删除 remme 写入的内容。

### 方式二：AI 安装

把下面这段话粘贴给你的 AI 编程助手（Claude Code、Codex、Cursor、Devin 等）：

```text
请在本机安装 remme，仓库地址 https://github.com/cckyros/remme。
1. 克隆仓库，在仓库内执行 `npm install` 和 `npm run build`。
2. 执行 `node dist/cli.js targets` 并把列表展示给我。
3. 询问我要接入哪些 Agent，以及项目目录是什么。
4. 执行 `node dist/cli.js install --target <ids> --dir <project> --dry-run`，把计划修改的内容给我看；只有我确认后才去掉 --dry-run 真正执行。
5. 用 `node dist/cli.js status` 验证，然后告诉我改动了哪些文件以及如何卸载。
不要把密钥、token 或私有配置写进记忆。
```

### 方式三：Ask AI

不确定你的 Agent 是否支持？把仓库作为上下文交给 AI 助手：

```text
请阅读 https://github.com/cckyros/remme 的 README.zh-CN.md 和 docs/PLATFORM-ADAPTATION.md，
告诉我我使用的 Agent（<填写你的 Agent 名称>）是否在支持列表中、安装器对它是自动写入还是需要手动处理，
以及准确的安装命令。
```

### MCP 客户端配置（手动）

任何支持 stdio 的 MCP 客户端都可以直接启动 remme：

```json
{
  "mcpServers": {
    "remme": {
      "command": "node",
      "args": ["/absolute/path/to/remme/dist/cli.js", "mcp"]
    }
  }
}
```

## 平台支持

`node dist/cli.js targets` 输出同样的列表。**自动**表示安装器会写入该客户端的文档化配置文件或复制 skill；**CLI**表示当该客户端的命令行在 `PATH` 中时执行它自己的插件命令，否则打印操作步骤；**手动**表示只给出指引。

| ID | Agent | 类型 | 范围 | 安装器做什么 |
|----|-------|------|------|--------------|
| `claude` | Claude Code | native | 项目 / 全局 | 自动：`settings.json` 中写入 `mcpServers.remme` + skill |
| `codex` | Codex | native | 项目 / 全局 | 自动：`config.toml` 中的 `[mcp_servers."remme"]` 块、`AGENTS.md` 中的规则块、skill，并修正 `supports_search_tool` |
| `opencode` | OpenCode | native | 项目 / 全局 | 自动：`opencode.json` 中写入 `mcp.remme` + 共享 skill |
| `qwen` | Qwen Code | native | 项目 / 全局 | 自动：`.qwen/settings.json` 中写入 `mcpServers.remme` + skill |
| `reasonix` | Reasonix | native | 项目 / 全局 | 自动：项目级写 `.mcp.json`，全局级写受管 `[[plugins]]` 块，并写共享 skill |
| `kilo` | Kilo Code | native | 项目 / 全局 | 自动：`kilo.json` 中写入 `mcp.remme` + 共享 skill |
| `workbuddy` | WorkBuddy | native | 项目 / 全局 | 自动：`.mcp.json` 条目 + skill |
| `devin` | Devin | native | 项目 / 全局 | 自动：`mcp_config.json` 中写入 `mcpServers.remme` + 共享 skill |
| `trae` | Trae | skill | 项目 | 复制 skill；MCP 需在 IDE 中手动添加 |
| `pi` | pi | skill | 项目 | 共享 skill；仅当存在 MCP 适配扩展时写入 MCP 配置 |
| `omp` | Oh My Pi | skill | 项目 | 共享 skill；MCP 需手动配置 |
| `dsh` | dsh | skill | 项目 | 共享 skill；MCP 需手动配置 |
| `copilot` | GitHub Copilot | plugin | 全局 | CLI：`copilot plugin install <插件目录>`，否则打印步骤 |
| `cursor` | Cursor | plugin | 全局 | 自动：检测到 Cursor 时把插件目录复制到 `~/.cursor/plugins/local/remme` |
| `kiro` | Kiro | plugin | 全局 | 手动：在 Powers 面板中导入插件目录 |
| `openclaw` | OpenClaw | plugin | 全局 | 手动：尚未提供原生 bundle |
| `hermes` | Hermes | plugin | 全局 | CLI：`hermes plugin install <插件目录>`，否则打印步骤 |
| `vscode` | VS Code | plugin | 全局 | 自动：用户设置中写入 `chat.pluginLocations` |
| `chatgpt-codex` | ChatGPT & Codex | plugin | 全局 | 生成 marketplace shim；检测到 codex CLI 时执行 `codex plugin` 命令 |
| `grok` | Grok Bot | plugin | 全局 | CLI：`grok plugin install <插件目录> --trust`，否则打印步骤 |
| `nanoclaw` | NanoClaw | plugin | 全局 | 复制模板；检测到 `ncl` 时执行 `ncl groups create` |
| `other` | 其他 Agent | plugin | 全局 | 手动：按你的 Agent 文档安装插件目录 |

安装器规则：只修改带有 remme 标记或键名的内容；已有文件在首次修改前备份为 `.bak`；无法解析的 JSON（包括 JSONC 注释）会报告为手动处理且不改动；单个目标失败不会阻塞其他目标。

```bash
node dist/cli.js install --target all --dry-run          # 预览所有目标的改动
node dist/cli.js install --target codex --scope global   # 用户级而非项目级
node dist/cli.js uninstall --target claude --dir <project>
```

## 记忆规则

这些规则告诉 Agent 何时检索、何时沉淀。安装器会把它们写入 Codex 的 `AGENTS.md`，并写入 remme skill（其他支持 skill 的目标）。规则源文件是 [`src/assets/agents-fragment.md`](src/assets/agents-fragment.md)。

**召回（`memory_search`）**

- 开始非平凡任务前：搜项目名和关键技术词，找历史决策和坑。
- 遇到报错或 bug：搜错误关键词，找已有解决方案。
- 做技术选型或架构决策前：搜技术名，复用历史决策。
- 用户提到过去（"上次"、"我记得"）：搜用户的原话。
- 开新项目或新模块前：搜项目名和领域词。
- 简单问答、闲聊、当前会话已完成的工作不需要检索。
- 没有结果就如实说没找到，不要猜。

**沉淀（`memory_write`）**

- 解决非平凡 bug 后：写根因和修复方案（`knowledgeType: solution`）。
- 做了架构或技术选型决策后：写决策和理由（`decision`）。
- 发现坑：写坑和避法（`pitfall`）。
- 确认可复用模式：写模式描述（`pattern`）。
- 用户明确要求记住时：按要求写。
- 不写临时调试过程、日常操作或未经验证的猜测。
- 纠正已有记忆时用 `memory_update`，不要重复写一条。

**提升与关联**

- 确认过的知识：`memory_promote`（状态 `confirmed` 或 `verified`）。
- 相关记忆：`memory_link`，关系可选 `derived_from`、`supports`、`corrects`、`supersedes`、`verifies`、`related_to`。

检索结果会进入 Agent 的上下文，但不会自动保存；写入永远是一次显式的工具调用。

## MCP 工具

| 工具 | 作用 |
|------|------|
| `memory_search` | 关键词 + 向量检索，支持标签、项目、状态、知识类型、实体和日期过滤 |
| `memory_write` | 创建 Markdown 记忆（默认状态 `candidate`） |
| `memory_update` | 更新已有记忆 |
| `memory_promote` | 把候选记忆提升为知识，并记录 provenance |
| `memory_link` | 关联两条记忆，形成决策链 |
| `memory_read` | 读取全文、关系和 provenance |
| `memory_list` | 列出记忆文件 |
| `memory_restore` | 在 `confirm=true` 时校验 SQLite 快照；拒绝在线替换，请离线恢复 |
| `memory_import` | 导入 OpenClaw 或 Markdown 目录，支持 dry-run |
| `memory_import_status` | 查看历史导入批次 |
| `memory_import_rollback` | 移除一个导入批次（需要 `confirm=true`） |

## 命令行

| 命令 | 作用 |
|------|------|
| `node dist/cli.js mcp` | 启动 MCP stdio 服务 |
| `node dist/cli.js targets` | 列出安装目标 |
| `node dist/cli.js install --target <id,...\|all> [--scope project\|global] [--dir <路径>] [--dry-run]` | 安装到 Agent |
| `node dist/cli.js uninstall --target <id,...\|all> [...]` | 删除 remme 写入的内容 |
| `node dist/cli.js init` | 显示生效配置和记忆规则 |
| `node dist/cli.js status` / `reindex` | 查看索引状态 / 重建索引 |
| `node dist/cli.js import <markdown\|openclaw> --source <目录>` | 导入记忆 |
| `node dist/cli.js embed` | 补齐缺失的 embedding |

## 数据位置

```text
~/.remme/
├── memory.db       # SQLite 索引（可重建）
├── memory.db.bak   # 单一备份点
├── memory/         # Markdown 事实来源
├── plugin/         # 安装器生成的 Agent Plugins 包
└── config.json     # 可选配置覆盖
```

可用 `REMME_CONFIG` 指定其他配置文件，`dbPath` 和 `memoryDir` 也可以指向其他位置。测试使用临时目录，不会修改你的数据。

## 开发

```bash
npm run build      # 打包 dist/cli.js，并生成 plugin.json、mcp.json、.mcp.json、skills/
npm run typecheck
npm test           # 单元 + 组件测试（MCP stdio 和安装器都针对 dist/cli.js 运行）
npm run verify     # 以上全部
```

## 设计边界

- 向量检索是本地精确扫描，尚未引入 HNSW/ANN 索引。
- 会话启动时不自动注入上下文，由 Agent 显式调用 `memory_search`。
- 不做无人值守的 LLM 记忆整理，不索引完整会话历史。
- 只支持本地 embedding，暂不支持远程 embedding 服务和 HTTP/SSE 传输。
- 插件包在本地构建（`dist/` 不入库），因此请从克隆的仓库安装。

设计文档：[`docs/SPEC.md`](docs/SPEC.md)、[`docs/PLATFORM-ADAPTATION.md`](docs/PLATFORM-ADAPTATION.md)、[`docs/OPENCLAW-IMPORT-DESIGN.md`](docs/OPENCLAW-IMPORT-DESIGN.md)。

## 许可证

MIT 许可证，见 [`LICENSE`](LICENSE)。
