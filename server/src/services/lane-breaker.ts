import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  FLEET_CAPACITY_RUN_WINDOW,
  applyLaneDownRollup,
  classifyAgentCapacity,
  type FleetCapacityAgentInput,
  type FleetCapacityReason,
  type FleetCapacityRow,
  type FleetCapacityRunInput,
} from "./fleet-capacity.js";

/**
 * Lane circuit breaker (AUR-5464).
 *
 * Makes the AUR-4385 fleet-capacity classifier load-bearing at admission:
 * `claimQueuedRun` consults `evaluateAdmission` before the queued->running
 * transition, and a tripped lane leaves the run QUEUED (the periodic admission
 * drive re-attempts it), never cancelled — an outage must not destroy work.
 *
 * Two independent trip sources, neither a single point of failure for the
 * other:
 *  1. Error stream: the classifier's own derivation over terminal run history
 *     (`quota_exhausted` / `entitlement_revoked` / `lane_down`). Always
 *     available; needs no probe infrastructure.
 *  2. Provider probe reports (`reportProviderProbe`, fed by AUR-5435/AUR-5461
 *     where available): an unhealthy report trips the lane even when the run
 *     history is quiet. A HEALTHY report never force-clears an error-stream
 *     trip — per the classifier invariant, only a `succeeded` run strictly
 *     after the failure proves recovery.
 *
 * Re-arm rules (the half-open state machine):
 *  - closed  -> open        when either source trips.
 *  - open    -> half-open   one queued run is admitted as a probe once per
 *                           HALF_OPEN_PROBE_INTERVAL_MS (immediately when a
 *                           quota reset boundary has passed, or on manual
 *                           re-arm). Everything else stays deferred.
 *  - half-open -> closed    the probe run SUCCEEDS: the classifier's tail walk
 *                           breaks and the next evaluation reads healthy.
 *  - half-open -> open      the probe fails: the failure tail extends and the
 *                           next probe waits a full interval again.
 * A lane therefore NEVER re-opens on a timer alone — the timer only earns the
 * lane a single probe, and only a success re-admits the fleet. This is what
 * makes `entitlement_revoked` (no reset boundary to parse) safe: it probes on
 * the same cadence but can only clear on proof.
 *
 * State here is deliberately in-memory: the trip itself is DERIVED state
 * (recomputed from run history, which is durable in Postgres), so a process
 * restart cannot lose a trip — it re-derives on the first admission attempt.
 * Only the probe cadence bookkeeping resets, costing at most one extra probe
 * per lane per restart.
 */

/** Reasons that gate admission outright (never auto-clear on a timer). */
export const LANE_BREAKER_HARD_TRIP_REASONS = new Set<FleetCapacityReason>([
  "quota_exhausted",
  "entitlement_revoked",
  "lane_down",
]);

/**
 * While tripped, at most one queued run per lane is admitted as a half-open
 * probe per this interval. 30 min bounds probe burn on a multi-day outage
 * (<= 48 failed probes/day) while keeping recovery detection latency under
 * half an hour — and a quota reset boundary or a manual re-arm makes the next
 * probe immediate, so the common recovery paths do not wait on it.
 */
export const HALF_OPEN_PROBE_INTERVAL_MS = 30 * 60 * 1000;

/** Classification cache TTL: admission may evaluate hundreds of queued runs per pass. */
const LANE_SNAPSHOT_TTL_MS = 20_000;

/** Throttle for the per-claim "deferred" log line (the state itself is on the route). */
const DEFERRAL_LOG_INTERVAL_MS = 60_000;

export interface LaneProbeReport {
  healthy: boolean;
  reason: string | null;
  observedAt: Date;
  source: string;
}

export type LaneBreakerTripSource = "error_stream" | "provider_probe";

export interface LaneAdmissionDecision {
  admit: boolean;
  /** True when this admission is the lane's single half-open probe. */
  halfOpenProbe: boolean;
  state: "closed" | "open" | "half_open";
  trippedBy: LaneBreakerTripSource[];
  reason: string | null;
  detail: string | null;
}

export interface LaneBreakerLaneState {
  lane: string;
  state: "closed" | "open";
  trippedBy: LaneBreakerTripSource[];
  reason: string | null;
  detail: string | null;
  agents: FleetCapacityRow[];
  lastSuccessAt: string | null;
  nextProbeEligibleAt: string | null;
  providerProbe: (Omit<LaneProbeReport, "observedAt"> & { observedAt: string }) | null;
  manualRearmAt: string | null;
}

interface LaneSnapshot {
  computedAt: number;
  rows: FleetCapacityRow[];
  /** Newest succeeded-run time across the lane's agents (probe-trip clearing). */
  lastSuccessAtMs: number | null;
}

interface LaneClassificationInput {
  agents: FleetCapacityAgentInput[];
  runsByAgent: Map<string, FleetCapacityRunInput[]>;
}

export type LaneClassificationLoader = (
  companyId: string,
  lane: string,
) => Promise<LaneClassificationInput>;

/**
 * Default loader: same backlog-proof query shape as the fleet-capacity route —
 * terminal runs only, so a deep queued backlog cannot evict the terminal
 * history the classifier needs (queue depth is irrelevant to admission).
 */
function defaultLoader(db: Db): LaneClassificationLoader {
  return async (companyId, lane) => {
    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        pausedAt: agents.pausedAt,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, lane)));
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
        .limit(FLEET_CAPACITY_RUN_WINDOW);
      runsByAgent.set(agent.id, terminal);
    }
    return { agents: agentRows, runsByAgent };
  };
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export class LaneBreaker {
  private readonly db: Db;
  private readonly load: LaneClassificationLoader;
  private readonly now: () => Date;

  private readonly snapshots = new Map<string, LaneSnapshot>();
  /** Keyed `${companyId}:${lane}` — absent while the lane is closed. */
  private readonly halfOpen = new Map<string, { nextProbeEligibleAt: number }>();
  /** Provider probe reports are per-lane (the provider account is host-wide). */
  private readonly probeReports = new Map<string, LaneProbeReport>();
  private readonly manualRearms = new Map<string, Date>();
  private readonly lastLoggedState = new Map<string, "closed" | "open">();
  private readonly lastDeferralLogAt = new Map<string, number>();

  constructor(opts: { db: Db; load?: LaneClassificationLoader; now?: () => Date }) {
    this.db = opts.db;
    this.load = opts.load ?? defaultLoader(opts.db);
    this.now = opts.now ?? (() => new Date());
  }

  reportProviderProbe(lane: string, report: LaneProbeReport) {
    const existing = this.probeReports.get(lane);
    if (existing && existing.observedAt.getTime() > report.observedAt.getTime()) return;
    this.probeReports.set(lane, report);
    this.snapshots.delete(this.laneCacheKeyPrefix(lane));
    logger.info(
      { lane, healthy: report.healthy, reason: report.reason, source: report.source },
      "laneBreaker: provider probe report recorded",
    );
  }

  /**
   * Operator manual re-arm: clears any provider-probe trip (operator override
   * of the external report) and makes the next queued run an IMMEDIATE
   * half-open probe. Deliberately does NOT blind-open the lane: if the
   * provider is still down, the probe fails and the lane re-trips — a manual
   * re-arm can therefore never re-admit the whole fleet into a dead lane.
   */
  manualRearm(companyId: string, lane: string, actor: { actorType: "agent" | "user" | "system"; actorId: string }) {
    const now = this.now();
    this.manualRearms.set(lane, now);
    this.halfOpen.set(this.key(companyId, lane), { nextProbeEligibleAt: now.getTime() });
    this.snapshots.clear();
    void logActivity(this.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "fleet.lane_breaker_manual_rearm",
      entityType: "fleet_lane",
      entityId: lane,
      details: { lane, at: now.toISOString() },
    }).catch((err) => logger.error({ err, lane }, "laneBreaker: manual re-arm activity log failed"));
    return { lane, probeEligibleAt: now.toISOString() };
  }

  async evaluateAdmission(
    companyId: string,
    agent: { id: string; adapterType: string },
  ): Promise<LaneAdmissionDecision> {
    const lane = agent.adapterType;
    const now = this.now();
    const snapshot = await this.getLaneSnapshot(companyId, lane, now);
    const row = snapshot.rows.find((r) => r.agentId === agent.id) ?? null;

    const errorStreamTrip =
      row != null &&
      (LANE_BREAKER_HARD_TRIP_REASONS.has(row.reason) || row.reason === "quota_reset_unverified");
    const probeTrip = this.activeProbeTrip(lane, snapshot.lastSuccessAtMs);

    const trippedBy: LaneBreakerTripSource[] = [];
    if (errorStreamTrip) trippedBy.push("error_stream");
    if (probeTrip) trippedBy.push("provider_probe");

    if (trippedBy.length === 0) {
      await this.recordTransition(companyId, lane, "closed", null, null);
      this.halfOpen.delete(this.key(companyId, lane));
      return { admit: true, halfOpenProbe: false, state: "closed", trippedBy, reason: null, detail: null };
    }

    const reason = errorStreamTrip ? row!.reason : "provider_probe_unhealthy";
    const detail = errorStreamTrip ? row!.reasonDetail : probeTrip!.reason;
    await this.recordTransition(companyId, lane, "open", reason, detail);

    const key = this.key(companyId, lane);
    let hs = this.halfOpen.get(key);
    if (!hs) {
      // First observation of this trip. A passed quota reset boundary
      // (`quota_reset_unverified`) earns an immediate probe — the provider
      // itself claims recovery, we just refuse to take its word for the whole
      // fleet. Everything else waits a full interval: the failures that
      // tripped the lane are themselves fresh negative evidence.
      const immediate = row?.reason === "quota_reset_unverified";
      hs = { nextProbeEligibleAt: now.getTime() + (immediate ? 0 : HALF_OPEN_PROBE_INTERVAL_MS) };
      this.halfOpen.set(key, hs);
    }

    if (now.getTime() >= hs.nextProbeEligibleAt) {
      hs.nextProbeEligibleAt = now.getTime() + HALF_OPEN_PROBE_INTERVAL_MS;
      logger.info(
        { companyId, lane, agentId: agent.id, reason },
        "laneBreaker: lane tripped — admitting single half-open probe run",
      );
      void logActivity(this.db, {
        companyId,
        actorType: "system",
        actorId: "lane_breaker",
        agentId: agent.id,
        action: "fleet.lane_breaker_probe_admitted",
        entityType: "fleet_lane",
        entityId: lane,
        details: { lane, reason, nextProbeEligibleAt: new Date(hs.nextProbeEligibleAt).toISOString() },
      }).catch((err) => logger.error({ err, lane }, "laneBreaker: probe activity log failed"));
      return { admit: true, halfOpenProbe: true, state: "half_open", trippedBy, reason, detail };
    }

    this.logDeferralThrottled(companyId, lane, reason);
    return { admit: false, halfOpenProbe: false, state: "open", trippedBy, reason, detail };
  }

  /** Read surface for `GET /companies/:companyId/fleet-capacity`. */
  async describeLanes(companyId: string): Promise<LaneBreakerLaneState[]> {
    const laneRows = await this.db
      .selectDistinct({ adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const now = this.now();
    const out: LaneBreakerLaneState[] = [];
    for (const { adapterType: lane } of laneRows) {
      if (!lane) continue;
      const snapshot = await this.getLaneSnapshot(companyId, lane, now);
      const trippedRows = snapshot.rows.filter(
        (r) => LANE_BREAKER_HARD_TRIP_REASONS.has(r.reason) || r.reason === "quota_reset_unverified",
      );
      const probeTrip = this.activeProbeTrip(lane, snapshot.lastSuccessAtMs);
      const trippedBy: LaneBreakerTripSource[] = [];
      if (trippedRows.length > 0) trippedBy.push("error_stream");
      if (probeTrip) trippedBy.push("provider_probe");
      const hs = this.halfOpen.get(this.key(companyId, lane));
      const report = this.probeReports.get(lane) ?? null;
      const manualRearmAt = this.manualRearms.get(lane) ?? null;
      out.push({
        lane,
        state: trippedBy.length > 0 ? "open" : "closed",
        trippedBy,
        reason: trippedRows[0]?.reason ?? (probeTrip ? "provider_probe_unhealthy" : null),
        detail: trippedRows[0]?.reasonDetail ?? probeTrip?.reason ?? null,
        agents: snapshot.rows,
        lastSuccessAt: snapshot.lastSuccessAtMs ? new Date(snapshot.lastSuccessAtMs).toISOString() : null,
        nextProbeEligibleAt:
          trippedBy.length > 0 && hs ? new Date(hs.nextProbeEligibleAt).toISOString() : null,
        providerProbe: report ? { ...report, observedAt: report.observedAt.toISOString() } : null,
        manualRearmAt: manualRearmAt ? manualRearmAt.toISOString() : null,
      });
    }
    return out;
  }

  private key(companyId: string, lane: string) {
    return `${companyId}:${lane}`;
  }

  private laneCacheKeyPrefix(lane: string) {
    // Probe reports are lane-wide; drop every company's snapshot for the lane.
    for (const key of [...this.snapshots.keys()]) {
      if (key.endsWith(`:${lane}`)) this.snapshots.delete(key);
    }
    return lane;
  }

  /**
   * An unhealthy provider probe report trips the lane until one of:
   *  - a newer HEALTHY report from the probe (the source recanting),
   *  - a `succeeded` run in the lane strictly after the report (the
   *    classifier's own proof-of-recovery standard), or
   *  - a manual re-arm after the report (operator override).
   * Never a timer — an entitlement outage has no expiry to wait out.
   */
  private activeProbeTrip(lane: string, lastSuccessAtMs: number | null): LaneProbeReport | null {
    const report = this.probeReports.get(lane);
    if (!report || report.healthy) return null;
    const observedMs = report.observedAt.getTime();
    if (lastSuccessAtMs != null && lastSuccessAtMs > observedMs) return null;
    const rearm = this.manualRearms.get(lane);
    if (rearm && rearm.getTime() > observedMs) return null;
    return report;
  }

  private async getLaneSnapshot(companyId: string, lane: string, now: Date): Promise<LaneSnapshot> {
    const key = this.key(companyId, lane);
    const cached = this.snapshots.get(key);
    if (cached && now.getTime() - cached.computedAt < LANE_SNAPSHOT_TTL_MS) return cached;
    const input = await this.load(companyId, lane);
    const rows = input.agents.map((agent) =>
      classifyAgentCapacity(agent, input.runsByAgent.get(agent.id) ?? [], now),
    );
    applyLaneDownRollup(rows);
    let lastSuccessAtMs: number | null = null;
    for (const row of rows) {
      const t = toMs(row.lastSuccessfulRunAt);
      if (t != null && (lastSuccessAtMs == null || t > lastSuccessAtMs)) lastSuccessAtMs = t;
    }
    const snapshot: LaneSnapshot = { computedAt: now.getTime(), rows, lastSuccessAtMs };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  private async recordTransition(
    companyId: string,
    lane: string,
    state: "closed" | "open",
    reason: string | null,
    detail: string | null,
  ) {
    const key = this.key(companyId, lane);
    const previous = this.lastLoggedState.get(key);
    if (previous === state) return;
    this.lastLoggedState.set(key, state);
    // First observation of a healthy lane is not a transition worth an audit row.
    if (previous === undefined && state === "closed") return;
    const action = state === "open" ? "fleet.lane_breaker_tripped" : "fleet.lane_breaker_rearmed";
    logger.warn({ companyId, lane, state, reason }, `laneBreaker: lane ${state === "open" ? "TRIPPED" : "re-armed"}`);
    await logActivity(this.db, {
      companyId,
      actorType: "system",
      actorId: "lane_breaker",
      action,
      entityType: "fleet_lane",
      entityId: lane,
      details: { lane, reason, detail },
    }).catch((err) => logger.error({ err, lane }, "laneBreaker: transition activity log failed"));
  }

  private logDeferralThrottled(companyId: string, lane: string, reason: string | null) {
    const key = this.key(companyId, lane);
    const nowMs = this.now().getTime();
    const last = this.lastDeferralLogAt.get(key) ?? 0;
    if (nowMs - last < DEFERRAL_LOG_INTERVAL_MS) return;
    this.lastDeferralLogAt.set(key, nowMs);
    logger.info(
      { companyId, lane, reason },
      "laneBreaker: lane tripped — leaving queued runs queued (log throttled to 1/min/lane)",
    );
  }
}

/**
 * Per-db singleton: `heartbeatService` is instantiated once per route module
 * AND once in index.ts against the same `Db`, and the breaker's half-open /
 * probe-report bookkeeping must be shared across all of them.
 */
const breakerByDb = new WeakMap<object, LaneBreaker>();

export function laneBreakerForDb(db: Db): LaneBreaker {
  let breaker = breakerByDb.get(db as object);
  if (!breaker) {
    breaker = new LaneBreaker({ db });
    breakerByDb.set(db as object, breaker);
  }
  return breaker;
}
