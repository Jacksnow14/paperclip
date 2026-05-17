import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Done.",
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
    `Skipping embedded Postgres terminal-guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal-issue run guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-terminal-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Done.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();

    // Drain any queued/running runs before deleting rows. Require 3 consecutive
    // idle observations so background fire-and-forget work has time to settle.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await db
        .select({ status: heartbeatRuns.status, processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId })
        .from(heartbeatRuns);
      const managedExecutionStillActive = rows.some(
        (r) => (r.status === "queued" || r.status === "running") && !r.processPid && !r.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
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
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedBase(issueStatus: "todo" | "in_progress" | "cancelled" | "done") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function seedQueuedRun(agentId: string, companyId: string, issueId: string) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
      startedAt: now,
      updatedAt: now,
    });

    return { runId, wakeupRequestId };
  }

  async function waitForRunToSettle(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    timeoutMs = 3_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  // ---- claimQueuedRun guard ----

  it("claimQueuedRun: cancels queued run when issue is cancelled", async () => {
    const { companyId, agentId, issueId } = await seedBase("cancelled");
    const { runId } = await seedQueuedRun(agentId, companyId, issueId);
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.error).toContain("cancelled");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("claimQueuedRun: cancels queued run when issue is done", async () => {
    const { companyId, agentId, issueId } = await seedBase("done");
    const { runId } = await seedQueuedRun(agentId, companyId, issueId);
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.error).toContain("done");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("claimQueuedRun: proceeds normally when issue is in_progress (positive control)", async () => {
    const { companyId, agentId, issueId } = await seedBase("in_progress");
    const { runId } = await seedQueuedRun(agentId, companyId, issueId);
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).not.toBe("queued");
    expect(run?.status).not.toBe("cancelled");
    expect(mockAdapterExecute).toHaveBeenCalled();
  });

  // ---- enqueueWakeup guard ----

  it("enqueueWakeup: inserts skipped wakeup with reason=issue_terminal_status for cancelled issue", async () => {
    const { agentId, issueId } = await seedBase("cancelled");
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(result).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
    expect(skipped.some((w) => w.reason === "issue_terminal_status")).toBe(true);
  });

  it("enqueueWakeup: inserts skipped wakeup with reason=issue_terminal_status for done issue", async () => {
    const { agentId, issueId } = await seedBase("done");
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(result).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
    expect(skipped.some((w) => w.reason === "issue_terminal_status")).toBe(true);
  });

  it("enqueueWakeup: queues a run normally for an in_progress issue (positive control)", async () => {
    const { agentId, issueId } = await seedBase("in_progress");
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(result).toBeTruthy();
    expect(result?.status).toMatch(/^(queued|running|succeeded|failed|cancelled)$/);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.some((w) => w.status !== "skipped")).toBe(true);
  });
});
