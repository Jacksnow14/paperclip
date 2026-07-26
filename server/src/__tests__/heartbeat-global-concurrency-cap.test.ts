import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Completed heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import {
  computeProcessLostRetrySchedule,
  heartbeatService,
  resolveGlobalMaxConcurrentRuns,
  GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR,
  PROCESS_LOST_RETRY_DELAYS_MS,
  PROCESS_LOST_RETRY_MAX_ATTEMPTS,
} from "../services/heartbeat.ts";
import { findActiveAdapterQuotaPause, MAX_ADAPTER_QUOTA_PAUSE_MS } from "../services/quota-pause.ts";

const GiB = 1024 * 1024 * 1024;

describe("resolveGlobalMaxConcurrentRuns", () => {
  it("derives the default from total memory (7.7 GiB incident host -> 4)", () => {
    // floor((7884.8 MB - 3072 MB reserved) / 1024 MB per-run budget) = 4
    expect(resolveGlobalMaxConcurrentRuns({}, 7.7 * GiB)).toBe(4);
    // floor((16384 - 3072) / 1024) = 13, clamped to the derived max of 12.
    expect(resolveGlobalMaxConcurrentRuns({}, 16 * GiB)).toBe(12);
  });

  it("clamps the derived value on tiny and huge hosts", () => {
    expect(resolveGlobalMaxConcurrentRuns({}, 1 * GiB)).toBe(2);
    expect(resolveGlobalMaxConcurrentRuns({}, 128 * GiB)).toBe(12);
  });

  it("honors the env override within hard bounds and ignores garbage", () => {
    expect(resolveGlobalMaxConcurrentRuns({ [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "6" }, 7.7 * GiB)).toBe(6);
    expect(resolveGlobalMaxConcurrentRuns({ [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "0" }, 7.7 * GiB)).toBe(1);
    expect(resolveGlobalMaxConcurrentRuns({ [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "500" }, 7.7 * GiB)).toBe(64);
    expect(resolveGlobalMaxConcurrentRuns({ [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "banana" }, 7.7 * GiB)).toBe(4);
    expect(resolveGlobalMaxConcurrentRuns({ [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "  " }, 7.7 * GiB)).toBe(4);
  });
});

describe("computeProcessLostRetrySchedule", () => {
  const now = new Date("2026-07-25T00:00:00.000Z");

  it("applies exponential base delays with bounded +/-50% jitter", () => {
    expect(computeProcessLostRetrySchedule(1, now, () => 0.5)?.delayMs).toBe(30_000);
    expect(computeProcessLostRetrySchedule(1, now, () => 0)?.delayMs).toBe(15_000);
    expect(computeProcessLostRetrySchedule(1, now, () => 1)?.delayMs).toBe(45_000);
    expect(computeProcessLostRetrySchedule(2, now, () => 0.5)?.delayMs).toBe(120_000);
    expect(computeProcessLostRetrySchedule(3, now, () => 0.5)?.delayMs).toBe(480_000);
    expect(computeProcessLostRetrySchedule(1, now, () => 0.5)?.dueAt.toISOString()).toBe(
      new Date(now.getTime() + 30_000).toISOString(),
    );
  });

  it("is bounded: attempts past the delay table produce no schedule", () => {
    expect(computeProcessLostRetrySchedule(PROCESS_LOST_RETRY_MAX_ATTEMPTS + 1, now)).toBeNull();
    expect(computeProcessLostRetrySchedule(0, now)).toBeNull();
    expect(computeProcessLostRetrySchedule(1.5, now)).toBeNull();
  });

  it("desynchronizes a batch of simultaneous failures via jitter", () => {
    const samples = [0.05, 0.35, 0.65, 0.95];
    const dueTimes = samples.map(
      (sample) => computeProcessLostRetrySchedule(1, now, () => sample)?.dueAt.getTime(),
    );
    expect(new Set(dueTimes).size).toBe(samples.length);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global concurrency cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("global concurrency ceiling and process-lost backoff", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adapterReleases: Array<() => void> = [];

  const adapterSuccessResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Completed heartbeat work.",
    provider: "test",
    model: "test-model",
  };

  function hangAdapterUntilReleased() {
    mockAdapterExecute.mockImplementation(
      () =>
        new Promise((resolve) => {
          adapterReleases.push(() => resolve(adapterSuccessResult));
        }),
    );
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-global-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const release of adapterReleases) release();
    adapterReleases = [];
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => adapterSuccessResult);
    runningProcesses.clear();

    // Cancel anything still live so table cleanup does not race executions.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
        .from(heartbeatRuns)
        .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
      if (activeRuns.length === 0) break;
      const now = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
          errorCode: "test_cleanup",
          error: "Cancelled by global concurrency cap test cleanup",
          processPid: null,
          processGroupId: null,
        })
        .where(inArray(heartbeatRuns.id, activeRuns.map((run) => run.id)));
      const wakeupRequestIds = activeRuns
        .map((run) => run.wakeupRequestId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (wakeupRequestIds.length > 0) {
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: now })
          .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, opts?: { maxConcurrentRuns?: number; adapterType?: string }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Coder-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: opts?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: opts?.maxConcurrentRuns ?? 5 },
      },
      permissions: {},
    });
    return agentId;
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      payload: {},
      status: "queued",
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  async function seedActiveQuotaPause(companyId: string, agentId: string, scheduledRetryAt: Date) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "transient_failure_retry",
      payload: {},
      status: "queued",
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { transientRetryNotBefore: scheduledRetryAt.toISOString() },
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  // AUR-4139: a scheduled_retry row with a future scheduledRetryAt but no
  // transientRetryNotBefore marker is an ordinary bounded retry (e.g. a
  // process-lost backoff), not a parsed provider quota reset -- it must not
  // suppress admission the way seedActiveQuotaPause's row does.
  async function seedScheduledRetryWithoutQuotaMarker(companyId: string, agentId: string, scheduledRetryAt: Date) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "process_lost_retry",
      payload: {},
      status: "queued",
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt,
      scheduledRetryReason: "process_lost",
      contextSnapshot: {},
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  async function seedDeadRunningRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: 999_999_999,
      startedAt: now,
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  it("refuses admission past the global ceiling even when per-agent slots are free", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 2 });
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    const agentB = await seedAgent(companyId);
    const agentC = await seedAgent(companyId);
    const runA = await seedQueuedRun(companyId, agentA);
    const runB = await seedQueuedRun(companyId, agentB);
    const runC = await seedQueuedRun(companyId, agentC);

    hangAdapterUntilReleased();

    expect(await heartbeat.startNextQueuedRunForAgent(agentA)).toHaveLength(1);
    expect(await heartbeat.startNextQueuedRunForAgent(agentB)).toHaveLength(1);

    // Ceiling reached: agent C has all of its per-agent slots free, but the
    // host-wide cap must refuse admission.
    expect(await heartbeat.startNextQueuedRunForAgent(agentC)).toHaveLength(0);
    expect((await heartbeat.getRun(runC))?.status).toBe("queued");

    // Driving the whole queue cannot bypass the gate either.
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(runC))?.status).toBe("queued");

    // Releasing one running slot restores admission for exactly one run.
    // Wait for both hung adapters to actually be invoked, release whichever
    // started first, and wait for its run to settle.
    await (async () => {
      const deadline = Date.now() + 10_000;
      while (adapterReleases.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    expect(adapterReleases.length).toBe(2);
    adapterReleases.shift()?.();
    const settledStatuses = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const statuses = await Promise.all([
          heartbeat.getRun(runA).then((run) => run?.status),
          heartbeat.getRun(runB).then((run) => run?.status),
        ]);
        if (statuses.includes("succeeded")) return statuses;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return Promise.all([
        heartbeat.getRun(runA).then((run) => run?.status),
        heartbeat.getRun(runB).then((run) => run?.status),
      ]);
    })();
    expect(settledStatuses).toContain("succeeded");

    expect(await heartbeat.startNextQueuedRunForAgent(agentC)).toHaveLength(1);
    expect((await heartbeat.getRun(runC))?.status).toBe("running");
  }, 20_000);

  it("suppresses new run admission for an agent quota-paused until a parsed reset time (AUR-4055)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, agentId, resetAt);
    const otherIssueRun = await seedQueuedRun(companyId, agentId);

    // A different, independently-queued run for the same agent must not be
    // admitted while a parsed quota reset time is still in the future — it
    // would just burn another zero-token attempt into the same wall.
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(0);
    expect((await heartbeat.getRun(otherIssueRun))?.status).toBe("queued");

    // Once the reset time has passed, admission resumes without any manual
    // clearing — the gate simply stops matching.
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "scheduled_retry")));
    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(1);
    expect((await heartbeat.getRun(otherIssueRun))?.status).toBe("running");
  });

  it("does not suppress admission for a scheduled_retry row lacking a parsed quota reset marker (AUR-4139)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const futureRetryAt = new Date(Date.now() + 60 * 60 * 1000);
    await seedScheduledRetryWithoutQuotaMarker(companyId, agentId, futureRetryAt);
    const queuedRun = await seedQueuedRun(companyId, agentId);

    // A future scheduledRetryAt alone (no transientRetryNotBefore) must not be
    // mistaken for an active quota pause -- otherwise every ordinary bounded
    // retry (e.g. process-lost backoff) would also freeze admission.
    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(1);
    expect((await heartbeat.getRun(queuedRun))?.status).toBe("running");
  });

  it("suppresses admission for a sibling agent sharing the same adapter's quota pause (AUR-4139)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const siblingAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, pausedAgentId, resetAt);
    const siblingQueuedRun = await seedQueuedRun(companyId, siblingAgentId);

    // Session limits are scoped to the credential/account behind the adapter, not
    // to the individual agent whose run happened to hit the limit -- a sibling
    // agent sharing the same adapterType shares the same wall.
    expect(await heartbeat.startNextQueuedRunForAgent(siblingAgentId)).toHaveLength(0);
    expect((await heartbeat.getRun(siblingQueuedRun))?.status).toBe("queued");
  });

  it("does not suppress admission for an agent on a different adapterType than the paused one (AUR-4139)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const unrelatedAgentId = await seedAgent(companyId, { adapterType: "codex_local" });
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, pausedAgentId, resetAt);
    const unrelatedQueuedRun = await seedQueuedRun(companyId, unrelatedAgentId);

    // A different adapterType means a different credential/account -- it must
    // not inherit another adapter's quota pause.
    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(unrelatedAgentId)).toHaveLength(1);
    expect((await heartbeat.getRun(unrelatedQueuedRun))?.status).toBe("running");
  });

  it("clamps an adapter-wide quota pause to the maximum horizon (AUR-4139)", async () => {
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const now = new Date("2026-07-26T00:00:00.000Z");
    await seedActiveQuotaPause(companyId, pausedAgentId, new Date(now.getTime() + 24 * 60 * 60 * 1000));

    const activePause = await findActiveAdapterQuotaPause(db, companyId, "claude_local", now);

    expect(activePause).not.toBeNull();
    expect(activePause?.agentId).toBe(pausedAgentId);
    expect(activePause?.scheduledRetryAt.toISOString()).toBe(
      new Date(now.getTime() + MAX_ADAPTER_QUOTA_PAUSE_MS).toISOString(),
    );
  });

  it("ignores terminated agents when resolving an adapter-wide quota pause (AUR-4139)", async () => {
    const companyId = await seedCompany();
    const terminatedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const liveAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const now = new Date("2026-07-26T00:00:00.000Z");
    await seedActiveQuotaPause(companyId, terminatedAgentId, new Date(now.getTime() + 5 * 60 * 60 * 1000));
    await seedActiveQuotaPause(companyId, liveAgentId, new Date(now.getTime() + 60 * 60 * 1000));
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminatedAgentId));

    const activePause = await findActiveAdapterQuotaPause(db, companyId, "claude_local", now);

    expect(activePause).not.toBeNull();
    expect(activePause?.agentId).toBe(liveAgentId);
    expect(activePause?.scheduledRetryAt.toISOString()).toBe(
      new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("schedules process-lost retries with backoff and jitter instead of re-queueing them", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentIds: string[] = [];
    const deadRunIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const agentId = await seedAgent(companyId);
      agentIds.push(agentId);
      deadRunIds.push(await seedDeadRunningRun(companyId, agentId));
    }

    const reapStartedAt = Date.now();
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(4);

    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "scheduled_retry"));
    expect(retries).toHaveLength(4);
    const queuedOrRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    expect(queuedOrRunning).toHaveLength(0);

    // A synchronized mass process-loss event must not re-dispatch anything in
    // the same instant: every retry waits out a jittered backoff window.
    for (const retry of retries) {
      expect(retry.scheduledRetryReason).toBe("process_lost");
      expect(retry.processLossRetryCount).toBe(1);
      const dueInMs = new Date(retry.scheduledRetryAt!).getTime() - reapStartedAt;
      expect(dueInMs).toBeGreaterThanOrEqual(PROCESS_LOST_RETRY_DELAYS_MS[0] * 0.5 - 5_000);
      expect(dueInMs).toBeLessThanOrEqual(PROCESS_LOST_RETRY_DELAYS_MS[0] * 1.5 + 5_000);
    }
    const dueTimes = new Set(retries.map((retry) => new Date(retry.scheduledRetryAt!).getTime()));
    expect(dueTimes.size).toBeGreaterThanOrEqual(2);

    // Nothing is startable while the retries wait out their backoff.
    for (const agentId of agentIds) {
      expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(0);
    }
    expect((await heartbeat.promoteDueScheduledRetries(new Date())).promoted).toBe(0);

    // Once due, retries promote back into the queue (and from there re-enter
    // capped admission like any other queued run).
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(inArray(heartbeatRuns.id, retries.map((retry) => retry.id)));
    hangAdapterUntilReleased();
    const promotion = await heartbeat.promoteDueScheduledRetries(new Date());
    expect(promotion.promoted).toBe(4);
  });

  it("promoted process-lost retries are admitted through the global ceiling, not around it", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 1 });
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    const agentB = await seedAgent(companyId);
    await seedDeadRunningRun(companyId, agentA);
    await seedDeadRunningRun(companyId, agentB);

    await heartbeat.reapOrphanedRuns();
    const retries = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "scheduled_retry"));
    expect(retries).toHaveLength(2);

    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(inArray(heartbeatRuns.id, retries.map((retry) => retry.id)));
    hangAdapterUntilReleased();
    expect((await heartbeat.promoteDueScheduledRetries(new Date())).promoted).toBe(2);

    // Both retries are due simultaneously, but the ceiling admits only one.
    expect(await heartbeat.startNextQueuedRunForAgent(agentA)).toHaveLength(1);
    expect(await heartbeat.startNextQueuedRunForAgent(agentB)).toHaveLength(0);
    const statuses = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, retries.map((retry) => retry.id)));
    expect(statuses.map((row) => row.status).sort()).toEqual(["queued", "running"]);
  });

  it("stops retrying after the bounded attempt count is exhausted", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedDeadRunningRun(companyId, agentId);
    await db
      .update(heartbeatRuns)
      .set({ processLossRetryCount: PROCESS_LOST_RETRY_MAX_ATTEMPTS })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.errorCode).toBe("process_lost");
  });
});
