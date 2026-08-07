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
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const adapterSuccessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Completed heartbeat work.",
  provider: "test",
  model: "test-model",
};
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Completed heartbeat work.",
  provider: "test",
  model: "test-model",
})));

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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres work-class budget gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-5168 AC3: proves the heartbeat admission gate both ways -- self_improvement
// work dispatches while the trailing-7d share sits under the 10% cap, and is
// skipped (left queued, not failed) once it doesn't, except for the founder's
// named hard carve-outs.
describeEmbeddedPostgres("AUR-5168 AC3: work-class budget admission gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adapterReleases: Array<() => void> = [];

  function hangAdapterUntilReleased() {
    mockAdapterExecute.mockImplementation(
      () =>
        new Promise((resolve) => {
          adapterReleases.push(() => resolve(adapterSuccessResult));
        }),
    );
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-work-class-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const release of adapterReleases) release();
    adapterReleases = [];
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => adapterSuccessResult);
    runningProcesses.clear();

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
          error: "Cancelled by work-class budget gate test cleanup",
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(costEvents);
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
      await db.delete(documents);
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

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Coder-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 10 } },
      permissions: {},
    });
    return agentId;
  }

  let issueSeedCounter = 0;
  async function seedIssue(
    companyId: string,
    opts: {
      workClass: "revenue" | "self_improvement" | null;
      title?: string;
      description?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
    },
  ) {
    issueSeedCounter += 1;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: opts.title ?? `Test issue ${issueSeedCounter}`,
      description: opts.description ?? null,
      status: "in_progress",
      priority: "medium",
      issueNumber: issueSeedCounter,
      identifier: `T${issueSeedCounter}`,
      workClass: opts.workClass,
      parentId: opts.parentId ?? null,
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
    return issueId;
  }

  async function seedQueuedRun(companyId: string, agentId: string, issueId: string) {
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
      contextSnapshot: { issueId },
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  async function seedCostEvent(companyId: string, agentId: string, issueId: string, outputTokens: number) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "sonnet-5",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens,
      costCents: 10,
      occurredAt: new Date(),
    });
  }

  it("dispatches self_improvement work when the trailing-7d share is under the 10% cap", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const revenueIssueId = await seedIssue(companyId, { workClass: "revenue" });
    await seedCostEvent(companyId, agentId, revenueIssueId, 970);

    const selfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement", assigneeAgentId: agentId });
    await seedCostEvent(companyId, agentId, selfImprovementIssueId, 30);
    const selfImprovementRun = await seedQueuedRun(companyId, agentId, selfImprovementIssueId);

    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(1);
    expect((await heartbeat.getRun(selfImprovementRun))?.status).toBe("running");
  });

  it("skips non-exempt self_improvement work once the 7d share hits the 10% cap, while revenue and carve-out work still dispatch", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // 90% self-improvement share -- well over the 10% cap.
    const priorRevenueIssueId = await seedIssue(companyId, { workClass: "revenue" });
    await seedCostEvent(companyId, agentId, priorRevenueIssueId, 100);
    const priorSelfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement" });
    await seedCostEvent(companyId, agentId, priorSelfImprovementIssueId, 900);

    // Non-exempt self_improvement work must be shed (left queued).
    const gatedIssueId = await seedIssue(companyId, { workClass: "self_improvement", title: "Refactor fleet tooling", assigneeAgentId: agentId });
    const gatedRun = await seedQueuedRun(companyId, agentId, gatedIssueId);

    // Ordinary revenue work is untouched by the cap.
    const revenueIssueId = await seedIssue(companyId, { workClass: "revenue", title: "Ship product feature", assigneeAgentId: agentId });
    const revenueRun = await seedQueuedRun(companyId, agentId, revenueIssueId);

    // Keyword carve-out: control-plane outage response is never throttled.
    const outageIssueId = await seedIssue(companyId, {
      workClass: "self_improvement",
      title: "Control-plane outage: API returning 500s",
      assigneeAgentId: agentId,
    });
    const outageRun = await seedQueuedRun(companyId, agentId, outageIssueId);

    // AUR-5122 subtree carve-out: fixing the fleet's own ability to earn.
    const carveoutRootId = await seedIssue(companyId, { workClass: "self_improvement", title: "Budget enforcement root" });
    await db.update(issues).set({ identifier: "AUR-5122" }).where(eq(issues.id, carveoutRootId));
    const carveoutChildId = await seedIssue(companyId, {
      workClass: "self_improvement",
      title: "Wire up the cap",
      parentId: carveoutRootId,
      assigneeAgentId: agentId,
    });
    const carveoutRun = await seedQueuedRun(companyId, agentId, carveoutChildId);

    hangAdapterUntilReleased();
    const admitted = await heartbeat.startNextQueuedRunForAgent(agentId);

    // Three of the four queued runs are admissible; the gated one is shed.
    expect(admitted).toHaveLength(3);
    expect((await heartbeat.getRun(gatedRun))?.status).toBe("queued");
    expect((await heartbeat.getRun(revenueRun))?.status).toBe("running");
    expect((await heartbeat.getRun(outageRun))?.status).toBe("running");
    expect((await heartbeat.getRun(carveoutRun))?.status).toBe("running");
  });

  // Regression for review blocker 1: matching title+description exempted 6 of 7
  // currently-open self_improvement issues wrongly, because agent-written
  // descriptions routinely mention carve-out words without being that kind of
  // work. The carve-out must only fire on the title.
  it("does not exempt a self_improvement issue whose description (not title) mentions carve-out words, when over cap", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // 90% self-improvement share -- well over the 10% cap.
    const priorRevenueIssueId = await seedIssue(companyId, { workClass: "revenue" });
    await seedCostEvent(companyId, agentId, priorRevenueIssueId, 100);
    const priorSelfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement" });
    await seedCostEvent(companyId, agentId, priorSelfImprovementIssueId, 900);

    const gatedIssueId = await seedIssue(companyId, {
      workClass: "self_improvement",
      title: "Refactor fleet tooling",
      description: "This touches security and disk exhaustion topics only in passing, not as the actual work.",
      assigneeAgentId: agentId,
    });
    const gatedRun = await seedQueuedRun(companyId, agentId, gatedIssueId);

    hangAdapterUntilReleased();
    const admitted = await heartbeat.startNextQueuedRunForAgent(agentId);

    expect(admitted).toHaveLength(0);
    expect((await heartbeat.getRun(gatedRun))?.status).toBe("queued");
  });

  // Regression for review blocker 2: computeBudget() falls back to
  // deriveWorkClass() for a null issues.workClass, but the admission gate was
  // reading the raw column -- a self_improvement issue with a null workClass
  // (i.e. every issue pre-backfill) inflated the share while staying immune to
  // the cap it caused. The gate must derive workClass the same way the meter does.
  it("gates a self_improvement issue with a null workClass the same as one with an explicit column value", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // 90% self-improvement share -- well over the 10% cap.
    const priorRevenueIssueId = await seedIssue(companyId, { workClass: "revenue" });
    await seedCostEvent(companyId, agentId, priorRevenueIssueId, 100);
    const priorSelfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement" });
    await seedCostEvent(companyId, agentId, priorSelfImprovementIssueId, 900);

    // workClass column is null; only the explicit exec.work_class: token in
    // the description resolves it to self_improvement via deriveWorkClass().
    const gatedIssueId = await seedIssue(companyId, {
      workClass: null,
      title: "Improve internal tooling",
      description: "exec.work_class: self_improvement",
      assigneeAgentId: agentId,
    });
    const gatedRun = await seedQueuedRun(companyId, agentId, gatedIssueId);

    hangAdapterUntilReleased();
    const admitted = await heartbeat.startNextQueuedRunForAgent(agentId);

    expect(admitted).toHaveLength(0);
    expect((await heartbeat.getRun(gatedRun))?.status).toBe("queued");
  });
});
