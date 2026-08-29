/**
 * Ported from scripts/sgi-loop-c-streak-detection.test.mjs in the source
 * monorepo. Only cases compatible with this port's documented
 * simplification are ported (see src/streak.ts header): the production
 * script orders trend detectors by a separate "work date" pulled from an
 * issue-title convention (AUR-4233) and fails a window closed when that
 * work date is ambiguous or missing. This port has no title/work-date
 * concept — it orders directly by `createdAt`, per the extraction spec's
 * scoped input shape of `{ qualitySignal, reworkRequired, createdAt }`.
 * Cases that specifically exercise the work-date-vs-createdAt divergence,
 * the `unorderable` fail-closed reasons, or Paperclip-specific concerns
 * (cooldown, issue-title parsing, agent-key canonicalization, self-edit
 * issue payloads) are intentionally NOT ported — they test behavior this
 * standalone engine does not implement, by design.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBucket, selectForCreation, StreakRecord } from "../src/streak";

const REF_DATE = new Date("2026-07-26T00:00:00Z");

function daysAgoIso(days: number): string {
  const d = new Date(REF_DATE);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function makeRecs(
  qualities: number[],
  opts: { startDaysAgo?: number; stepDays?: number; rework?: boolean[] } = {},
): StreakRecord[] {
  const { startDaysAgo = 0, stepDays = 3, rework = [] } = opts;
  const newestFirst = [...qualities].reverse();
  return newestFirst.map((q, i) => {
    const daysAgo = startDaysAgo + i * stepDays;
    return {
      qualitySignal: q,
      reworkRequired: rework[qualities.length - 1 - i] === true,
      createdAt: daysAgoIso(daysAgo),
    };
  });
}

// ── Detector B — non-strict decline, small buckets ──────────────────────────

test("5,4,4 with no rework does NOT trigger detector B — quality 4 is good work", () => {
  const result = evaluateBucket(makeRecs([5, 4, 4]), REF_DATE);
  assert.equal(result.skip, "no_trigger");
});

test("5,3,2 with rework triggers detector B — a real decline still fires", () => {
  const result = evaluateBucket(makeRecs([5, 3, 2], { rework: [false, true, true] }), REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === "B"));
});

test("quality floor CLEARS a healthy streak: 5,4,4 even WITH rework does not trigger B", () => {
  const result = evaluateBucket(makeRecs([5, 4, 4], { rework: [true, true, true] }), REF_DATE);
  assert.ok(!result.triggers.some((t) => t.detector === "B"), "min quality 4 is at the floor");
});

test("quality floor FIRES once the window dips below it: 5,4,3 with rework triggers B", () => {
  const result = evaluateBucket(makeRecs([5, 4, 3], { rework: [false, false, true] }), REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === "B"));
});

test("rework gate CLEARS a no-rework streak: 5,4,3 with zero rework does not trigger B", () => {
  const result = evaluateBucket(makeRecs([5, 4, 3]), REF_DATE);
  assert.equal(result.skip, "no_trigger");
});

test("rework gate FIRES when one record in the window required rework: 5,4,3 triggers B", () => {
  const result = evaluateBucket(makeRecs([5, 4, 3], { rework: [false, true, false] }), REF_DATE);
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === "B"));
});

test("flat 4,4,4 does not trigger any detector", () => {
  const result = evaluateBucket(makeRecs([4, 4, 4]), REF_DATE);
  assert.equal(result.skip, "no_trigger");
});

// ── Detector A — baseline-delta regression ──────────────────────────────────

test("25-record bucket with recent5 mean 0.6 below prior20 mean triggers detector A", () => {
  const baselineQ = Array.from({ length: 20 }, () => 5);
  const recentQ = [5, 4, 4, 4, 5];
  const result = evaluateBucket(makeRecs([...baselineQ, ...recentQ]), REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  const a = result.triggers.find((t) => t.detector === "A");
  assert.ok(a, "detector A should fire");
  assert.ok(Math.abs((a as any).severity - 0.6) < 1e-9);
});

test("25-record bucket with flat quality does not trigger detector A", () => {
  const result = evaluateBucket(makeRecs(Array.from({ length: 25 }, () => 4)), REF_DATE);
  assert.equal(result.skip, "no_trigger");
});

// ── Staleness guard ──────────────────────────────────────────────────────────

test("a bucket whose most-recent record is older than 30 days is skipped as stale", () => {
  const result = evaluateBucket(
    makeRecs([5, 3, 2], { startDaysAgo: 40, rework: [true, true, true] }),
    REF_DATE,
  );
  assert.equal(result.skip, "stale");
});

test("a bucket whose most-recent record is within 30 days is evaluated normally", () => {
  const result = evaluateBucket(
    makeRecs([5, 3, 2], { startDaysAgo: 29, rework: [true, true, true] }),
    REF_DATE,
  );
  assert.ok(!result.skip);
});

// ── Detector C — sustained low absolute quality ─────────────────────────────

test("recent5 mean <= 2.5 triggers detector C", () => {
  const result = evaluateBucket(makeRecs([2, 2, 3, 2, 3]), REF_DATE); // mean 2.4
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === "C"));
});

// ── Detector D — rework streak (3 of last 5) ────────────────────────────────

test("3 of last 5 rework_required triggers detector D even with 2 clean runs", () => {
  const result = evaluateBucket(
    makeRecs([4, 4, 4, 4, 4], { rework: [true, false, true, false, true] }),
    REF_DATE,
  );
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === "D"));
});

test("2 of last 5 rework_required does not trigger detector D", () => {
  const result = evaluateBucket(
    makeRecs([4, 4, 4, 4, 4], { rework: [true, false, true, false, false] }),
    REF_DATE,
  );
  assert.equal(result.skip, "no_trigger");
});

// ── too-few-records floor ────────────────────────────────────────────────────

test("fewer than 3 records is skipped as too_few_records, not evaluated", () => {
  const result = evaluateBucket(makeRecs([4, 4]), REF_DATE);
  assert.equal(result.skip, "too_few_records");
});

// ── selectForCreation cap ────────────────────────────────────────────────────

test("selectForCreation caps at N, highest severity first, and reports dropped", () => {
  const eligible = [
    { key: "a/feature", severity: 0.5 },
    { key: "b/feature", severity: 2.0 },
    { key: "c/feature", severity: 1.2 },
    { key: "d/feature", severity: 0.9 },
  ];
  const { selected, dropped } = selectForCreation(eligible, 3);
  assert.deepEqual(selected.map((t) => t.key), ["b/feature", "c/feature", "d/feature"]);
  assert.deepEqual(dropped.map((t) => t.key), ["a/feature"]);
});

test("selectForCreation does not drop anything under the cap", () => {
  const eligible = [{ key: "a/feature", severity: 1 }];
  const { selected, dropped } = selectForCreation(eligible, 3);
  assert.equal(selected.length, 1);
  assert.equal(dropped.length, 0);
});
