import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { backgroundJobRuns, backgroundJobs, companies, createDb } from "@paperclipai/db";
import { memoryService } from "../services/memory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping memory synthesis tick tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("memoryService.tickSynthesisSchedules", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-tick-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(backgroundJobRuns);
    await db.delete(backgroundJobs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithBinding(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tick Test ${prefix}`,
      issuePrefix: `${prefix}${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = memoryService(db);
    const binding = await service.createBinding(companyId, {
      key: `tick-${prefix.toLowerCase()}`,
      name: `Tick ${prefix}`,
      providerKey: "local_basic",
      config: {},
      enabled: true,
    });
    return { companyId, bindingId: binding.id, service };
  }

  async function insertSynthesisRun(input: {
    companyId: string;
    status: "queued" | "running" | "succeeded" | "failed";
    finishedAt: Date | null;
  }) {
    await db.insert(backgroundJobRuns).values({
      companyId: input.companyId,
      jobKey: "memory.synthesis",
      jobType: "memory_synthesis",
      trigger: "manual",
      status: input.status,
      requestedByActorType: "system",
      requestedByActorId: "test",
      startedAt: input.finishedAt ? new Date(input.finishedAt.getTime() - 60_000) : null,
      finishedAt: input.finishedAt,
    });
  }

  it("triggers a schedule run when no prior synthesis run exists", async () => {
    const { service } = await seedCompanyWithBinding("A");
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const result = await service.tickSynthesisSchedules(new Date("2026-05-17T12:00:00.000Z"));

    expect(result).toEqual({
      scanned: 1,
      triggered: 1,
      skippedFresh: 0,
      skippedBusy: 0,
      errors: 0,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ trigger: "schedule" }),
      expect.objectContaining({ actorType: "system" }),
    );
  });

  it("triggers when the latest succeeded run is older than 7 days", async () => {
    const { companyId, service } = await seedCompanyWithBinding("B");
    const now = new Date("2026-05-17T12:00:00.000Z");
    await insertSynthesisRun({
      companyId,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 10 * DAY_MS),
    });
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const result = await service.tickSynthesisSchedules(now);

    expect(result.triggered).toBe(1);
    expect(result.skippedFresh).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips when the latest succeeded run is within the 7-day window", async () => {
    const { companyId, service } = await seedCompanyWithBinding("C");
    const now = new Date("2026-05-17T12:00:00.000Z");
    await insertSynthesisRun({
      companyId,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 3 * DAY_MS),
    });
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const result = await service.tickSynthesisSchedules(now);

    expect(result).toEqual({
      scanned: 1,
      triggered: 0,
      skippedFresh: 1,
      skippedBusy: 0,
      errors: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips when a synthesis run is already queued or running", async () => {
    const { companyId, service } = await seedCompanyWithBinding("D");
    const now = new Date("2026-05-17T12:00:00.000Z");
    // Even with a stale prior succeeded run, an in-flight run blocks a new tick fire.
    await insertSynthesisRun({
      companyId,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 30 * DAY_MS),
    });
    await insertSynthesisRun({
      companyId,
      status: "running",
      finishedAt: null,
    });
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const result = await service.tickSynthesisSchedules(now);

    expect(result.triggered).toBe(0);
    expect(result.skippedBusy).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores disabled bindings", async () => {
    const { service, bindingId } = await seedCompanyWithBinding("E");
    await service.updateBinding(bindingId, { enabled: false });
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const result = await service.tickSynthesisSchedules(new Date("2026-05-17T12:00:00.000Z"));

    expect(result.scanned).toBe(0);
    expect(result.triggered).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("respects a custom maxAgeDays override", async () => {
    const { companyId, service } = await seedCompanyWithBinding("F");
    const now = new Date("2026-05-17T12:00:00.000Z");
    // 2 days old — fresh against the default 7d window, but stale against a 1d window.
    await insertSynthesisRun({
      companyId,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 2 * DAY_MS),
    });
    const spy = vi.spyOn(service, "startSynthesisJob").mockResolvedValue({} as never);

    const fresh = await service.tickSynthesisSchedules(now);
    expect(fresh.triggered).toBe(0);
    expect(fresh.skippedFresh).toBe(1);

    const stale = await service.tickSynthesisSchedules(now, { maxAgeDays: 1 });
    expect(stale.triggered).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("continues scanning when a single binding fails", async () => {
    const a = await seedCompanyWithBinding("G");
    const b = await seedCompanyWithBinding("H");
    // Both bindings need a fire; we use the same service instance (b.service)
    // so spy overrides apply consistently across the loop.
    const service = b.service;
    let calls = 0;
    const spy = vi.spyOn(service, "startSynthesisJob").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("simulated provider failure");
      }
      return {} as never;
    });

    const result = await service.tickSynthesisSchedules(new Date("2026-05-17T12:00:00.000Z"));

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.triggered).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    // Sanity: the two test companies are different.
    expect(a.companyId).not.toBe(b.companyId);
  });
});
