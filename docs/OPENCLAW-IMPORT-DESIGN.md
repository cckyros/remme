# OpenClaw 导入设计

## 目标

把 OpenClaw 的 Markdown 和 SQLite 记忆导入 remme，导入数据与 remme 原生记忆隔离，导入文件按来源和分类整理，SQLite 里的 source/chunk/FTS/vector/provenance 关系一致，支持 dry-run、备份、幂等导入和失败回滚。

## 用户决策（已确认）

- **Q1 A**：复制到独立导入目录，不修改 OpenClaw 原目录。
- **Q2 B**：Markdown + OpenClaw SQLite records 都导入；如果 SQLite 无法读取，**整个导入放弃并保留原因**，不做部分静默导入。
- **Q3 B**：embedding 兼容则复用，不兼容则先跳过，后续可重建。
- 额外要求：导入能力必须暴露 MCP 接口。

## 导入目录设计

```text
~/.remme/
├── memory/                            # remme 原生记忆 + 导入索引区
│   ├── 2026-09-04T...md              # 原生记忆
│   └── imports/
│       └── openclaw/                  # 导入的规范化 Markdown（被 sync() 索引）
│           ├── curated/
│           ├── daily/
│           ├── projects/
│           ├── technical/
│           ├── learnings/
│           └── system/
├── imports/
│   └── openclaw/                      # 导入存档区（不被 sync() 索引）
│       ├── manifest.json              # 导入批次、来源、统计、版本
│       └── raw/                       # OpenClaw 原始文件/数据库副本，只读
│           ├── MEMORY.md
│           ├── USER.md
│           ├── daily/
│           └── main.sqlite
└── memory.db
```

### 设计原则

- OpenClaw 原目录不修改。
- `imports/openclaw/raw/` 保留原始副本，便于审计和重新导入，**不在 memoryDir 下**，不被 sync() 索引。
- `memory/imports/openclaw/{category}/` 是 remme 生成的规范化导入文件，**在 memoryDir 下**，被 sync() 递归索引。
- 导入文件与原生 memory 通过 `origin=imported`、`import_id` 区分。
- `memory_imports` SQLite 表是导入状态的 source of truth，`manifest.json` 是冗余副本。

### 为什么导入 Markdown 放在 memoryDir 下

当前 `MemoryDatabase.sync()` 只扫描 `config.memoryDir` 单层目录，`memory_search` 用 `relative(config.memoryDir, row.path)` 返回路径，`memory_read` 用 `safePath` 限制在 memoryDir 内。如果把导入文件放在 memoryDir 外，sync() 不会索引它们，search 返回的路径会包含 `..` 段被 safePath 拒绝。

把导入的规范化 Markdown 放在 `memoryDir/imports/openclaw/` 下，sync() 递归扫描后能正常索引，search 和 read 的现有路径逻辑不需要改。

## sync() 改造

### 递归扫描

`sync()` 从单层 `readdirSync` 改为递归扫描 `memoryDir` 下所有 `.md` 文件（包括 `imports/` 子目录）。

### origin 感知删除

`sync()` 的删除逻辑改为只删除 `origin = 'native'` 且文件不存在的行。导入的 chunk（`origin = 'imported'`）不由 sync() 删除，而由 `memory_import_rollback` 或 `memory_import_reindex` 管理。

```text
sync():
  files = recursiveScan(memoryDir, "*.md")  // 返回相对于 memoryDir 的路径集合
  existing = SELECT path, origin FROM memory_chunks
  for row in existing:
    rel = relative(memoryDir, row.path)
    if row.origin = 'native' and rel not in files:
      delete chunks, fts, vec for row.path
    if row.origin = 'imported':
      check if file still exists at row.path
      if not exists: mark for import rollback (don't auto-delete)
  for file in files:
    absPath = join(memoryDir, file)
    if changed (mtime/size): re-chunk and insert, preserving origin from frontmatter
```

### 导入文件变更检测

导入的 Markdown 文件如果被用户手动修改，sync() 会检测到 mtime/size 变化并重新分块，但保留 `origin`、`import_id`、`category` 等导入元数据。

## OpenClaw Markdown 分类

| OpenClaw 来源 | remme 分类 | 默认知识类型 |
|---|---|---|
| `MEMORY.md`、`USER.md` | `curated/` | `observation` |
| `memory/YYYY-MM-DD.md` | `daily/` | `observation` |
| `memory/projects/*.md` | `projects/` | `observation` |
| `memory/technical/*.md` | `technical/` | `observation` |
| `memory/learnings/*.md` | `learnings/` | `pattern` |
| `.dreams/`、`dreaming/` | `system/` | 默认不导入（`--include-system` 可覆盖） |
| `pags/` | `system/` | 默认不导入 |
| `prompt-templates/` | `system/` | 默认不导入 |

分类映射通过 `importer/classifier.ts` 的纯函数实现，支持 `import-map.json` 覆盖。

### 导入后的 Markdown frontmatter

```yaml
---
origin: imported
importId: openclaw-20260904-001
source: openclaw
originalPath: memory/technical/sqlite.md
category: technical
knowledgeType: observation
status: candidate
project: openclaw
importance: 5
tags: ["openclaw", "technical"]
created: 2026-09-04T00:00:00Z
agent: openclaw
entities: []
---
```

- `status: candidate`（不引入新状态值，用 `origin: imported` 区分导入来源）
- 用户或 Agent 后续可调用 `memory_promote` 变成 `confirmed` 或 `verified`

## SQLite Schema 扩展

### Schema 版本管理

在 `database.ts` 构造时执行 migration（SQLite 要求每个 `ADD COLUMN` 单独一条语句，`NOT NULL` 列必须有 `DEFAULT`）：

```text
PRAGMA user_version
  if 0 → 创建所有表（含导入表），设置 PRAGMA user_version = 2
  if 1 → 逐条执行 ALTER TABLE memory_chunks ADD COLUMN：
           ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'
           ADD COLUMN category TEXT
           ADD COLUMN import_id TEXT
           ADD COLUMN source_id INTEGER
           ADD COLUMN original_path TEXT
           ADD COLUMN original_record_id TEXT
           ADD COLUMN embedding_dims INTEGER
           ADD COLUMN embedding_model TEXT
         创建导入表（memory_imports/sources/records）
         创建唯一索引 idx_import_dedup
         设置 PRAGMA user_version = 2
  if 2 → 无操作
```

所有新增列要么 nullable，要么有 `DEFAULT`，确保旧数据不需要 backfill 即可正常工作。`origin` 默认 `'native'`，自动适用于所有现有 chunk。

### 新增 `memory_imports`

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 导入批次 ID |
| source_type | TEXT NOT NULL | `openclaw` |
| source_path | TEXT | OpenClaw memory 目录 |
| source_db_path | TEXT | OpenClaw SQLite 路径（可空） |
| target_path | TEXT NOT NULL | 导入目标目录 |
| started_at | TEXT NOT NULL | ISO 时间 |
| completed_at | TEXT | ISO 时间（可空） |
| status | TEXT NOT NULL | `pending`/`running`/`completed`/`failed`/`rolled-back`/`interrupted` |
| file_count | INTEGER NOT NULL DEFAULT 0 | |
| chunk_count | INTEGER NOT NULL DEFAULT 0 | |
| error_count | INTEGER NOT NULL DEFAULT 0 | |
| options_json | TEXT NOT NULL DEFAULT '{}' | |
| manifest_hash | TEXT | |

状态机：

```text
pending → running → completed
                  → failed
running → interrupted (进程崩溃，下次启动检测)
completed → rolled-back (rollback)
```

并发控制：`memory_import` 启动时在排他事务中检查并占用运行槽：

```sql
BEGIN IMMEDIATE;
SELECT COUNT(*) FROM memory_imports WHERE status IN ('pending','running');
-- 如果 > 0，ROLLBACK 并拒绝
-- 否则 INSERT 新 import 记录，status = 'pending'
COMMIT;
```

`BEGIN IMMEDIATE` 获取写锁，确保两个并发调用不会同时通过检查。

### 新增 `memory_sources`

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PRIMARY KEY | |
| path | TEXT NOT NULL UNIQUE | remme 内规范化路径 |
| origin | TEXT NOT NULL DEFAULT 'native' | `native`/`imported` |
| import_id | TEXT | 关联 `memory_imports.id`（native 为 NULL） |
| source_type | TEXT NOT NULL DEFAULT 'markdown' | `markdown`/`sqlite` |
| original_path | TEXT | OpenClaw 原始路径 |
| original_record_id | TEXT | OpenClaw SQLite 记录 ID（可空） |
| hash | TEXT NOT NULL | 文件内容哈希 |
| mtime | REAL NOT NULL DEFAULT 0 | |
| size | INTEGER NOT NULL DEFAULT 0 | |
| embedding_model | TEXT | embedding 模型（可空） |
| embedding_dims | INTEGER | embedding 维度（可空） |
| FOREIGN KEY | | `(import_id) REFERENCES memory_imports(id) ON DELETE CASCADE` |

`memory_sources` 是 `origin`/`category`/`embedding_*` 的权威来源，`memory_chunks` 中的对应列是冗余缓存。

### 扩展 `memory_chunks`

新增列（全部 nullable，有默认值）：

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| source_id | INTEGER | NULL | 关联 `memory_sources.id` |
| import_id | TEXT | NULL | 关联 `memory_imports.id` |
| origin | TEXT NOT NULL DEFAULT 'native' | `native` | `native`/`imported` |
| category | TEXT | NULL | 分类 |
| original_path | TEXT | NULL | OpenClaw 原始路径 |
| original_record_id | TEXT | NULL | OpenClaw SQLite 记录 ID |
| embedding_dims | INTEGER | NULL | embedding 维度（可空） |
| embedding_model | TEXT | NULL | embedding 模型（可空） |

现有列保留。`DbRow` 接口更新包含新列。

chunk hash 计算改为包含 `import_id`（导入内容）或保持原样（原生内容）：

```text
native:  ${path}:${BunHash(source)}:${startLine}
imported: ${path}:${source_hash}:${startLine}:${import_id}
```

这样不同导入批次不会 hash 冲突。

### 新增 `memory_import_records`

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PRIMARY KEY | |
| import_id | TEXT NOT NULL | 关联 `memory_imports.id` |
| source_kind | TEXT NOT NULL | `markdown`/`sqlite` |
| original_path | TEXT NOT NULL | OpenClaw 原始路径 |
| original_record_id | TEXT | OpenClaw SQLite 记录 ID（可空） |
| source_hash | TEXT NOT NULL | 源内容哈希 |
| target_source_id | INTEGER | remme `memory_sources.id` |
| target_chunk_ids | TEXT NOT NULL DEFAULT '[]' | JSON 数组，remme chunk IDs |
| embedding_mode | TEXT NOT NULL DEFAULT 'skip' | `reuse`/`rebuild`/`skip` |
| embedding_dims | INTEGER | embedding 维度（可空） |
| status | TEXT NOT NULL | `imported`/`skipped`/`failed` |
| FOREIGN KEY | | `(import_id) REFERENCES memory_imports(id) ON DELETE CASCADE` |

### 幂等逻辑

幂等去重不依赖 `memory_import_records` 的主键。使用独立唯一索引（`COALESCE` 处理 `original_record_id` 为 NULL 的情况，SQLite 中 NULL 不参与唯一性约束）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_dedup
ON memory_import_records(
  source_kind,
  original_path,
  COALESCE(original_record_id, ''),
  source_hash
);
```

Markdown 导入时 `original_record_id` 为 NULL，SQLite 原生会将 NULL 视为不相等导致去重失效，`COALESCE` 把 NULL 转成空字符串参与比较。SQLite 3.31+ 支持表达式索引。

重新导入时：

1. 计算源文件 `source_hash`
2. 查询 `memory_import_records` 是否存在 `(source_kind, original_path, original_record_id, source_hash)` 匹配
3. 如果存在且 `status = 'imported'`，跳过，不生成新 chunk
4. 如果不存在或 `source_hash` 变化，删除旧记录及其 chunk/source，重新导入

`import_id` 不参与去重判断，只用于批次管理和回滚。

### 外键强制

`database.ts` 构造时增加：

```sql
PRAGMA foreign_keys = ON;
```

所有新表声明 `FOREIGN KEY ... ON DELETE CASCADE`。`memory_provenance` 和 `memory_relations` 引用 `memory_chunks.id` 的，在 rollback 时显式清理（虚拟表和这些表不能用 CASCADE 自动清理）。

## chunker.ts 扩展

`parseMarkdown` 和 `renderMarkdown` 需要扩展以支持导入 frontmatter 字段。

### MemoryMetadata 扩展

```typescript
export interface MemoryMetadata {
  importance: number;
  tags: string[];
  knowledgeType?: string;
  status: string;
  project?: string;
  agent: string;
  created: string;
  entities: string[];
  // 导入扩展（可选，native 记忆不需要）
  origin?: string;          // 'native' | 'imported'
  importId?: string;
  source?: string;          // 'openclaw'
  originalPath?: string;
  category?: string;        // 'curated' | 'daily' | ...
}
```

### parseMarkdown 扩展

解析新增字段：`origin`、`importId`、`source`、`originalPath`、`category`。这些字段可选，缺失时 `origin` 默认 `'native'`。

### renderMarkdown 扩展

当 metadata 中存在 `origin: 'imported'` 时，render 输出包含导入字段的 frontmatter。native 记忆不输出这些字段（保持现有格式不变）。

### 为什么需要

sync() 重新索引导入文件时，需要从 frontmatter 恢复 `origin`、`import_id`、`category` 等元数据。如果 chunker 不解析这些字段，restore 后重建的 chunk 会丢失导入标识，导致 origin-aware sync() 误删。

## database.ts API 扩展

### per-chunk embedding

当前 `setEmbedding(path, vector)` 对文件内所有 chunk 设置同一个向量。OpenClaw SQLite 存储的是 per-chunk embedding，reuse 模式需要按 chunk 设置。

新增 API：

```typescript
setChunkEmbedding(chunkId: number, embedding: Float32Array, model: string, dims: number): void
```

行为：
- 更新 `memory_chunks.embedding`、`embedding_model`、`embedding_dims`
- 如果 `dims === 384`，插入 `memory_vec`
- 如果 `dims !== 384`，只存 BLOB，不入 `memory_vec`

`setEmbedding(path, vector)` 保留用于 native 记忆的简单场景，内部调用 `setChunkEmbedding`。

### searchVector 改造

`searchVector` 按查询维度分两条路径：

- **384 维（remme 默认模型）**：优先使用 `memory_vec` KNN 搜索（如果 sqlite-vec 可用），利用虚拟表索引加速
- **其他维度**：从 `memory_chunks` 加载相同 `embedding_dims` 的行，在 JS 中计算 cosine

```typescript
searchVector(query: Float32Array): { row: DbRow; score: number }[] {
  const dims = query.length;
  if (dims === 384 && this.vecAvailable) {
    // 384 维走 memory_vec KNN 快速路径
    const rows = this.db.prepare(
      "SELECT c.*, v.distance as distance FROM memory_vec v JOIN memory_chunks c ON c.id = v.rowid WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT 100"
    ).all(Buffer.from(query.buffer)) as (DbRow & { distance: number })[];
    // sqlite-vec cosine distance 范围 [0,2]，转换为相似度分数 [0,1]
    return rows.map(row => ({ row, score: 1 - row.distance / 2 }));
  }
  // 非 384 维或 vec 不可用：JS 暴力 cosine
  const rows = this.db.prepare(
    "SELECT * FROM memory_chunks WHERE embedding IS NOT NULL AND embedding_dims = ?"
  ).all(dims) as DbRow[];
  return rows.map(row => ({
    row,
    score: cosine(query, new Float32Array(row.embedding!.buffer, row.embedding!.byteOffset, row.embedding!.byteLength / 4))
  })).sort((a, b) => b.score - a.score);
}
```

`memory_vec` 继续用于 384 维的快速路径。非 384 维的 embedding 只存 BLOB，不入 `memory_vec`。`vecAvailable` 在构造时检测 sqlite-vec 是否成功加载。

### sync() 递归扫描

```typescript
sync(): void {
  const files = this.scanMarkdownRecursive(this.config.memoryDir);
  // files 是 Map<absolutePath, {mtime, size}>
  ...
}

private scanMarkdownRecursive(dir: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      result.push(...this.scanMarkdownRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push(full);
    }
  }
  return result;
}
```

跳过 `.staging-*` 和 `.bak` 等隐藏目录。

## config.ts 扩展

`Config` 新增 `importsDir`：

```typescript
export interface Config {
  dbPath: string;
  memoryDir: string;
  importsDir: string;       // 新增：~/.remme/imports
  embeddingModel: string;
  ...
}
```

默认 `importsDir = join(homedir(), ".remme", "imports")`。`ensureConfigDirs` 同时创建 `importsDir`。

## OpenClaw SQLite 导入策略

OpenClaw SQLite 不能直接挂载为 remme 的数据库。采用"读取源数据库，转换后写入 remme"的方式。

### 安全打开

```typescript
const sourceDb = new Database(dbPath, { readonly: true });
sourceDb.pragma("query_only = ON");
```

### 路径验证

`source` 和 `db` 参数必须通过路径验证：

1. `path.resolve()` 规范化
2. 检查路径存在
3. 检查路径不包含 `..` 段（防止 traversal）
4. `db` 必须是 `.sqlite`/`.db`/`.sqlite.migrated` 扩展名
5. `target` 必须在 `~/.remme/imports/` 下

不限制必须在工作区内（OpenClaw 可能安装在任何位置），但拒绝明显危险的路径（系统目录、网络路径）。

### 导入流程

```text
1. 打开 OpenClaw SQLite（readonly + query_only）
2. 检查 sqlite_master 和 schema 版本
   ↓ 不可读 → 整个导入放弃，返回错误原因
3. 读取 sources/chunks/recall/provenance
4. 建立 original_record_id → remme source/chunk ID 映射
5. 生成规范化 Markdown 到 staging 目录
6. 事务写入 remme SQLite（分批提交，每 1000 chunk 一个事务）
7. 校验后移动 staging 文件到正式目录
8. 更新 memory_imports.status = completed
```

### SQLite 不可读时的行为

如果用户指定了 `db` 但 SQLite 无法打开或 schema 不兼容，**整个导入放弃**：

- 不做部分静默导入
- `memory_imports.status = failed`
- 已写入的 staging 文件清理
- SQLite 事务回滚
- 返回错误原因

### 分批提交

导入大数据库时，每 1000 个 chunk 一个事务，避免单大事务和长 WAL。每批提交后更新 `memory_imports.chunk_count`。如果中途失败，`status = interrupted`，下次 `remme import reindex <import-id>` 可从断点继续。

### Embedding 策略

三种模式：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 检查 OpenClaw embedding 的 model 和 dims，与 remme 当前模型兼容（model 相同且 dims=384）则 reuse，否则 skip |
| `reuse` | 强制复用旧向量，dims ≠ 384 时只存 BLOB 不入 memory_vec |
| `rebuild` | 重新用 remme 当前 embedding 模型生成向量 |
| `skip` | 只导入 Markdown、FTS 和 metadata，不入向量索引 |

### 向量索引兼容性

`memory_vec` 是 `vec0(embedding float[384])`。只有 384 维的 embedding 才能插入 `memory_vec`。非 384 维的 embedding 只存 `memory_chunks.embedding` BLOB，不入 `memory_vec`。

`searchVector` 改为按 `embedding_dims` 过滤：

```text
searchVector(query):
  queryDims = query.length
  rows = SELECT * FROM memory_chunks WHERE embedding IS NOT NULL AND embedding_dims = queryDims
  for each row: cosine(query, row.embedding)
```

这样不同维度的 embedding 不会错误比较。

## CLI 设计

### Markdown 导入

```powershell
remme import openclaw --source "C:/Users/<user>/.openclaw/workspace/memory" --dry-run
remme import openclaw --source "C:/Users/<user>/.openclaw/workspace/memory"
```

### SQLite 导入

```powershell
remme import openclaw --db "C:/path/to/main.sqlite.migrated" --dry-run
remme import openclaw --db "C:/path/to/main.sqlite.migrated"
```

### 组合导入

```powershell
remme import openclaw --source "..." --db "..." --embedding skip
```

### 管理命令

```powershell
remme import list
remme import status <import-id>
remme import reindex <import-id>
remme import rollback <import-id> --confirm
```

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--source` | 无 | OpenClaw memory 目录 |
| `--db` | 无 | OpenClaw SQLite 路径 |
| `--target` | `~/.remme/imports/openclaw` | 导入存档目录 |
| `--embedding` | `auto` | `auto`/`reuse`/`rebuild`/`skip` |
| `--dry-run` | false | 只报告不写入 |
| `--confirm` | false | rollback 必须显式确认 |
| `--include-system` | false | 导入 .dreams/pags/prompt-templates |

### dry-run 输出示例

```text
Source:
  type: OpenClaw
  memory directory: ...
  database: ...

Files:
  curated: 2
  daily: 31
  projects: 4
  technical: 12
  learnings: 8
  excluded system files: 17

Database:
  sources: 124
  chunks: 638
  reusable embeddings: 0
  embeddings requiring rebuild: 638

Target:
  ~/.remme/imports/openclaw/ (archive)
  ~/.remme/memory/imports/openclaw/ (indexed)

Warnings:
  - embedding dimensions differ
  - system-managed directories excluded
  - 3 files have unsupported frontmatter

No files were written.
```

## MCP 工具设计

### `memory_import`

触发一次导入。

参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| source | string | 否 | OpenClaw memory 目录 |
| db | string | 否 | OpenClaw SQLite 路径 |
| embedding | string | 否 | `auto`/`reuse`/`rebuild`/`skip`，默认 `auto` |
| dryRun | boolean | 否 | 只报告不写入，默认 false |
| includeSystem | boolean | 否 | 导入系统目录，默认 false |

行为：

- 至少提供 `source` 或 `db` 之一
- 检查并发：如果有 `pending`/`running` 的导入，拒绝
- `dryRun=true` 时只返回报告，不写文件和数据库
- 实际导入时创建 `memory_imports` 记录，写入 staging，校验后提交
- 返回 `importId`、统计和警告

返回：

```json
{
  "importId": "openclaw-20260904-001",
  "status": "completed",
  "files": { "curated": 2, "daily": 31, "projects": 4, "technical": 12, "learnings": 8 },
  "chunks": 638,
  "embeddings": { "reused": 0, "rebuilt": 0, "skipped": 638 },
  "warnings": ["embedding dimensions differ"],
  "errors": []
}
```

错误返回（统一 schema）：

```json
{
  "error": {
    "code": "SQLITE_UNREADABLE",
    "message": "OpenClaw SQLite schema not recognized: missing 'sources' table"
  }
}
```

### `memory_import_status`

查询导入状态。

参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| importId | string | 否 | 指定批次，不传则返回最近 50 批次摘要 |

返回：

```json
{
  "imports": [
    {
      "importId": "openclaw-20260904-001",
      "sourceType": "openclaw",
      "status": "completed",
      "startedAt": "...",
      "completedAt": "...",
      "fileCount": 57,
      "chunkCount": 638,
      "errorCount": 0
    }
  ]
}
```

### `memory_import_rollback`

回滚一次导入，删除该批次产生的所有 source/chunk/FTS/vec/relation/provenance 和导入文件。

参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| importId | string | 是 | 要回滚的批次 |
| confirm | boolean | 是 | 必须为 `true` |

行为（事务内）：

1. `SELECT id FROM memory_chunks WHERE import_id = ?` 收集该批次所有 chunk IDs（用 live 查询，不用 `memory_import_records.target_chunk_ids`，因为 sync() re-chunk 后存储的 JSON 会过期）
2. `DELETE FROM memory_fts WHERE rowid IN (chunk_ids)`
3. `DELETE FROM memory_vec WHERE rowid IN (chunk_ids)`（try/catch，vec 表可能不存在）
4. `DELETE FROM memory_provenance WHERE memory_id IN (chunk_ids)`
5. `DELETE FROM memory_relations WHERE source_id IN (chunk_ids) OR target_id IN (chunk_ids)`
6. `DELETE FROM memory_chunks WHERE import_id = ?`
7. `DELETE FROM memory_sources WHERE import_id = ?`
8. `DELETE FROM memory_import_records WHERE import_id = ?`
9. `UPDATE memory_imports SET status = 'rolled-back' WHERE id = ?`
10. 删除 `memory/imports/openclaw/` 下该批次的 Markdown 文件
11. 保留 `imports/openclaw/raw/` 副本用于审计

返回：

```json
{
  "importId": "openclaw-20260904-001",
  "status": "rolled-back",
  "removedChunks": 638,
  "removedSources": 57
}
```

### MCP 工具设计原则

- `memory_import` 通过 MCP 暴露，让 Agent 能直接触发导入
- `dryRun` 是必须支持的，Agent 应先 dry-run 再实际导入
- `rollback` 必须显式 `confirm: true`
- 所有工具返回结构化 JSON，错误返回统一 `{ error: { code, message } }` schema
- 错误在 `tools.ts` 捕获并包装，`mcp-runtime.ts` 透传

## memory_restore 与导入的关系

`memory_restore` 验证 SQLite 备份完整性后拒绝在线替换，要求停止所有 remme 客户端后离线恢复。离线恢复会丢失备份后导入的 chunk 数据，但 `memory/imports/openclaw/` 下的 Markdown 文件仍然存在。

离线 restore 后行为：

1. SQLite 中导入的 chunk 消失
2. 下次 `sync()` 递归扫描 `memory/imports/openclaw/`，发现 Markdown 文件存在但 SQLite 中没有对应 chunk
3. sync() 重新索引这些文件（保留 `origin=imported` 元数据从 frontmatter 读取）
4. `memory_imports` 表状态可能丢失（如果在备份后创建），但 chunk 会被重建

文档中明确：`memory_restore` 仅验证备份并指导离线恢复，不在线替换 SQLite 索引，不删除导入的 Markdown 文件。导入的 Markdown 是 source of truth，SQLite 索引可重建。

## 幂等、备份和失败恢复

### 导入前

1. 创建一次 SQLite 备份（复用现有 `memory.db.bak` 机制）
2. 创建 `memory_imports` 记录，`status = pending`
3. 所有文件先写入 staging 目录（`memory/imports/openclaw/.staging-{importId}/`）
4. 完成校验后再移动到正式目录
5. SQLite 使用分批事务提交（每 1000 chunk）

### 失败时

- staging 目录保留（便于断点续传）
- 已提交的 SQLite 事务不回滚（分批提交的已入库数据保留）
- `memory_imports.status = failed` 或 `interrupted`
- 返回错误原因
- 可通过 `remme import reindex <import-id>` 从断点继续

### 重复导入时

- 计算源文件 `source_hash`
- 查询 `memory_import_records` 唯一索引 `(source_kind, original_path, original_record_id, source_hash)`
- 匹配且 `status = 'imported'` → 跳过
- 匹配但 `source_hash` 变化 → 删除旧 chunk/source/record，重新导入
- 不匹配 → 新增导入
- 不产生重复 chunk

### 进程崩溃恢复

下次 `MemoryDatabase` 构造时检查 `memory_imports` 中 `status IN ('pending','running')` 的记录，标记为 `interrupted`。用户可通过 `remme import reindex <import-id>` 继续。

## 第一版实现范围

1. OpenClaw Markdown 导入（递归扫描目录）
2. 分类复制和规范化 frontmatter
3. `memory_imports` / `memory_sources` / `memory_import_records` 表
4. `memory_chunks` 扩展列 + schema migration
5. `sync()` 递归扫描 + origin 感知删除
6. FTS 和 SQLite 索引
7. dry-run
8. 幂等导入（基于 `source_hash` 去重）
9. import rollback（显式清理 FTS/vec/provenance/relations）
10. SQLite 只读检测和导入（schema 适配器）
11. embedding `auto`/`skip`/`rebuild`/`reuse` 策略 + 维度兼容检查
12. `searchVector` 按维度过滤
13. MCP 工具：`memory_import`、`memory_import_status`、`memory_import_rollback`
14. CLI 命令：`remme import openclaw`、`list`、`status`、`reindex`、`rollback`
15. 路径验证和安全 SQLite 打开
16. 分批提交和断点续传
17. 并发导入控制
18. 进程崩溃恢复

## 项目结构扩展

```text
src/
├── importer/
│   ├── openclaw.ts      # OpenClaw 导入器（Markdown + SQLite）
│   ├── classifier.ts    # 文件路径 → 分类映射（纯函数）
│   ├── manifest.ts      # 导入批次 manifest 读写和哈希
│   └── schema.ts        # OpenClaw SQLite schema 检测（纯函数）
├── database.ts          # 扩展：导入表 + migration + sync() 递归 + origin 感知 + per-chunk embedding + searchVector 维度过滤
├── chunker.ts           # 扩展：MemoryMetadata 增加 origin/importId/source/originalPath/category，parseMarkdown/renderMarkdown 支持导入字段
├── config.ts            # 扩展：Config 增加 importsDir
├── tools.ts             # 扩展：memory_import/status/rollback 工具 + 路径验证
├── mcp-runtime.ts       # 扩展：handlers/descriptions/schemas 注册新工具
└── cli.ts               # 扩展：import 子命令
```

### 导入器接口

```typescript
class OpenClawImporter {
  constructor(
    config: Config,
    db: MemoryDatabase,
    embed: (text: string, model: string) => Promise<Float32Array>,
    dryRun?: boolean
  )
  async importMarkdown(sourceDir: string, options: ImportOptions): Promise<ImportResult>
  async importSqlite(dbPath: string, options: ImportOptions): Promise<ImportResult>
  async rollback(importId: string): Promise<RollbackResult>
  status(importId?: string): ImportStatus[]
}
```

`classifier.classify(filePath: string): { category: string; knowledgeType: string }` 和 `schema.detectSchema(db: Database): SchemaInfo` 是纯函数，可直接单元测试。

## 测试策略

### 单元测试

- `importer/classifier.ts`：文件路径 → 分类映射，包括 `--include-system` 覆盖
- `importer/manifest.ts`：manifest 读写和哈希
- `importer/schema.ts`：OpenClaw SQLite schema 检测，包括不兼容 schema
- `chunker.ts`：parseMarkdown 解析导入 frontmatter（origin/importId/source/originalPath/category），renderMarkdown 输出导入字段，native 记忆不输出导入字段
- `database.ts`：schema migration 从 v0/v1 升级到 v2，origin backfill 正确，per-chunk embedding API，searchVector 维度过滤

### 集成测试

- 准备临时 OpenClaw 目录（Markdown + SQLite）
- 执行导入，验证 `memory_imports`/`memory_sources`/`memory_chunks`/`memory_import_records` 一致
- 验证幂等：重复导入不产生重复 chunk
- 验证回滚：回滚后该批次 chunk/source/fts/vec/provenance/relations 全部清除，原生记忆不变
- 验证 dry-run：不写文件和数据库
- 验证 sync() 递归：导入后 sync() 不删除导入 chunk
- 验证 schema migration：旧数据库升级后 origin='native' backfill 正确
- 验证 embedding 维度兼容：384 维入 vec，非 384 维只存 BLOB
- 验证路径验证：拒绝危险路径
- 验证并发控制：同时两个导入被拒绝
- 验证断点续传：interrupted 状态可 reindex

### 黑盒测试

- 通过真实 MCP 入口调用 `memory_import`（dry-run 和实际导入）
- 验证 `memory_import_status` 返回
- 验证 `memory_import_rollback` 行为
- 验证导入后 `memory_search` 能搜到导入内容
- 验证 `memory_read` 能读取导入文件
- 验证 `memory_list` 能列出导入文件
- 验证 rollback 后 `memory_search` 不再返回导入内容

## 待确认决策

无。所有决策已在设计阶段确认。
