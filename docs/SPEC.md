# Spec: remme — Lightweight MCP Memory Server

## Problem Statement

每个 AI agent（Claude Code、Codex、Cursor、Windsurf、Devin 等）各自维护自己的上下文，在一个工具里做的决策对其他工具不可见。用户希望所有 agent 共享一个本地记忆库，但现有方案要么绑定单一 agent，要么需要独立数据库进程/daemon，要么依赖远程 API。

remme 解决的问题：给所有 MCP 兼容的 agent 一个共享的、本地的、被动的知识沉淀系统，极致轻量（一个 SQLite 文件 + 一个 Node.js 进程），数据完全留在本机。它不仅保存原始记忆，还把决策、问题、解决方案和失败经验组织成可复用的知识，并保留跨 Agent 的来源和决策链。

## Solution

remme 是一个 stdio MCP server，用 SQLite + sqlite-vec + Transformers.js 实现：

- **存储**：Markdown 文件是 source of truth（人可读可编辑），SQLite 是检索索引（chunks + embedding + FTS5）
- **检索**：Hybrid search（向量语义匹配 + BM25 关键词匹配），支持 tags/日期过滤缩小搜索空间
- **Embedding**：Transformers.js 在 Node.js 进程内通过 ONNX 生成 embedding，默认 all-MiniLM-L6-v2（384维），首次使用自动下载缓存
- **被动 recall**：agent 通过 MCP 工具显式搜索，remme 不主动注入上下文
- **知识沉淀**：原始工作记录可以被标记为决策、解决方案、坑、约束或模式，逐步从临时记忆变成可复用知识
- **跨 Agent 共享**：多个 MCP client 连同一个 remme，共享同一个 SQLite 文件和 memory 目录
- **决策链追踪**：记录哪一个 Agent 在什么项目中产生、验证、修正或替代了某条知识，支持从问题追溯到方案和验证结果
- **记忆恢复**：启动时备份 SQLite 文件，提供 `memory_restore` 工具恢复到上次会话前状态

## User Stories

### 核心读写

1. 作为 agent，我想要搜索记忆，以便找到与当前任务相关的历史决策和上下文
2. 作为 agent，我想要写入记忆，以便记录当前会话的重要决策供未来召回
3. 作为 agent，我想要更新已有记忆，以便修正之前写入的错误信息
4. 作为 agent，我想要读取指定记忆文件，以便获取完整的记忆内容而非片段
5. 作为 agent，我想要列出所有记忆文件，以便浏览记忆结构

### 搜索过滤

6. 作为 agent，我想要按 tags 过滤搜索结果，以便缩小搜索空间到相关类别
7. 作为 agent，我想要按日期范围过滤搜索结果，以便找到特定时间段的记忆
8. 作为 agent，我想要指定搜索结果数量上限，以便控制返回的上下文量
9. 作为 agent，我想要指定最低相似度阈值，以便过滤掉不相关的结果

### Embedding

10. 作为用户，我想要首次使用时自动下载 embedding 模型，以便零配置开箱即用
11. 作为用户，我想要在配置文件中指定 embedding 模型，以便按需切换模型
12. 作为用户，我想要切换模型时自动检测维度变化并重建索引，以便避免维度不匹配
13. 作为 agent，我想要在 embedding 不可用时降级到纯关键词搜索，以便功能不完全中断
14. 作为 agent，我想要在搜索结果中看到当前搜索模式（hybrid/fts-only），以便判断结果质量

### 记忆管理

15. 作为 agent，我想要写入记忆时指定 importance 分数，以便重要记忆在搜索时排名更高
16. 作为 agent，我想要写入记忆时指定 tags，以便记忆可按标签过滤
17. 作为 agent，我想要写入记忆时自动记录时间戳和来源 agent，以便追溯记忆来源
18. 作为用户，我想要记忆以 Markdown 文件存储，以便直接阅读和编辑
19. 作为用户，我想要记忆文件有 YAML frontmatter 元数据，以便元数据人可读

### 索引同步

20. 作为 agent，我想要搜索时自动检测文件变更并增量更新索引，以便索引始终最新
21. 作为用户，我想要手动触发索引重建，以便处理索引异常
22. 作为用户，我想要查看索引状态，以便了解索引健康度

### 备份恢复

23. 作为用户，我想要 remme 启动时自动备份 SQLite 文件，以便有恢复点
24. 作为 agent，我想要通过 MCP 工具恢复记忆到备份状态，以便应对数据损坏
25. 作为用户，我想要恢复操作需要显式确认，以便防止误恢复

### 配置和初始化

26. 作为用户，我想要首次启动时自动初始化目录和数据库，以便零配置使用
27. 作为用户，我想要通过 `remme init` 交互式配置，以便自定义设置
28. 作为用户，我想要通过 JSON 配置文件管理设置，以便持久化配置
29. 作为用户，我想要配置文件只放覆盖项，以便最小化配置负担

### 跨 agent 共享

30. 作为用户，我想要多个 agent 连同一个 remme 实例，以便共享记忆
31. 作为用户，我想要记忆文件记录来源 agent，以便知道哪条记忆是哪个 agent 写的

### 知识沉淀

36. 作为 agent，我想要把原始工作记录标记为观察、决策、解决方案、坑、约束或可复用模式，以便未来按知识用途检索
37. 作为 agent，我想要标记知识的状态（候选、已确认、已验证、已过时），以便区分临时信息和可靠知识
38. 作为 agent，我想要把一条知识从候选状态提升为正式知识，以便在确认后供其他 agent 复用
39. 作为 agent，我想要更新或废弃错误、过时的知识，同时保留其历史来源，以便避免错误再次被召回
40. 作为用户，我想要看到知识由哪些原始记忆沉淀而来，以便判断结论是否有依据

### 跨 Agent 决策链

41. 作为 agent，我想要记录记忆与项目、文件、错误、决策和解决方案的关联，以便按工作上下文召回
42. 作为用户，我想要看到不同 agent 对同一问题的连续处理过程，以便了解完整的协作决策链
43. 作为 agent，我想要声明一条知识支持、修正、替代或源自另一条知识，以便避免孤立的记忆条目
44. 作为 agent，我想要按项目、agent、关联实体和关系类型过滤搜索，以便缩小跨项目共享库的搜索范围
45. 作为用户，我想要知道一条知识的提出者、验证者和最近修改者，以便评估来源和可信度

### 搜索质量

46. 作为 agent，我想要向量搜索和关键词搜索并行执行并合并结果，以便同时匹配语义和精确词
47. 作为 agent，我想要 importance 分数作为搜索排名乘数，以便重要记忆优先
48. 作为 agent，我想要 MMR 多样性重排减少重复结果，以便看到更多样的记忆
49. 作为 agent，我想要中文/日文/韩文关键词能被正确搜索，以便 CJK 记忆可检索

## Implementation Decisions

### 运行时和传输

- **语言/运行时**：TypeScript + Node.js（用户环境 Node v24.15.0）
- **MCP 传输**：stdio（agent 通过子进程拉起 remme，stdin/stdout 通信）
- **MCP SDK**：`@modelcontextprotocol/sdk`

### 存储层

- **SQLite 驱动**：`better-sqlite3`（同步 API，prebuilt binary，原生支持 `loadExtension`）
- **向量搜索**：`sqlite-vec`（npm 包，prebuilt Windows binary，暴力扫描 O(n)，对本地记忆量级足够）
- **全文搜索**：SQLite FTS5，默认 trigram 分词器（CJK 友好），<3 字符的 CJK 词用 LIKE fallback
- **存储模型**：Markdown 文件是 source of truth，SQLite 是可重建的索引
- **数据库路径**：默认 `~/.remme/memory.db`
- **Memory 目录**：默认 `~/.remme/memory/`

### SQLite Schema

核心表（借鉴 openclaw 简化版）：

- `memory_sources`：文件源记录（id, path, hash, mtime, size）
- `memory_chunks`：文本块（id, source_id, start_line, end_line, hash, text, embedding, model, updated_at, importance, tags, created, agent）
- `memory_chunks_fts`：FTS5 虚拟表（text, id），trigram 分词
- `memory_chunks_vec`：sqlite-vec 虚拟表（embedding float[384]）
- `memory_embedding_cache`：embedding 缓存（model, hash, embedding, dims, updated_at）
- `memory_meta`：元数据 KV（schema_version, embedding_model, embedding_dims 等）
- `memory_relations`：知识关系（source_memory_id, relation_type, target_memory_id, agent, created_at），支持 `derived_from`、`supports`、`corrects`、`supersedes`、`verifies`、`related_to`
- `memory_entities`：可检索实体（memory_id, entity_type, entity_name, normalized_name），用于关联项目、文件、错误、技术和目标
- `memory_provenance`：知识来源和生命周期记录（memory_id, event_type, agent, timestamp, source_id），记录提出、确认、验证、修正和废弃事件

设计要点：
- 所有表用 STRICT 模式
- embedding 存储为序列化文本（JSON array），sqlite-vec 虚拟表引用 chunk id
- importance/tags/created/agent 作为 chunk 的列，不单独建表（简化版，区别于 openclaw 的分离设计）
- 知识层元数据包括 `knowledge_type`、`status`、`project`、`entities`，关系和生命周期事件使用独立表，避免把决策链压缩成不可追踪的 tags
- embedding 缓存按 (model, hash) 去重，避免重复计算
- 结构化实体和关系优先来自 Agent 显式提供的元数据，以及 Git、文件路径、错误签名等可验证来源；第一版不要求 remme 内部调用 LLM 猜测关系

### Embedding

- **默认模型**：`Xenova/all-MiniLM-L6-v2`（384维，~23MB ONNX，Transformers.js 原生支持）
- **生成方式**：`@huggingface/transformers` 在 Node.js 进程内通过 ONNX Runtime 生成
- **首次使用**：自动从 HuggingFace 下载并缓存到本地，之后离线可用
- **可配置**：配置文件可指定模型，换模型时检测维度变化并标记索引需要重建
- **降级**：embedding 模型加载失败时降级到纯 FTS 搜索，搜索结果标注 `mode: "fts-only"`

### 检索算法

Hybrid search 管线（借鉴 openclaw 简化版）：

1. **并行检索**：
   - 向量搜索：query embedding → sqlite-vec KNN（可选 tags/日期过滤缩小空间）
   - 关键词搜索：query → FTS5 BM25（trigram 分词，<3 字符 CJK 用 LIKE fallback）
2. **加权合并**：`contentScore = vectorWeight * vectorScore + textWeight * keywordScore`（默认 0.7/0.3）
3. **Importance 乘数**：`score *= (0.75 + importance * 0.05)`（1分=0.8x，10分=1.25x，null=1.0x）
4. **MMR 多样性重排**：`λ * relevance - (1-λ) * max_similarity`（默认 λ=0.7，Jaccard 相似度）
5. **结果选择**：按 minScore 过滤，取 top maxResults

搜索空间优化：
- `memory_search` 支持可选 `tags` 和 `dateFrom`/`dateTo` 参数
- 过滤条件在 SQL 层应用，先缩小候选集再做向量 KNN
- 不传过滤条件时全局搜索

### Chunking

- **策略**：按 Markdown 标题/段落分块，每块上限 400 tokens，80 tokens overlap
- **frontmatter 处理**：YAML frontmatter 不计入 chunk 文本，但 importance/tags/created/agent 提取到 chunk 元数据
- **chunk id**：`source_id:start_line:end_line` 格式

### MCP 工具

| 工具 | 参数 | 用途 |
|------|------|------|
| `memory_search` | query (必填), limit?, threshold?, tags?, dateFrom?, dateTo?, project?, agent?, knowledgeType?, status?, entity? | 搜索记忆和知识，返回结构化结果与关系摘要 |
| `memory_write` | content (必填), importance?, tags?, knowledgeType?, status?, project?, entities?, relations? | 创建新的原始记忆或知识条目 |
| `memory_update` | path (必填), content (必填), importance?, tags?, knowledgeType?, status?, project?, entities?, relations? | 覆盖已有记忆文件并记录修正关系 |
| `memory_promote` | path (必填), status?, knowledgeType?, confirm? | 将候选记忆提升为可复用知识，并记录 provenance 事件 |
| `memory_link` | source (必填), target (必填), relationType (必填) | 建立两条记忆/知识之间的支持、修正、替代或来源关系 |
| `memory_read` | path (必填) | 读取指定记忆文件全文、来源和关系 |
| `memory_list` | limit?, knowledgeType?, status?, project? | 列出记忆或知识文件 |
| `memory_restore` | confirm (必填, true) | 恢复 SQLite 到启动时备份的状态 |

工具设计原则：知识沉淀通过 Agent 显式提供类型、状态和关系完成，不在每次写入时强制调用内部 LLM。`memory_promote` 和 `memory_link` 将沉淀与关联变成单独、可审计的操作。

`memory_search` 返回格式：
```json
{
  "results": [
    {
      "path": "memory/2026-09-03-143000.md",
      "snippet": "记忆片段文本...",
      "score": 0.85,
      "importance": 7,
      "tags": ["typescript", "sqlite"],
      "startLine": 1,
      "endLine": 20,
      "created": "2026-09-03T14:30:00Z",
      "agent": "claude-code"
    }
  ],
  "mode": "hybrid"
}
```

### Memory 文件格式

写入时自动生成 Markdown 文件：
```markdown
---
importance: 7
tags: ["typescript", "sqlite"]
knowledgeType: decision
status: verified
project: remme
created: 2026-09-03T14:30:00Z
agent: claude-code
entities: ["sqlite-vec", "hnswlib", "database.ts"]
---

## 决定使用 sqlite-vec

在当前记忆规模下，sqlite-vec 的精确搜索足够快，暂不引入 HNSW。
```

- 文件名：`YYYY-MM-DD-HHmmss.md`（自动生成，避免冲突）
- 路径：`~/.remme/memory/YYYY-MM-DD-HHmmss.md`
- 基础 frontmatter：importance/tags/created/agent
- 知识 frontmatter：`knowledgeType`、`status`、`project`、`entities`
- `status` 取值：`candidate`、`confirmed`、`verified`、`superseded`、`obsolete`
- `knowledgeType` 取值：`observation`、`decision`、`solution`、`pitfall`、`constraint`、`pattern`、`procedure`、`question`

### 知识沉淀与决策链

remme 区分“记忆”和“知识”：

- **记忆**是原始工作记录，可以是临时的、不完整的、未经验证的
- **知识**是经过整理或确认、可以在未来复用的记忆
- **沉淀**是记忆被标记、确认、验证并关联到来源和上下文的过程

沉淀流程：

```text
原始工作记录
    ↓ memory_write，status=candidate
候选知识
    ↓ memory_promote，人工或 Agent 确认
confirmed
    ↓ 验证结果写入 provenance
verified / superseded / obsolete
```

关系类型：

- `derived_from`：知识由某条记忆整理而来
- `supports`：一条知识支持另一条决策
- `corrects`：一条知识修正另一条知识
- `supersedes`：新知识替代旧知识
- `verifies`：一条记忆或验证事件确认另一条知识有效
- `related_to`：两条记忆具有关联但没有方向性因果

跨 Agent 决策链示例：

```text
Claude Code 发现问题
    ↓ derived_from
Codex 提出解决方案
    ↓ supports
Cursor 完成验证
    ↓ verifies
新的 verified 知识
```

每个 provenance 事件至少记录：事件类型、Agent、时间、关联来源和可选验证说明。搜索结果优先返回 verified 知识，同时附带其来源记忆、最近验证者和关系摘要。

知识实体的第一版来源：Agent 显式提供的 entities/relations，以及文件路径、Git commit、错误签名等可验证结构化信息。remme 不在每次写入时自动调用 LLM，不把 LLM 猜测当作事实。

### 索引同步

- **搜索时同步**：每次 `memory_search` 前检查 memory 目录文件 mtime/hash 变化，增量更新（新增/修改/删除）
- **手动重建**：CLI `remme reindex` 强制全量重建索引
- **索引状态**：CLI `remme status` 显示 chunk 数量、embedding 模型、索引版本

### 备份恢复

- **备份时机**：remme 进程启动时，复制 `memory.db` 到 `memory.db.bak`（只保留一份）
- **备份内容**：只备份 SQLite 文件（Markdown 是 source of truth，用户可自行管理）
- **恢复方式**：`memory_restore` MCP 工具（需 `confirm: true`）或 CLI `remme restore`
- **恢复语义**：恢复到上次 remme 进程启动前的 SQLite 状态

### 配置

- **配置文件**：`~/.remme/config.json`（JSON 格式，只放覆盖项）
- **配置项**：
  - `dbPath`：SQLite 文件路径（默认 `~/.remme/memory.db`）
  - `memoryDir`：Memory Markdown 目录（默认 `~/.remme/memory/`）
  - `embeddingModel`：Transformers.js 模型 ID（默认 `Xenova/all-MiniLM-L6-v2`）
  - `vectorWeight`：向量搜索权重（默认 0.7）
  - `textWeight`：关键词搜索权重（默认 0.3）
  - `maxResults`：默认搜索结果数（默认 6）
  - `minScore`：默认最低相似度阈值（默认 0.0）
  - `ftsTokenizer`：FTS5 分词器（默认 `trigram`）
  - `mmrLambda`：MMR lambda 参数（默认 0.7）
  - `mmrEnabled`：是否启用 MMR（默认 true）

### CLI 命令

| 命令 | 用途 |
|------|------|
| `remme` | 启动 MCP server（stdio） |
| `remme init` | 交互式初始化配置 |
| `remme reindex` | 强制重建索引 |
| `remme status` | 显示索引状态 |
| `remme restore` | 从备份恢复 SQLite |

### 项目结构

```
src/
├── index.ts          # MCP server 入口 + CLI 分发
├── database.ts       # SQLite + sqlite-vec + FTS5 schema 和操作
├── embedding.ts      # Transformers.js embedding 生成和缓存
├── search.ts         # hybrid search 管线（merge + importance + MMR）
├── chunker.ts        # Markdown 分块 + frontmatter 解析
├── tools.ts          # MCP 工具实现（search/write/update/promote/link/read/list/restore）
├── config.ts         # 配置加载（JSON 文件 + 默认值）
├── backup.ts         # 备份和恢复
└── cli.ts            # CLI 命令（init/reindex/status/restore）
```

### 依赖

- `@modelcontextprotocol/sdk` — MCP server SDK
- `better-sqlite3` — SQLite 驱动
- `sqlite-vec` — 向量搜索扩展
- `@huggingface/transformers` — 进程内 embedding 生成
- `gray-matter` — YAML frontmatter 解析

## Testing Decisions

### 测试策略

只测外部行为，不测实现细节。

### 测试缝

1. **数据库层**（`database.ts`）：直接测试 SQLite schema 创建、FTS5 查询、sqlite-vec KNN、过滤逻辑。用临时 SQLite 文件，不需要 mock。
2. **搜索管线**（`search.ts`）：测试 hybrid merge、importance 乘数、MMR 重排。纯函数测试，输入是向量结果 + 关键词结果，输出是排序后的结果列表。不需要真实 embedding。
3. **Embedding 层**（`embedding.ts`）：测试模型加载、向量生成、维度一致性、缓存命中/未命中。用 mock 返回固定向量避免依赖模型下载。
4. **MCP 工具层**（`tools.ts`）：测试工具 schema 验证、参数处理、错误处理、降级行为。mock database 和 embedding 层。
5. **端到端**：写入记忆 → 搜索记忆 → 验证结果。用真实 SQLite + mock embedding（固定向量），覆盖完整流程。

### 测试先例

- `samuelfranklin/mcp-memory-sqlite` — 类似项目的 unit + integration 测试结构
- `aeriondyseti/vector-memory-mcp` — sqlite-vec + Transformers.js 的测试模式
- openclaw `memory-schema.test.ts` / `hybrid.test.ts` — schema 和搜索算法的测试模式

### 关键测试场景

- 写入记忆 → 搜索能找到（语义匹配）
- 写入中文记忆 → trigram 搜索能命中
- 写入带 tags 记忆 → 按 tag 过滤搜索能命中，不匹配的 tag 过滤掉
- 写入带 knowledgeType/status/project/entities 的知识 → 对应过滤条件能命中
- 候选记忆 promote 为 verified 知识 → 状态和 provenance 事件正确记录
- 建立 supports/corrects/supersedes/derived_from 关系 → 读取和搜索结果返回关系链
- 多个 Agent 依次写入、验证和修正同一主题 → 能按来源 Agent 还原决策链
- 更新或废弃旧知识 → 新知识可召回，旧知识标记为 superseded/obsolete 且来源不丢失
- 写入记忆 → 按 importance 排序正确
- 写入多条相似记忆 → MMR 减少重复
- embedding 不可用 → 降级到 FTS-only，结果标注 mode
- 文件手动修改 → 搜索时自动检测并增量更新索引
- 启动备份 → restore 恢复到备份状态
- 切换 embedding 模型 → 检测维度变化，标记需要重建

## Out of Scope

- **HTTP/SSE 传输**：只做 stdio，未来可加
- **HNSW/ANN 索引**：用 sqlite-vec 暴力扫描 + 分类过滤，HNSW 作为未来优化
- **Session memory**：不索引会话历史，只索引 memory 文件
- **自动记忆整理/consolidation**：不做无人确认的自动总结、dreaming 或后台 LLM 整理；显式的 memory_promote 和 memory_link 属于本期范围
- **主动注入/trigger recall**：纯被动 recall，agent 显式搜索；本期不在 session 开始时自动注入上下文
- **多用户/权限**：单用户本地工具，无权限系统
- **复杂 Provenance 信任分级**：记录来源、验证者和生命周期事件，但不实现 openclaw 的 owner/agent/untrusted/system 信任模型
- **Project ranking**：支持 project 作为过滤和关联字段，但不根据活跃度自动排序
- **Web UI**：不提供管理界面
- **远程 embedding API**：默认本地 ONNX，不支持 OpenAI/Ollama 等（未来可加）
- **Markdown 目录自动分类**：agent 写入时可选 tags，但不自动按 category 分目录
- **better-trigram 分词器**：默认用内置 trigram + LIKE fallback，better-trigram 作为未来优化
- **多 SQLite 文件/分库**：一个 SQLite 文件
- **增量备份/多备份点**：只保留一份备份

## Further Notes

### 与 openclaw memory 的关系

remme 借鉴了 openclaw 的核心设计（SQLite schema 分离、hybrid search 管线、importance 乘数、MMR、temporal decay 概念），但做了有边界的简化：
- 去掉 plugin SDK 边界（单一程序）
- 不索引完整 session memory，但记录跨 Agent 的来源和 provenance 事件
- 不做复杂的 project ranking，但支持 project 过滤和关联
- 不做 dreaming 式无人值守整理，改为显式的 memory_promote 和 memory_link
- 去掉 temporal decay（默认不开，importance 和知识状态已足够）
- 用 Transformers.js 替代 llama.cpp managed server（更简单的本地 embedding）
- 用 trigram 替代可配置分词器（CJK 开箱即用）

### 与现有 MCP memory server 的关系

remme 的差异化在于"知识沉淀 + 跨 Agent 决策链 + 被动召回"，而不只是另一个向量数据库：
- `aeriondyseti/vector-memory-mcp` 最接近但用 Bun，remme 用 Node.js
- `AyubMoh1/memory-mcp` 依赖 Ollama，remme 用进程内 ONNX
- `samuelfranklin/mcp-memory-sqlite` 侧重持久化和 hybrid search，remme 增加知识状态、来源和关系链
- remme 强调多个 Agent 对同一问题的发现、决策、实现、验证和修正能够沉淀成可追溯链路
- remme 不把未经确认的文本和经过验证的知识混为一谈，搜索结果会暴露知识状态和来源

### 未来优化路径

1. **HNSW/ANN**：如果记忆量超过 10 万条 chunk，考虑 vectorlite（SQLite + hnswlib 扩展）或 sqlite-vec 的 ANN alpha
2. **better-trigram**：编译 C 扩展替换内置 trigram，支持单字符 CJK 分词
3. **HTTP 传输**：添加 HTTP/SSE 模式支持常驻服务
4. **远程 embedding**：支持 OpenAI/Ollama 等 API 作为 embedding provider
5. **temporal decay**：作为可选功能加入，dated 文件按半衰期衰减
6. **辅助式知识整理**：由本地或远程 LLM 生成候选知识和关系草稿，必须经过 Agent 或用户确认后才能写入 verified 状态
7. **更丰富的工作流适配**：从 Git、测试结果、代码审查和 goal-acceptance 自动产生 provenance 事件
8. **有限的上下文注入**：在明确的 session/project 条件满足时提供可选的启动上下文，而不是默认主动注入
