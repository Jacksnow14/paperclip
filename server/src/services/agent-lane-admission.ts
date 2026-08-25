import { conflict } from "../errors.js";

/**
 * AUR-4512: `agents.status` alone does not tell you whether a lane is alive —
 * a corpse can sit at `status: "idle"` indefinitely (Etsy Support read `idle`
 * at 1745h stale). This is the one shared predicate every admission path
 * (issue create, issue PATCH re-route, routine target resolution, checkout)
 * must use instead of inlining its own comparison.
 */
export const STALE_LANE_HEARTBEAT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface AgentLaneLivenessInput {
  id: string;
  status: string;
  lastHeartbeatAt: Date | null;
}

/**
 * `lastHeartbeatAt === null` must NOT be treated as stale — it is the
 * legitimate signature of agents that never emit heartbeats at all (Wake
 * Watchdog Bot, the `http` adapter). Only `status: "error"` or a heartbeat
 * older than the threshold counts as a dead lane.
 */
export function isAgentLaneStale(
  agent: AgentLaneLivenessInput,
  now: Date = new Date(),
): boolean {
  if (agent.status === "error") return true;
  if (agent.lastHeartbeatAt == null) return false;
  return now.getTime() - agent.lastHeartbeatAt.getTime() > STALE_LANE_HEARTBEAT_THRESHOLD_MS;
}

/**
 * Escape hatch (AC#5): a `blocked` issue routed to its only possible owner
 * must remain assignable to a stale lane — it is parked, not live work, so
 * the risk this guard exists to prevent does not apply. Callers pass
 * `allowStaleLane: true` only when the resulting issue status is `blocked`.
 */
export function assertAgentLaneAdmissible(
  agent: AgentLaneLivenessInput,
  options: { now?: Date; allowStaleLane?: boolean } = {},
): void {
  if (options.allowStaleLane) return;
  const now = options.now ?? new Date();
  if (!isAgentLaneStale(agent, now)) return;

  const heartbeatAgeMs = agent.lastHeartbeatAt ? now.getTime() - agent.lastHeartbeatAt.getTime() : null;
  throw conflict("Cannot assign work to a stale agent lane", {
    agentId: agent.id,
    agentStatus: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt ? agent.lastHeartbeatAt.toISOString() : null,
    heartbeatAgeMs,
    staleLaneThresholdMs: STALE_LANE_HEARTBEAT_THRESHOLD_MS,
  });
}
