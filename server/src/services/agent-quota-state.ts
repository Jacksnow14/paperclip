import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { AgentQuotaState } from "@paperclipai/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  classifyAgentCapacity,
  type FleetCapacityAgentInput,
  type FleetCapacityReason,
  type FleetCapacityRunInput,
} from "./fleet-capacity.js";

export type { AgentQuotaState } from "@paperclipai/shared";

/**
 * AUR-4604: surface quota/entitlement exhaustion on the agent record itself.
 *
 * An agent that cannot execute currently reads `status: "idle"` with
 * `pauseReason: null` on every route backed by `agentService.list`/`getById`
 * (the agent list, `/agents/:id`, `/agents/me`) -- indistinguishable from a
 * healthy unoccupied agent. AUR-4385's `classifyAgentCapacity` already derives
 * this correctly for the dedicated `/companies/:companyId/fleet-capacity`
 * route; this module reuses that SAME classifier (not a new one) and attaches
 * its verdict to the agent record so a caller doesn't have to know a second
 * route exists.
 *
 * Deliberately a separate nullable field, not a new `PAUSE_REASONS` member:
 * `PAUSE_REASONS` (`manual`/`budget`/`system`) is operator/budget-controlled
 * state that only clears via an explicit `resume()` call. This state is
 * derived fresh from run history and the clock on every read -- it clears
 * itself the instant a run succeeds or the parsed reset boundary passes, with
 * no writer and no `resume()` call involved. Folding it into `pauseReason`
 * would require `resume()` to know about a reason it never set, and every
 * `pauseReason` reader (permission checks, the pause/resume routes) to
 * special-case a value it can neither set nor clear.
 */
// Deliberately excludes "lane_down": that reason only exists after
// applyLaneDownRollup mutates a whole lane's rows together, and this module
// classifies one agent at a time via classifyAgentCapacity directly (see
// defaultLoader — it never loads lane-mates). Including it here would be
// dead code: classifyAgentCapacity alone can never produce it. The lane-wide
// view stays on the dedicated /fleet-capacity route.
export const AGENT_QUOTA_BLOCKING_REASONS = new Set<FleetCapacityReason>([
  "quota_exhausted",
  "entitlement_revoked",
]);

/**
 * Only the newest terminal run decides the classification -- a `succeeded`
 * row breaks the failure tail walk immediately (see `classifyAgentCapacity`).
 * A small extra window just enriches the consecutive-failure count in
 * `detail`. Deliberately narrower than `FLEET_CAPACITY_RUN_WINDOW` (200),
 * which is scoped to the dedicated `/fleet-capacity` route's periodic poll;
 * this one runs on every agent list/detail read.
 */
export const AGENT_QUOTA_STATE_RUN_WINDOW = 10;

export type AgentQuotaStateLoader = (
  companyId: string,
  agentIds: string[],
) => Promise<{
  agents: FleetCapacityAgentInput[];
  runsByAgent: Map<string, FleetCapacityRunInput[]>;
}>;

function defaultLoader(db: Db): AgentQuotaStateLoader {
  return async (companyId, agentIds) => {
    if (agentIds.length === 0) return { agents: [], runsByAgent: new Map() };
    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        pausedAt: agents.pausedAt,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));

    const runsByAgent = new Map<string, FleetCapacityRunInput[]>();
    for (const agent of agentRows) {
      const terminal = await db
        .select({
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          finishedAt: heartbeatRuns.finishedAt,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agent.id),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(AGENT_QUOTA_STATE_RUN_WINDOW);
      runsByAgent.set(agent.id, terminal);
    }
    return { agents: agentRows, runsByAgent };
  };
}

/** Pure derivation, unit-testable without a Db: classify, then narrow to the
 * quota-blocking reasons only -- `ok`/`paused`/`consecutive_failures`/
 * `no_recent_runs`/`quota_reset_unverified` are all `canExecuteNow: true` or
 * already surfaced via `status`/`pauseReason`, so they report `null` here. */
export function deriveAgentQuotaState(
  agent: FleetCapacityAgentInput,
  runs: FleetCapacityRunInput[],
  now: Date,
): AgentQuotaState | null {
  const classified = classifyAgentCapacity(agent, runs, now);
  if (classified.canExecuteNow || !AGENT_QUOTA_BLOCKING_REASONS.has(classified.reason)) {
    return null;
  }
  return {
    reason: classified.reason as AgentQuotaState["reason"],
    resetAt: classified.resetAt,
    detail: classified.reasonDetail,
  };
}

export async function getAgentQuotaStates(
  db: Db,
  companyId: string,
  agentIds: string[],
  options: { now?: Date; load?: AgentQuotaStateLoader } = {},
): Promise<Map<string, AgentQuotaState | null>> {
  const result = new Map<string, AgentQuotaState | null>();
  if (agentIds.length === 0) return result;
  const now = options.now ?? new Date();
  const load = options.load ?? defaultLoader(db);
  const { agents: agentRows, runsByAgent } = await load(companyId, agentIds);
  for (const agent of agentRows) {
    result.set(agent.id, deriveAgentQuotaState(agent, runsByAgent.get(agent.id) ?? [], now));
  }
  return result;
}
