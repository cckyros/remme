---
name: remme
description: "Recall and save cross-agent memories with remme: search past decisions and pitfalls before non-trivial work, and record verified solutions afterwards. Local-first MCP knowledge memory with SQLite and cross-agent provenance."
---
<!-- remme:skill -->
# remme memory skill

Use the `remme` MCP tools (memory_search, memory_write, memory_update, memory_promote, memory_link, memory_read, memory_list) for durable, reusable knowledge.

## remme memory rules

remme is a local memory shared by all your agents. Markdown files are the source of truth and SQLite is a rebuildable index. Search results enter the current context but are never saved automatically: write what is worth keeping.

### When to recall (memory_search)

- Before starting a non-trivial task: search the project name plus key technology terms for past decisions and pitfalls.
- When you hit an error or bug: search the error keywords for an existing solution.
- Before a technology choice or architecture decision: search the technology name and reuse earlier decisions.
- When the user refers to the past ("last time", "I remember", "before"): search the user's own wording.
- Before starting a new project or module: search the project or domain terms for related context.
- When unsure how to implement something: search the feature keywords for an existing pattern or solution.
- Do not recall for simple questions, small talk, or work already done in the current session.
- If a search returns nothing, say so. Do not guess. Widen the query only when the user asks.

### When to write (memory_write)

- After solving a non-trivial bug: record the root cause and the fix (knowledgeType: solution).
- After an architecture or technology decision: record the decision and its reason (knowledgeType: decision).
- After finding a pitfall: record the pitfall and how to avoid it (knowledgeType: pitfall).
- After confirming a reusable pattern: record the pattern (knowledgeType: pattern).
- When the user explicitly asks you to remember something: write it as requested.
- Do not write: temporary exploration or debugging steps, routine operations, or unverified guesses.
- Use memory_update to correct an existing memory instead of writing a duplicate.
- New writes start as status "candidate". Set importance (1-10) and tags so they can be recalled later.

### Promote and link

- When a candidate is confirmed, call memory_promote (status "confirmed" or "verified").
- Connect related memories with memory_link using derived_from, supports, corrects, supersedes, verifies, or related_to.

### Safety

- Never store secrets, tokens, passwords, cookies, or private configuration values in a memory.
- memory_restore is offline-only: stop every remme client before restoring the SQLite snapshot.
