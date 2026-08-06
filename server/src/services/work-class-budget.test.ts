import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies, costEvents, issues } from "@paperclipai/db";
import {
  BUDGET_CARVEOUT_ROOT_IDENTIFIER,
  matchesBudgetCarveoutKeywords,
  workClassBudgetService,
} from "./work-class-budget.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

describe("matchesBudgetCarveoutKeywords", () => {
  it("matches each of the four named carve-out categories", () => {
    expect(matchesBudgetCarveoutKeywords("Trunk is red on main", null)).toBe(true);
    expect(matchesBudgetCarveoutKeywords("Exposed credential in logs", null)).toBe(true);
    expect(matchesBudgetCarveoutKeywords("Host disk exhaustion alert", null)).toBe(true);
    expect(matchesBudgetCarveoutKeywords("Control-plane outage", null)).toBe(true);
  });

  it("does not match ordinary feature work", () => {
    expect(matchesBudgetCarveoutKeywords("Add dark mode toggle", "Ship the new settings UI")).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workClassBudgetService", () => {
  let db!: ReturnType<typeof createDb>;
  let budget!: ReturnType<typeof workClassBudgetService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-class-budget-");
    db = createDb(tempDb.connectionString);
    budget = workClassBudgetService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("computes the self-improvement share from workClass-tagged issues, under cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const revenueIssueId = randomUUID();
    const selfImprovementIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: revenueIssueId,
        companyId,
        title: "Ship product feature",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
        workClass: "revenue",
      },
      {
        id: selfImprovementIssueId,
        companyId,
        title: "Refactor fleet tooling",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
        workClass: "self_improvement",
      },
    ]);

    const now = new Date("2026-08-06T00:00:00.000Z");
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: revenueIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 900,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 60_000),
      },
      {
        companyId,
        agentId,
        issueId: selfImprovementIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 120_000),
      },
    ]);

    const result = await budget.computeBudget(companyId, now);
    expect(result.revenueTokens).toBe(900);
    expect(result.selfImprovementTokens).toBe(100);
    expect(result.selfImprovementShare).toBeCloseTo(0.1, 5);
    expect(result.capShare).toBe(0.1);
    // Exactly at the 10% boundary counts as over cap (AC3 gates on >=).
    expect(result.overCap).toBe(true);
  });

  it("is under cap when self-improvement share is below 10%", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const revenueIssueId = randomUUID();
    const selfImprovementIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: revenueIssueId,
        companyId,
        title: "Ship product feature",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
        workClass: "revenue",
      },
      {
        id: selfImprovementIssueId,
        companyId,
        title: "Refactor fleet tooling",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
        workClass: "self_improvement",
      },
    ]);

    const now = new Date("2026-08-06T00:00:00.000Z");
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: revenueIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 950,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 60_000),
      },
      {
        companyId,
        agentId,
        issueId: selfImprovementIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 120_000),
      },
    ]);

    const result = await budget.computeBudget(companyId, now);
    expect(result.selfImprovementShare).toBeCloseTo(0.05, 5);
    expect(result.overCap).toBe(false);
  });

  it("re-derives workClass at read time for issues never backfilled (null column)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const undbackfilledSelfImprovementIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: undbackfilledSelfImprovementIssueId,
        companyId,
        title: "Old closed paperclip fix",
        description: "exec.work_class: self_improvement",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
        workClass: null,
      },
    ]);

    const now = new Date("2026-08-06T00:00:00.000Z");
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: undbackfilledSelfImprovementIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 300,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 60_000),
      },
    ]);

    const result = await budget.computeBudget(companyId, now);
    expect(result.selfImprovementTokens).toBe(300);
    expect(result.revenueTokens).toBe(0);
  });

  it("excludes cost events older than the 7-day window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const staleIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: staleIssueId,
        companyId,
        title: "Ancient self-improvement work",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
        workClass: "self_improvement",
      },
    ]);

    const now = new Date("2026-08-06T00:00:00.000Z");
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: staleIssueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "sonnet-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 500,
        costCents: 10,
        occurredAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await budget.computeBudget(companyId, now);
    expect(result.revenueTokens).toBe(0);
    expect(result.selfImprovementTokens).toBe(0);
  });

  it("walks the parent chain to find the AUR-5122 carve-out root", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const unrelatedId = randomUUID();

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Budget enforcement root",
        status: "in_progress",
        priority: "critical",
        issueNumber: 1,
        identifier: BUDGET_CARVEOUT_ROOT_IDENTIFIER,
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child of root",
        status: "in_progress",
        priority: "critical",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Grandchild of root",
        status: "in_progress",
        priority: "critical",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: unrelatedId,
        companyId,
        title: "Unrelated self-improvement issue",
        status: "in_progress",
        priority: "critical",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);

    expect(await budget.isUnderBudgetCarveoutRoot(grandchildId)).toBe(true);
    expect(await budget.isUnderBudgetCarveoutRoot(childId)).toBe(true);
    expect(await budget.isUnderBudgetCarveoutRoot(rootId)).toBe(true);
    expect(await budget.isUnderBudgetCarveoutRoot(unrelatedId)).toBe(false);
  });
});
