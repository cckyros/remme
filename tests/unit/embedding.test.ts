import test from "node:test";
import assert from "node:assert/strict";
import { cosine } from "../../src/embedding.ts";

// ============================================================
// cosine
// ============================================================

test("cosine: identical vectors return 1", () => {
  const v = new Float32Array([1, 2, 3]);
  assert.equal(cosine(v, v), 1);
});

test("cosine: orthogonal vectors return 0", () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
});

test("cosine: opposite vectors return -1", () => {
  assert.equal(cosine(new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3])), -1);
});

test("cosine: zero vector returns 0", () => {
  assert.equal(cosine(new Float32Array([0, 0, 0]), new Float32Array([1, 2, 3])), 0);
  assert.equal(cosine(new Float32Array([1, 2, 3]), new Float32Array([0, 0, 0])), 0);
});

test("cosine: different lengths use min length", () => {
  const result = cosine(new Float32Array([1, 0, 5]), new Float32Array([1, 0]));
  assert.equal(result, 1);
});

test("cosine: empty vectors return 0", () => {
  assert.equal(cosine(new Float32Array([]), new Float32Array([])), 0);
});

test("cosine: known value matches manual calculation", () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([4, 5, 6]);
  const dot = 1 * 4 + 2 * 5 + 3 * 6;
  const expected = dot / (Math.sqrt(1 + 4 + 9) * Math.sqrt(16 + 25 + 36));
  assert.ok(Math.abs(cosine(a, b) - expected) < 1e-6);
});
