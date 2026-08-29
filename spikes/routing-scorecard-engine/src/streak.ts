/**
 * Streak / regression detection.
 *
 * Ported (read-only) from `scripts/sgi-loop-c-streak-detection.mjs`,
 * function `evaluateBucket` (and `selectForCreation`), in the source
 * monorepo this engine was extracted from. This is a standalone copy — do
 * not resync by writing back to the original.
 *
 * Four independent detectors run over a time-ordered series of
 * `{ qualitySignal, reworkRequired, createdAt }` records for one
 * agent+task_type bucket:
 *
 *   A — baseline-delta regression: mean(most-recent 5) <= mean(prior 20) - 0.5
 *   B — non-strict decline for small buckets (3 <= n < 10): the 3 most
 *       recent records are non-increasing oldest→newest AND the total drop
 *       is >= 1 AND the window's minimum quality is below an absolute floor
 *       AND at least one record in the window required rework
 *   C — sustained low absolute quality: mean(most-recent 5) <= 2.5
 *   D — rework streak: >= 3 of the most-recent 5 records have
 *       reworkRequired === true
 *
 * Simplification vs. the source script: the source additionally orders
 * trend detectors (A, B) by a "work date" distinct from `createdAt`, to
 * avoid reading a false trend out of backfill insertion order (its
 * AUR-4233 fix). This port takes the reduced input shape the extraction
 * spec calls for — `{ qualitySignal, reworkRequired, createdAt }` only —
 * and orders every detector by `createdAt` directly. A caller with a
 * genuine work-date/insertion-order distinction should sort records by
 * work date before calling `evaluateBucket`.
 */

import { mean } from "./util";

export interface StreakRecord {
  qualitySignal: number | null;
  reworkRequired: boolean;
  createdAt: string; // ISO-8601
}

export type DetectorId = "A" | "B" | "C" | "D";

export interface DetectorTrigger {
  detector: DetectorId;
  severity: number;
  description: string;
}

export type BucketSkipReason = "too_few_records" | "stale" | "no_trigger";

export interface BucketEvaluation {
  skip?: BucketSkipReason;
  triggers: DetectorTrigger[];
  severity: number | null;
  mostRecentAgeDays: number | null;
}

export const RECENT_N = 5;
export const BASELINE_N = 20;
export const BASELINE_MIN = 5;
export const DETECTOR_A_DELTA = 0.5;
export const DETECTOR_B_MAX_BUCKET = 10;
export const DETECTOR_B_QUALITY_FLOOR = 4;
export const DETECTOR_C_THRESHOLD = 2.5;
export const DETECTOR_D_MIN_REWORK = 3;
export const STALENESS_DAYS = 30;

const isNumber = (v: unknown): v is number => typeof v === "number";

export function evaluateBucket(records: StreakRecord[], refDate: Date = new Date()): BucketEvaluation {
  const sorted = [...records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  if (sorted.length < 3) {
    return { skip: "too_few_records", triggers: [], severity: null, mostRecentAgeDays: null };
  }

  const mostRecentAgeDays =
    (refDate.getTime() - new Date(sorted[0].createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (mostRecentAgeDays > STALENESS_DAYS) {
    return { skip: "stale", triggers: [], severity: null, mostRecentAgeDays };
  }

  const triggers: DetectorTrigger[] = [];
  const recent = sorted.slice(0, RECENT_N);
  const qRecent = recent.map((r) => r.qualitySignal).filter(isNumber);

  // Detector A — baseline-delta regression.
  const aRecent = sorted.slice(0, RECENT_N);
  const baseline = sorted.slice(RECENT_N, RECENT_N + BASELINE_N);
  const qARecent = aRecent.map((r) => r.qualitySignal).filter(isNumber);
  const qBaseline = baseline.map((r) => r.qualitySignal).filter(isNumber);
  if (
    aRecent.length >= RECENT_N &&
    baseline.length >= BASELINE_MIN &&
    qARecent.length &&
    qBaseline.length
  ) {
    const meanRecent = mean(qARecent);
    const meanBaseline = mean(qBaseline);
    const delta = meanBaseline - meanRecent;
    if (delta >= DETECTOR_A_DELTA) {
      triggers.push({
        detector: "A",
        severity: delta,
        description: `baseline-delta regression — recent${qARecent.length} mean ${meanRecent.toFixed(2)} vs prior${qBaseline.length} mean ${meanBaseline.toFixed(2)} (Δ=${delta.toFixed(2)})`,
      });
    }
  }

  // Detector B — non-strict decline, small buckets only.
  if (sorted.length >= 3 && sorted.length < DETECTOR_B_MAX_BUCKET) {
    const [n1, n2, n3] = sorted; // n1 = most recent, n3 = oldest of the 3
    if (isNumber(n1.qualitySignal) && isNumber(n2.qualitySignal) && isNumber(n3.qualitySignal)) {
      const q1 = n1.qualitySignal;
      const q2 = n2.qualitySignal;
      const q3 = n3.qualitySignal;
      const nonIncreasing = q3 >= q2 && q2 >= q1;
      const drop = q3 - q1;
      const minQuality = Math.min(q1, q2, q3);
      const belowFloor = minQuality < DETECTOR_B_QUALITY_FLOOR;
      const anyRework = [n1, n2, n3].some((r) => r.reworkRequired === true);
      if (nonIncreasing && drop >= 1 && belowFloor && anyRework) {
        triggers.push({
          detector: "B",
          severity: drop,
          description: `non-strict decline: ${q3}→${q2}→${q1}, min quality ${minQuality} (<${DETECTOR_B_QUALITY_FLOOR}) with rework`,
        });
      }
    }
  }

  // Detector C — sustained low absolute quality.
  if (recent.length >= RECENT_N && qRecent.length) {
    const meanRecent = mean(qRecent);
    if (meanRecent <= DETECTOR_C_THRESHOLD) {
      triggers.push({
        detector: "C",
        severity: DETECTOR_C_THRESHOLD - meanRecent,
        description: `sustained low quality — recent${qRecent.length} mean ${meanRecent.toFixed(2)} (≤${DETECTOR_C_THRESHOLD})`,
      });
    }
  }

  // Detector D — rework streak (3 of last 5).
  if (recent.length >= RECENT_N) {
    const reworkCount = recent.filter((r) => r.reworkRequired === true).length;
    if (reworkCount >= DETECTOR_D_MIN_REWORK) {
      triggers.push({
        detector: "D",
        severity: reworkCount / RECENT_N,
        description: `rework streak — ${reworkCount}/${RECENT_N} most-recent runs required rework`,
      });
    }
  }

  if (!triggers.length) {
    return { skip: "no_trigger", triggers: [], severity: null, mostRecentAgeDays };
  }

  return {
    triggers,
    severity: Math.max(...triggers.map((t) => t.severity)),
    mostRecentAgeDays,
  };
}

export interface SeverityBucket {
  severity: number;
}

/** Sort eligible buckets by severity desc, take the top `cap`, report the rest as dropped. */
export function selectForCreation<T extends SeverityBucket>(
  eligible: T[],
  cap: number,
): { selected: T[]; dropped: T[] } {
  const sorted = [...eligible].sort((a, b) => b.severity - a.severity);
  return { selected: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}
