# remme

Local-first MCP memory for AI agents. Markdown files hold the knowledge you can read and edit; a SQLite index makes it searchable; every agent you connect shares the same memory.

**English** | [简体中文](README.zh-CN.md)

> Status: pre-alpha. The MCP server works and is covered by stdio tests. The installer's main config formats are covered by component tests; live runs inside each client are not verified for every target.

## Features

- **Local-first.** Markdown is the source of truth. SQLite (FTS5 + optional sqlite-vec) is a rebuildable index.
- **Shared across agents.** One memory for Claude Code, Codex, Cursor, Devin, OpenClaw and 17 more targets.
- **Traceable.** Every memory keeps provenance; candidates can be promoted and linked into decision chains.
- **Hybrid search.** Keyword + local embedding search (Transformers.js), with keyword-only fallback.

## Install

> Do not run `npx remme`. The npm registry name `remme` belongs to an unrelated project. Install from this repository.

### Option 1: Manual

```bash
git clone https://github.com/cckyros/remme.git
cd remme
npm install
npm run build
node dist/cli.js targets
node dist/cli.js install --target claude,codex --dir /path/to/your/project --dry-run
node dist/cli.js install --target claude,codex --dir /path/to/your/project
```

`install` writes absolute `node` + `dist/cli.js` entries, so the clone must stay where it is. Re-running install is idempotent; `uninstall --target <id>` removes only what remme wrote.

### Option 2: AI install

Paste this into your AI coding agent (Claude Code, Codex, Cursor, Devin, ...):

```text
Install remme from https://github.com/cckyros/remme on this machine.
1. Clone the repository, then run `npm install` and `npm run build` inside it.
2. Run `node dist/cli.js targets` and show me the list.
3. Ask me which agents and which project directory to use.
4. Run `node dist/cli.js install --target <ids> --dir <project> --dry-run`, show me the planned changes, and only run it without --dry-run after I confirm.
5. Verify the MCP server with `node dist/cli.js status`, then tell me what changed and how to uninstall.
Never store secrets in memories.
```

### Option 3: Ask AI

Not sure whether your agent is supported? Ask an AI assistant with the repository as context:

```text
Read https://github.com/cckyros/remme (README.md and docs/PLATFORM-ADAPTATION.md).
Tell me whether my agent (<name your agent>) is in the supported list, what the installer
does for it (automatic or manual), and the exact command to run.
```

### MCP client config (manual)

Any stdio MCP client can run remme directly:

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

## Platform support

`node dist/cli.js targets` prints the same list. **Automatic** means the installer writes the documented config file or copies the skill. **CLI** means it runs the client's own plugin command when that CLI is on `PATH`, otherwise it prints the steps. **Manual** means guidance only.

| ID | Agent | Kind | Scope | What install does |
|----|-------|------|-------|-------------------|
| `claude` | Claude Code | native | project / global | Automatic: `mcpServers.remme` in `settings.json` + skill |
| `codex` | Codex | native | project / global | Automatic: `[mcp_servers."remme"]` block in `config.toml`, rules block in `AGENTS.md`, skill, `supports_search_tool` fix |
| `opencode` | OpenCode | native | project / global | Automatic: `mcp.remme` in `opencode.json` + shared skill |
| `qwen` | Qwen Code | native | project / global | Automatic: `mcpServers.remme` in `.qwen/settings.json` + skill |
| `reasonix` | Reasonix | native | project / global | Automatic: `.mcp.json` entry (project) or managed `[[plugins]]` block (global) + shared skill |
| `kilo` | Kilo Code | native | project / global | Automatic: `mcp.remme` in `kilo.json` + shared skill |
| `workbuddy` | WorkBuddy | native | project / global | Automatic: `.mcp.json` entry + skill |
| `devin` | Devin | native | project / global | Automatic: `mcpServers.remme` in `mcp_config.json` + shared skill |
| `trae` | Trae | skill | project | Skill copied; MCP added by hand in the IDE |
| `pi` | pi | skill | project | Shared skill; MCP only when an MCP adapter extension is present |
| `omp` | Oh My Pi | skill | project | Shared skill; MCP by hand |
| `dsh` | dsh | skill | project | Shared skill; MCP by hand |
| `copilot` | GitHub Copilot | plugin | global | CLI: `copilot plugin install <plugin dir>`, otherwise steps |
| `cursor` | Cursor | plugin | global | Automatic: copies the plugin dir to `~/.cursor/plugins/local/remme` when Cursor is installed |
| `kiro` | Kiro | plugin | global | Manual: import the plugin dir as a power |
| `openclaw` | OpenClaw | plugin | global | Manual: no native bundle shipped yet |
| `hermes` | Hermes | plugin | global | CLI: `hermes plugin install <plugin dir>`, otherwise steps |
| `vscode` | VS Code | plugin | global | Automatic: `chat.pluginLocations` in user settings |
| `chatgpt-codex` | ChatGPT & Codex | plugin | global | Marketplace shim + `codex plugin` commands when the codex CLI exists |
| `grok` | Grok Bot | plugin | global | CLI: `grok plugin install <plugin dir> --trust`, otherwise steps |
| `nanoclaw` | NanoClaw | plugin | global | Template copy + `ncl groups create` when `ncl` exists |
| `other` | Other agents | plugin | global | Manual: install the plugin dir per your agent's docs |

Installer rules: files are changed only when they carry remme's marker or key; existing files are backed up to `.bak`; unparseable JSON (including JSONC comments) is reported as manual and left untouched; a failing target never blocks the others.

Common commands:

```bash
node dist/cli.js install --target all --dry-run          # preview every target
node dist/cli.js install --target codex --scope global   # user-level instead of project
node dist/cli.js uninstall --target claude --dir <project>
```

## Memory rules

These rules tell an agent when to recall and when to write. The installer copies them into `AGENTS.md` (Codex) and into the remme skill (all other skill-aware targets). The source is [`src/assets/agents-fragment.md`](src/assets/agents-fragment.md).

**Recall (`memory_search`)**

- Before a non-trivial task, search the project name and key technology terms for past decisions and pitfalls.
- On an error or bug, search the error keywords for an existing solution.
- Before a technology choice or architecture decision, search the technology name.
- When the user refers to the past ("last time", "I remember"), search the user's own wording.
- Before a new project or module, search the domain terms.
- Do not recall for simple questions, small talk, or work already done in the current session.
- If nothing comes back, say so. Do not guess.

**Write (`memory_write`)**

- After solving a non-trivial bug: the root cause and the fix (`knowledgeType: solution`).
- After an architecture or technology decision: the decision and its reason (`decision`).
- After finding a pitfall: the pitfall and how to avoid it (`pitfall`).
- After confirming a reusable pattern: the pattern (`pattern`).
- When the user asks you to remember something: write it as asked.
- Do not write temporary debugging steps, routine operations, or unverified guesses.
- Use `memory_update` to correct an existing memory instead of writing a duplicate.

**Promote and link**

- Confirmed knowledge: `memory_promote` (status `confirmed` or `verified`).
- Related memories: `memory_link` with `derived_from`, `supports`, `corrects`, `supersedes`, `verifies` or `related_to`.

Search results enter the agent's context but are never saved automatically: writing is always an explicit tool call.

## MCP tools

- `memory_search`: keyword + vector search with tag, project, status, knowledge type, entity and date filters
- `memory_write`: create a Markdown memory (status `candidate` by default)
- `memory_update`: update an existing memory
- `memory_promote`: promote a candidate to knowledge, with provenance
- `memory_link`: connect two memories
- `memory_read`: full text, relations and provenance
- `memory_list`: list memory files
- `memory_restore`: validate a SQLite snapshot with `confirm=true`; online replacement is refused, restore offline instead
- `memory_import`, `memory_import_status`, `memory_import_rollback`: import OpenClaw or Markdown directories with dry-run and rollback

## CLI

| Command | Purpose |
|---------|---------|
| `node dist/cli.js mcp` | run the MCP stdio server |
| `node dist/cli.js targets` | list install targets |
| `node dist/cli.js install --target <id,...\|all> [--scope project\|global] [--dir <path>] [--dry-run]` | install into agents |
| `node dist/cli.js uninstall --target <id,...\|all> [...]` | remove what remme wrote |
| `node dist/cli.js init` | show the effective config and the memory rules |
| `node dist/cli.js status` / `reindex` | index status / rebuild the index |
| `node dist/cli.js import <markdown\|openclaw> --source <dir>` | import memories |
| `node dist/cli.js embed` | backfill missing embeddings |

## Data location

```text
~/.remme/
├── memory.db       # SQLite index (rebuildable)
├── memory.db.bak   # single backup point
├── memory/         # Markdown source of truth
├── plugin/         # Agent Plugins package written by the installer
└── config.json     # optional overrides
```

Set `REMME_CONFIG` to use a different config file. `dbPath` and `memoryDir` can point elsewhere. Tests use temporary directories and never touch your data.

## Development

```bash
npm run build      # bundle dist/cli.js and generate plugin.json, mcp.json, .mcp.json, skills/
npm run typecheck
npm test           # unit + component tests (MCP stdio and installer run against dist/cli.js)
npm run verify     # all of the above
```

## Design boundaries

- Vector search is an exact local scan; no HNSW/ANN index yet.
- Nothing is injected at session start; the agent calls `memory_search` explicitly.
- No unattended LLM memory consolidation, no full conversation indexing.
- Only local embeddings; no remote embedding provider or HTTP/SSE transport yet.
- Plugin packages are built locally (`dist/` is not committed), so install from a clone.

Design notes: [`docs/SPEC.md`](docs/SPEC.md), [`docs/PLATFORM-ADAPTATION.md`](docs/PLATFORM-ADAPTATION.md), [`docs/OPENCLAW-IMPORT-DESIGN.md`](docs/OPENCLAW-IMPORT-DESIGN.md).

## License

MIT. See [`LICENSE`](LICENSE).
