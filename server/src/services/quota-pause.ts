import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

export interface ActiveAdapterQuotaPause {
  agentId: string;
  scheduledRetryAt: Date;
}

export const MAX_ADAPTER_QUOTA_PAUSE_MS = 6 * 60 * 60 * 1000;

// AUR-4139: provider session limits are scoped to the credential/account behind an
// adapter (one CLI session, one subscription) — not to an individual Paperclip agent.
// Every agent sharing that adapterType on this host shares the same quota wall, so a
// pause discovered via one agent's scheduled_retry row must suppress admission for
// every agent of that adapterType in the same company, or the rest keep burning
// zero-token runs against a wall they can't clear. Scoped by companyId so agents in
// different companies (and thus different credential grants) never cross-suppress.
export async function findActiveAdapterQuotaPause(
  db: Db,
  companyId: string,
  adapterType: string,
  now: Date,
): Promise<ActiveAdapterQuotaPause | null> {
  const maxPauseUntil = new Date(now.getTime() + MAX_ADAPTER_QUOTA_PAUSE_MS);
  const row = await db
    .select({
      agentId: heartbeatRuns.agentId,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.adapterType, adapterType),
        ne(agents.status, "terminated"),
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'transientRetryNotBefore' is not null`,
        gt(heartbeatRuns.scheduledRetryAt, now),
      ),
    )
    .orderBy(desc(heartbeatRuns.scheduledRetryAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row?.scheduledRetryAt) return null;
  return {
    agentId: row.agentId,
    scheduledRetryAt: row.scheduledRetryAt.getTime() > maxPauseUntil.getTime() ? maxPauseUntil : row.scheduledRetryAt,
  };
}
