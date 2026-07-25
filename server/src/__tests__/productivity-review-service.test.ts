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
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  PROCESS_LOST_ERROR_CODE,
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
});
