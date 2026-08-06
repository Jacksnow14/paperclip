import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, shipRatioSnapshots } from "@paperclipai/db";
import { SHIP_RATIO_FLOOR, shipRatioGateService } from "./ship-ratio-gate.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("shipRatioGateService", () => {
  let db!: ReturnType<typeof createDb>;
  let gate!: ReturnType<typeof shipRatioGateService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ship-ratio-gate-");
    db = createDb(tempDb.connectionString);
    gate = shipRatioGateService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(shipRatioSnapshots);
    await db.delete(companies);
  });

  afterAll(async () => {
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

  it("returns null when the company has never had a snapshot recorded", async () => {
    const companyId = await seedCompany();
    expect(await gate.getLatestSnapshot(companyId)).toBeNull();
  });

  it("computes overCap=true below the 2:1 floor (the founder's measured 1:40 case)", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const recorded = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 2,
      selfImprovementMerged: 81,
    });
    expect(recorded.ratio).toBeCloseTo(2 / 81, 5);
    expect(recorded.overCap).toBe(true);
    expect(recorded.floorRatio).toBe(SHIP_RATIO_FLOOR);
  });

  it("computes overCap=false at/above the 2:1 floor", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const recorded = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 4,
      selfImprovementMerged: 2,
    });
    expect(recorded.ratio).toBeCloseTo(2, 5);
    expect(recorded.overCap).toBe(false);
  });

  it("floors the self-improvement denominator at 1 so a zero-merge day doesn't divide by zero", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const recorded = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 3,
      selfImprovementMerged: 0,
    });
    expect(Number.isFinite(recorded.ratio)).toBe(true);
    expect(recorded.ratio).toBeCloseTo(3, 5);
    expect(recorded.overCap).toBe(false);
  });

  it("reports closed-without-merge counts without folding them into the ratio", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const recorded = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 2,
      selfImprovementMerged: 1,
      moneyMakingClosedWithoutMerge: 5,
      selfImprovementClosedWithoutMerge: 20,
    });
    // closed-without-merge is reported...
    expect(recorded.moneyMakingClosedWithoutMerge).toBe(5);
    expect(recorded.selfImprovementClosedWithoutMerge).toBe(20);
    // ...but the ratio is unaffected by it either way (2:1 merged only).
    expect(recorded.ratio).toBeCloseTo(2, 5);
    expect(recorded.overCap).toBe(false);
  });

  it("logs repo-vs-workClass disagreements verbatim without resolving them", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const disagreement = {
      prNumber: 42,
      repo: "Jacksnow14/paperclip",
      repoWorkClass: "self_improvement" as const,
      issueIdentifier: "AUR-9001",
      issueWorkClass: "revenue",
    };
    const recorded = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 1,
      selfImprovementMerged: 1,
      disagreements: [disagreement],
    });
    expect(recorded.disagreements).toEqual([disagreement]);
  });

  it("getLatestSnapshot returns the most recently recorded row, not the first", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-08-06T00:00:00.000Z");
    await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      windowEnd: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      moneyMakingMerged: 5,
      selfImprovementMerged: 1,
    });
    // Force createdAt ordering deterministically (defaultNow() alone can tie
    // within the same millisecond on a fast test run).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await gate.recordSnapshot(companyId, {
      windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      windowEnd: now,
      moneyMakingMerged: 1,
      selfImprovementMerged: 10,
    });

    const latest = await gate.getLatestSnapshot(companyId);
    expect(latest?.id).toBe(second.id);
    expect(latest?.overCap).toBe(true);
  });

  it("scopes snapshots per company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    await gate.recordSnapshot(companyA, {
      windowStart: new Date("2026-07-30T00:00:00.000Z"),
      windowEnd: new Date("2026-08-06T00:00:00.000Z"),
      moneyMakingMerged: 1,
      selfImprovementMerged: 50,
    });
    expect(await gate.getLatestSnapshot(companyA)).not.toBeNull();
    expect(await gate.getLatestSnapshot(companyB)).toBeNull();
  });
});
