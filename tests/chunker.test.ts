import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, renderMarkdown } from "../src/chunker.ts";
test("frontmatter round trips essential knowledge metadata", () => { const source = renderMarkdown("A decision", { knowledgeType: "decision", status: "verified", tags: ["sqlite"] }, "codex"); const parsed = parseMarkdown(source, "unknown"); assert.equal(parsed.metadata.knowledgeType, "decision"); assert.equal(parsed.metadata.status, "verified"); assert.deepEqual(parsed.metadata.tags, ["sqlite"]); assert.equal(parsed.metadata.agent, "codex"); });
