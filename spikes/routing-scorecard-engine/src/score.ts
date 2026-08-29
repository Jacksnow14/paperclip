/**
 * Cost-adjusted score formula.
 *
 * Ported (read-only) from `server/src/services/close-time-scorecard.ts`,
 * function `buildCloseTimeScorecardCaptures`, in the source monorepo this
 * engine was extracted from. This is a standalone copy — do not resync by
 * writing back to the original.
 *
 *   score_adjusted = (quality_signal * value_signal) / token_cost
 *
 * Edge case: `token_cost <= 0` means "we never measured cost", not "this
 * cost nothing". An earlier version of the source formula clamped token
 * cost to a minimum of 1, which silently turned an unmeasured close into
 * `score_adjusted: 9.0` — the best possible score obtainable — and that
 * fabricated score then won every routing comparison it appeared in. This
 * port preserves the fix: an unmeasured cost returns `null` with an
 * explicit reason instead of a fabricated number.
 */

export interface ScoreInput {
  taskType?: string;
  tokenCost: number;
  qualitySignal: number;
  valueSignal: number;
}

export interface ScoreResult {
  scoreAdjusted: number | null;
  reason?: "unmeasured_cost";
}

export function computeScoreAdjusted(input: ScoreInput): ScoreResult {
  const { tokenCost, qualitySignal, valueSignal } = input;
  if (!(tokenCost > 0)) {
    return { scoreAdjusted: null, reason: "unmeasured_cost" };
  }
  return { scoreAdjusted: (qualitySignal * valueSignal) / tokenCost };
}
