import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, parseMarkdown, renderMarkdown } from "../../src/chunker.ts";
import type { MemoryMetadata } from "../../src/chunker.ts";

const defaultMetadata = parseMarkdown("").metadata;

// ============================================================
// parseMarkdown
// ============================================================

test("parseMarkdown: empty input returns defaults", () => {
  const { metadata, body } = parseMarkdown("");
  assert.equal(metadata.importance, 5);
  assert.equal(metadata.status, "candidate");
  assert.equal(metadata.agent, "unknown");
  assert.equal(metadata.origin, "native");
  assert.deepEqual(metadata.tags, []);
  assert.deepEqual(metadata.entities, []);
  assert.equal(body, "");
});

test("parseMarkdown: no frontmatter returns source as body", () => {
  const { metadata, body } = parseMarkdown("just text");
  assert.equal(body, "just text");
  assert.equal(metadata.agent, "unknown");
});

test("parseMarkdown: all declared metadata fields round trip", () => {
  for (const origin of ["imported", "native", "custom"]) {
    const expected: MemoryMetadata = {
      importance: 8, tags: ["中文", "a,b"], knowledgeType: "decision", status: "verified",
      project: "", agent: "codex", created: "2026-01-02T03:04:05Z", entities: ["sqlite"],
      origin, importId: "import-1", source: "openclaw", originalPath: "D:\\notes\\a.md",
      category: "knowledge", sourceId: 0, embeddingDims: 384, embeddingModel: "model/name", originalRecordId: "00042",
    };
    assert.deepEqual(parseMarkdown(renderMarkdown("body", expected, "fallback")).metadata, expected);
  }
});

test("parseMarkdown: empty legacy project never consumes the following metadata line", () => {
  const parsed = parseMarkdown("---\r\nproject: \t\r\nagent: codex\r\nimportance: 7\r\n---\r\n\r\n  body\r\n");
  assert.equal(parsed.metadata.project, undefined);
  assert.equal(parsed.metadata.agent, "codex");
  assert.equal(parsed.metadata.importance, 7);
  assert.equal(parsed.body, "\r\n  body\r\n");
});

test("parseMarkdown: legacy unquoted metadata and comma lists remain readable", () => {
  const parsed = parseMarkdown('---\nproject: old project\nagent: old agent\ntags: alpha, 中文\nentities: db, api\noriginalPath: C:\\notes\\old.md\nsourceId: 17\nembeddingDims: 768\nembeddingModel: old-model\noriginalRecordId: 0007\n---\nbody');
  assert.equal(parsed.metadata.project, "old project");
  assert.equal(parsed.metadata.agent, "old agent");
  assert.deepEqual(parsed.metadata.tags, ["alpha", "中文"]);
  assert.deepEqual(parsed.metadata.entities, ["db", "api"]);
  assert.equal(parsed.metadata.originalPath, "C:\\notes\\old.md");
  assert.equal(parsed.metadata.sourceId, 17);
  assert.equal(parsed.metadata.embeddingDims, 768);
  assert.equal(parsed.metadata.originalRecordId, "0007");
});

test("parseMarkdown: JSON-quoted string values are decoded", () => {
  assert.equal(parseMarkdown('---\nproject: "\\u4e2d\\u6587"\n---\nbody').metadata.project, "中文");
});

test("parseMarkdown: invalid numbers return undefined", () => {
  assert.equal(parseMarkdown("---\nembeddingDims: Infinity\nsourceId: invalid\n---\nbody").metadata.sourceId, undefined);
  assert.equal(parseMarkdown("---\nembeddingDims: Infinity\n---\nbody").metadata.embeddingDims, undefined);
});

test("parseMarkdown: fallback agent used when agent field missing", () => {
  assert.equal(parseMarkdown("---\n---\nbody", "my-agent").metadata.agent, "my-agent");
  assert.equal(parseMarkdown("---\nagent: explicit\n---\nbody", "my-agent").metadata.agent, "explicit");
});

test("parseMarkdown: importance is clamped to 1-10 range", () => {
  assert.equal(parseMarkdown("---\nimportance: 0\n---\nbody").metadata.importance, 1);
  assert.equal(parseMarkdown("---\nimportance: 99\n---\nbody").metadata.importance, 10);
  assert.equal(parseMarkdown("---\nimportance: 5\n---\nbody").metadata.importance, 5);
});

test("parseMarkdown: CRLF line endings handled", () => {
  const parsed = parseMarkdown("---\r\nagent: codex\r\nimportance: 3\r\n---\r\nbody text\r\n");
  assert.equal(parsed.metadata.agent, "codex");
  assert.equal(parsed.metadata.importance, 3);
  assert.equal(parsed.body, "body text\r\n");
});

// ============================================================
// renderMarkdown
// ============================================================

test("renderMarkdown: minimal metadata uses defaults", () => {
  const rendered = renderMarkdown("content", {}, "my-agent");
  assert.ok(rendered.includes("importance: 5"));
  assert.ok(rendered.includes('agent: "my-agent"'));
  assert.ok(rendered.includes('status: "candidate"'));
  assert.ok(rendered.includes("content"));
});

test("renderMarkdown: frontmatter round trips essential knowledge metadata", () => {
  const source = renderMarkdown("A decision", { knowledgeType: "decision", status: "verified", tags: ["sqlite"] }, "codex");
  const parsed = parseMarkdown(source, "unknown");
  assert.equal(parsed.metadata.knowledgeType, "decision");
  assert.equal(parsed.metadata.status, "verified");
  assert.deepEqual(parsed.metadata.tags, ["sqlite"]);
  assert.equal(parsed.metadata.agent, "codex");
});

test("renderMarkdown: dangerous strings cannot inject fields or frontmatter", () => {
  const dangerous = '  quoted "value"\\path\r\n---\nstatus: forged\u2028next\u2029end  ';
  const strings = {
    knowledgeType: dangerous, status: dangerous, project: dangerous, agent: dangerous,
    created: dangerous, origin: dangerous, importId: dangerous, source: dangerous,
    originalPath: dangerous, category: dangerous, embeddingModel: dangerous, originalRecordId: dangerous,
  };
  const rendered = renderMarkdown("actual body", { ...strings, tags: [dangerous], entities: [dangerous] }, "fallback");
  assert.equal(rendered.split("\n").filter((line) => line === "---").length, 2);
  assert.ok(!rendered.includes("\r"));
  assert.ok(!rendered.includes("\u2028"));
  assert.ok(!rendered.includes("\u2029"));
  const parsed = parseMarkdown(rendered);
  for (const [key, value] of Object.entries(strings)) assert.equal(parsed.metadata[key as keyof MemoryMetadata], value);
  assert.deepEqual(parsed.metadata.tags, [dangerous]);
  assert.deepEqual(parsed.metadata.entities, [dangerous]);
  assert.equal(parsed.body.trim(), "actual body");
});

test("renderMarkdown: content is trimmed", () => {
  const rendered = renderMarkdown("  \n  hello world  \n  ", {}, "agent");
  const parsed = parseMarkdown(rendered);
  assert.equal(parsed.body.trim(), "hello world");
});

// ============================================================
// chunkMarkdown
// ============================================================

test("chunkMarkdown: empty or whitespace-only body returns []", () => {
  assert.deepEqual(chunkMarkdown("", defaultMetadata), []);
  assert.deepEqual(chunkMarkdown(" \n\t ", defaultMetadata), []);
});

test("chunkMarkdown: long single line retains prefix and every character under the cap", () => {
  const body = "PREFIX" + "x".repeat(4100) + "END";
  const chunks = chunkMarkdown(body, defaultMetadata, 64);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), body);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 64));
  assert.ok(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1));
});

test("chunkMarkdown: prefers newline boundaries without exceeding maxChars", () => {
  const chunks = chunkMarkdown("abc\ndefghij\nkl", defaultMetadata, 7);
  assert.deepEqual(chunks.map(({ text, startLine, endLine }) => ({ text, startLine, endLine })), [
    { text: "abc\n", startLine: 1, endLine: 1 },
    { text: "defghij", startLine: 2, endLine: 2 },
    { text: "\nkl", startLine: 2, endLine: 3 },
  ]);
});

test("chunkMarkdown: line numbers stay relative to the untrimmed body including leading blank lines", () => {
  const body = " \r\n\t\r\n  abc\r\ndefghij\r\nkl  \r\n";
  const chunks = chunkMarkdown(body, defaultMetadata, 7);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), body.trim());
  let offset = body.length - body.trimStart().length;
  for (const chunk of chunks) {
    assert.equal(chunk.startLine, 1 + (body.slice(0, offset).match(/\n/g)?.length ?? 0));
    const end = offset + chunk.text.length - (chunk.text.endsWith("\n") ? 1 : 0);
    assert.equal(chunk.endLine, 1 + (body.slice(0, end).match(/\n/g)?.length ?? 0));
    assert.equal(chunk.metadata, defaultMetadata);
    offset += chunk.text.length;
  }
  assert.equal(chunks[0].startLine, 3);
});

test("chunkMarkdown: parse and chunk retain body-relative blank-line coordinates", () => {
  const parsed = parseMarkdown("---\nagent: a\n---\n\n  first\nsecond\n");
  const chunks = chunkMarkdown(parsed.body, parsed.metadata, 100);
  assert.equal(chunks[0].text, "first\nsecond");
  assert.equal(chunks[0].startLine, 2);
  assert.equal(chunks[0].endLine, 3);
});

test("chunkMarkdown: Unicode character caps never split surrogate pairs", () => {
  const body = "𠮷中文\t  café\n".repeat(10).trim();
  for (const maxChars of [1, 2, 5, 20]) {
    const chunks = chunkMarkdown(body, defaultMetadata, maxChars);
    assert.equal(chunks.map((chunk) => chunk.text).join(""), body);
    assert.ok(chunks.every((chunk) => Array.from(chunk.text).length <= maxChars && !/[\uD800-\uDFFF]/u.test(chunk.text)));
  }
});

test("chunkMarkdown: default maxChars is 1800", () => {
  const body = "a".repeat(3600);
  const chunks = chunkMarkdown(body, defaultMetadata);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1800));
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("chunkMarkdown: invalid cap throws RangeError", () => {
  for (const cap of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => chunkMarkdown("abc", defaultMetadata, cap), RangeError);
});
