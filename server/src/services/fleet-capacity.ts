import {
  CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
  extractClaudeRetryNotBefore,
} from "@paperclipai/adapter-claude-local/server";
import { extractCodexRetryNotBefore } from "@paperclipai/adapter-codex-local/server";

/**
 * Fleet capacity classifier (AUR-4385).
 *
 * Answers exactly one question per agent: "if I assign work right now, will it
 * execute?" It is NOT "is this agent busy" and NOT "does it have work".
 * Derived purely from run history so it works standalone today; where
 * AUR-4144's agent-record error reason lands later, callers should prefer it
 * and fall through to this derivation.
 *
 * Key invariants, validated against the live fleet on 2026-07-29 (issue
 * thread has the full derivation):
 * - `canExecuteNow: false` requires POSITIVE evidence of inability, never
 *   absence of evidence. Idle-with-no-work and deep-but-admitting are `true`.
 * - Proof of admission after a quota failure is a `succeeded` run strictly
 *   after it. `startedAt` / `lastOutputAt` / non-empty `usageJson` are all
 *   present on quota-starved runs (the run starts, is refused upstream, and
 *   dies), so none of them can prove recovery.
 * - `cancelled` runs are neutral: they carry no capacity information
 *   (assignee changes cancel runs), so they neither break nor extend a
 *   failure tail.
 */

export const FLEET_CAPACITY_RUN_WINDOW = 200;

/** Last success older than this classifies as dormant (`no_recent_runs`). */
const DORMANT_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Quota/credit exhaustion signatures only. Deliberately narrower than the
 * adapters' transient-upstream regexes: 429/overloaded/high-demand are
 * transient upstream weather, not quota, and deterministic failures such as
 * "Prompt is too long" must never match (negative control in the tests).
 *
 * Exported (AUR-5038) as the single source of the quota wording for the
 * auth-rendered-wall reclassifier, which also runs it inside Postgres (`~*`) —
 * the pattern is deliberately kept POSIX/ARE-compatible (verified live).
 */
export const QUOTA_SIGNATURE_RE =
  /(?:hit your (?:session|weekly|usage) limit|usage limit reached|usage cap reached|5[-\s]?hour limit reached|weekly limit reached|claude usage limit reached|out of extra usage|session limit reached)/i;

/**
 * AUR-5038: the run-failure classifier can now prove a quota wall from lane
 * history even when the CLI's error text lies about it ("Not logged in ·
 * Please run /login" during a weekly wall). Those rows carry the dedicated
 * errorCode but NOT the quota wording, so keying on text alone would classify
 * a reclassified tail as `consecutive_failures` and the lane-down rollup would
 * never fire.
 */
const QUOTA_EXHAUSTED_ERROR_CODES = new Set<string>([CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE]);

export type FleetCapacityReason =
  | "ok"
  | "paused"
  | "quota_exhausted"
  | "quota_reset_unverified"
  | "consecutive_failures"
  | "lane_down"
  | "no_recent_runs";

export interface FleetCapacityRunInput {
  status: string;
  createdAt: Date | string | null;
  finishedAt?: Date | string | null;
  error?: string | null;
  errorCode?: string | null;
}

export interface FleetCapacityAgentInput {
  id: string;
  name: string;
  adapterType: string;
  pausedAt?: Date | string | null;
}

export interface FleetCapacityRow {
  agentId: string;
  name: string;
  lane: string;
  canExecuteNow: boolean;
  reason: FleetCapacityReason;
  reasonDetail: string | null;
  queueDepth: number;
  lastSuccessfulRunAt: string | null;
  consecutiveFailures: number;
}

export interface FleetCapacitySnapshot {
  computedAt: string;
  window: { runs: number };
  rollup: {
    totalQueued: number;
    executableNow: number;
    blockedCount: number;
    byReason: Partial<Record<FleetCapacityReason, number>>;
  };
  agents: FleetCapacityRow[];
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  const time = toTime(value);
  return time == null ? null : new Date(time).toISOString();
}

/**
 * Reset boundary parsed from the quota error text, anchored at the moment the
 * error was emitted (the "resets 9pm" clock is relative to the failure, not
 * to the read). Reuses the adapters' own extractors read-only; `http` and
 * unknown lanes have no extractor, so their reset time is always unknown.
 */
function extractResetAt(lane: string, error: string, failedAt: Date): Date | null {
  if (lane === "claude_local") {
    return extractClaudeRetryNotBefore({ errorMessage: error }, failedAt);
  }
  if (lane === "codex_local") {
    return extractCodexRetryNotBefore({ errorMessage: error }, failedAt);
  }
  return null;
}

export function classifyAgentCapacity(
  agent: FleetCapacityAgentInput,
  runs: FleetCapacityRunInput[],
  now: Date,
): FleetCapacityRow {
  const sorted = [...runs].sort((a, b) => (toTime(b.createdAt) ?? 0) - (toTime(a.createdAt) ?? 0));

  const queueDepth = sorted.filter((run) => run.status === "queued" || run.status === "scheduled_retry").length;

  const lastSuccess = sorted.find((run) => run.status === "succeeded") ?? null;
  const lastSuccessfulRunAt = lastSuccess ? toIso(lastSuccess.createdAt) : null;

  // Tail walk, newest -> oldest, over terminal runs only. `succeeded` breaks
  // the tail; `failed` extends it; everything else (queued / running /
  // scheduled_retry / cancelled) is neutral.
  let consecutiveFailures = 0;
  let newestFailure: FleetCapacityRunInput | null = null;
  for (const run of sorted) {
    if (run.status === "succeeded") break;
    if (run.status !== "failed") continue;
    consecutiveFailures += 1;
    if (!newestFailure) newestFailure = run;
  }

  const base = {
    agentId: agent.id,
    name: agent.name,
    lane: agent.adapterType,
    queueDepth,
    lastSuccessfulRunAt,
    consecutiveFailures,
  };

  if (agent.pausedAt != null) {
    return {
      ...base,
      canExecuteNow: false,
      reason: "paused",
      reasonDetail: `Agent paused at ${toIso(agent.pausedAt) ?? "unknown time"}.`,
    };
  }

  const newestFailureError = newestFailure?.error ?? "";
  const newestFailureIsQuota =
    newestFailure != null &&
    (QUOTA_EXHAUSTED_ERROR_CODES.has(newestFailure.errorCode ?? "") ||
      QUOTA_SIGNATURE_RE.test(newestFailureError));
  if (newestFailure && newestFailureIsQuota) {
    // Quota tail with no succeeded run after it (a success would have broken
    // the tail walk above).
    const failedAtTime =
      toTime(newestFailure.finishedAt) ?? toTime(newestFailure.createdAt) ?? now.getTime();
    const resetAt = extractResetAt(agent.adapterType, newestFailureError, new Date(failedAtTime));
    if (resetAt != null && resetAt.getTime() <= now.getTime()) {
      return {
        ...base,
        canExecuteNow: true,
        reason: "quota_reset_unverified",
        reasonDetail:
          `Quota tail of ${consecutiveFailures} failure(s); reset boundary ${resetAt.toISOString()} has passed ` +
          `but nothing has succeeded since — recovery unproven (advisory, not a block).`,
      };
    }
    return {
      ...base,
      canExecuteNow: false,
      reason: "quota_exhausted",
      reasonDetail:
        `${consecutiveFailures} consecutive quota-signature failure(s), newest at ` +
        `${toIso(newestFailure.createdAt) ?? "unknown"}, no succeeded run since; reset ` +
        (resetAt ? `at ${resetAt.toISOString()} still in the future.` : `time unknown.`),
    };
  }

  if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return {
      ...base,
      canExecuteNow: false,
      reason: "consecutive_failures",
      reasonDetail:
        `${consecutiveFailures} consecutive non-quota failures since last success` +
        (newestFailureError ? `; newest error: ${newestFailureError.slice(0, 200)}` : "") +
        ".",
    };
  }

  const lastSuccessTime = toTime(lastSuccess?.createdAt);
  if (sorted.length === 0 || lastSuccessTime == null || now.getTime() - lastSuccessTime >= DORMANT_AFTER_MS) {
    return {
      ...base,
      canExecuteNow: true,
      reason: "no_recent_runs",
      reasonDetail:
        sorted.length === 0
          ? "No runs in window (dormant — informational, not a block)."
          : `No recent success in window (last: ${lastSuccessfulRunAt ?? "none"}) — dormant, informational.`,
    };
  }

  return { ...base, canExecuteNow: true, reason: "ok", reasonDetail: null };
}

/**
 * Lane rollup: when a lane has >= 2 non-dormant agents and every one of them
 * is `quota_exhausted`, the lane itself is down (quota is per-adapter, so all
 * agents in a lane starve together). Overrides the per-agent reason;
 * `canExecuteNow` stays false.
 */
export function applyLaneDownRollup(rows: FleetCapacityRow[]): FleetCapacityRow[] {
  const byLane = new Map<string, FleetCapacityRow[]>();
  for (const row of rows) {
    const lane = byLane.get(row.lane) ?? [];
    lane.push(row);
    byLane.set(row.lane, lane);
  }
  for (const [lane, laneRows] of byLane) {
    const active = laneRows.filter((row) => row.reason !== "no_recent_runs");
    if (active.length >= 2 && active.every((row) => row.reason === "quota_exhausted")) {
      for (const row of active) {
        row.reason = "lane_down";
        row.reasonDetail = `Every non-dormant ${lane} agent is quota-exhausted — the lane is down, not just this agent.`;
      }
    }
  }
  return rows;
}

export function computeFleetCapacity(
  agents: FleetCapacityAgentInput[],
  runsByAgent: Map<string, FleetCapacityRunInput[]>,
  now: Date,
  windowRuns: number = FLEET_CAPACITY_RUN_WINDOW,
): FleetCapacitySnapshot {
  const rows = agents.map((agent) => classifyAgentCapacity(agent, runsByAgent.get(agent.id) ?? [], now));
  applyLaneDownRollup(rows);
  rows.sort((a, b) => {
    if (a.canExecuteNow !== b.canExecuteNow) return a.canExecuteNow ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const byReason: Partial<Record<FleetCapacityReason, number>> = {};
  for (const row of rows) {
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
  }

  return {
    computedAt: now.toISOString(),
    window: { runs: windowRuns },
    rollup: {
      totalQueued: rows.reduce((sum, row) => sum + row.queueDepth, 0),
      executableNow: rows.filter((row) => row.canExecuteNow).length,
      blockedCount: rows.filter((row) => !row.canExecuteNow).length,
      byReason,
    },
    agents: rows,
  };
}
