import test from "node:test";
import assert from "node:assert/strict";
import { rankResults } from "../../src/search.ts";
import type { SearchItem } from "../../src/search.ts";

function item(id: number, snippet: string, score = 1000 - id): SearchItem {
  return { id, path: `${id}.md`, snippet, score, vectorScore: 0, textScore: 0, importance: 5, tags: [], status: "candidate", agent: "test", startLine: 1, endLine: 1 };
}

// ============================================================
// rankResults
// ============================================================

test("rankResults: orders by score descending when dedup disabled", () => {
  const result = rankResults([
    item(1, "alpha", 0.2), item(2, "beta", 0.9),
  ], false);
  assert.deepEqual(result.map((x) => x.id), [2, 1]);
});

test("rankResults: identical Chinese is deduplicated while different Chinese remains", () => {
  const results = rankResults([
    item(1, "缓存失效处理方案"), item(2, "缓存失效处理方案"), item(3, "数据库事务隔离级别"),
    item(4, "cache database 缓存失效"), item(5, "cache database 网络超时"),
  ]);
  assert.deepEqual(results.map((result) => result.id), [1, 3, 4, 5]);
});

test("rankResults: Unicode words, combining forms and short CJK snippets are recognized", () => {
  const results = rankResults([
    item(1, "CAFÉ résumé"), item(2, "cafe\u0301 re\u0301sume\u0301"),
    item(3, "中"), item(4, "中"), item(5, "文"),
    item(6, "日本語の記憶"), item(7, "日本語の記憶"), item(8, "한국어기억"), item(9, "한국어기억"),
  ]);
  assert.deepEqual(results.map((result) => result.id), [1, 3, 5, 6, 8]);
});

test("rankResults: CJK bigrams retain ordering instead of reducing text to a character bag", () => {
  assert.equal(rankResults([item(1, "甲乙丙丁"), item(2, "丁丙乙甲")]).length, 2);
});

test("rankResults: Jaccard duplicate filtering preserves relevance order rather than applying MMR", () => {
  const input = [item(3, "unrelated result", 1), item(2, "alpha beta gamma delta", 9), item(1, "alpha beta gamma delta", 10)];
  const original = [...input];
  assert.deepEqual(rankResults(input).map((result) => result.id), [1, 3]);
  assert.deepEqual(input, original);
  assert.deepEqual(rankResults(input, false).map((result) => result.id), [1, 2, 3]);
});

test("rankResults: third argument limits selected results after deduplication", () => {
  const input = [item(1, "duplicate words"), item(2, "duplicate words"), item(3, "unique result"), item(4, "last entry")];
  assert.deepEqual(rankResults(input, true, 2).map((result) => result.id), [1, 3]);
  assert.deepEqual(rankResults(input, false, 2).map((result) => result.id), [1, 2]);
});

test("rankResults: limit=0 returns empty array", () => {
  assert.deepEqual(rankResults([item(1, "a")], true, 0), []);
  assert.deepEqual(rankResults([item(1, "a")], false, 0), []);
});

test("rankResults: empty input returns empty array", () => {
  assert.deepEqual(rankResults([], true, 2), []);
  assert.deepEqual(rankResults([], false, 2), []);
});

test("rankResults: default result cap is 100 with or without Jaccard filtering", () => {
  const input = Array.from({ length: 250 }, (_, index) => item(index, `unique${index}`));
  assert.equal(rankResults(input).length, 100);
  assert.equal(rankResults(input, false).length, 100);
  assert.equal(rankResults(input, true, 150).length, 150);
});

test("rankResults: bounded selection stops tokenizing as soon as enough results are selected", () => {
  const tail = item(3, "unused");
  Object.defineProperty(tail, "snippet", { get() { throw new Error("tail must not be tokenized"); } });
  assert.deepEqual(rankResults([item(1, "first"), item(2, "second"), tail], true, 2).map((result) => result.id), [1, 2]);
});

test("rankResults: nonfinite limits fall back to 100 and finite limits are floored and clamped", () => {
  const input = Array.from({ length: 120 }, (_, index) => item(index, `unique${index}`));
  for (const limit of [NaN, Infinity, -Infinity]) assert.equal(rankResults(input, true, limit).length, 100);
  assert.equal(rankResults(input, false, 1.9).length, 1);
  assert.deepEqual(rankResults(input, true, -1), []);
});
