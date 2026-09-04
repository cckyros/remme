# remme

本地优先的 MCP 知识沉淀工具。remme 使用 Markdown 保存人类可读的记忆，使用 SQLite、FTS5 和可选 sqlite-vec 建立本地索引，让 Claude Code、Codex、Cursor、Devin、OpenClaw 等 Agent 共享同一份可追溯知识。

## 当前状态

当前版本是可运行的 pre-alpha MVP：

- MCP stdio server 可独立运行
- 支持 memory CRUD、hybrid search、知识提升、关系链、provenance 和 SQLite restore
- 默认使用本地 Transformers.js embedding，embedding 不可用时降级到 FTS-only
- 已验证 Claude Code、Codex、Cursor、OpenClaw 和 Devin 本地 MCP 入口
- 规划 22 个平台适配目标，当前实现并验证 4 个

详细设计见：

- [`docs/SPEC.md`](docs/SPEC.md)：功能规格、数据模型、MCP 工具和测试决策
- [`docs/PLATFORM-ADAPTATION.md`](docs/PLATFORM-ADAPTATION.md)：平台适配架构和当前/规划范围
- [`docs/openclaw-investigation.md`](docs/openclaw-investigation.md)：OpenClaw memory search 调查
- [`CONTEXT.md`](CONTEXT.md)：领域术语和设计上下文
- [`AGENTS.md`](AGENTS.md)：开发工作流、Skill 使用和验收规则

## 快速开始

### 安装依赖并构建

```powershell
npm install
npm run build
```

### 启动 MCP server

```powershell
node dist/cli.js mcp
```

MCP 客户端的 stdio 配置示例：

```json
{
  "mcpServers": {
    "remme": {
      "command": "node",
      "args": ["D:/path/to/remme/dist/cli.js", "mcp"],
      "cwd": "D:/path/to/remme"
    }
  }
}
```

### Devin 本地配置

Devin IDE 的 MCP 配置文件位于 Windows 默认路径：

```text
%APPDATA%/devin/mcp_config.json
```

本地源码测试时，将 remme 指向构建产物：

```json
{
  "remme": {
    "command": "C:/path/to/node.exe",
    "args": ["D:/path/to/remme/dist/cli.js", "mcp"],
    "cwd": "D:/path/to/remme"
  }
}
```

### 平台安装器

安装器目前验证了 4 个目标：

```powershell
node dist/cli.js install --target claude --dry-run
node dist/cli.js install --target codex --dry-run
node dist/cli.js install --target cursor --dry-run
node dist/cli.js install --target openclaw --dry-run
node dist/cli.js install --target devin --dry-run
```

去掉 `--dry-run` 才会写入目标客户端配置。重复安装应保持幂等，卸载使用：

```powershell
node dist/cli.js uninstall --target <target>
```

## 数据位置

默认情况下，remme 使用当前用户目录：

```text
~/.remme/
├── memory.db       # SQLite 索引
├── memory.db.bak   # 单一备份点
├── memory/         # Markdown source of truth
└── config.json     # 可选配置覆盖
```

Windows 示例：`C:/Users/<user>/.remme/memory.db`。

可通过 `REMME_CONFIG` 指向自定义 JSON 配置。配置中的 `dbPath` 和 `memoryDir` 可以改变数据库和 Markdown 目录位置。测试和 CI 应使用临时配置，避免修改用户数据。

## MCP 工具

- `memory_search`：搜索记忆和知识，支持关键词、向量、标签、项目、状态和日期条件
- `memory_write`：创建 Markdown 记忆或候选知识
- `memory_update`：更新已有记忆
- `memory_promote`：将候选记忆提升为知识并记录 provenance
- `memory_link`：建立支持、修正、替代和来源关系
- `memory_read`：读取全文、关系和 provenance
- `memory_list`：列出记忆文件
- `memory_restore`：在 `confirm=true` 时恢复 SQLite 备份

remme 的搜索是被动的：MCP 搜索结果会进入当前 Agent 上下文，但不会自动写回长期记忆。需要长期保存时，Agent 必须显式调用 `memory_write` 或 `memory_update`。

## 开发与验证

```powershell
npm run build
npm run typecheck
npm test
npm run verify
```

`npm run verify` 会依次运行构建、严格类型检查和全部 Node 测试。当前测试覆盖：

- Markdown frontmatter 和 chunking
- SQLite schema、FTS5、sqlite-vec 加载和 provenance
- memory CRUD、知识提升和关系读取
- CJK 短查询和 FTS-only fallback
- SQLite backup/restore
- 独立进程 MCP stdio 黑盒测试
- 平台安装器 dry-run

## 设计边界

当前实现刻意保持轻量：

- 向量搜索使用本地精确扫描，尚未引入 HNSW/ANN
- session 启动时不会自动注入上下文，Agent 需要显式调用 `memory_search`
- 不做无人值守的 LLM 记忆整理
- 不索引完整会话历史
- 当前只实现并验证 4 个平台，其他目标属于后续适配范围
- 远程 embedding provider 和 HTTP/SSE transport 暂不在范围内

## 许可证

当前仓库尚未发布正式许可证。发布前需要补充许可证选择和文件。
