import { and, eq, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

export interface ActiveAdapterQuotaPause {
  agentId: string;
  /** When the pause actually expires: min(parsed reset, pauseRecordedAt + MAX_ADAPTER_QUOTA_PAUSE_MS). */
  scheduledRetryAt: Date;
  /** The provider's parsed reset time, unclamped — for logging when the two differ. */
  parsedResetAt: Date;
  /** Row creation timestamp the max horizon is anchored to. */
  pauseRecordedAt: Date;
}

export const MAX_ADAPTER_QUOTA_PAUSE_MS = 6 * 60 * 60 * 1000;

// AUR-4139/AUR-4680: agents in these states cannot clear a quota wall, so a
// scheduled_retry row they own carries no live signal about the shared
// credential and must not gate their siblings. Deliberately narrower than
// HEARTBEAT_ADMISSION_INELIGIBLE_AGENT_STATUSES: an agent in `error` is not
// admitted as runnable work, but its scheduled_retry row can still be the only
// live proof of an adapter-wide session-limit wall and must remain visible here.
export const QUOTA_PAUSE_SIGNAL_INELIGIBLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

// AUR-4680 decision: `error` is a non-runnable agent state until an explicit
// operator/system transition clears it (for example a due scheduled retry,
// resume, or config repair). Such agents are neither fair-share contenders nor
// admission candidates for ordinary queued work; if they were counted, stale
// queued rows on a dead adapter lane would shrink the guaranteed floor for live
// agents and the redistribution pass could burn slots on work known not to
// execute.
export const HEARTBEAT_ADMISSION_INELIGIBLE_AGENT_STATUSES = [
  ...QUOTA_PAUSE_SIGNAL_INELIGIBLE_AGENT_STATUSES,
  "error",
];

// AUR-4139: provider session limits are scoped to the credential/account behind an
// adapter (one CLI session, one subscription) — not to an individual Paperclip agent.
// Every agent sharing that adapterType on this host shares the same quota wall, so a
// pause discovered via one agent's scheduled_retry row must suppress admission for
// every agent of that adapterType in the same company, or the rest keep burning
// zero-token runs against a wall they can't clear. Scoped by companyId so agents in
// different companies (and thus different credential grants) never cross-suppress.
//
// The max horizon is anchored to the row's `createdAt` — the arming instant, since both
// arming paths INSERT a fresh scheduled_retry row rather than transitioning an existing
// one — and NOT to `now`. A ceiling of `now + MAX` is not a bound at all: it slides
// forward as fast as time does and can never expire, so a misparsed multi-day reset would
// still suppress the whole fleet for its full duration while merely *reporting* a 6h
// horizon. `createdAt` rather than `updatedAt` because `createdAt` is immutable by
// construction (`.defaultNow()`, absent from every `db.update(heartbeatRuns)` site),
// whereas `updatedAt` is stable only as an emergent property of no writer currently
// touching a paused row — and if that ever changed the bound would silently slide and
// restore the multi-day fleet outage AUR-4055/AUR-4139 exist to kill. Do not "simplify"
// this back to `updatedAt`.
// The clamp therefore lives in the WHERE clause, where it decides whether the row still
// matches, rather than only in the returned value: the caller gates on presence alone.
//
// Deliberately NOT `scheduledRetryAt <= now + MAX`, which would fail *open* — a long
// reset would stop matching entirely and restore the AUR-4055 zero-token burn loop.
// Bounding the horizon means that once it lapses queued runs sharing that adapterType
// are admitted again to probe the wall: if the wall is real, one or more of those runs
// re-fail and re-arm a fresh anchored horizon; if the reset was misparsed they succeed.
// That bounded re-admission is the intended behaviour — a handful of probe runs per day
// instead of either a continuous burn or a silent multi-day fleet outage.
//
// AUR-4520: this clamped query has two shapes of consumer with opposite requirements.
// Every *admission-gating* consumer (run admission, contended-ceiling denominator,
// recovery's requeue-vs-hold decision) wants the bounded horizon above — that bound is
// what makes them periodically re-probe a possibly-misparsed wall instead of either
// burning zero-token runs or freezing for the reset's full stated duration. But
// productivity-review's *stall explainer* wants the opposite: it isn't deciding whether
// to admit work, it's deciding whether a `long_active` episode is explained by a real,
// still-active provider wall. Reusing the clamped WHERE for that purpose means a genuine
// 24h reset stops matching this query at t+6h even though the provider wall is still up,
// and the stall watchdog starts filing false findings against an agent correctly waiting
// on a limit it cannot influence — see AUR-4520. `findActiveAdapterQuotaPauseForStallExplanation`
// below exists so that mistake can't be made by accident: the two query shapes are two
// named functions, not one function plus a boolean/mode flag a future call site could
// default the wrong way.
async function queryActiveAdapterQuotaPause(
  db: Db,
  companyId: string,
  adapterType: string,
  now: Date,
  horizon: SQL<Date>,
): Promise<ActiveAdapterQuotaPause | null> {
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  const row = await db
    .select({
      agentId: heartbeatRuns.agentId,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      pauseRecordedAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.adapterType, adapterType),
        notInArray(agents.status, QUOTA_PAUSE_SIGNAL_INELIGIBLE_AGENT_STATUSES),
        eq(heartbeatRuns.status, "scheduled_retry"),
        isNotNull(heartbeatRuns.scheduledRetryAt),
        sql`${heartbeatRuns.contextSnapshot} ->> 'transientRetryNotBefore' is not null`,
        sql`${horizon} > ${nowParam}`,
      ),
    )
    .orderBy(sql`${horizon} desc`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row?.scheduledRetryAt || !row.pauseRecordedAt) return null;
  // Same formula as the SQL predicate above, so the reported horizon can never disagree
  // with the one that decided the row still matches.
  const anchoredHorizon = new Date(row.pauseRecordedAt.getTime() + MAX_ADAPTER_QUOTA_PAUSE_MS);
  return {
    agentId: row.agentId,
    scheduledRetryAt:
      row.scheduledRetryAt.getTime() > anchoredHorizon.getTime() ? anchoredHorizon : row.scheduledRetryAt,
    parsedResetAt: row.scheduledRetryAt,
    pauseRecordedAt: row.pauseRecordedAt,
  };
}

// Interval rendered as a literal/cast rather than a bound number param: the postgres
// driver will not bind a raw Date inside a sql`` tag.
const maxPauseInterval = sql.raw(`interval '${MAX_ADAPTER_QUOTA_PAUSE_MS / 1000} seconds'`);

/**
 * Admission-gating shape: the horizon is clamped to MAX_ADAPTER_QUOTA_PAUSE_MS from the
 * row's `createdAt`. Use this for every consumer that decides whether to admit/requeue
 * work right now — it is what bounds a misparsed multi-day reset to a handful of probe
 * runs per day instead of a silent fleet-wide outage.
 */
export async function findActiveAdapterQuotaPause(
  db: Db,
  companyId: string,
  adapterType: string,
  now: Date,
): Promise<ActiveAdapterQuotaPause | null> {
  const effectiveHorizon = sql<Date>`least(${heartbeatRuns.scheduledRetryAt}, ${heartbeatRuns.createdAt} + ${maxPauseInterval})`;
  return queryActiveAdapterQuotaPause(db, companyId, adapterType, now, effectiveHorizon);
}

/**
 * Stall-explanation shape: the horizon is the provider's own unclamped parsed reset
 * (`scheduledRetryAt` on the row), not the admission clamp. Use this ONLY to decide
 * whether a `long_active` episode is explained by a still-active provider wall — never
 * to gate admission/requeue, or a misparsed multi-day reset would silently suppress the
 * whole fleet for its full duration again (the exact regression MAX_ADAPTER_QUOTA_PAUSE_MS
 * exists to prevent). See AUR-4520.
 */
export async function findActiveAdapterQuotaPauseForStallExplanation(
  db: Db,
  companyId: string,
  adapterType: string,
  now: Date,
): Promise<ActiveAdapterQuotaPause | null> {
  const unclampedHorizon = sql<Date>`${heartbeatRuns.scheduledRetryAt}`;
  return queryActiveAdapterQuotaPause(db, companyId, adapterType, now, unclampedHorizon);
}
