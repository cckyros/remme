# 踩坑警示（Pitfall Warning）规划

> 状态：**P0–P4 已实现**（2026-11-13）。`src/triggers.ts` + `src/hook.ts`（`dist/hook.js`）、`install --hooks`（claude/devin）、触发字段进 frontmatter/MCP schema、文档已同步；P5 实机验证待做。决策 D1–D4 按下文"建议"执行。
> 本文归纳调研结论、决策项和分阶段计划，作为实现依据保留。

## 目标

Agent 做事时，如果当前动作命中一条已确认的坑，remme 通过 hook 主动提醒它，而不是指望 Agent 记得先调 `memory_search`。

**非目标（本期不做）**

- 不引入第二个 LLM 自动写记忆。
- 不引入常驻进程、HTTP 服务或外部向量库。
- 不做会话启动时的全量历史注入。
- 不改变"Markdown 是事实来源、SQLite 可重建"的架构。

## 背景：remme 现状

| 事实 | 依据 |
|------|------|
| 召回完全靠 Agent 自觉调用工具 | `src/assets/agents-fragment.md`；`docs/SPEC.md` 第 16 行"被动 recall" |
| "不做 hook、不主动注入"是写进文档的设计边界 | `README.md` 第 256 行；`docs/SPEC.md` 第 385 行；`docs/PLATFORM-ADAPTATION.md` 第 80、182、373 行 |
| SPEC 已把"有限的上下文注入"列为后续方向 | `docs/SPEC.md` 第 427 行 |
| 知识类型里已有 `pitfall`，状态有 `confirmed` / `verified` | `src/tools.ts` 第 67–68 行 |
| 检索分数 = (向量 × 权重 + 关键词 × 权重) × 重要度系数，再按阈值过滤 | `src/tools.ts` 第 95–112 行 |
| 每次打开数据库都会把整库序列化写成 `.bak` | `src/database.ts` 第 25–32 行 |
| Claude Code 目标目前只写 `mcpServers` 和 skill，不写 hook | `src/install/targets.ts` 第 61–64 行 |

做这个功能意味着修改上面第二行的设计边界，相关文档必须同步改。

## 调研结论

### claude-mem 值得借鉴什么

来源见文末[参照](#参照) 1–4。

| claude-mem 的做法 | 结论 | 理由 |
|-------------------|------|------|
| 用生命周期 hook 驱动召回，Agent 不需要记得去搜 | 采纳 | 本功能的核心 |
| 渐进披露：先给约 50–100 token 的索引行，详情按 ID 再取 | 采纳 | 警示必须短，否则变成噪音 |
| observation 记录 `files_read` / `files_modified`，可按文件查历史 | 采纳思路 | 按文件路径匹配比语义相似度准 |
| 同会话同文件不重复注入；worker 调用有 3 秒预算，超时放行 | 采纳 | hook 出错或变慢不能卡住 Agent |
| `<private>` 标签内的内容不入库 | 可选，后续 | 与本功能无直接关系 |
| 第二个 LLM（observer）把每次工具调用写成 observation | 不采纳 | 有 LLM 成本和噪音；与 remme"人工确认、带状态和溯源"的定位冲突 |
| 常驻 worker（Bun 管理）+ Chroma 向量库 | 不采纳 | remme 的定位是无守护进程 |
| 大文件整读拦截（≥32 KB 时拒绝 Read，改用 outline 工具） | 不采纳 | 目的是省 token，与踩坑无关 |
| 云同步、默认开启的匿名遥测、登录流程 | 不采纳 | 与本地优先冲突 |

claude-mem 本身没有"踩坑警示"。它的 `PreToolUse` hook 匹配的是读取类工具，做的是文件历史注入和读取拦截。

### 平台 hook 能力

来源见[参照](#参照) 5–6。

| 能力 | Claude Code | Devin |
|------|-------------|-------|
| 提示词提交时注入上下文 | `UserPromptSubmit` + `additionalContext` | `UserPromptSubmit` + `additionalContext` |
| 工具执行前让 Agent 看到警示 | 只能拒绝：`permissionDecision: "deny"` + `permissionDecisionReason` | 只能拦截：`decision: "block"` + `reason`（或退出码 2） |
| `PreToolUse` 的 `additionalContext` | 支持，但随工具结果送达，此时工具已执行 | 文档未列出支持 |
| 工具失败后注入上下文 | `PostToolUseFailure` + `additionalContext` | `PostToolUse`（`tool_response.success` 为 false）+ `additionalContext` |
| 会话标识 | 输入含 `session_id` | 输入含 `session_id` |
| 配置位置 | `.claude/settings.json` 的 `hooks` | `.devin/hooks.v1.json`，或 `config.json` 的 `hooks` |
| 注入文本上限 | 10,000 字符 | 文档未说明 |

两点需要注意：

- **"动手前警示"在两个平台上都只能靠拦截实现。** 不拦截的话，Agent 要到工具跑完才看到提示。
- **Devin 默认也会读取 `.claude/` 下的 hook。** 同一个项目两边都装，可能触发两次。

其余 20 个安装目标的 hook 支持情况没有核实。

### 实测数据

在一个约 25 条 pitfall 的真实库上测量：

| 测量项 | 结果 |
|--------|------|
| 用 `git commit` + heredoc + powershell 作查询词搜 pitfall | 最高分 0.215，关键词分 0 |
| 用 `npm run build` 作查询词 | 最高分 0.239，关键词分 0 |
| 用完全无关的 `ls -la src` 作查询词 | 最高分 0.149，关键词分 0 |
| CLI 冷启动（`targets` 命令，不开数据库） | 约 215 ms；裸 `node` 约 93 ms |
| 库中 pitfall 的元数据情况 | 25 条都有 `tags`，14 条有 `entities`，23 条为 `confirmed` 或 `verified` |

结论：

1. **语义分数分不开相关和无关的动作**，不能用阈值做警示触发。需要显式触发条件。
2. **hook 路径不能用向量检索。** 每次工具调用都是新进程，都要重新加载 embedding 模型。
3. **hook 路径不能走现有的数据库打开流程**，否则每次工具调用都会整库备份一次。

## 待决策

| 编号 | 问题 | 建议 | 备选 |
|------|------|------|------|
| D1 | `PreToolUse` 命中时怎么办？ | 每条坑每会话拦截一次并给出理由，Agent 重试即放行 | 不拦截，只用提示词注入和失败后注入 |
| D2 | 触发条件存在哪里？ | 新增触发字段（路径、命令、关键词），无触发字段的坑不参与 `PreToolUse` | 复用现有 `tags` / `entities` 做精确匹配，不改结构 |
| D3 | 先支持哪些平台？ | Claude Code 和 Devin | 只做其中一个 |
| D4 | hook 是否默认安装？ | 不默认，`install --hooks` 显式开启 | 随 `install` 一起装 |

D1 选"拦截一次"的代价：命中时 Agent 多一轮调用。选"不拦截"的代价：做不到动手前提醒。

## 方案设计（建议）

### 触发条件

在 pitfall 的 frontmatter 里增加三个可选字段，沿用 `tags` / `entities` 的单行 JSON 数组写法：

```markdown
---
knowledgeType: "pitfall"
status: "verified"
triggerPaths: ["src/database.ts", "**/*.sql"]
triggerCommands: ["git commit .*<<"]
triggerKeywords: ["heredoc", "better-sqlite3"]
---
```

- `triggerPaths`：glob，匹配 edit / write 类工具的目标文件。
- `triggerCommands`：正则，匹配 shell 命令文本。
- `triggerKeywords`：关键词，匹配用户提示词和工具报错文本。

只有 `confirmed` / `verified` 的坑参与警示。

### 三个挂载点

| 挂载点 | 输入 | 匹配方式 | 输出 |
|--------|------|----------|------|
| `UserPromptSubmit` | 提示词 + 项目 | `triggerKeywords` | 注入上下文 |
| 工具失败后 | 报错文本 | `triggerKeywords` + FTS 关键词检索 solution / pitfall | 注入上下文 |
| `PreToolUse`（edit / write / shell） | 文件路径或命令 | `triggerPaths` / `triggerCommands` | 按 D1 |

### 警示内容

每次最多 3 条，只给标题和路径，详情由 Agent 自己用 `memory_read` 取：

```text
remme: 2 known pitfalls match this action
- [verified] better-sqlite3 migrations need an immediate transaction -> 2026-09/xxxx.md
- [confirmed] heredoc does not work in PowerShell -> 2026-10/yyyy.md
Read details with memory_read(path) before continuing.
```

### 运行时护栏

- **永不让工具失败**：任何异常都输出空对象并以 0 退出。
- **只读打开数据库**：不备份、不迁移、不同步。
- **不加载 embedding**。
- **会话内去重**：同一条坑在同一个 `session_id` 内只提醒一次。
- **时间预算**：超时放行。
- **平台识别靠输入内容或环境变量**，不靠命令行参数，以应对 Devin 读取 `.claude/` hook 的情况。

### 安装

- 在 `claude` 和 `devin` 两个目标上增加 hook 条目的写入和卸载。
- 沿用现有规则：按标记识别自己的条目、改前备份 `.bak`、幂等、无法解析的配置转人工。
- 可参考 goal-acceptance 的 `src/framework/hook-runtime.ts` 和 `src/framework/hooksettings.ts`。

## 分阶段计划

| 阶段 | 内容 | 交付物 | 验证 |
|------|------|--------|------|
| P0 | 确认 D1–D4 | 本文"待决策"一节更新为已决定 | 用户确认 |
| P1 | 触发字段 + 匹配核心，不含 hook | frontmatter 读写、索引列、`memory_write` / `memory_update` 接受触发字段、纯函数匹配器、`remme check` 命令 | 单元测试；上面三条实测查询在无触发字段时不产生警示 |
| P2 | hook 运行时 | `remme hook <event>`：输入归一化、只读查询、去重、预算、两个平台的输出格式 | 组件测试：用样例输入驱动 `dist/cli.js`；异常路径输出空对象且退出码为 0；测量耗时 |
| P3 | 安装器 | `claude` / `devin` 目标的 hook 写入与卸载，`--hooks` 开关 | 组件测试（临时 HOME）：幂等、保留用户已有 hook、卸载只删自己的 |
| P4 | 规则与文档 | `agents-fragment.md` 增加"写坑时填触发条件"；`SPEC.md`、`PLATFORM-ADAPTATION.md`、中英文 README 更新设计边界 | 文档里的事实与代码一致 |
| P5 | 实机验证 | 在真实 Claude Code 和 Devin 会话里各跑一遍三个挂载点 | 记录实际表现和耗时；Devin 用 `/hooks` 确认加载 |

依赖关系：P1 → P2 → P3；P4 可与 P3 并行；P5 在 P3 之后。

**存量数据**：现有的坑没有触发字段。回填属于用户本机数据的修改，不在仓库内，需要单独确认后再做。

**时间预算的具体数值**在 P2 测量后确定。当前基线是 CLI 冷启动约 215 ms。如果超预算，再考虑为 hook 单独打一个不含 embedding 依赖的小 bundle。

## 验收标准

- 命中触发条件的动作产生警示；未命中的动作不产生任何输出。
- 同一条坑在同一会话内只提醒一次。
- hook 在数据库缺失、损坏、被锁或超时的情况下都以 0 退出并放行。
- hook 运行不产生 `.bak` 写入，不修改数据库。
- 安装幂等；卸载后用户原有的 hook 条目保持不变。
- `npm run verify` 通过。
- 至少在一个真实客户端上完成实机验证，并记录结果。

## 风险

| 风险 | 应对 |
|------|------|
| 误报过多，Agent 或用户关掉 hook | 只用显式触发条件；每次最多 3 条；会话内去重 |
| 拦截导致 Agent 多一轮调用，或在少数情况下反复重试 | 每条坑每会话只拦一次；D1 保留"不拦截"备选 |
| 每次工具调用增加延迟 | 只读、不加载 embedding；P2 实测后定预算 |
| Devin 同时读取 `.claude/` 和 `.devin/` 的 hook，重复触发 | 会话内去重；平台识别不依赖命令行参数 |
| 触发字段没人填，功能形同虚设 | 规则里要求写坑时填；`remme check` 便于自查 |
| 平台 hook 协议变化 | 输出格式集中在一处；实机验证记录客户端版本 |

## 参照

外部资料均于 2026-11-13 查阅。

1. claude-mem README（功能概述、安装流程、遥测与登录、三步检索）：<https://github.com/thedotmack/claude-mem>。当时版本 15.18.3，Apache-2.0。
2. claude-mem hook 配置（各事件、匹配器、超时）：<https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/hooks.json>
3. claude-mem 按文件注入与读取拦截的实现（3 秒预算、32 KB 拦截阈值、会话去重）：<https://github.com/thedotmack/claude-mem/blob/main/src/cli/handlers/file-context.ts>
4. claude-mem 的 DeepWiki（二手资料，仅用于了解整体结构）：<https://deepwiki.com/thedotmack/claude-mem>
5. Claude Code hooks 参考（事件列表、`PreToolUse` 决策字段、`additionalContext` 送达时机、10,000 字符上限）：<https://code.claude.com/docs/en/hooks>
6. Devin CLI 内置文档 `extensibility/hooks/overview.mdx` 与 `extensibility/hooks/lifecycle-hooks.mdx`（事件、输出格式、配置位置、读取 `.claude/` 的默认行为）。
7. goal-acceptance 项目的 `src/framework/hook-runtime.ts`、`src/framework/hooksettings.ts`（hook 的 stdin/stdout 协议外壳，以及按标记增删 hook 条目）。
8. 本仓库：`docs/SPEC.md`、`docs/PLATFORM-ADAPTATION.md`、`src/tools.ts`、`src/database.ts`、`src/install/targets.ts`、`src/assets/agents-fragment.md`。
