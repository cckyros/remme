import test from "node:test";
import assert from "node:assert/strict";
import { rankResults } from "../src/search.ts";
test("rankResults orders by score", () => { const result = rankResults([{ id: 1, path: "a", snippet: "alpha", score: 0.2, vectorScore: 0, textScore: 0, importance: 5, tags: [], status: "candidate", agent: "a", startLine: 1, endLine: 1 }, { id: 2, path: "b", snippet: "beta", score: 0.9, vectorScore: 0, textScore: 0, importance: 5, tags: [], status: "verified", agent: "b", startLine: 1, endLine: 1 }], false); assert.deepEqual(result.map((x) => x.id), [2, 1]); });
