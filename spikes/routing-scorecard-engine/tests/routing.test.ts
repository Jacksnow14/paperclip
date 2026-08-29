/**
 * No standalone fixture file exists for this logic in the source monorepo
 * (scripts/check-routing-rationale.mjs audits rationale *record existence*,
 * not the comparison itself) — these cases are written directly against
 * the Step 1 / Step 2 algorithm as documented by that repo's
 * routing-rationale doctrine, which src/routing.ts's header cites verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recommendCandidate, Candidate } from "../src/routing";

test("Step 1: picks the candidate with the highest avg score_adjusted when both have cost-adjusted data", () => {
  const candidates: Candidate[] = [
    { id: "agent-a", records: [{ scoreAdjusted: 0.000015 }, { scoreAdjusted: 0.000013 }] },
    { id: "agent-b", records: [{ scoreAdjusted: 0.000009 }] },
  ];
  const result = recommendCandidate(candidates);
  assert.equal(result.chosenCandidateId, "agent-a");
  assert.equal(result.dataAvailable, true);
  assert.match(result.rationale, /agent-a/);
});

test("Step 1 excludes AUR-5410 excludeFromAggregates/metricsLost rows from the average", () => {
  const candidates: Candidate[] = [
    {
      id: "agent-a",
      records: [
        { scoreAdjusted: 0.00001 },
        { scoreAdjusted: 999, excludeFromAggregates: true },
        { scoreAdjusted: 999, metricsLost: true },
      ],
    },
    { id: "agent-b", records: [{ scoreAdjusted: 0.000005 }] },
  ];
  const result = recommendCandidate(candidates);
  const a = result.candidates.find((c) => c.id === "agent-a")!;
  assert.equal(a.usableScoreAdjustedSamples, 1);
  assert.equal(a.avgScoreAdjusted, 0.00001);
  assert.equal(result.chosenCandidateId, "agent-a");
});

test("Step 2: falls back to raw quality_signal when no candidate has cost-adjusted data", () => {
  const candidates: Candidate[] = [
    { id: "agent-a", records: [{ qualitySignal: 3 }, { qualitySignal: 3 }] },
    { id: "agent-b", records: [{ qualitySignal: 5 }] },
  ];
  const result = recommendCandidate(candidates);
  assert.equal(result.chosenCandidateId, "agent-b");
  assert.equal(result.dataAvailable, true);
  assert.match(result.rationale, /fell back to raw quality_signal/);
});

test("no data available for any candidate falls back to role-based routing signal", () => {
  const candidates: Candidate[] = [
    { id: "agent-a", records: [] },
    { id: "agent-b", records: [] },
  ];
  const result = recommendCandidate(candidates);
  assert.equal(result.chosenCandidateId, null);
  assert.equal(result.dataAvailable, false);
  assert.match(result.rationale, /role-based routing/);
});

test("a single candidate with cost-adjusted data wins even with no runner-up", () => {
  const candidates: Candidate[] = [{ id: "agent-a", records: [{ scoreAdjusted: 0.00002 }] }];
  const result = recommendCandidate(candidates);
  assert.equal(result.chosenCandidateId, "agent-a");
  assert.match(result.rationale, /only candidate with cost-adjusted data/);
});
