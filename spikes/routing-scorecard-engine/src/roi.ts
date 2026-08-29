/**
 * ROI ledger math.
 *
 * Ported (read-only) from `scripts/sgi-loop-d-roi-ledger.mjs` — specifically
 * `deriveValueSignal` and the value/token aggregation inside `computeRoi` —
 * in the source monorepo this engine was extracted from. This is a
 * standalone copy — do not resync by writing back to the original.
 *
 * The source script's full ROI ledger also resolves each scorecard to a
 * project, references a company-wide median for a logistic ROI score, and
 * posts board approvals — all Paperclip-specific and out of scope here.
 * What is ported is the pure aggregation the extraction spec asks for:
 *
 *   lifetime_value  = Σ derived_value(record) * (quality_signal / 5)
 *   lifetime_tokens = Σ token_cost
 *   roi_ratio       = lifetime_value / (lifetime_tokens / 1000)   // value per 1K tokens
 *
 * A record flagged `excludeFromAggregates`/`metricsLost` (AUR-5410: no
 * measured cost at capture time) is skipped entirely rather than folded in
 * with token_cost 0 — including it would add its value to the numerator
 * while adding nothing to the token denominator, silently inflating the
 * ratio for whichever bucket it landed in.
 */

export const PRIORITY_VALUE_WEIGHTS: Record<string, number> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0.5,
};

export interface ScorecardLike {
  valueSignal?: number | null;
  qualitySignal?: number | null;
  tokenCost: number;
  reworkRequired?: boolean;
  outcome?: string | null;
  priority?: "urgent" | "high" | "medium" | "low" | null;
  excludeFromAggregates?: boolean;
  metricsLost?: boolean;
}

export interface DerivedValue {
  value: number;
  basis: "explicit" | "derived_priority_outcome";
}

/**
 * Agents almost always leave `value_signal` at its default of 1, which
 * collapses the ledger into a completion counter. Until real revenue
 * accounting exists, value is derived from what the work itself declares:
 *
 *   value = priorityWeight(issue.priority) × outcomeWeight(record)
 *
 * An explicit non-default value_signal (anything other than missing/0/1) is
 * treated as a deliberate claim and respected as-is.
 */
export function deriveValueSignal(record: ScorecardLike): DerivedValue {
  const explicit = record.valueSignal ?? 0;
  if (explicit && explicit !== 1) {
    return { value: explicit, basis: "explicit" };
  }
  const priorityWeight = record.priority ? PRIORITY_VALUE_WEIGHTS[record.priority] ?? 1 : 1;
  const outcome = (record.outcome || "").toLowerCase();
  const outcomeWeight = outcome === "failure" ? 0.15 : record.reworkRequired === true ? 0.6 : 1;
  return { value: priorityWeight * outcomeWeight, basis: "derived_priority_outcome" };
}

export interface RoiAggregate {
  lifetimeValue: number;
  lifetimeTokens: number;
  roiRatio: number;
  sampleCount: number;
  excludedCount: number;
}

export function aggregateRoi(records: ScorecardLike[]): RoiAggregate {
  let lifetimeValue = 0;
  let lifetimeTokens = 0;
  let sampleCount = 0;
  let excludedCount = 0;

  for (const r of records) {
    if (r.excludeFromAggregates === true || r.metricsLost === true) {
      excludedCount += 1;
      continue;
    }
    const derived = deriveValueSignal(r);
    const quality = typeof r.qualitySignal === "number" ? r.qualitySignal : 3;
    const adjValue = derived.value * (Math.min(Math.max(quality, 0), 5) / 5);
    lifetimeValue += adjValue;
    lifetimeTokens += r.tokenCost;
    sampleCount += 1;
  }

  const roiRatio = lifetimeTokens > 0 ? lifetimeValue / (lifetimeTokens / 1000) : 0;
  return { lifetimeValue, lifetimeTokens, roiRatio, sampleCount, excludedCount };
}
