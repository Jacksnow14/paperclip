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
  shipRatioSnapshots,
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
    `Skipping embedded Postgres ship-ratio gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-5207: proves the second admission gate both ways -- self_improvement
// work is shed once the latest 7d merged-PR ratio snapshot reports overCap,
// independent of (AND'd with, never averaged with) the AUR-5168 token cap;
// dispatches normally when the ratio is at/above its floor; and fails OPEN
// (dispatches, does not shed) when no snapshot has ever been recorded.
describeEmbeddedPostgres("AUR-5207: ship-ratio admission gate", () => {
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-ship-ratio-gate-");
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
          error: "Cancelled by ship-ratio gate test cleanup",
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
    await db.delete(shipRatioSnapshots);
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

  async function seedShipRatioSnapshot(companyId: string, overCap: boolean) {
    const now = new Date();
    // moneyMakingMerged/selfImprovementMerged chosen to land exactly on the
    // requested overCap side of the 2:1 floor.
    const [moneyMakingMerged, selfImprovementMerged] = overCap ? [1, 40] : [4, 1];
    await db.insert(shipRatioSnapshots).values({
      companyId,
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged,
      selfImprovementMerged,
      moneyMakingClosedWithoutMerge: 0,
      selfImprovementClosedWithoutMerge: 0,
      ratio: moneyMakingMerged / Math.max(selfImprovementMerged, 1),
      floorRatio: 2,
      overCap,
      disagreements: [],
    });
  }

  it("dispatches self_improvement work when the latest ship-ratio snapshot is within the 2:1 floor", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedShipRatioSnapshot(companyId, false);

    const selfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement", assigneeAgentId: agentId });
    const selfImprovementRun = await seedQueuedRun(companyId, agentId, selfImprovementIssueId);

    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(1);
    expect((await heartbeat.getRun(selfImprovementRun))?.status).toBe("running");
  });

  it("sheds non-exempt self_improvement work when the ship-ratio snapshot is over cap, even though the token cap alone is under cap (AND semantics)", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // No cost events recorded at all -- the token-cap gate alone reports
    // NOT over cap (0/0 tokens). This isolates the ship-ratio gate: if it can
    // independently trigger shedding, the two gates are truly AND'd for
    // admission, not merged into one softer signal.
    await seedShipRatioSnapshot(companyId, true);

    const gatedIssueId = await seedIssue(companyId, { workClass: "self_improvement", title: "Refactor fleet tooling", assigneeAgentId: agentId });
    const gatedRun = await seedQueuedRun(companyId, agentId, gatedIssueId);

    const revenueIssueId = await seedIssue(companyId, { workClass: "revenue", title: "Ship product feature", assigneeAgentId: agentId });
    const revenueRun = await seedQueuedRun(companyId, agentId, revenueIssueId);

    // Keyword carve-out: control-plane outage response is never throttled,
    // by either gate.
    const outageIssueId = await seedIssue(companyId, {
      workClass: "self_improvement",
      title: "Control-plane outage: API returning 500s",
      assigneeAgentId: agentId,
    });
    const outageRun = await seedQueuedRun(companyId, agentId, outageIssueId);

    // AUR-5122 subtree carve-out.
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

    expect(admitted).toHaveLength(3);
    expect((await heartbeat.getRun(gatedRun))?.status).toBe("queued");
    expect((await heartbeat.getRun(revenueRun))?.status).toBe("running");
    expect((await heartbeat.getRun(outageRun))?.status).toBe("running");
    expect((await heartbeat.getRun(carveoutRun))?.status).toBe("running");
  });

  it("fails open: dispatches self_improvement work when no ship-ratio snapshot has ever been recorded", async () => {
    const heartbeat = heartbeatService(db, { globalMaxConcurrentRuns: 4 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Deliberately no seedShipRatioSnapshot call -- the routine has never run.

    const selfImprovementIssueId = await seedIssue(companyId, { workClass: "self_improvement", assigneeAgentId: agentId });
    const selfImprovementRun = await seedQueuedRun(companyId, agentId, selfImprovementIssueId);

    hangAdapterUntilReleased();
    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toHaveLength(1);
    expect((await heartbeat.getRun(selfImprovementRun))?.status).toBe("running");
  });
});
