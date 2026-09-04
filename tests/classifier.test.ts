import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/importer/classifier.ts";

test("classifier maps OpenClaw paths to remme categories", () => {
  assert.deepEqual(classify("MEMORY.md"), { category: "curated", knowledgeType: "observation" });
  assert.deepEqual(classify("USER.md"), { category: "curated", knowledgeType: "observation" });
  assert.deepEqual(classify("memory/2026-09-04.md"), { category: "daily", knowledgeType: "observation" });
  assert.deepEqual(classify("memory/projects/remme.md"), { category: "projects", knowledgeType: "observation" });
  assert.deepEqual(classify("memory/technical/sqlite.md"), { category: "technical", knowledgeType: "observation" });
  assert.deepEqual(classify("memory/learnings/lesson.md"), { category: "learnings", knowledgeType: "pattern" });
});

test("classifier excludes system dirs by default", () => {
  assert.equal(classify(".dreams/dream1.md"), null);
  assert.equal(classify("dreaming/phase.md"), null);
  assert.equal(classify("pags/note.md"), null);
  assert.equal(classify("prompt-templates/template.md"), null);
});

test("classifier includes system dirs when flag set", () => {
  const result = classify(".dreams/dream1.md", true);
  assert.equal(result?.category, "system");
});

test("classifier handles Windows backslash paths", () => {
  assert.deepEqual(classify("memory\\technical\\sqlite.md"), { category: "technical", knowledgeType: "observation" });
});
