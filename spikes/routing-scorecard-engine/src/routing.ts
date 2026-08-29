/**
 * Routing recommendation.
 *
 * Ported (read-only) from the candidate-comparison convention documented and
 * enforced by `scripts/check-routing-rationale.mjs` and the routing-
 * rationale doctrine in the source monorepo this engine was extracted from
 * ("Step 1 — cost-adjusted scorecards (primary)" / "Step 2 — raw
 * quality_signal (fallback)"). This is a standalone copy — do not resync by
 * writing back to the original.
 *
 * Given N candidates, each carrying a set of recent scorecard-like records:
 *
 *   Step 1: if ANY candidate has usable score_adjusted samples (excluding
 *           records flagged excludeFromAggregates/metricsLost — the
 *           AUR-5410 "unmeasured cost" case), pick the candidate with the
 *           highest average score_adjusted among those that have data.
 *   Step 2: otherwise, fall back to the candidate with the highest average
 *           raw quality_signal.
 *   Neither: report no usable data at all — the caller falls back to
 *           role-based routing, which this engine does not automate.
 *
 * The output always includes the numeric comparison AND a human-readable
 * rationale string — the explainability hook this extraction exists to
 * demonstrate.
 */

import { mean } from "./util";

export interface CandidateRecord {
  scoreAdjusted?: number | null;
  qualitySignal?: number | null;
  reworkRequired?: boolean;
  tokenCost?: number;
  excludeFromAggregates?: boolean;
  metricsLost?: boolean;
}

export interface Candidate {
  id: string;
  records: CandidateRecord[];
}

export interface CandidateScore {
  id: string;
  usableScoreAdjustedSamples: number;
  avgScoreAdjusted: number | null;
  avgQualitySignal: number | null;
  reworkCount: number;
  sampleCount: number;
  fellBackToQuality: boolean;
}

export interface RoutingRecommendation {
  chosenCandidateId: string | null;
  candidates: CandidateScore[];
  dataAvailable: boolean;
  rationale: string;
}

function usableScoreAdjustedRecords(records: CandidateRecord[]): CandidateRecord[] {
  return records.filter(
    (r) =>
      r.excludeFromAggregates !== true &&
      r.metricsLost !== true &&
      typeof r.scoreAdjusted === "number",
  );
}

export function scoreCandidate(candidate: Candidate): CandidateScore {
  const usable = usableScoreAdjustedRecords(candidate.records);
  const avgScoreAdjusted = usable.length
    ? mean(usable.map((r) => r.scoreAdjusted as number))
    : null;
  const qualityValues = candidate.records
    .map((r) => r.qualitySignal)
    .filter((v): v is number => typeof v === "number");
  const avgQualitySignal = qualityValues.length ? mean(qualityValues) : null;
  const reworkCount = candidate.records.filter((r) => r.reworkRequired === true).length;
  return {
    id: candidate.id,
    usableScoreAdjustedSamples: usable.length,
    avgScoreAdjusted,
    avgQualitySignal,
    reworkCount,
    sampleCount: candidate.records.length,
    fellBackToQuality: usable.length === 0,
  };
}

export function recommendCandidate(candidates: Candidate[]): RoutingRecommendation {
  const scored = candidates.map(scoreCandidate);
  const withCostAdjusted = scored.filter((c) => c.avgScoreAdjusted !== null);

  if (withCostAdjusted.length) {
    const ranked = [...withCostAdjusted].sort(
      (a, b) => (b.avgScoreAdjusted as number) - (a.avgScoreAdjusted as number),
    );
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const rationale = runnerUp
      ? `Chose ${winner.id}: avg score_adjusted ${(winner.avgScoreAdjusted as number).toFixed(6)} vs ${runnerUp.id}'s ${(runnerUp.avgScoreAdjusted as number).toFixed(6)} (${winner.usableScoreAdjustedSamples} samples).`
      : `Chose ${winner.id}: only candidate with cost-adjusted data (avg score_adjusted ${(winner.avgScoreAdjusted as number).toFixed(6)}, ${winner.usableScoreAdjustedSamples} samples).`;
    return { chosenCandidateId: winner.id, candidates: scored, dataAvailable: true, rationale };
  }

  const withQuality = scored.filter((c) => c.avgQualitySignal !== null);
  if (withQuality.length) {
    const ranked = [...withQuality].sort(
      (a, b) => (b.avgQualitySignal as number) - (a.avgQualitySignal as number),
    );
    const winner = ranked[0];
    return {
      chosenCandidateId: winner.id,
      candidates: scored,
      dataAvailable: true,
      rationale: `No scorecard-adjusted data for any candidate — fell back to raw quality_signal. Chose ${winner.id}: avg quality_signal ${(winner.avgQualitySignal as number).toFixed(2)}.`,
    };
  }

  return {
    chosenCandidateId: null,
    candidates: scored,
    dataAvailable: false,
    rationale: "No scorecard data available for any candidate — fall back to role-based routing.",
  };
}
