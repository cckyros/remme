import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../src/importer/classifier.ts";

// ============================================================
// classify
// ============================================================

test("classify: MEMORY.md and USER.md map to curated observation", () => {
  assert.deepEqual(classify("MEMORY.md"), { category: "curated", knowledgeType: "observation" });
  assert.deepEqual(classify("USER.md"), { category: "curated", knowledgeType: "observation" });
});

test("classify: date-prefixed filenames map to daily", () => {
  assert.deepEqual(classify("memory/2026-09-04.md"), { category: "daily", knowledgeType: "observation" });
  assert.deepEqual(classify("2026-01-01-notes.md"), { category: "daily", knowledgeType: "observation" });
});

test("classify: projects directory maps to projects", () => {
  assert.deepEqual(classify("memory/projects/remme.md"), { category: "projects", knowledgeType: "observation" });
  assert.deepEqual(classify("projects/app.md"), { category: "projects", knowledgeType: "observation" });
});

test("classify: technical directory maps to technical", () => {
  assert.deepEqual(classify("memory/technical/sqlite.md"), { category: "technical", knowledgeType: "observation" });
  assert.deepEqual(classify("technical/gpu.md"), { category: "technical", knowledgeType: "observation" });
});

test("classify: learnings directory maps to learnings with pattern type", () => {
  assert.deepEqual(classify("memory/learnings/lesson.md"), { category: "learnings", knowledgeType: "pattern" });
  assert.deepEqual(classify("learnings/tip.md"), { category: "learnings", knowledgeType: "pattern" });
});

test("classify: system dirs excluded by default", () => {
  assert.equal(classify(".dreams/dream1.md"), null);
  assert.equal(classify("dreaming/phase.md"), null);
  assert.equal(classify("pags/note.md"), null);
  assert.equal(classify("prompt-templates/template.md"), null);
});

test("classify: system dirs included when flag set", () => {
  assert.equal(classify(".dreams/dream1.md", true)?.category, "system");
  assert.equal(classify("dreaming/phase.md", true)?.category, "system");
  assert.equal(classify("pags/note.md", true)?.category, "system");
  assert.equal(classify("prompt-templates/template.md", true)?.category, "system");
});

test("classify: Windows backslash paths handled", () => {
  assert.deepEqual(classify("memory\\technical\\sqlite.md"), { category: "technical", knowledgeType: "observation" });
  assert.deepEqual(classify("projects\\app.md"), { category: "projects", knowledgeType: "observation" });
});

test("classify: unknown paths default to curated observation", () => {
  assert.deepEqual(classify("random/path/notes.md"), { category: "curated", knowledgeType: "observation" });
  assert.deepEqual(classify("file.md"), { category: "curated", knowledgeType: "observation" });
});
