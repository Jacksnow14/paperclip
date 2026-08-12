import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  // Quiesce the scheduler before deleting anything. AUR-4143 made a completing
  // run re-drive the queue in starvation order, so leftover queued rows keep
  // being admitted *during* teardown and each new run writes fresh
  // issue_comments / activity_log rows. That defeats the retry loop below
  // outright: every attempt races a newly admitted run rather than converging.
  // Cancelling queued rows first is the same guard the global-concurrency-cap
  // fixture already uses.
  await db
    .update(heartbeatRuns)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));

  await resetEmbeddedPostgresTestDatabase(db);
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
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
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string;
    wakeupCommentId?: string;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: {
        issueId: input.issueId,
        ...(input.wakeupCommentId ? { commentId: input.wakeupCommentId } : {}),
      },
      status: "queued",
      requestedByActorType: input.requestedByActorType ?? null,
      requestedByActorId: input.requestedByActorId ?? null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  // AUR-5465 (B) FIRE case: before this fix, a `wakeCommentId` in context (the exact shape a
  // recovery-action re-wake carries) let a queued run on a cancelled issue slip past this guard
  // and execute — this is how the 08-06 bulk-cancel queue kept draining. `cancelled` must have no
  // resume hatch at all, unlike `done`.
  it("still cancels a queued run on a cancelled issue even when a wakeCommentId is present", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled task with a stray comment-driven wake",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "A recovery-action re-wake comment.",
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      wakeupCommentId: commentId,
      contextExtras: { commentId, wakeCommentId: commentId },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  // AUR-5465 (B) FIRE case: an explicit `resumeIntent` must not revive a cancelled issue either.
  // `done` legitimately honors resumeIntent (see the PASS case below); `cancelled` never does.
  it("still cancels a queued run on a cancelled issue even when resumeIntent is set", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled task with an explicit resume intent",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      contextExtras: { resumeIntent: true },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  // PASS case (must not regress): `done` keeps its resume hatch. A deliberate `resumeIntent`
  // follow-up on a completed issue is a real, supported flow and must still run.
  it("still runs a queued run on a done issue when resumeIntent is set", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completed task with a deliberate resume follow-up",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      contextExtras: { resumeIntent: true },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels generic comment-driven wakes on in_review issues when the agent is no longer the current participant", async () => {
    // A plain issue_commented wake is addressed to "whoever currently owns this issue", not to
    // this specific agent by name. Even though the underlying comment is real, it must not keep
    // a non-participant's queued run alive once review ownership has moved elsewhere (AUR-3245).
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      requestedByActorType: "agent",
      requestedByActorId: otherAgentId,
      wakeupCommentId: commentId,
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("still runs a verified mention-scoped reply wake on in_review issues even when the agent is not the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: otherAgentId,
        companyId,
        name: "ReviewerAgent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "MentionedAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with an explicit mention",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "@MentionedAgent can you double check this?",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId: mentionedAgentId,
      issueId,
      wakeReason: "issue_comment_mentioned",
      invocationSource: "automation",
      requestedByActorType: "agent",
      requestedByActorId: otherAgentId,
      wakeupCommentId: commentId,
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "comment.mention",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
  });

  it("cancels a queued issue_commented follow-up for the old assignee once the issue is reassigned before the run starts (AUR-3217 timeline)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    // The issue is already handed off to the replacement by the time the queued run is
    // evaluated, mirroring the Fast -> CTO -> Max handoff from AUR-3217/AUR-3243: the queued
    // follow-up run was created while `agentId` still owned the issue, but the reassignment
    // landed before the queued run could start.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned after a genuine human comment",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "human-founder",
      body: "Following up on this while Fast still owns it.",
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      requestedByActorType: "user",
      requestedByActorId: "human-founder",
      wakeupCommentId: commentId,
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  // AUR-4323: the two halves of "re-routing an issue away from a wedged agent never
  // schedules work for the new assignee". Neither of these may lean on the old agent's
  // lane ever admitting again — that is precisely what is broken in the field.
  async function seedReroutedIssueWithOrphanRun(opts: { issueStatus?: string } = {}) {
    const { companyId, agentId: wedgedAgentId } = await seedCompanyAndAgent({ agentName: "WedgedCoder" });
    const newAssigneeId = randomUUID();
    await db.insert(agents).values({
      id: newAssigneeId,
      companyId,
      name: "HealthyCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Re-routed away from a wedged agent",
      status: opts.issueStatus ?? "todo",
      priority: "critical",
      assigneeAgentId: newAssigneeId,
    });

    // The orphan: queued on the OLD agent, never started, and it never will be.
    const { runId: orphanRunId } = await seedQueuedRun({
      companyId,
      agentId: wedgedAgentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
    });

    return { companyId, wedgedAgentId, newAssigneeId, issueId, orphanRunId };
  }

  it("schedules a run for the new assignee even when an unstartable queued run is stranded on the old one", async () => {
    const { companyId, newAssigneeId, issueId, orphanRunId } = await seedReroutedIssueWithOrphanRun();

    // The assignment wake. Pre-fix this returns a `deferred_issue_execution` wake and
    // no run, because the company-wide execution-run scan adopts the orphan and the
    // execution lock lands back on the agent that can never run it.
    await heartbeat.wakeup(newAssigneeId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assignee_changed" },
      contextSnapshot: { issueId, source: "issue_update" },
      requestedByActorType: "system",
    });

    await waitForCondition(async () => {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, newAssigneeId));
      return rows.length > 0;
    });

    const newAssigneeRuns = await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, newAssigneeId));
    const runsForIssue = newAssigneeRuns.filter(
      (row) => (row.contextSnapshot as { issueId?: string } | null)?.issueId === issueId,
    );
    expect(runsForIssue.length).toBeGreaterThan(0);

    // And the orphan is retired rather than left to pin the lock forever.
    const orphan = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, orphanRunId))
      .then((rows) => rows[0] ?? null);
    expect(orphan?.status).toBe("cancelled");
    expect(orphan?.errorCode).toBe("issue_assignee_changed");

    // Nothing should have been parked as a dead-letter deferred wake.
    const deferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        sql`${agentWakeupRequests.companyId} = ${companyId}
          and ${agentWakeupRequests.status} = 'deferred_issue_execution'
          and ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
      );
    expect(deferred).toHaveLength(0);
  });

  it("promotes a deferred wake once the stale queued run blocking the issue is cancelled", async () => {
    const { companyId, newAssigneeId, issueId, orphanRunId } = await seedReroutedIssueWithOrphanRun({
      issueStatus: "in_progress",
    });

    // Exactly the field state of AUR-4144: the new assignee's wake parked as a
    // deferred dead letter behind an orphan run that can never drain.
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: newAssigneeId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_assigned", source: "issue_update" },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
    });

    // Cancelling the orphan must hand the issue on, not just free it.
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const wake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId))
        .then((rows) => rows[0] ?? null);
      return wake?.status !== "deferred_issue_execution";
    }, 8_000);

    const orphan = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, orphanRunId))
      .then((rows) => rows[0] ?? null);
    expect(orphan?.status).toBe("cancelled");

    const deferredWake = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWake?.status).not.toBe("deferred_issue_execution");
    expect(deferredWake?.runId).toBeTruthy();
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued continuation recovery when the continuation summary parks executor work for review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("continuation summary says the executor should wait");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("promotes a deferred wake once a queued run blocked by unresolved dependencies is cancelled (AUR-4388 G3)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: issueId,
        companyId,
        title: "Blocked by an open dependency",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });
    // Same field state as the G1/G2 dead letters: a wake parked behind the lock
    // this queued run would have held once claimed.
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_commented", source: "issue_update" },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_dependencies_blocked");
    expect(countExecuteCallsForRun(runId)).toBe(0);

    await waitForCondition(async () => {
      const wake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId))
        .then((rows) => rows[0] ?? null);
      return wake?.status !== "deferred_issue_execution";
    }, 8_000);

    const deferredWake = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWake?.status).not.toBe("deferred_issue_execution");
    expect(deferredWake?.runId).toBeTruthy();
  });

  it("promotes a deferred wake once a reassignment-suppressed scheduled retry is cancelled (AUR-4388 G1)", async () => {
    const { companyId, agentId: originalAgentId } = await seedCompanyAndAgent({ agentName: "OriginalAssignee" });
    const newAssigneeId = randomUUID();
    await db.insert(agents).values({
      id: newAssigneeId,
      companyId,
      name: "NewAssignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned while a retry was scheduled",
      status: "in_progress",
      priority: "medium",
      // Reassigned away from the agent the scheduled retry still belongs to.
      assigneeAgentId: newAssigneeId,
    });

    const now = new Date("2026-04-20T12:00:00.000Z");
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: originalAgentId,
      invocationSource: "assignment",
      status: "failed",
      error: "transient failure",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: originalAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_retry_scheduled",
      payload: { issueId },
      status: "queued",
      runId: retryRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId: originalAgentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      scheduledRetryAt: now,
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned", retryReason: "transient_failure" },
      updatedAt: now,
      createdAt: now,
    });

    // The new assignee's wake, parked behind the lock the old agent's retry
    // still nominally held.
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: newAssigneeId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_assigned", source: "issue_update" },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
    });

    // Gate-suppressed retries are cancelled, not promoted, so they never land in
    // `promotedRunIds` -- assert the cancellation directly instead.
    await heartbeat.promoteDueScheduledRetries(now);

    const retryRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("cancelled");
    expect(retryRun?.errorCode).toBe("issue_reassigned");

    await waitForCondition(async () => {
      const wake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId))
        .then((rows) => rows[0] ?? null);
      return wake?.status !== "deferred_issue_execution";
    }, 8_000);

    const deferredWake = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWake?.status).not.toBe("deferred_issue_execution");
    expect(deferredWake?.runId).toBeTruthy();
  });

  it("promotes a deferred wake once enqueueWakeup clears a stale terminal execution lock (AUR-4388 G4)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution lock leaked onto a terminal run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // A run that finished (terminal status, not in
    // EXECUTION_PATH_HEARTBEAT_RUN_STATUSES) but whose id was never cleared off
    // issues.executionRunId -- the leaked-lock precondition enqueueWakeup's
    // stale-terminal-lock branch exists to clean up.
    const staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "cancelled",
      error: "test fixture: terminal run with a leaked lock reference",
      errorCode: "test_fixture",
      finishedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({
        executionRunId: staleRunId,
        executionAgentNameKey: "claudecoder",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    // Same agent's own wake, parked behind the stale lock -- exactly the dead
    // letter this gap produces if the lock is cleared without draining.
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_commented", source: "issue_update" },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
    });

    // Occupy the agent's only concurrency slot (maxConcurrentRuns: 1) with an
    // unrelated in-flight run on a different issue. Otherwise the queued run
    // this wakeup() call creates for `issueId` gets claimed and executed
    // immediately by the post-transaction startNextQueuedRunForAgent call, and
    // its own completion path (finalizeAgentStatus -> releaseIssueExecutionAndPromote)
    // drains `deferredWakeId` too -- masking whether the G4 in-transaction drain
    // itself did anything.
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId,
      title: "Unrelated in-flight work holding the agent's only concurrency slot",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const blockerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: unrelatedIssueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({ executionRunId: blockerRunId, executionAgentNameKey: "claudecoder", executionLockedAt: new Date() })
      .where(eq(issues.id, unrelatedIssueId));

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, source: "issue_update" },
      requestedByActorType: "system",
    });

    await waitForCondition(async () => {
      const wake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId))
        .then((rows) => rows[0] ?? null);
      return wake?.status !== "deferred_issue_execution";
    }, 8_000);

    const deferredWake = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWake?.status).not.toBe("deferred_issue_execution");
    expect(deferredWake?.runId).toBeTruthy();

    const staleRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId))
      .then((rows) => rows[0] ?? null);
    // The stale run's own terminal status must be left untouched -- only the
    // issue-level lock reference to it is cleared.
    expect(staleRun?.status).toBe("cancelled");

    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).not.toBe(staleRunId);

    // Both the concurrency-blocker run and the newly-promoted run are left in
    // non-terminal statuses by design (nothing in this test ever executes
    // them). The shared afterEach hook polls up to 5s waiting for every
    // heartbeatRuns row to reach a terminal status before it will proceed to
    // cleanup -- settle them here so that poll exits immediately instead of
    // burning its full budget on every run of this test.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.id, [blockerRunId, ...(deferredWake?.runId ? [deferredWake.runId] : [])]));
  });

  // AUR-5465 end-to-end regression: replay the 08-06 sequence — an outage drives repeated
  // run failures on a batch of in-flight issues, an operator bulk-cancels them with a single
  // multi-row UPDATE (exactly the shape that bypassed all 3 known AUR-4299 call sites and left
  // 47 orphaned recovery actions live), and then a wave of re-wake attempts (recovery-action
  // comment wakes, resumeIntent follow-ups, plain reassignment wakes) hits the now-cancelled
  // issues. B closes the resume hatch per run; C1's DB trigger closes the recovery actions
  // synchronously on the bulk write, not per-call-site. Assert the queue reaches zero and,
  // on a second independent drain pass plus the C2 reconciler sweep, stays zero.
  it("replays the 08-06 org-block -> bulk-cancel -> re-wake sequence and drains the queue to zero and keeps it there", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OutageCoder" });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const issueCount = 5;
    const issueIds = Array.from({ length: issueCount }, () => randomUUID());

    for (const [index, issueId] of issueIds.entries()) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Org-block casualty ${index}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });

      // N failed runs per issue: the outage-era attempt history left behind by the adapter
      // being unreachable, exactly as claim_queued_run would have recorded them.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          invocationSource: "assignment",
          status: "failed",
          errorCode: "adapter_failed",
          startedAt: new Date(),
          finishedAt: new Date(),
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        });
      }

      // The escalation the repeated failures produced: a live wake_owner recovery action,
      // still active at the moment the operator reaches for the bulk cancel.
      await recoveryActionSvc.upsertSourceScoped({
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `org-block-replay:${issueId}`,
        evidence: { failedAttempts: 3 },
        nextAction: "Escalated during the org-block outage.",
        wakePolicy: { type: "wake_owner" },
      });
    }

    // The bulk cancel: a single multi-row UPDATE, not a loop over the service's update() call
    // site — this is the exact shape that bypassed AUR-4299's 3 known call sites on 08-06.
    await db.update(issues).set({ status: "cancelled" }).where(inArray(issues.id, issueIds));

    // C1 must have closed every recovery action synchronously, in the same statement.
    const closedActions = await db
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId, status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(inArray(issueRecoveryActions.sourceIssueId, issueIds));
    expect(closedActions).toHaveLength(issueCount);
    expect(closedActions.every((action) => action.status === "cancelled")).toBe(true);

    // Re-wake attempts: a mix of the wake shapes that used to slip past the old guard.
    const wakeRunIds: string[] = [];
    for (const [index, issueId] of issueIds.entries()) {
      const mode = index % 3;
      if (mode === 0) {
        const commentId = randomUUID();
        await db.insert(issueComments).values({
          id: commentId,
          companyId,
          issueId,
          authorAgentId: agentId,
          body: "Recovery-action re-wake comment carried over from the outage.",
        });
        const { runId } = await seedQueuedRun({
          companyId,
          agentId,
          issueId,
          wakeReason: "issue_commented",
          wakeupCommentId: commentId,
          contextExtras: { commentId, wakeCommentId: commentId },
        });
        wakeRunIds.push(runId);
      } else if (mode === 1) {
        const { runId } = await seedQueuedRun({
          companyId,
          agentId,
          issueId,
          wakeReason: "issue_assigned",
          contextExtras: { resumeIntent: true },
        });
        wakeRunIds.push(runId);
      } else {
        const { runId } = await seedQueuedRun({
          companyId,
          agentId,
          issueId,
          wakeReason: "issue_assigned",
        });
        wakeRunIds.push(runId);
      }
    }

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, wakeRunIds));
      return runs.every((run) => run.status === "cancelled");
    });

    const drainedRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, wakeRunIds));
    expect(drainedRuns).toHaveLength(issueCount);
    for (const run of drainedRuns) {
      expect(run.status).toBe("cancelled");
      expect(run.errorCode).toBe("issue_terminal_status");
    }
    for (const runId of wakeRunIds) {
      expect(countExecuteCallsForRun(runId)).toBe(0);
    }

    const queuedAfterFirstDrain = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    expect(queuedAfterFirstDrain).toHaveLength(0);

    // Stays zero: an independent second drain pass plus the C2 backstop sweep must both be
    // no-ops. Nothing regenerates a queued run or reactivates a recovery action.
    await heartbeat.resumeQueuedRuns();
    const orphanSweep = await recoveryActionSvc.reconcileOrphanedTerminalActions();
    expect(orphanSweep.resolvedCount).toBe(0);
    expect(orphanSweep.cancelledCount).toBe(0);

    const queuedAfterSecondPass = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    expect(queuedAfterSecondPass).toHaveLength(0);

    const activeActionsAfter = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(and(inArray(issueRecoveryActions.sourceIssueId, issueIds), eq(issueRecoveryActions.status, "active")));
    expect(activeActionsAfter).toHaveLength(0);
  });
});
