#!/usr/bin/env node
/**
 * SGI Loop H — Experiment scope isolation (AUR-3202)
 *
 * Canonical, importable logic that makes Loop H adopt/reject gates *attributable*.
 *
 * Root cause (AUR-3201 → AUR-3202): experiment 9f073e41 reached `adopted` on a
 * +41.64% quality-per-token swing that was **agent-wide** — the Watchdog's
 * measurement window defaulted to *all* of the CTO agent's scorecards, a window
 * heavy with small ops/heartbeat tasks, so workload composition (not the change)
 * inflated the ratio. The experiment record carried no isolation key, so the
 * measure could not be scoped to the affected workload.
 *
 * Fix: every `experiment/{id}` record MUST carry an isolation key — one of
 * `task_type`, `target_routine`, or `scope_selector` — and the Watchdog measures
 * ONLY the target agent's scorecards that match that key. An experiment lacking
 * an isolation key can never reach `measured`/`adopted`; it is parked as
 * `needs_scope` (a blocked terminal-for-now state) instead.
 *
 * This module is the single source of truth referenced by:
 *   - Routine dc2cf7de (Hypothesis Drafter)   — reject drafts without an isolation key
 *   - Routine 556eb4c3 (Experiment Watchdog)  — filter scorecards by the isolation key
 *   - CTO AGENTS.md § "SGI Loop H — Experiment Framework"
 */

/** Isolation keys, in precedence order. The first present + non-empty one wins. */
export const ISOLATION_KEYS = ["task_type", "target_routine", "scope_selector"];

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Extract the experiment's isolation key from its metadata.
 * @returns {{key: string, value: any}|null} first present isolation key, or null.
 */
export function getExperimentIsolation(metadata) {
  const md = metadata ?? {};
  for (const key of ISOLATION_KEYS) {
    if (isNonEmpty(md[key])) {
      return { key, value: md[key] };
    }
  }
  return null;
}

/**
 * Validate that an experiment record is attributable (carries an isolation key).
 * @param {{metadata?: object}} record  an `experiment/{id}` memory record
 * @returns {{ok: boolean, isolation: {key,value}|null, reason: string}}
 */
export function validateExperimentScope(record) {
  const isolation = getExperimentIsolation(record?.metadata);
  if (!isolation) {
    return {
      ok: false,
      isolation: null,
      reason:
        "needs_scope: experiment lacks an isolation key " +
        `(one of ${ISOLATION_KEYS.join(", ")} is required so measured_delta ` +
        "reflects only the targeted workload, not agent-wide composition)",
    };
  }
  return { ok: true, isolation, reason: "" };
}

/**
 * Does a scorecard fall within the experiment's isolation scope?
 * @param {{metadata?: object}} scorecard  a performance/ or scorecard-adjusted/ record
 * @param {{key: string, value: any}} isolation
 */
export function scorecardMatchesScope(scorecard, isolation) {
  const md = scorecard?.metadata ?? {};
  switch (isolation.key) {
    case "task_type":
      return md.task_type === isolation.value;
    case "target_routine":
      // scorecards may record the routine under either field
      return (
        md.target_routine === isolation.value ||
        md.routine_id === isolation.value ||
        md.routine === isolation.value
      );
    case "scope_selector": {
      // scope_selector is {field, value}: match that metadata field exactly.
      const sel = isolation.value;
      if (!sel || typeof sel !== "object" || !sel.field) return false;
      return md[sel.field] === sel.value;
    }
    default:
      return false;
  }
}

/**
 * Filter the target agent's scorecards down to the experiment's isolation scope.
 * Throws if the experiment carries no isolation key — the Watchdog must refuse to
 * compute measured_delta rather than silently measure the wrong workload.
 * @param {Array} scorecards
 * @param {{metadata?: object}} record
 */
export function filterScorecardsByScope(scorecards, record) {
  const { ok, isolation, reason } = validateExperimentScope(record);
  if (!ok) {
    throw new Error(reason);
  }
  return (scorecards ?? []).filter((sc) => scorecardMatchesScope(sc, isolation));
}

/**
 * Watchdog measurement step (AUR-3202). Given a running experiment and the target
 * agent's scorecards since run_start_date, return the scoped measurement.
 *
 * @returns {{
 *   status: "needs_scope"|"measurable",
 *   reason: string,
 *   isolation: {key,value}|null,
 *   tasksMeasured: number,       // count of IN-SCOPE scorecards only
 *   tokensSpent: number,         // sum of token_cost over IN-SCOPE scorecards only
 *   scopedScorecards: Array,     // the in-scope subset used for measured_delta
 * }}
 *
 * When status === "needs_scope", the Watchdog MUST park the experiment as
 * `needs_scope`/`blocked` and MUST NOT compute measured_delta, adopt, or reject.
 */
export function measureExperimentScoped(record, scorecards) {
  const { ok, isolation, reason } = validateExperimentScope(record);
  if (!ok) {
    return {
      status: "needs_scope",
      reason,
      isolation: null,
      tasksMeasured: 0,
      tokensSpent: 0,
      scopedScorecards: [],
    };
  }
  const scoped = (scorecards ?? []).filter((sc) => scorecardMatchesScope(sc, isolation));
  const tokensSpent = scoped.reduce((sum, sc) => sum + (Number(sc?.metadata?.token_cost) || 0), 0);
  return {
    status: "measurable",
    reason: "",
    isolation,
    tasksMeasured: scoped.length,
    tokensSpent,
    scopedScorecards: scoped,
  };
}
