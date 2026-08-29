/**
 * No standalone test fixture file exists for the source formula (it lives
 * inline in server/src/services/close-time-scorecard.ts with no dedicated
 * test file) — these cases are written directly against that formula and
 * its AUR-5410 "unmeasured cost is not free" edge case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeScoreAdjusted } from "../src/score";

test("computes quality * value / tokenCost", () => {
  const result = computeScoreAdjusted({ tokenCost: 1000, qualitySignal: 4, valueSignal: 2 });
  assert.equal(result.scoreAdjusted, (4 * 2) / 1000);
  assert.equal(result.reason, undefined);
});

test("AUR-5410: tokenCost of 0 is unmeasured, not free — returns null, never divides", () => {
  const result = computeScoreAdjusted({ tokenCost: 0, qualitySignal: 5, valueSignal: 3 });
  assert.equal(result.scoreAdjusted, null);
  assert.equal(result.reason, "unmeasured_cost");
});

test("AUR-5410: a negative tokenCost is also treated as unmeasured", () => {
  const result = computeScoreAdjusted({ tokenCost: -5, qualitySignal: 5, valueSignal: 3 });
  assert.equal(result.scoreAdjusted, null);
  assert.equal(result.reason, "unmeasured_cost");
});

test("a higher quality/value at the same cost produces a higher score", () => {
  const low = computeScoreAdjusted({ tokenCost: 1000, qualitySignal: 2, valueSignal: 1 });
  const high = computeScoreAdjusted({ tokenCost: 1000, qualitySignal: 5, valueSignal: 3 });
  assert.ok((high.scoreAdjusted as number) > (low.scoreAdjusted as number));
});
