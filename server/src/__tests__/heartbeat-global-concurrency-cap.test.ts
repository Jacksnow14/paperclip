import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
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
import { logger } from "../middleware/logger.js";

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
    // Runs released above can still write rows (comments, activity, cost
    // events) between any two ordered deletes — the shared reset truncates
    // every table in one atomic statement instead (AUR-5103).
    await resetEmbeddedPostgresTestDatabase(db);
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

  async function seedQueuedRun(
    companyId: string,
    agentId: string,
    opts?: { createdAt?: Date; issueId?: string },
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = opts?.createdAt ?? new Date();
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
      contextSnapshot: opts?.issueId ? { issueId: opts.issueId } : {},
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  let issueSeedCounter = 0;
  async function seedIssue(companyId: string, opts?: { priority?: string; assigneeAgentId?: string }) {
    issueSeedCounter += 1;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Test issue ${issueSeedCounter}`,
      status: "in_progress",
      priority: opts?.priority ?? "medium",
      assigneeAgentId: opts?.assigneeAgentId ?? null,
      issueNumber: issueSeedCounter,
      identifier: `T${issueSeedCounter}`,
    });
    return issueId;
  }

  // `pauseRecordedAt` is the row's createdAt -- the fixed point MAX_ADAPTER_QUOTA_PAUSE_MS
  // is anchored to. Tests must control it explicitly, otherwise "clamped" is
  // indistinguishable from "recomputed relative to now" (AUR-4139).
  async function seedActiveQuotaPause(
    companyId: string,
    agentId: string,
    scheduledRetryAt: Date,
    pauseRecordedAt?: Date,
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = pauseRecordedAt ?? new Date();
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

  async function seedQuotaPauseMarkerWithoutScheduledRetryAt(
    companyId: string,
    agentId: string,
    pauseRecordedAt?: Date,
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = pauseRecordedAt ?? new Date();
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
      scheduledRetryAt: null,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { transientRetryNotBefore: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() },
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

    // AUR-4143: the completing run's `finally` now drives the whole queue in
    // starvation order rather than re-driving only its own agent, so the freed
    // slot is reallocated to agentC automatically. This used to require the
    // explicit startNextQueuedRunForAgent(agentC) call below, which is why that
    // call now returns [] — there is nothing left queued for it to claim.
    const runCStatus = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = (await heartbeat.getRun(runC))?.status;
        if (status === "running") return status;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return (await heartbeat.getRun(runC))?.status;
    })();
    expect(runCStatus).toBe("running");

    // Exactly one run was admitted into the freed slot — the ceiling still holds.
    const globalRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(globalRunning).toBe(2);

    // Re-driving agentC explicitly is now a no-op rather than a second claim.
    expect(await heartbeat.startNextQueuedRunForAgent(agentC)).toHaveLength(0);
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

  it("clamps an adapter-wide quota pause to the maximum horizon measured from when it was recorded (AUR-4139)", async () => {
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    // A ~24h reset recorded 1h ago: still inside the 6h max horizon, so still paused,
    // but reported as expiring at anchor+6h rather than at the parsed 24h reset.
    const recordedAt = new Date(Date.now() - 60 * 60 * 1000);
    const parsedResetAt = new Date(recordedAt.getTime() + 24 * 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, pausedAgentId, parsedResetAt, recordedAt);

    const activePause = await findActiveAdapterQuotaPause(db, companyId, "claude_local", new Date());

    expect(activePause).not.toBeNull();
    expect(activePause?.agentId).toBe(pausedAgentId);
    expect(activePause?.scheduledRetryAt.toISOString()).toBe(
      new Date(recordedAt.getTime() + MAX_ADAPTER_QUOTA_PAUSE_MS).toISOString(),
    );
    // the unclamped provider value stays available for logging
    expect(activePause?.parsedResetAt.toISOString()).toBe(parsedResetAt.toISOString());
  });

  // The load-bearing test for the clamp. Asserting the horizon at a single instant cannot
  // fail on a clamp anchored to `now` -- at t=0 "bounded to 6h" and "returns now+6h
  // forever" are the same value. This asserts PAST the horizon, the one axis a sliding
  // window cannot survive (AUR-4139).
  it("stops suppressing admission once the maximum horizon has elapsed, even if the parsed reset is far out (AUR-4139)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const siblingAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    // A ~24h reset recorded 7h ago: the parsed reset is still 17h in the future, but the
    // 6h max horizon lapsed an hour ago, so the fleet must be released to probe the wall.
    const recordedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const parsedResetAt = new Date(recordedAt.getTime() + 24 * 60 * 60 * 1000);
    expect(parsedResetAt.getTime()).toBeGreaterThan(Date.now());
    await seedActiveQuotaPause(companyId, pausedAgentId, parsedResetAt, recordedAt);

    expect(await findActiveAdapterQuotaPause(db, companyId, "claude_local", new Date())).toBeNull();

    const siblingQueuedRun = await seedQueuedRun(companyId, siblingAgentId);
    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(siblingAgentId)).toHaveLength(1);
    expect((await heartbeat.getRun(siblingQueuedRun))?.status).toBe("running");
  });

  it("anchors the maximum horizon to createdAt even if updatedAt changes later (AUR-4139)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const siblingAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const recordedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const parsedResetAt = new Date(recordedAt.getTime() + 24 * 60 * 60 * 1000);
    const pauseRunId = await seedActiveQuotaPause(companyId, pausedAgentId, parsedResetAt, recordedAt);

    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, pauseRunId));

    expect(await findActiveAdapterQuotaPause(db, companyId, "claude_local", new Date())).toBeNull();

    const siblingQueuedRun = await seedQueuedRun(companyId, siblingAgentId);
    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(siblingAgentId)).toHaveLength(1);
    expect((await heartbeat.getRun(siblingQueuedRun))?.status).toBe("running");
  });

  it("ignores scheduled_retry rows with a quota marker but NULL scheduledRetryAt (AUR-4139)", async () => {
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const nullPauseAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const now = new Date();
    const realPauseRecordedAt = new Date(now.getTime() - 60 * 60 * 1000);
    const realPauseResetAt = new Date(now.getTime() + 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, pausedAgentId, realPauseResetAt, realPauseRecordedAt);
    await seedQuotaPauseMarkerWithoutScheduledRetryAt(
      companyId,
      nullPauseAgentId,
      new Date(now.getTime() - 10 * 60 * 1000),
    );

    const activePause = await findActiveAdapterQuotaPause(db, companyId, "claude_local", now);

    expect(activePause).not.toBeNull();
    expect(activePause?.agentId).toBe(pausedAgentId);
    expect(activePause?.scheduledRetryAt.toISOString()).toBe(realPauseResetAt.toISOString());
  });

  it("logs the suppression payload when an adapter-wide quota pause blocks admission (AUR-4139 AC1)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const siblingAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
    const recordedAt = new Date(Date.now() - 60 * 60 * 1000);
    const parsedResetAt = new Date(recordedAt.getTime() + 24 * 60 * 60 * 1000);
    await seedActiveQuotaPause(companyId, pausedAgentId, parsedResetAt, recordedAt);
    const siblingQueuedRun = await seedQueuedRun(companyId, siblingAgentId);
    const loggerInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    expect(await heartbeat.startNextQueuedRunForAgent(siblingAgentId)).toHaveLength(0);
    expect((await heartbeat.getRun(siblingQueuedRun))?.status).toBe("queued");
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: siblingAgentId,
        pausedByAgentId: pausedAgentId,
        adapterType: "claude_local",
        quotaPausedUntil: new Date(recordedAt.getTime() + MAX_ADAPTER_QUOTA_PAUSE_MS).toISOString(),
        parsedResetAt: parsedResetAt.toISOString(),
        clampedToMaxHorizon: true,
      }),
      "startNextQueuedRunForAgent: adapter quota pause active; run admission suppressed",
    );
  });

  it.each(["paused", "pending_approval"])(
    "ignores %s agents when resolving an adapter-wide quota pause (AUR-4139)",
    async (ineligibleStatus) => {
      const companyId = await seedCompany();
      const ineligibleAgentId = await seedAgent(companyId, { adapterType: "claude_local" });
      const recordedAt = new Date(Date.now() - 60 * 1000);
      await seedActiveQuotaPause(
        companyId,
        ineligibleAgentId,
        new Date(recordedAt.getTime() + 60 * 60 * 1000),
        recordedAt,
      );
      await db.update(agents).set({ status: ineligibleStatus }).where(eq(agents.id, ineligibleAgentId));

      // An agent admission already refuses cannot clear the wall, so its retry row carries
      // no live signal about the shared credential and must not gate live siblings.
      expect(await findActiveAdapterQuotaPause(db, companyId, "claude_local", new Date())).toBeNull();
    },
  );

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

  // AUR-4143: an idle agent with queued runs and free global slots must admit
  // work. Live incident: per-agent maxConcurrentRuns defaults to 20 while the
  // derived host cap was 4, and resumeQueuedRuns iterated queued agents in
  // arbitrary table-scan order letting each greedily claim every free slot. Two
  // chatty agents held 4/4 running while three engineers sat on 74 queued runs
  // aging 14h+, each computing availableSlots = min(20 - 0, 4 - 4) = 0.
  //
  // This asserts the fair-share invariant, which fails on the pre-fix code in
  // EVERY scan ordering, not just the unlucky one. Cap 4, three contending
  // agents => ceiling floor(4/3) = 1 each, so all three must be admitted.
  // Pre-fix: whichever agent is scanned first drains the cap (greedy takes 4 ->
  // 4/0/0; scanned second -> 1/3/0; scanned third -> 1/1/2) so at least one
  // agent is starved or one exceeds its share in all three permutations.
  it("shares the global cap fairly instead of letting one agent starve the fleet", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();

    // The greedy agent mirrors production config: a per-agent ceiling far above
    // the global cap, plus a deep backlog it will happily consume the cap with.
    const greedyAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });
    const starvedAgentA = await seedAgent(companyId, { maxConcurrentRuns: 20 });
    const starvedAgentB = await seedAgent(companyId, { maxConcurrentRuns: 20 });

    // Greedy queues oldest so it is scanned first under both the old heap-scan
    // order and the new starvation-first ordering.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 4; i += 1) {
      await seedQueuedRun(companyId, greedyAgent, { createdAt: new Date(base + i) });
    }
    const starvedRunA = await seedQueuedRun(companyId, starvedAgentA, {
      createdAt: new Date(base + 10_000),
    });
    const starvedRunB = await seedQueuedRun(companyId, starvedAgentB, {
      createdAt: new Date(base + 20_000),
    });

    hangAdapterUntilReleased();
    await heartbeat.resumeQueuedRuns();

    const runningByAgent = async (agentId: string) =>
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
        .then((rows) => rows.length);

    // ...and the agents that were starved in production must each get a slot
    // BEFORE anyone gets more than their equal share.
    expect(await runningByAgent(starvedAgentA)).toBe(1);
    expect(await runningByAgent(starvedAgentB)).toBe(1);
    expect((await heartbeat.getRun(starvedRunA))?.status).toBe("running");
    expect((await heartbeat.getRun(starvedRunB))?.status).toBe("running");

    // AUR-4620 F2: once both starved agents have exhausted their queued work
    // (their fair share was all they had), the cap has one slot left with
    // nobody else waiting for it. greedyAgent still has a backlog, so it may
    // now reclaim that idle slot -- this is the redistribution pass, not a
    // regression of the fairness guarantee above: starvedAgentA/B already got
    // their guaranteed slot with certainty before greedy could take a second.
    expect(await runningByAgent(greedyAgent)).toBe(2);

    // The global ceiling is still respected, and AUR-4620 means it's now
    // fully used rather than left idle with queued work still available.
    const globalRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(globalRunning).toBe(4);
  });

  // Guard the other half of the invariant (see doctrine: a gate proven only by a
  // failing case may be one that can never clear). A sole agent with queued work
  // is uncontended and must still be able to use the whole host budget.
  it("lets an uncontended agent use the full global cap", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const soloAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });
    for (let i = 0; i < 6; i += 1) {
      await seedQueuedRun(companyId, soloAgent, { createdAt: new Date(Date.now() - 60_000 + i) });
    }

    hangAdapterUntilReleased();
    await heartbeat.resumeQueuedRuns();

    const running = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, soloAgent), eq(heartbeatRuns.status, "running")))
      .then((rows) => rows.length);
    expect(running).toBe(4);
  });

  // AUR-4620: agents that can never claim a slot right now (quota-paused
  // adapter, or an inadmissible status) must not shrink the ceiling for agents
  // that actually can. Live incident: several permanently quota-paused
  // codex_local agents with stale queued rows inflated the contender count,
  // forcing ceiling=1 for every agent including the truly eligible ones --
  // cap sat at 2/4 running against 280 queued.
  //
  // Below: pausedAgentX itself holds no queued row (only the scheduled_retry
  // that establishes the pause), so only 4 agentIds ever have a queued row --
  // eligibleA, eligibleB, pausedAgentY, and terminatedAgent. Pre-fix, all 4
  // counted as contenders -> ceiling floor(4/4)=1 each, leaving 2 of the 4
  // global slots stranded since pausedAgentY and terminatedAgent can never
  // claim theirs. Post-fix, both get excluded from the denominator, so the 2
  // eligible agents should each get ceiling floor(4/2)=2.
  it("excludes quota-paused and inadmissible-status agents from the fair-share denominator", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();

    const eligibleA = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "claude_local" });
    const eligibleB = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "claude_local" });
    for (let i = 0; i < 2; i += 1) {
      await seedQueuedRun(companyId, eligibleA, { createdAt: new Date(Date.now() - 60_000 + i) });
    }
    for (let i = 0; i < 2; i += 1) {
      await seedQueuedRun(companyId, eligibleB, { createdAt: new Date(Date.now() - 60_000 + i) });
    }

    // Two codex_local agents permanently walled off behind a shared quota pause,
    // each still holding a stale queued row.
    const pausedAgentX = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "codex_local" });
    const pausedAgentY = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "codex_local" });
    await seedActiveQuotaPause(companyId, pausedAgentX, new Date(Date.now() + 60 * 60 * 1000));
    await seedQueuedRun(companyId, pausedAgentY);

    // A terminated agent with a stale queued row nobody ever cleaned up.
    const terminatedAgent = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "codex_local" });
    await seedQueuedRun(companyId, terminatedAgent);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminatedAgent));

    hangAdapterUntilReleased();
    await heartbeat.resumeQueuedRuns();

    const runningByAgent = async (agentId: string) =>
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
        .then((rows) => rows.length);

    // Pre-fix: contenders counted all 4 agentIds with a queued row (eligibleA,
    // eligibleB, pausedAgentY, terminatedAgent) -> ceiling floor(4/4) = 1 each,
    // leaving 2 of the 4 global slots unfillable since pausedAgentY and
    // terminatedAgent can never claim theirs.
    expect(await runningByAgent(eligibleA)).toBe(2);
    expect(await runningByAgent(eligibleB)).toBe(2);

    const globalRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(globalRunning).toBe(4);
  });

  // AUR-4620 F2 (CTO review of PR #185). Filtering ineligible contenders out
  // of the denominator (the test above) is not enough on its own: the ceiling
  // formula floor(cap/contenders) collapses to 1 for *every* contender once
  // contenders > cap, and nothing reclaims a contender's unused share of 1 for
  // another agent that could use more. Reproduces that shape directly: 3
  // "phantom" contenders are eligible (no quota pause, admissible status) and
  // each hold one queued run of their own, so they inflate the denominator to
  // 5 against cap 4 -- but their queued work is non-critical and gets shed
  // under disk pressure every single pass, so they can never actually claim
  // the 1-slot share the ceiling formula reserves for them. Two real agents
  // hold deep, critical-priority backlogs capable of using more than a
  // ceiling of 1 once it's freed. Without a redistribution pass this asserts
  // globalRunning stays at 2 (only the fair-share floor, forever stranding
  // the other 2 slots); with it, all 4 slots fill.
  it("redistributes a contender's unclaimed fair share once cap < contenders (AUR-4620 F2)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4, isDiskPressureActive: () => true });
    const companyId = await seedCompany();

    const phantomAgents: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const agentId = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "claude_local" });
      phantomAgents.push(agentId);
      // No issueId -> queuedIssue is null -> priority !== "critical" -> shed
      // under disk pressure every pass, regardless of ceiling.
      await seedQueuedRun(companyId, agentId, { createdAt: new Date(Date.now() - 70_000 + i) });
    }

    const realAgentA = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "claude_local" });
    const realAgentB = await seedAgent(companyId, { maxConcurrentRuns: 20, adapterType: "claude_local" });
    const criticalIssueA = await seedIssue(companyId, { priority: "critical", assigneeAgentId: realAgentA });
    const criticalIssueB = await seedIssue(companyId, { priority: "critical", assigneeAgentId: realAgentB });
    for (let i = 0; i < 3; i += 1) {
      await seedQueuedRun(companyId, realAgentA, { createdAt: new Date(Date.now() - 50_000 + i), issueId: criticalIssueA });
    }
    for (let i = 0; i < 3; i += 1) {
      await seedQueuedRun(companyId, realAgentB, { createdAt: new Date(Date.now() - 50_000 + i), issueId: criticalIssueB });
    }

    hangAdapterUntilReleased();
    await heartbeat.resumeQueuedRuns();

    const runningByAgent = async (agentId: string) =>
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
        .then((rows) => rows.length);

    for (const phantomAgentId of phantomAgents) {
      expect(await runningByAgent(phantomAgentId)).toBe(0);
    }
    expect(await runningByAgent(realAgentA)).toBe(2);
    expect(await runningByAgent(realAgentB)).toBe(2);

    const globalRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(globalRunning).toBe(4);
  });

  // AUR-4143 review follow-up (CEO). The first cut of the fix took the ceiling
  // as a caller-supplied option, and only resumeQueuedRuns passed it. The other
  // 8 call sites — retry promotion, assignment dispatch, and most importantly
  // executeRun's `finally` — passed nothing, which meant an infinite ceiling.
  // Fairness must hold on a *direct* admission call, not only via the fair tick.
  it("enforces fair share on direct admission paths, not just the fair tick", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 2 });
    const companyId = await seedCompany();
    const greedyAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });
    const starvedAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });

    const base = Date.now() - 60_000;
    for (let i = 0; i < 3; i += 1) {
      await seedQueuedRun(companyId, greedyAgent, { createdAt: new Date(base + i) });
    }
    await seedQueuedRun(companyId, starvedAgent, { createdAt: new Date(base + 10_000) });

    hangAdapterUntilReleased();

    // Two contenders against a cap of 2 means a ceiling of 1 each. Pre-fix this
    // direct call had no ceiling and took both slots, leaving starvedAgent at 0.
    expect(await heartbeat.startNextQueuedRunForAgent(greedyAgent)).toHaveLength(1);
    expect(await heartbeat.startNextQueuedRunForAgent(starvedAgent)).toHaveLength(1);
  });

  // The mechanism that actually starved Claude Code Fast: executeRun's finally
  // re-drove only the completing agent, handing the just-freed slot straight
  // back to it. A holdings ceiling alone cannot fix this — the completing
  // agent's runningCount has already dropped to 0, so it is entitled to its
  // share again. Only reallocating in starvation order breaks the grip.
  it("hands a freed slot to the starved agent, not back to the agent that freed it", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 1 });
    const companyId = await seedCompany();
    const greedyAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });
    const starvedAgent = await seedAgent(companyId, { maxConcurrentRuns: 20 });

    // starvedAgent's wake is the oldest, so starvation-first ordering must
    // prefer it the moment capacity appears.
    const base = Date.now() - 120_000;
    const starvedRun = await seedQueuedRun(companyId, starvedAgent, {
      createdAt: new Date(base),
    });
    for (let i = 0; i < 2; i += 1) {
      await seedQueuedRun(companyId, greedyAgent, { createdAt: new Date(base + 60_000 + i) });
    }

    hangAdapterUntilReleased();

    // greedyAgent holds the only slot. Its remaining queued run is younger than
    // starvedAgent's, so once this one completes the slot is not its to keep.
    expect(await heartbeat.startNextQueuedRunForAgent(greedyAgent)).toHaveLength(1);
    expect((await heartbeat.getRun(starvedRun))?.status).toBe("queued");

    // Let greedyAgent's run finish; its `finally` re-drives the queue.
    const deadline = Date.now() + 10_000;
    while (adapterReleases.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    adapterReleases.shift()?.();

    const starvedStatus = await (async () => {
      const settleBy = Date.now() + 10_000;
      while (Date.now() < settleBy) {
        const status = (await heartbeat.getRun(starvedRun))?.status;
        if (status && status !== "queued") return status;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return (await heartbeat.getRun(starvedRun))?.status;
    })();

    // Pre-fix: greedyAgent recaptured its own slot and this stayed "queued".
    expect(starvedStatus).not.toBe("queued");

    const greedyRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, greedyAgent), eq(heartbeatRuns.status, "running")))
      .then((rows) => rows.length);
    expect(greedyRunning).toBe(0);
  }, 30_000);

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
