import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");
const {
  checkGlobalRunAdmission,
  __resetGlobalRunAdmissionMonitorForTest,
} = await import("./global-run-admission-monitor.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping global-run-admission-monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("checkGlobalRunAdmission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-global-run-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    __resetGlobalRunAdmissionMonitorForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
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

  async function seedAgent(companyId: string, status: string = "idle") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status,
      contextSnapshot: {},
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  it("reports current running/queued/scheduled_retry counts and agents-in-error, unsaturated below the cap", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    const agentB = await seedAgent(companyId, "error");
    await seedRun(companyId, agentA, "running");
    await seedRun(companyId, agentA, "queued");
    await seedRun(companyId, agentA, "queued");
    await seedRun(companyId, agentA, "scheduled_retry");

    const snapshot = await checkGlobalRunAdmission(db, { globalCap: 4 });

    expect(snapshot).toMatchObject({
      globalCap: 4,
      running: 1,
      queued: 2,
      scheduledRetry: 1,
      agentsInError: 1,
      saturated: false,
      saturatedForMs: null,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("marks the ceiling saturated once running reaches the cap, but does not warn on a single observation", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    await seedRun(companyId, agentA, "running");
    await seedRun(companyId, agentA, "running");

    const snapshot = await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date("2026-07-29T00:00:00.000Z") });

    expect(snapshot.saturated).toBe(true);
    expect(snapshot.saturatedForMs).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("escalates to warn once saturation has held continuously past the sustained threshold, then dedups", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    await seedRun(companyId, agentA, "running");
    await seedRun(companyId, agentA, "running");

    const t0 = new Date("2026-07-29T00:00:00.000Z");
    await checkGlobalRunAdmission(db, { globalCap: 2, now: t0 });
    expect(logger.warn).not.toHaveBeenCalled();

    // Still under the 5-minute sustained threshold.
    await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 4 * 60 * 1000) });
    expect(logger.warn).not.toHaveBeenCalled();

    // Past the threshold: first warn fires.
    await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 6 * 60 * 1000) });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Still sustained but within the repeat-dedup window: no second warn.
    await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 10 * 60 * 1000) });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Past the repeat window: warns again.
    await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 22 * 60 * 1000) });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("resets the saturation streak once a slot frees below the cap", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId);
    const runA = await seedRun(companyId, agentA, "running");
    await seedRun(companyId, agentA, "running");

    const t0 = new Date("2026-07-29T00:00:00.000Z");
    await checkGlobalRunAdmission(db, { globalCap: 2, now: t0 });
    await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 6 * 60 * 1000) });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runA));
    const recovered = await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 7 * 60 * 1000) });
    expect(recovered.saturated).toBe(false);
    expect(recovered.saturatedForMs).toBeNull();

    // Saturate again — the streak must restart from zero, not resume the old one.
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runA));
    const resaturated = await checkGlobalRunAdmission(db, { globalCap: 2, now: new Date(t0.getTime() + 8 * 60 * 1000) });
    expect(resaturated.saturated).toBe(true);
    expect(resaturated.saturatedForMs).toBe(0);
  });
});
