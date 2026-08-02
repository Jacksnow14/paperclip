import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { resolveGlobalMaxConcurrentRuns } from "./heartbeat.js";

// AUR-4059: claimQueuedRun logs one info line per refused admission, which
// makes "the cap is correctly throttling a busy fleet" and "the fleet is
// dead and nothing is running" look identical from outside — both produce a
// stream of identical info lines. This module aggregates admission state
// across calls so a *sustained* saturated ceiling (not a single refusal,
// which is normal) escalates to a warn, and exposes current cap/queue state
// for /api/health to read without a DB query or log grep.

export interface GlobalRunAdmissionSnapshot {
  globalCap: number;
  running: number;
  queued: number;
  scheduledRetry: number;
  agentsInError: number;
  saturated: boolean;
  /** How long the ceiling has been continuously saturated across observations of this monitor, or null if not currently saturated. */
  saturatedForMs: number | null;
}

// Module-level, process-global — reset on restart, same as disk-monitor's pressure flag.
let _saturatedSinceMs: number | null = null;
let _lastWarnAtMs: number | null = null;

const SUSTAINED_SATURATION_WARN_MS = 5 * 60 * 1000;
const SUSTAINED_SATURATION_WARN_REPEAT_MS = 15 * 60 * 1000;

/** Resets the in-process saturation streak. Exposed for tests only. */
export function __resetGlobalRunAdmissionMonitorForTest(): void {
  _saturatedSinceMs = null;
  _lastWarnAtMs = null;
}

async function computeCounts(db: Db, globalCap: number) {
  const [statusRows, [errorAgentRow]] = await Promise.all([
    db
      .select({ status: heartbeatRuns.status, count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]))
      .groupBy(heartbeatRuns.status),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.status, "error")),
  ]);

  const byStatus = new Map(statusRows.map((row) => [row.status, Number(row.count ?? 0)]));
  return {
    globalCap,
    running: byStatus.get("running") ?? 0,
    queued: byStatus.get("queued") ?? 0,
    scheduledRetry: byStatus.get("scheduled_retry") ?? 0,
    agentsInError: Number(errorAgentRow?.count ?? 0),
  };
}

/**
 * Computes current cap/queue state, updates the sustained-saturation streak,
 * and emits a warn once saturation has held continuously past the threshold
 * (re-warned at a reduced cadence while it persists). Call periodically
 * (e.g. every 60s) and/or on demand from a health surface — dedup on
 * `_lastWarnAtMs` keeps repeated calls from spamming logs.
 */
export async function checkGlobalRunAdmission(
  db: Db,
  opts: { now?: Date; globalCap?: number } = {},
): Promise<GlobalRunAdmissionSnapshot> {
  const now = opts.now ?? new Date();
  const globalCap = opts.globalCap ?? resolveGlobalMaxConcurrentRuns();
  const counts = await computeCounts(db, globalCap);
  const saturated = counts.running >= globalCap;
  const nowMs = now.getTime();

  if (saturated) {
    if (_saturatedSinceMs == null) _saturatedSinceMs = nowMs;
  } else {
    _saturatedSinceMs = null;
    _lastWarnAtMs = null;
  }

  const saturatedForMs = saturated && _saturatedSinceMs != null ? nowMs - _saturatedSinceMs : null;

  if (saturated && saturatedForMs != null && saturatedForMs >= SUSTAINED_SATURATION_WARN_MS) {
    if (_lastWarnAtMs == null || nowMs - _lastWarnAtMs >= SUSTAINED_SATURATION_WARN_REPEAT_MS) {
      _lastWarnAtMs = nowMs;
      logger.warn(
        { ...counts, saturatedForMs },
        "global-run-admission: concurrency ceiling has been continuously saturated past the sustained threshold",
      );
    }
  }

  return { ...counts, saturated, saturatedForMs };
}
