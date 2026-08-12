// AUR-5464: proves the lane circuit breaker is load-bearing at the REAL
// admission gate (claimQueuedRun via resumeQueuedRuns), not just in the unit
// tests. FIRE: a lane the classifier proves dead leaves queued runs QUEUED
// (not cancelled, not claimed). PASS: a healthy lane admits normally. And the
// manual re-arm admits exactly ONE half-open probe, not the fleet.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
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

import { heartbeatService } from "../services/heartbeat.ts";
import { laneBreakerForDb } from "../services/lane-breaker.ts";

const ORG_BLOCK_0806 =
  "Claude run failed: subtype=success: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lane-breaker admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("lane breaker gates claimQueuedRun (AUR-5464)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-lane-breaker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
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

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Coder-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedTerminalRun(
    companyId: string,
    agentId: string,
    opts: { status: "failed" | "succeeded"; at: Date; error?: string },
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: opts.status,
      error: opts.error ?? null,
      contextSnapshot: {},
      startedAt: opts.at,
      finishedAt: opts.at,
      createdAt: opts.at,
      updatedAt: opts.at,
    });
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

  async function runStatus(runId: string) {
    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row?.status ?? null;
  }

  it("FIRE: an entitlement-revoked lane leaves the queued run QUEUED — not claimed, not cancelled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Two org-block failures after an old success: classifier -> entitlement_revoked.
    await seedTerminalRun(companyId, agentId, { status: "succeeded", at: new Date(Date.now() - 3_600_000) });
    await seedTerminalRun(companyId, agentId, {
      status: "failed",
      at: new Date(Date.now() - 120_000),
      error: ORG_BLOCK_0806,
    });
    await seedTerminalRun(companyId, agentId, {
      status: "failed",
      at: new Date(Date.now() - 60_000),
      error: ORG_BLOCK_0806,
    });
    const runId = await seedQueuedRun(companyId, agentId);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns({ companyId });

    expect(await runStatus(runId)).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("PASS: a healthy lane admits the queued run normally", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedTerminalRun(companyId, agentId, { status: "succeeded", at: new Date(Date.now() - 60_000) });
    const runId = await seedQueuedRun(companyId, agentId);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns({ companyId });

    expect(await runStatus(runId)).not.toBe("queued");
  });

  it("manual re-arm admits exactly ONE half-open probe, and a probe SUCCESS re-opens the lane", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedTerminalRun(companyId, agentId, {
      status: "failed",
      at: new Date(Date.now() - 60_000),
      error: ORG_BLOCK_0806,
    });
    const runA = await seedQueuedRun(companyId, agentId);
    const runB = await seedQueuedRun(companyId, agentId);

    const heartbeat = heartbeatService(db);
    // Tripped: neither run admitted.
    await heartbeat.resumeQueuedRuns({ companyId });
    expect(await runStatus(runA)).toBe("queued");
    expect(await runStatus(runB)).toBe("queued");

    // Operator re-arm: the next pass admits exactly one run as the probe.
    laneBreakerForDb(db).manualRearm(companyId, "claude_local", {
      actorType: "user",
      actorId: "operator",
    });
    await heartbeat.resumeQueuedRuns({ companyId });
    const statuses = [await runStatus(runA), await runStatus(runB)];
    expect(statuses.filter((s) => s === "queued")).toHaveLength(1);

    // The probe (mock adapter) succeeds; wait for it to land as a succeeded
    // run, which is the classifier's proof of recovery.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [{ status }] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, statuses[0] === "queued" ? runB : runA));
      if (status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // The breaker's snapshot cache (20s TTL) hides the fresh success from the
    // derivation briefly; the admission-facing assertion that matters here is
    // the decision itself, so bypass the cache by asking a fresh breaker.
    const { LaneBreaker } = await import("../services/lane-breaker.ts");
    const fresh = new LaneBreaker({ db });
    const decision = await fresh.evaluateAdmission(companyId, { id: agentId, adapterType: "claude_local" });
    expect(decision.admit).toBe(true);
    expect(decision.state).toBe("closed");
  });
});
