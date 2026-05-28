import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer-disable tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer-disable", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-disable-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  async function waitForRunsSettled(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function cleanupRows() {
    await waitForRunsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    vi.clearAllMocks();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: {
    heartbeatEnabled: boolean;
    intervalSec?: number;
    lastHeartbeatAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: opts.heartbeatEnabled,
          intervalSec: opts.intervalSec ?? 60,
        },
      },
      permissions: {},
      lastHeartbeatAt: opts.lastHeartbeatAt,
    });
    return { companyId, agentId, issuePrefix };
  }

  async function insertTimerRun(
    agentId: string,
    companyId: string,
    status: "queued" | "scheduled_retry",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status,
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
    });
    return runId;
  }

  async function insertOnDemandRun(
    agentId: string,
    companyId: string,
    status: "queued" | "scheduled_retry",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status,
      contextSnapshot: {},
    });
    return runId;
  }

  async function insertAutomationTimerRetryRun(
    agentId: string,
    companyId: string,
    status: "queued" | "scheduled_retry",
    retryOfRunId?: string,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status,
      retryOfRunId: retryOfRunId ?? null,
      scheduledRetryReason: "transient_failure",
      scheduledRetryAttempt: 1,
      contextSnapshot: { wakeSource: "timer", source: "scheduler", reason: "interval_elapsed" },
    });
    return runId;
  }

  async function insertUnrelatedAutomationRun(
    agentId: string,
    companyId: string,
    status: "queued" | "scheduled_retry",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status,
      contextSnapshot: { wakeSource: "assignment", issueId: randomUUID() },
    });
    return runId;
  }

  describe("tickTimers", () => {
    it("does not enqueue a timer run for a disabled agent", async () => {
      const now = new Date();
      await seedAgent({
        heartbeatEnabled: false,
        intervalSec: 60,
        // lastHeartbeatAt far in the past so interval has definitely elapsed
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(now);

      expect(result.enqueued).toBe(0);

      const allRuns = await db.select().from(heartbeatRuns);
      expect(allRuns).toHaveLength(0);
    });

    it("enqueues a timer run when interval has elapsed for an enabled agent", async () => {
      const now = new Date();
      const { agentId } = await seedAgent({
        heartbeatEnabled: true,
        intervalSec: 60,
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(now);

      expect(result.enqueued).toBe(1);

      // The run may transition from queued→running quickly via startNextQueuedRunForAgent;
      // verify a timer run exists (regardless of current execution status).
      const allRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]!.invocationSource).toBe("timer");
    });
  });

  describe("cancelQueuedTimerRunsForAgent", () => {
    it("cancels queued timer runs but leaves on_demand runs untouched", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      const timerRunId = await insertTimerRun(agentId, companyId, "queued");
      const onDemandRunId = await insertOnDemandRun(agentId, companyId, "queued");

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(1);

      const timerRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, timerRunId))
        .then((rows) => rows[0]);
      expect(timerRun?.status).toBe("cancelled");

      const onDemandRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, onDemandRunId))
        .then((rows) => rows[0]);
      expect(onDemandRun?.status).toBe("queued");
    });

    it("cancels scheduled_retry timer runs", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      const scheduledRunId = await insertTimerRun(agentId, companyId, "scheduled_retry");

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(1);

      const run = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduledRunId))
        .then((rows) => rows[0]);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("cancelled");
    });

    it("returns 0 when there are no queued timer runs", async () => {
      const { agentId } = await seedAgent({ heartbeatEnabled: false });

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(0);
    });

    it("does not cancel timer runs that are already running", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { source: "scheduler" },
        startedAt: new Date(),
      });

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(0);

      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(run?.status).toBe("running");
    });

    it("cancels automation scheduled_retry runs derived from timer heartbeats", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      // Simulate: timer run failed, bounded retry created an automation run
      const timerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: timerRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { wakeSource: "timer" },
        finishedAt: new Date(),
        error: "transient error",
        errorCode: "transient_failure",
      });

      const automationRetryId = await insertAutomationTimerRetryRun(agentId, companyId, "scheduled_retry", timerRunId);

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(1);

      const retryRun = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, automationRetryId))
        .then((rows) => rows[0]);
      expect(retryRun?.status).toBe("cancelled");
      expect(retryRun?.errorCode).toBe("cancelled");
    });

    it("cancels cascading automation retry (depth 2) derived from a timer heartbeat", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      // Depth 1 retry already ran and failed; depth 2 is pending
      const timerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: timerRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { wakeSource: "timer" },
        finishedAt: new Date(),
        errorCode: "transient_failure",
      });

      const automationRetry1Id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: automationRetry1Id,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        retryOfRunId: timerRunId,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
        contextSnapshot: { wakeSource: "timer", source: "scheduler" },
        finishedAt: new Date(),
        errorCode: "transient_failure",
      });

      // Depth-2 retry: retryOfRunId points to automationRetry1 (not the timer run directly),
      // but wakeSource is still 'timer' because it was spread from the original context.
      const automationRetry2Id = await insertAutomationTimerRetryRun(
        agentId,
        companyId,
        "scheduled_retry",
        automationRetry1Id,
      );

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(1);

      const retry2Run = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, automationRetry2Id))
        .then((rows) => rows[0]);
      expect(retry2Run?.status).toBe("cancelled");
      expect(retry2Run?.errorCode).toBe("cancelled");
    });

    it("does not cancel unrelated automation runs without timer wake source", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      const unrelatedRunId = await insertUnrelatedAutomationRun(agentId, companyId, "scheduled_retry");

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(0);

      const unrelatedRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, unrelatedRunId))
        .then((rows) => rows[0]);
      expect(unrelatedRun?.status).toBe("scheduled_retry");
    });

    it("cancels timer-derived automation retries but not unrelated automation runs", async () => {
      const { agentId, companyId } = await seedAgent({ heartbeatEnabled: true });

      const timerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: timerRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { wakeSource: "timer" },
        finishedAt: new Date(),
        errorCode: "transient_failure",
      });

      const automationRetryId = await insertAutomationTimerRetryRun(agentId, companyId, "queued", timerRunId);
      const unrelatedRunId = await insertUnrelatedAutomationRun(agentId, companyId, "queued");

      const heartbeat = heartbeatService(db);
      const cancelled = await heartbeat.cancelQueuedTimerRunsForAgent(agentId);

      expect(cancelled).toBe(1);

      const retryRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, automationRetryId))
        .then((rows) => rows[0]);
      expect(retryRun?.status).toBe("cancelled");

      const unrelatedRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, unrelatedRunId))
        .then((rows) => rows[0]);
      expect(unrelatedRun?.status).toBe("queued");
    });
  });
});
