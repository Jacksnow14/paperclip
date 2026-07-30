import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
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

// AUR-4139: agents in these states cannot clear a quota wall (admission already refuses
// them in startNextQueuedRunForAgent), so a scheduled_retry row they own carries no live
// signal about the shared credential and must not gate their siblings. Mirrors the
// inadmissible set in heartbeat.ts.
const QUOTA_PAUSE_INELIGIBLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

// AUR-4139: provider session limits are scoped to the credential/account behind an
// adapter (one CLI session, one subscription) — not to an individual Paperclip agent.
// Every agent sharing that adapterType on this host shares the same quota wall, so a
// pause discovered via one agent's scheduled_retry row must suppress admission for
// every agent of that adapterType in the same company, or the rest keep burning
// zero-token runs against a wall they can't clear. Scoped by companyId so agents in
// different companies (and thus different credential grants) never cross-suppress.
//
// The max horizon is anchored to the row's `updatedAt` (when the retry was scheduled),
// NOT to `now`. A ceiling of `now + MAX` is not a bound at all — it slides forward as
// fast as time does and can never expire, so a misparsed multi-day reset would still
// suppress the whole fleet for its full duration while merely *reporting* a 6h horizon.
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
export async function findActiveAdapterQuotaPause(
  db: Db,
  companyId: string,
  adapterType: string,
  now: Date,
): Promise<ActiveAdapterQuotaPause | null> {
  // Interval and comparison operand are rendered as literals/casts rather than bound
  // Date/number params: the postgres driver will not bind a raw Date inside a sql`` tag.
  const maxPauseInterval = sql.raw(`interval '${MAX_ADAPTER_QUOTA_PAUSE_MS / 1000} seconds'`);
  const effectiveHorizon = sql<Date>`least(${heartbeatRuns.scheduledRetryAt}, ${heartbeatRuns.createdAt} + ${maxPauseInterval})`;
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
        notInArray(agents.status, QUOTA_PAUSE_INELIGIBLE_AGENT_STATUSES),
        eq(heartbeatRuns.status, "scheduled_retry"),
        isNotNull(heartbeatRuns.scheduledRetryAt),
        sql`${heartbeatRuns.contextSnapshot} ->> 'transientRetryNotBefore' is not null`,
        sql`${effectiveHorizon} > ${nowParam}`,
      ),
    )
    .orderBy(sql`${effectiveHorizon} desc`)
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
