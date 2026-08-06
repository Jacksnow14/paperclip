import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
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
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  // AUR-4250: `escalateStrandedAssignedIssue` refuses to re-escalate while the source-scoped
  // recovery action is still warm (`lastAttemptAt` newer than the 24h dormancy cutoff), because
  // the cooldown — not the old `status: "blocked"` write — is now the loop-breaker. Tests that
  // exercise escalation *twice* have to push the action past that window in between, exactly the
  // way the scheduler would after a day.
  async function backdateRecoveryActionPastDormancy(sourceIssueId: string) {
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
  }

  function createApp(actor: any = { type: "board", source: "local_implicit" }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });
    // AUR-4250: re-escalation is gated on the 24h recovery-action dormancy window. Without this
    // backdate the second call short-circuits to null and this test stops proving action reuse —
    // do not delete it. It mirrors "re-escalates stranded recovery once the recovery action has
    // gone dormant" in heartbeat-process-recovery.test.ts.
    await backdateRecoveryActionPastDormancy(sourceIssue.id);
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    // AUR-4250: escalation only mints `blocked` when real unresolved blockers exist. This fixture
    // has none and the recovery action has an invokable owner, so the issue is left dispatchable
    // (`todo`) instead of being dropped out of the execution candidate filter with zero blocker
    // edges. See "still blocks stranded work that has a real unresolved blocker" for the other arm.
    expect(updatedIssue).toMatchObject({
      status: "todo",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[0]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    // AUR-4250: the 24h cooldown would otherwise make the second escalation a no-op, and this
    // test would silently stop covering source-scoped action reuse. Keep the backdate.
    await backdateRecoveryActionPastDormancy(sourceIssue.id);
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[1]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  // AUR-5001 RECOVERY acceptance case: terminal recovery on a routine_execution issue
  // must never leave it in zero-edge `blocked` (AUR-4250 doctrine applied to routine
  // dispatch). A routine_execution umbrella has no human review workflow and the
  // routine re-fires on schedule, so once recovery attempts are exhausted (>3, no real
  // blockers) `blocked` would strand it forever — cancel it instead.
  it("cancels a stranded routine_execution issue instead of zero-edge blocking it once recovery attempts are exhausted (RECOVERY)", async () => {
    const { coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ originKind: "routine_execution", originId: randomUUID() })
      .where(eq(issues.id, sourceIssueId));
    const [routineIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    // Push attemptCount past MAX_DISPATCHABLE_STRANDED_RECOVERY_ATTEMPTS (3) so
    // keepDispatchable flips false even though blockerIds stays empty the whole
    // time — exactly the zero-edge-blocked case AUR-4250/AUR-5001 forbid.
    for (let i = 0; i < 4; i++) {
      await recovery.escalateStrandedAssignedIssue({
        issue: routineIssue!,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      });
      await backdateRecoveryActionPastDormancy(routineIssue!.id);
    }

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, routineIssue!.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]?.attemptCount).toBeGreaterThan(3);

    const [finalIssue] = await db.select().from(issues).where(eq(issues.id, routineIssue!.id));
    expect(finalIssue?.status).toBe("cancelled");
    expect(finalIssue?.status).not.toBe("blocked");

    // The cancel must be LOUD, and this assertion is load-bearing: attempts 1..3 go
    // down the ordinary escalation path first and post their own system comment. An
    // earlier version of this branch deduped on that shared `Recovery action: <id>`
    // line, so the cancellation notice was suppressed by the very escalation that
    // preceded it — the issue was cancelled silently, with no stated cause. Keyed on
    // this branch's own marker instead, so a prior escalation cannot mute it...
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, routineIssue!.id));
    const notices = comments.filter((c) => (c.body ?? "").includes("Cancelling"));
    expect(notices).toHaveLength(1);
    // ...and it still names why, not just that.
    expect(notices[0]?.body ?? "").toContain("routine-umbrella cancelled by recovery action");
  });

  // The invariant here is the tail re-assert, not any particular constant: `enqueueWakeup` flips
  // the issue to `in_progress` mid-escalation (a wake claimed before escalation finished writing),
  // and escalation's own status decision must win that race rather than silently losing it.
  //
  // AUR-4250 decision: the target of that re-assert is `todo`, not `blocked`. Nothing is blocking
  // this issue and it has an invokable recovery owner, so it must stay dispatchable. The old
  // behaviour clobbered a racing `in_progress` all the way to a zero-edge `blocked`, which was
  // strictly worse — it won the race and then removed the issue from execution entirely.
  it("re-asserts the escalation status over a synchronously-claimed wakeup", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    // The wake already wrote `in_progress`; escalation re-asserts over it. Discriminating: if the
    // tail re-assert were a no-op this would read `in_progress`.
    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("todo");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    // AUR-4250: without pushing the action past the 24h dormancy window the second escalation
    // short-circuits and `attemptCount` never reaches 2.
    await backdateRecoveryActionPastDormancy(sourceIssue.id);
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Recovery action:");
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(403);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  it("Class B durable-blocker sweep skips a durable blocked issue guarded by a fresh recovery action (AUR-4300)", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedIssueId = randomUUID();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Durably blocked with no blocker edge",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${prefix}-3`,
      createdAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId: blockedIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      cause: "stranded_assigned_issue",
      fingerprint: `test:${blockedIssueId}`,
      nextAction: "Restore a live execution path.",
      lastAttemptAt: new Date(),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result.classBSkippedOtherRecoveryAction).toBe(1);
    expect(result.classBNudged).toBe(0);
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ kind: "stranded_assigned_issue", status: "active" });
  });

  it("Class B durable-blocker sweep proceeds once the guarding recovery action's one-shot wake goes dormant (AUR-4300)", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedIssueId = randomUUID();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Durably blocked with no blocker edge",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${prefix}-3`,
      createdAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId: blockedIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      cause: "stranded_assigned_issue",
      fingerprint: `test:${blockedIssueId}`,
      nextAction: "Restore a live execution path.",
      lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result.classBSkippedOtherRecoveryAction).toBe(0);
    expect(result.classBNudged).toBe(1);
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, blockedIssueId), eq(issueRecoveryActions.status, "active")));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ kind: "issue_graph_liveness", attemptCount: 2 });
  });

  describe("terminal source issue resolves the recovery action (AUR-4299)", () => {
    async function seedActiveAction(companyId: string, sourceIssueId: string, ownerAgentId: string) {
      return issueRecoveryActionService(db).upsertSourceScoped({
        companyId,
        sourceIssueId,
        kind: "stranded_assigned_issue",
        ownerType: "agent",
        ownerAgentId,
        cause: "stranded_assigned_issue",
        fingerprint: `stranded:${sourceIssueId}`,
        nextAction: "Restore a live execution path.",
      });
    }

    async function readAction(actionId: string) {
      const [row] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, actionId));
      return row!;
    }

    it("resolves the action when the source issue is completed through issueService.update", async () => {
      const { companyId, managerId, sourceIssueId } = await seedCompany();
      const action = await seedActiveAction(companyId, sourceIssueId, managerId);
      expect(action.status).toBe("active");

      await issueService(db).update(sourceIssueId, { status: "done" });

      const row = await readAction(action.id);
      expect(row.status).toBe("resolved");
      expect(row.outcome).toBe("restored");
      expect(row.resolvedAt).toBeInstanceOf(Date);
      expect(
        await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId),
      ).toBeNull();
    });

    it("cancels the action when the source issue is cancelled through issueService.update", async () => {
      const { companyId, managerId, sourceIssueId } = await seedCompany();
      const action = await seedActiveAction(companyId, sourceIssueId, managerId);

      await issueService(db).update(sourceIssueId, { status: "cancelled" });

      const row = await readAction(action.id);
      expect(row.status).toBe("cancelled");
      expect(row.outcome).toBe("cancelled");
      expect(
        await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId),
      ).toBeNull();
    });

    // Control: proves the hook discriminates on terminal status rather than resolving on any
    // update at all. Without this, the two tests above would still pass if the hook were
    // unconditional — and an unconditional hook would destroy every live recovery action.
    it("leaves the action active for non-terminal status transitions", async () => {
      const { companyId, managerId, sourceIssueId } = await seedCompany();
      const action = await seedActiveAction(companyId, sourceIssueId, managerId);

      await issueService(db).update(sourceIssueId, { status: "in_review" });
      expect((await readAction(action.id)).status).toBe("active");

      await issueService(db).update(sourceIssueId, { status: "blocked" });
      expect((await readAction(action.id)).status).toBe("active");

      // A non-status update must not touch it either.
      await issueService(db).update(sourceIssueId, { title: "Renamed" });
      expect((await readAction(action.id)).status).toBe("active");

      expect(
        await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId),
      ).toMatchObject({ id: action.id });
    });

    it("resolves actions cancelled through the issue-tree bulk path, which bypasses issueService.update", async () => {
      const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
      const childIssueId = randomUUID();
      await db.insert(issues).values({
        id: childIssueId,
        companyId,
        parentId: sourceIssueId,
        title: "Child of stranded work",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
      });
      const childAction = await seedActiveAction(companyId, childIssueId, managerId);

      const treeSvc = issueTreeControlService(db);
      const hold = await treeSvc.createHold(companyId, sourceIssueId, {
        mode: "cancel",
        reason: "tree cancelled",
        actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
      });
      const cancelled = await treeSvc.cancelIssueStatusesForHold(companyId, sourceIssueId, hold.hold.id);
      expect(cancelled.updatedIssueIds).toContain(childIssueId);

      const row = await readAction(childAction.id);
      expect(row.status).toBe("cancelled");
      expect(row.outcome).toBe("cancelled");
    });

    it("is scoped to the company and idempotent on repeat terminal writes", async () => {
      const { companyId, managerId, sourceIssueId } = await seedCompany();
      const action = await seedActiveAction(companyId, sourceIssueId, managerId);
      const svc = issueRecoveryActionService(db);

      // Wrong company must not resolve it.
      expect(
        await svc.resolveActiveForTerminalIssues({
          companyId: randomUUID(),
          sourceIssueIds: [sourceIssueId],
          issueStatus: "done",
        }),
      ).toEqual([]);
      expect((await readAction(action.id)).status).toBe("active");

      const first = await svc.resolveActiveForTerminalIssues({
        companyId,
        sourceIssueIds: [sourceIssueId],
        issueStatus: "done",
      });
      expect(first).toHaveLength(1);
      const resolvedAt = (await readAction(action.id)).resolvedAt;

      // Second call matches nothing and must not rewrite the resolution timestamp.
      const second = await svc.resolveActiveForTerminalIssues({
        companyId,
        sourceIssueIds: [sourceIssueId],
        issueStatus: "done",
      });
      expect(second).toEqual([]);
      expect((await readAction(action.id)).resolvedAt).toEqual(resolvedAt);
    });
  });
});
