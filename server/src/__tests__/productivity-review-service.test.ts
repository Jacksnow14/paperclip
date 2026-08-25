import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  PROCESS_LOST_ERROR_CODE,
  NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES,
  SCHEDULER_LIFECYCLE_NON_ATTRIBUTABLE_ERROR_CODES,
  DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES,
  productivityReviewService,
} from "../services/productivity-review.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    parentId?: string | null;
    originKind?: string;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date("2026-04-28T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Productivity Review Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: opts?.startedAt ?? createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  // AUR-5008: real work has real usage. Runs that don't explicitly override usageJson default
  // to this non-zero shape so they represent genuine billable work and are exempt from both the
  // never-started backstop (isNeverStartedRun) and the zero-cost-contradiction filing
  // suppression -- both gate on hasZeroUsage(), which a real token count never satisfies. Tests
  // that need to exercise those zero-usage paths pass an explicit usageJson (e.g. ZERO_USAGE).
  const DEFAULT_ATTRIBUTABLE_USAGE = { inputTokens: 4200, outputTokens: 950, costUsd: 0.18 };

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
    startIndex?: number;
    status?: string;
    errorCode?: string | null;
    error?: string | null;
    usageJson?: Record<string, unknown> | null;
    logBytes?: number | null;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    const startIndex = input.startIndex ?? 0;
    for (let offset = 0; offset < input.count; offset += 1) {
      const index = startIndex + offset;
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: input.status ?? "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
        livenessState: input.status && input.status !== "succeeded" ? "failed" : "advanced",
        errorCode: input.errorCode ?? null,
        error: input.error ?? null,
        usageJson: input.usageJson ?? DEFAULT_ATTRIBUTABLE_USAGE,
        logBytes: input.logBytes ?? null,
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    if (input.withRunComments) {
      await db.insert(issueComments).values(
        runs.map((run, index) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          authorAgentId: input.agentId,
          createdByRunId: run.id,
          body: `Progress update ${index}`,
          createdAt: run.createdAt as Date,
          updatedAt: run.createdAt as Date,
        })),
      );
    }

    return runs;
  }

  async function insertProcessLostRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    startIndex?: number;
  }) {
    return insertRuns({
      ...input,
      status: "failed",
      errorCode: PROCESS_LOST_ERROR_CODE,
      error: "Process lost -- server may have restarted",
    });
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listRefreshComments(reviewIssueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, reviewIssueId),
        sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
      ))
      .orderBy(issueComments.createdAt);
  }

  it("creates exactly one manager-assigned review for a no-comment run streak and rate-limits immediate refresh", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(first.created).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.existing).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.parentId).toBe(seeded.issueId);
    expect(reviews[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(reviews[0]?.assigneeAdapterOverrides).toEqual({});
    expect(reviews[0]?.originId).toBe(seeded.issueId);
    expect(reviews[0]?.originFingerprint).toBe(`productivity-review:${seeded.issueId}`);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");

    expect(await listRefreshComments(reviews[0]!.id)).toHaveLength(0);
  });

  it("refreshes open productivity reviews only once per interval and caps refresh comments", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const firstRefreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
    const firstRefresh = await service.reconcileProductivityReviews({
      now: firstRefreshAt,
      companyId: seeded.companyId,
    });
    const tooSoonRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 2 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    const cappedRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 3 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });

    expect(firstRefresh.updated).toBe(1);
    expect(tooSoonRefresh.updated).toBe(0);
    expect(tooSoonRefresh.existing).toBe(1);
    expect(cappedRefresh.updated).toBe(0);
    expect(cappedRefresh.existing).toBe(1);
    expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);
  });

  it("caps productivity review creation per source issue in the rolling creation window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Completed productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.creationCapped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("does not count cancelled productivity reviews toward the creation cap", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Cancelled productivity review ${index + 1}`,
          status: "cancelled",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.creationCapped).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("creates a long-active review with non-zero recent activity, without enabling a continuation hold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    // One run in the last hour keeps the activity-rate axis non-zero, so this stays a
    // long_active_duration review rather than being reclassified as a stall (AUR-4014).
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now,
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.description).toContain("Activity rate in the last hour: non-zero");
    expect(review?.priority).toBe("medium");
    expect(hold.held).toBe(false);
  });

  // AUR-4014: long_active_duration fired on wall-clock episode age alone, so a genuinely dark
  // issue (zero runs, zero assignee comments, zero active runs in the last hour) got the same
  // churn-shaped "snooze / decompose / the work is inefficient" remedy menu as an issue that was
  // still actively (if slowly) working. Regression tests for all four cells of the
  // rate x episode-age table from the issue.
  describe("AUR-4014 stall vs churn discrimination", () => {
    it("fires stalled_active_episode (not long_active_duration) when episode age is long and recent activity is zero", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      });
      const service = productivityReviewService(db);

      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const hold = await service.isProductivityReviewContinuationHoldActive({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        agentId: seeded.coderId,
        now,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `stalled_active_episode`");
      expect(review?.description).toContain("stalled active episode");
      expect(review?.description).toContain("Activity rate in the last hour: zero");
      expect(review?.description).toContain("Wake the assignee agent to resume work");
      expect(review?.description).not.toContain("Continue with a snooze window");
      expect(review?.priority).toBe("high");
      // Not a soft-stop: nothing is running to hold, and the remedy is to wake the assignee.
      expect(hold.held).toBe(false);
    });

    it("fires nothing when episode age is short and recent activity is zero (between heartbeats)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 30 * 60 * 1000),
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
    });

    it("fires high_churn (not stalled_active_episode) when episode age is long and recent activity is high", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 10,
        now,
        withRunComments: true,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `high_churn`");
    });

    it("fires nothing when episode age is short and recent activity is high but below the churn threshold", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 30 * 60 * 1000),
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 3,
        now,
        withRunComments: true,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
    });

    it("fires stalled_active_episode, not high_churn, when the 6h window is stale but the last hour is dark", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      });
      // 30 runs land 65-94 minutes ago: inside the 6h churn window (so runCountLastSixHours alone
      // would clear the high-churn threshold) but outside the 1h window entirely, so the last hour
      // is completely dark. Before the AUR-4014 precedence fix, choosePrimaryTrigger checked
      // highChurn before stalled, so this stale 6h burst would mislabel a currently-dark issue as
      // churn -- the exact failure this trigger exists to prevent, just via the 6h path.
      // withRunComments avoids also tripping no_comment_streak (which outranks stalled and would
      // otherwise mask the precedence bug this test targets).
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 30,
        now,
        startIndex: 65,
        withRunComments: true,
      });
      const service = productivityReviewService(db);

      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `stalled_active_episode`");
      expect(review?.description).toContain("Activity rate in the last hour: zero");
      expect(review?.description).toContain("Wake the assignee agent to resume work");
      expect(review?.description).not.toContain("Continue with a snooze window");
      // The stale 6h churn stats must not appear as a "reason" alongside a stall-shaped review --
      // that would contradict the "this is a dark issue, not churn" text above it.
      expect(review?.description).not.toContain("assignee-run comments in 1h; 30 runs");
    });

    it("does not label the evidence block as the stall axis when a non-stall trigger wins precedence", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      // The whole no-comment streak lands 65-74 minutes ago, so the last hour is completely dark
      // (zeroRecentActivity === true) while `no_comment_streak` still wins precedence and carries
      // the generic (churn-shaped) manager menu.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        startIndex: 65,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      // The zero-rate measurement itself is still reported -- it is evidence either way ...
      expect(review?.description).toContain("Activity rate in the last hour: zero");
      // ... but the editorial "this is the stall axis" claim is gated on the resolved trigger,
      // exactly like triggerReasons: asserting a stall axis directly above a churn-shaped remedy
      // menu hands the manager the same mixed axis signal AUR-4014 exists to remove.
      expect(review?.description).not.toContain("this is a stall axis");
      expect(review?.description).toContain("Continue with a snooze window");
    });
  });

  describe("AUR-4111 assignee_unavailable trigger", () => {
    it("does not fire assignee_unavailable for an errored agent with a recent successful run", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, seeded.coderId));
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "succeeded",
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("Assignee availability: available");
    });

    it("fires assignee_unavailable for an errored agent whose latest failed run is older than the threshold with no active run", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, seeded.coderId));
      const staleNow = new Date(now.getTime() - 40 * 60 * 1000);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: staleNow,
        status: "failed",
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `assignee_unavailable`");
      expect(review?.description).toContain("Assignee availability: unavailable (error)");
      expect(review?.description).toContain("Reassign to a live agent who can pick up the work.");
    });

    it("does not fire assignee_unavailable for an errored agent whose latest failed run is under the threshold", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, seeded.coderId));
      const recentNow = new Date(now.getTime() - 90 * 1000);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: recentNow,
        status: "failed",
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("Assignee availability: available");
    });

    it("does not fire assignee_unavailable for a paused agent under the threshold, but fires once the threshold is exceeded", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");

      const seededUnder = await seedAssignedIssue();
      await db
        .update(agents)
        .set({ status: "paused", pausedAt: new Date(now.getTime() - 10 * 60 * 1000) })
        .where(eq(agents.id, seededUnder.coderId));
      await insertRuns({
        companyId: seededUnder.companyId,
        agentId: seededUnder.coderId,
        issueId: seededUnder.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
      const underResult = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seededUnder.companyId,
      });
      expect(underResult.created).toBe(1);
      const [underReview] = await listProductivityReviews(seededUnder.companyId);
      expect(underReview?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(underReview?.description).toContain("Assignee availability: available");

      const seededOver = await seedAssignedIssue();
      await db
        .update(agents)
        .set({ status: "paused", pausedAt: new Date(now.getTime() - 40 * 60 * 1000) })
        .where(eq(agents.id, seededOver.coderId));
      await insertRuns({
        companyId: seededOver.companyId,
        agentId: seededOver.coderId,
        issueId: seededOver.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
      const overResult = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seededOver.companyId,
      });
      expect(overResult.created).toBe(1);
      const [overReview] = await listProductivityReviews(seededOver.companyId);
      expect(overReview?.description).toContain("Primary trigger: `assignee_unavailable`");
      expect(overReview?.description).toContain("Assignee availability: unavailable (paused)");
    });

    it("fires assignee_unavailable immediately for a terminated agent, with no duration test", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.coderId));
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `assignee_unavailable`");
      expect(review?.description).toContain("Assignee availability: unavailable (terminated)");
    });

    it("wins precedence over simultaneously true high_churn and no_comment_streak, on the rendered markdown", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.coderId));
      // 12 recent, uncommented runs genuinely clear both the no-comment streak threshold (10)
      // and the high-churn hourly threshold (10) at once -- both axes are really true, not just
      // asserted via the trigger enum, so a churn-shaped menu surviving here would be caught.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 12,
        now,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `assignee_unavailable`");
      expect(review?.description).toContain("Assignee availability: unavailable (terminated)");
      expect(review?.description).toContain("Reassign to a live agent who can pick up the work.");
      expect(review?.description).toContain(
        "Escalate to the assignee's manager (`reportsTo`) if no other agent is available.",
      );
      // The churn/no-comment-shaped menu and reasoning must not appear next to an
      // unavailable-owner verdict -- see the AUR-4014 lesson this precedence rule generalizes.
      expect(review?.description).not.toContain("Continue with a snooze window");
      expect(review?.description).not.toContain("Request decomposition");
    });

    it("excludes an unavailable-errored candidate from review ownership, falling back to the next candidate", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      const ceoId = randomUUID();
      await db.insert(agents).values({
        id: ceoId,
        companyId: seeded.companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, seeded.managerId));
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.managerId,
        issueId: seeded.issueId,
        count: 1,
        now: new Date(now.getTime() - 40 * 60 * 1000),
        status: "failed",
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.assigneeAgentId).toBe(ceoId);
    });

    it("keeps a stale-error candidate selectable for review ownership once it has run successfully since", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await db.update(agents).set({ status: "error" }).where(eq(agents.id, seeded.managerId));
      // The sticky `error` status is stale: the manager's most recent terminal run succeeded,
      // so resolveErrorUnavailability (and isAgentInvokable, which reuses it) must trust the run
      // history over the stale status field and keep the manager selectable.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.managerId,
        issueId: seeded.issueId,
        count: 1,
        now,
        status: "succeeded",
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });
  });

  // AUR-4520: findActiveAdapterQuotaPause's admission clamp (MAX_ADAPTER_QUOTA_PAUSE_MS = 6h)
  // must not leak into the stall explainer above -- a genuine 24h provider wall has to keep
  // suppressing `stalled` past t+6h, even though admission is correctly re-probing the wall by
  // then via the separate, still-clamped findActiveAdapterQuotaPause query.
  describe("AUR-4520 quota-pause horizon in the stall explainer", () => {
    it("does not fire stalled_active_episode past the 6h admission clamp while a genuine 24h provider wall is still up", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const pauseRecordedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: pauseRecordedAt,
      });
      // A real 24h provider reset, recorded 7h ago -- past the 6h admission clamp (so admission
      // is correctly re-probing the wall by `now`) but the provider's own reset is still 17h out.
      const trueProviderResetAt = new Date(pauseRecordedAt.getTime() + 24 * 60 * 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        scheduledRetryAt: trueProviderResetAt,
        scheduledRetryReason: "transient_failure",
        contextSnapshot: { transientRetryNotBefore: trueProviderResetAt.toISOString() },
        createdAt: pauseRecordedAt,
        updatedAt: pauseRecordedAt,
      });

      const service = productivityReviewService(db);
      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      // Before the AUR-4520 fix, the stall explainer reused the admission-clamped query, which
      // stops matching this row at pauseRecordedAt + 6h -- well before `now`. That made
      // `activeQuotaPause` null, `longActive` true, and `stalled_active_episode` fire against an
      // agent correctly waiting on a provider wall it cannot influence.
      expect(result.created).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
    });

    it("still fires stalled_active_episode once the provider's own reset has actually passed", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const pauseRecordedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: pauseRecordedAt,
      });
      // The provider reset itself is now in the past -- the wall genuinely cleared, so the stall
      // explainer must not keep suppressing findings off a row with a lapsed real reset.
      const lapsedProviderResetAt = new Date(now.getTime() - 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        scheduledRetryAt: lapsedProviderResetAt,
        scheduledRetryReason: "transient_failure",
        contextSnapshot: { transientRetryNotBefore: lapsedProviderResetAt.toISOString() },
        createdAt: pauseRecordedAt,
        updatedAt: pauseRecordedAt,
      });

      const service = productivityReviewService(db);
      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `stalled_active_episode`");
    });
  });

  it("creates a high-churn review even when every sampled run has a progress comment", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).toContain("Runs in rolling windows: 10/1h");
  });

  it("ignores non-assignee comments when evaluating high-churn productivity reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 9,
      now,
    });
    const managerRuns = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    await db.insert(issueComments).values(
      managerRuns.map((run, index) => ({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.managerId,
        createdByRunId: run.id,
        body: `Manager note ${index}`,
        createdAt: run.createdAt as Date,
        updatedAt: run.createdAt as Date,
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("skips productivity-review descendants so reviews cannot recursively spawn reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const reviewId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Existing productivity review",
      status: "todo",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId: seeded.companyId,
      title: "Review follow-up child",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.coderId,
      parentId: reviewId,
      issueNumber: 3,
      identifier: `${seeded.issuePrefix}-3`,
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: childId,
      count: 10,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently completed review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(reviews).toHaveLength(1);
  });

  it("reports and logs soft-stop holds for open no-comment reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const [latestRun] = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(hold.held).toBe(true);
    if (!hold.held) return;

    await service.recordContinuationHold({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: latestRun!.id as string,
      agentId: seeded.coderId,
      reviewIssueId: review!.id,
      trigger: hold.trigger,
      reason: hold.reason,
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_continuation_held"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
  });

  it("clamps poisoned requestDepth metadata instead of aborting productivity reconciliation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(issues)
      .set({ requestDepth: 2_147_483_647 })
      .where(eq(issues.id, seeded.issueId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.failed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  // AUR-3926: the productivity watchdog counted every issue-linked run toward churn regardless of
  // why the run ended. A control-plane restart (OOM kill etc.) orphans in-flight runs, which get
  // recorded as "Process lost" failures and auto-retried -- the watchdog read that retry storm as
  // the assignee being unproductive (AUR-3921 was the real-world false positive this reproduces).
  describe("AUR-3926 infra-kill classification", () => {
    it("excludes infra-killed (process_lost) runs from the no-comment streak and churn tallies while a genuine no-comment streak still fires", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      // 9 infra-killed runs (would be indistinguishable from churn if counted) interleaved
      // ahead of the genuine no-comment streak.
      await insertProcessLostRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 9,
        now,
      });
      // 10 genuinely-completed runs with no comment -- this is the real signal and must still
      // cross the no-comment-streak threshold even with the infra noise sitting on top of it.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        startIndex: 9,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      expect(result.suppressedForInfraOutage).toBe(0);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("No-comment completed-run streak: 10");
      expect(review?.description).toContain(
        "Terminal sampled runs: 19 (9 infra-killed/non-attributable, 10 attributable to the agent)",
      );
      expect(review?.description).toContain("Excluded-run breakdown by errorCode: `process_lost`: 9");
      expect(review?.description).toContain(
        "contradiction: $0 in cost events despite 10 attributable terminal run(s) sampled",
      );
    });

    it("does not fire a per-agent high_churn review when process_lost runs are synchronized across multiple agents (AUR-3921 shape)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      const managerIssueId = randomUUID();
      await db.insert(issues).values({
        id: managerIssueId,
        companyId: seeded.companyId,
        title: "Unrelated in-progress work for the second agent",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: seeded.managerId,
        issueNumber: 2,
        identifier: `${seeded.issuePrefix}-2`,
        startedAt: seeded.createdAt,
        createdAt: seeded.createdAt,
        updatedAt: seeded.createdAt,
      });

      // Reproduces the AUR-3921 shape: 10 runs total on the primary agent's issue, 9 of which are
      // "Process lost" failures, 0 comments -- and a second, distinct agent also took process_lost
      // damage in the same window, which is the synchronized cross-agent signal of a control-plane
      // outage rather than one agent's churn.
      await insertProcessLostRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 9,
        now,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 1,
        now,
        startIndex: 9,
      });
      await insertProcessLostRuns({
        companyId: seeded.companyId,
        agentId: seeded.managerId,
        issueId: managerIssueId,
        count: 2,
        now,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(result.suppressedForInfraOutage).toBeGreaterThanOrEqual(1);
      expect(result.outageCompanyIds).toContain(seeded.companyId);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

      const outageActivity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "company.productivity_review_suppressed_for_infra_outage"));
      expect(outageActivity).toHaveLength(1);
    });

    it("still fires high_churn for 10 genuinely-completed runs even though the classifier now exists (inverse of the AUR-3921 shape)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 10,
        now,
        withRunComments: true,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      expect(result.suppressedForInfraOutage).toBe(0);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `high_churn`");
      expect(review?.description).toContain(
        "Terminal sampled runs: 10 (0 infra-killed/non-attributable, 10 attributable to the agent)",
      );
      expect(review?.description).toContain("Excluded-run breakdown by errorCode: none");
    });
  });

  describe("AUR-4016 provider-capacity classification", () => {
    it("does not fire a no_comment_streak review for AUR-3963's exact run mix (9 claude_transient_upstream + 1 claude_auth_required + 1 process_lost, all zero-token)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      const sessionLimitMessage =
        "Claude run failed: subtype=success: You've hit your session limit · resets 2:40pm (UTC)";

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 9,
        now,
        status: "failed",
        errorCode: "claude_transient_upstream",
        error: sessionLimitMessage,
        startIndex: 0,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 1,
        now,
        status: "failed",
        errorCode: "claude_auth_required",
        error: sessionLimitMessage,
        startIndex: 9,
      });
      await insertProcessLostRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 1,
        now,
        startIndex: 10,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(result.suppressedForInfraOutage).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
    });

    it("still counts a genuine agent failure with an unrecognized errorCode toward the no-comment streak", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "failed",
        errorCode: "some_other_agent_failure",
        error: "the agent's own code threw an unhandled exception",
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("No-comment completed-run streak: 10");
      expect(review?.description).toContain("Excluded-run breakdown by errorCode: none");
    });
  });

  // AUR-5008: a queued run the control plane itself decided not to run (issue cancelled/reached a
  // terminal status/dependencies still blocked/reassigned before it could start) carries zero
  // signal about the assignee -- it never even reached the provider wall the AUR-4016 codes die
  // at. A storm of these was being counted as churn (25 of 40 sampled runs on the flagged agent
  // in the forensics that motivated this issue).
  describe("AUR-5008 scheduler-lifecycle cancellation classification", () => {
    it("does not trip high_churn on a burst of issue_cancelled runs (FIRES: exclusion works)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      // 15 scheduler-cancelled runs in the last hour -- well over the hourly high_churn
      // threshold (10) if counted naively, and shaped exactly like a never-started run
      // (zero usage, no transcript at all).
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 15,
        now,
        status: "cancelled",
        errorCode: "issue_cancelled",
        error: "Issue was cancelled before this run could start",
        usageJson: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        logBytes: null,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
    });

    it("still fires high_churn for genuine churn once scheduler-cancellation noise is excluded (PASSES: doesn't regress into uselessness)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      // Same scheduler-cancellation noise as above, sitting on top of 10 genuinely-completed,
      // commented runs -- the noise must not mask real churn either.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 15,
        now,
        status: "cancelled",
        errorCode: "issue_dependencies_blocked",
        error: "Issue is blocked on unresolved dependencies",
        usageJson: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        logBytes: null,
        startIndex: 0,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 10,
        now,
        withRunComments: true,
        startIndex: 15,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `high_churn`");
      expect(review?.description).toContain(
        "Excluded-run breakdown by errorCode: `issue_dependencies_blocked`: 15",
      );
    });

    it("keeps the deterministic and scheduler-lifecycle code sets disjoint from the non-attributable provider set too", () => {
      const providerAndScheduler = new Set<string>([
        ...NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES,
        ...SCHEDULER_LIFECYCLE_NON_ATTRIBUTABLE_ERROR_CODES,
      ]);
      expect(providerAndScheduler.size).toBe(
        NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES.length + SCHEDULER_LIFECYCLE_NON_ATTRIBUTABLE_ERROR_CODES.length,
      );
    });
  });

  // AUR-5008: a run that never left the scheduler queue never spawned a process, so it has zero
  // usage AND no transcript at all (logBytes null/0) -- distinct from the AUR-4062 zero-token
  // backstop, which requires a *small but present* log. Fails closed on any errorCode, including
  // one never added to SCHEDULER_LIFECYCLE_NON_ATTRIBUTABLE_ERROR_CODES.
  describe("AUR-5008 never-started backstop classification", () => {
    it("excludes a terminal run with zero usage and no log at all, even under an unrecognized errorCode", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 9,
        now,
        status: "cancelled",
        errorCode: "some_future_scheduler_code",
        error: "Cancelled by a scheduler code path that hasn't been enumerated yet",
        usageJson: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        logBytes: null,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        startIndex: 9,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain(
        "Excluded-run breakdown by errorCode: `some_future_scheduler_code`: 9",
      );
    });
  });

  // AUR-5008: a detector that can articulate why its own finding is probably wrong should
  // suppress the filing, not annotate it and file anyway. Zero cost across EVERY sampled
  // attributable terminal run is proof no billable work happened.
  describe("AUR-5008 zero-cost-contradiction suppression", () => {
    it("suppresses the filing and emits an audit event instead when every attributable terminal run has zero cost and zero tokens", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "failed",
        errorCode: "an_error_code_no_list_has_ever_heard_of",
        error: "Something went wrong before anything billable happened",
        usageJson: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        // A real (non-null) log so this is NOT swept by the never-started or zero-token
        // backstops -- it must reach the zero-cost-contradiction suppression on its own merits.
        logBytes: 500_000,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(0);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

      const suppressionActivity = await db
        .select()
        .from(activityLog)
        .where(
          eq(activityLog.action, "issue.productivity_review_suppressed_zero_cost_contradiction"),
        );
      expect(suppressionActivity).toHaveLength(1);
      expect(suppressionActivity[0]?.entityId).toBe(seeded.issueId);
    });
  });

  describe("AUR-4062 zero-token/logBytes backstop classification", () => {
    const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const STARVED_LOG_BYTES = 6_100; // AUR-3943 forensics: starved runs logged ~6.0-6.2 KB.
    const REAL_WORK_LOG_BYTES = 280_000; // vs. 257-311 KB for runs that actually invoked the model.

    it("excludes a terminal run carrying the zero-token/tiny-log signature even under an errorCode not yet in the allowlist", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      // 9 runs shaped like AUR-4201's quota-starved streak, but tagged with a fictional
      // errorCode that has never been added to NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES --
      // this is exactly the "next provider failure mode" gap the backstop exists to close.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 9,
        now,
        status: "failed",
        errorCode: "some_future_provider_code",
        error: "Provider rejected the request before invoking the model",
        usageJson: ZERO_USAGE,
        logBytes: STARVED_LOG_BYTES,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        startIndex: 9,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("No-comment completed-run streak: 10");
      expect(review?.description).toContain(
        "Terminal sampled runs: 19 (9 infra-killed/non-attributable, 10 attributable to the agent)",
      );
      expect(review?.description).toContain(
        "Excluded-run breakdown by errorCode: `some_future_provider_code`: 9",
      );
    });

    it("labels an errorCode-less zero-token/tiny-log run distinctly from the process_lost fallback", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 3,
        now,
        status: "failed",
        errorCode: null,
        error: "connection reset before the model responded",
        usageJson: ZERO_USAGE,
        logBytes: STARVED_LOG_BYTES,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        startIndex: 3,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain(
        "Excluded-run breakdown by errorCode: `(zero-token/logBytes backstop)`: 3",
      );
    });

    it("does NOT exclude a genuine $0 failure that already reached the model (large logBytes)", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      // Same zero-usage-*cost* shape as a starved run, but logBytes is in the "actually
      // invoked the model" range -- e.g. the agent ran, produced a real transcript, and
      // errored before any billable cost was recorded (some input tokens were still
      // consumed). This must stay attributable so a genuine $0 agent failure can't be
      // swept under the backstop (the exact risk the issue description called out for
      // keeping this separate from AUR-4016), and it must not trip the unrelated AUR-5008
      // zero-cost-contradiction suppression, which requires zero *tokens* too.
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "failed",
        errorCode: null,
        error: "the agent's own code threw an unhandled exception after a full run",
        usageJson: { inputTokens: 1200, outputTokens: 0, costUsd: 0 },
        logBytes: REAL_WORK_LOG_BYTES,
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("No-comment completed-run streak: 10");
      expect(review?.description).toContain(
        "Terminal sampled runs: 10 (0 infra-killed/non-attributable, 10 attributable to the agent)",
      );
      expect(review?.description).toContain("Excluded-run breakdown by errorCode: none");
    });
  });

  // AUR-4513 / AUR-4212: a DETERMINISTIC repeated failure must stay attributable.
  // AUR-4212 reported a permanently-wedged agent as "0 attributable" because its
  // overflow runs were mis-coded `claude_transient_upstream` and swallowed by the
  // AUR-4016 provider-capacity exclusion above. Nothing external ever clears an
  // over-long prompt, so this streak has to escalate.
  describe("AUR-4513 deterministic-error attributability", () => {
    it("fires a no_comment_streak review for a repeated claude_context_overflow streak", async () => {
      const now = new Date("2026-07-30T12:00:00.000Z");
      const seeded = await seedAssignedIssue();

      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "failed",
        errorCode: CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
        error: "Claude run failed: subtype=success: Prompt is too long",
      });

      const result = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });

      expect(result.created).toBe(1);
      expect(result.suppressedForInfraOutage).toBe(0);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("Excluded-run breakdown by errorCode: none");
    });

    it("keeps the overflow code out of the non-attributable exclusion set", () => {
      // Guards the AUR-4513 instruction "do not simply add the new code to the
      // exclusion set -- that reproduces the bug under a new name".
      expect(NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES as readonly string[]).not.toContain(
        CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
      );
      expect(DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES as readonly string[]).toContain(
        CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
      );
    });

    // AUR-4557: this invariant used to be a module-scope `for` loop with a `throw`.
    // productivity-review is imported at startup (services/index.ts, heartbeat.ts), so
    // an edit adding a code to both sets would have crashed the shared multi-tenant
    // API on boot instead of failing a test. It is now a compile-time `AssertNever`
    // (see the type in productivity-review.ts, which stops compiling on overlap); this
    // is its runtime companion, so the invariant is covered without a boot crash.
    it("keeps the deterministic and non-attributable code sets disjoint", () => {
      const nonAttributable = new Set<string>(NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES);
      const overlap = (DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES as readonly string[]).filter(
        (code) => nonAttributable.has(code),
      );
      expect(overlap).toEqual([]);
    });

    // AUR-5008: same invariant, extended to the scheduler-lifecycle list -- it has its
    // own compile-time AssertNever guard (DeterministicCodesAreNotSchedulerLifecycleCodes)
    // mirroring the provider-code guard above, so this is its runtime companion too.
    it("keeps the deterministic and scheduler-lifecycle code sets disjoint", () => {
      const schedulerLifecycle = new Set<string>(SCHEDULER_LIFECYCLE_NON_ATTRIBUTABLE_ERROR_CODES);
      const overlap = (DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES as readonly string[]).filter(
        (code) => schedulerLifecycle.has(code),
      );
      expect(overlap).toEqual([]);
    });
  });
});
