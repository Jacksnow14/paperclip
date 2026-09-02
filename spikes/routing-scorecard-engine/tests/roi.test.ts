/**
 * Ported from scripts/sgi-loop-d-roi-ledger.test.mjs in the source
 * monorepo. `deriveValueSignal` cases are ported directly (signature
 * adapted: the source takes `(record, issueMeta)` as two objects; this
 * port takes one `ScorecardLike` object with `priority` inline). The
 * `computeRoi` cases are ported at the `aggregateRoi` level — the pure
 * value/token aggregation this extraction spec asks for — with the
 * source's project-resolution/revenue-basis machinery (out of scope)
 * left out, per src/roi.ts's header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveValueSignal, aggregateRoi, PRIORITY_VALUE_WEIGHTS, ScorecardLike } from "../src/roi";

test("deriveValueSignal respects an explicit non-default value_signal", () => {
  const derived = deriveValueSignal({ valueSignal: 4, priority: "low", tokenCost: 1000 });
  assert.deepEqual(derived, { value: 4, basis: "explicit" });
});

test("deriveValueSignal derives from priority when the signal is the default 1", () => {
  assert.equal(
    deriveValueSignal({ valueSignal: 1, priority: "urgent", tokenCost: 1000 }).value,
    PRIORITY_VALUE_WEIGHTS.urgent,
  );
  assert.equal(
    deriveValueSignal({ valueSignal: 1, priority: "low", tokenCost: 1000 }).value,
    PRIORITY_VALUE_WEIGHTS.low,
  );
  assert.equal(deriveValueSignal({ priority: "high", tokenCost: 1000 }).value, PRIORITY_VALUE_WEIGHTS.high);
  assert.equal(deriveValueSignal({ valueSignal: 0, priority: null, tokenCost: 1000 }).value, 1);
  assert.equal(
    deriveValueSignal({ valueSignal: 1, priority: "high", tokenCost: 1000 }).basis,
    "derived_priority_outcome",
  );
});

test("deriveValueSignal discounts failures and rework", () => {
  assert.equal(
    deriveValueSignal({ valueSignal: 1, outcome: "failure", priority: "medium", tokenCost: 1000 }).value,
    0.15,
  );
  assert.equal(
    deriveValueSignal({ valueSignal: 1, reworkRequired: true, priority: "medium", tokenCost: 1000 }).value,
    0.6,
  );
  // failure dominates over rework
  assert.equal(
    deriveValueSignal({
      valueSignal: 1,
      outcome: "failure",
      reworkRequired: true,
      priority: "urgent",
      tokenCost: 1000,
    }).value,
    3 * 0.15,
  );
});

test("an urgent-success bucket ranks above a low-failure bucket at equal token cost", () => {
  const urgent: ScorecardLike[] = [
    { tokenCost: 1000, valueSignal: 1, qualitySignal: 4, outcome: "success", priority: "urgent" },
    { tokenCost: 1000, valueSignal: 1, qualitySignal: 4, outcome: "success", priority: "urgent" },
  ];
  const failing: ScorecardLike[] = [
    { tokenCost: 1000, valueSignal: 1, qualitySignal: 4, outcome: "failure", priority: "low" },
    { tokenCost: 1000, valueSignal: 1, qualitySignal: 4, outcome: "failure", priority: "low" },
  ];
  const urgentAgg = aggregateRoi(urgent);
  const failingAgg = aggregateRoi(failing);
  assert.ok(urgentAgg.roiRatio > failingAgg.roiRatio, `expected ${urgentAgg.roiRatio} > ${failingAgg.roiRatio}`);
});

test("AUR-5410: aggregateRoi excludes a row flagged excludeFromAggregates/metricsLost", () => {
  const measuredOnly: ScorecardLike[] = [
    { tokenCost: 1000, valueSignal: 1, qualitySignal: 4, priority: "high" },
  ];
  const withUnmeasuredRowAdded: ScorecardLike[] = [
    ...measuredOnly,
    {
      tokenCost: 0,
      valueSignal: 1,
      qualitySignal: 4,
      priority: "high",
      excludeFromAggregates: true,
      metricsLost: true,
    },
  ];

  const baseline = aggregateRoi(measuredOnly);
  const withExcludedRow = aggregateRoi(withUnmeasuredRowAdded);

  // PASSING: the excluded row must not move the ratio or sample count at all.
  assert.equal(withExcludedRow.roiRatio, baseline.roiRatio);
  assert.equal(withExcludedRow.sampleCount, 1);
  assert.equal(withExcludedRow.excludedCount, 1);
  assert.equal(baseline.roiRatio, 1.6);

  // FIRING: re-run the pre-fix arithmetic to prove what this guard exists to
  // catch — folding the unmeasured row's value into the numerator while
  // adding nothing to the token denominator would double the ratio.
  const preFixValue = 1.6 + 1.6;
  const preFixRatio = preFixValue / (1000 / 1000);
  assert.equal(preFixRatio, 3.2);
  assert.notEqual(withExcludedRow.roiRatio, preFixRatio);
});
