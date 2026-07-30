import { randomUUID } from "node:crypto";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

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
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
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
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: true,
    });
  }

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedCompanyWithAgents() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    return { companyId, managerId, coderId, issuePrefix };
  }

  /** A blocked issue with no blocker edge at all, i.e. a Class B missing_edge. */
  async function insertBlockedIssueWithoutBlockerEdge(opts: {
    companyId: string;
    issuePrefix: string;
    issueNumber: number;
    assigneeAgentId: string | null;
    createdAt: Date;
    updatedAt?: Date;
    title?: string;
  }) {
    const blockedIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId: opts.companyId,
      title: opts.title ?? "Blocked with no blocker edge",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: opts.assigneeAgentId,
      issueNumber: opts.issueNumber,
      identifier: `${opts.issuePrefix}-${opts.issueNumber}`,
      createdAt: opts.createdAt,
      updatedAt: opts.updatedAt ?? opts.createdAt,
    });
    return blockedIssueId;
  }

  async function insertActiveGraphLivenessAction(opts: {
    companyId: string;
    sourceIssueId: string;
    ownerAgentId: string;
  }) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: opts.companyId,
        sourceIssueId: opts.sourceIssueId,
        kind: "issue_graph_liveness",
        status: "active",
        ownerType: "agent",
        ownerAgentId: opts.ownerAgentId,
        cause: "issue_graph_liveness",
        fingerprint: `issue_graph_liveness:${opts.sourceIssueId}:pre_existing`,
        evidence: { stage: "escalate_owner" },
        nextAction: "Pre-existing escalation that a guessed timestamp must not retire.",
      })
      .returning({ id: issueRecoveryActions.id });
    return row?.id as string;
  }

  /**
   * Drop every blocker edge except the one the test seeded. The legacy
   * escalation path attaches its own recovery issue as a real (non-terminal)
   * blocker edge, which would silently reclassify the issue as
   * open_non_terminal and let a Class A assertion pass for the wrong reason.
   */
  async function stripForeignBlockerEdges(
    blockedIssueId: string,
    keepBlockerIssueIds: string | string[],
  ) {
    const keep = Array.isArray(keepBlockerIssueIds) ? keepBlockerIssueIds : [keepBlockerIssueIds];
    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.relatedIssueId, blockedIssueId),
          notInArray(issueRelations.issueId, keep),
        ),
      );
  }

  async function reblock(blockedIssueId: string) {
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));
  }

  /** Age the recorded Class A *recovery* rows out of the oscillation window. */
  async function backdateClassAActuationRows(blockedIssueId: string, at: Date) {
    await db
      .update(activityLog)
      .set({ createdAt: at })
      .where(
        and(
          eq(activityLog.entityId, blockedIssueId),
          eq(activityLog.action, "issue.updated"),
          sql`${activityLog.details} ->> 'source' = 'recovery.reconcile_issue_graph_liveness'`,
          sql`${activityLog.details} ->> 'status' = 'todo'`,
        ),
      );
  }

  async function selectClassACappedMarkers(blockedIssueId: string) {
    return db
      .select({ details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, blockedIssueId),
          eq(activityLog.action, "issue.recovery_class_a_capped"),
        ),
      );
  }

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
    });
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("does not create recovery issues outside the configured lookback window", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ outsideLookback: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedOutsideLookback).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source issue is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId } = await seedBlockedChain();

    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: blockedIssueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { issueId: blockedIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("auto-recovers blocked issues whose direct blockers are terminal and wakes the assignee", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      terminalOnlyIssues: 1,
      classAAutoRecovered: 1,
      classBNudged: 0,
      classBEscalated: 0,
      escalationsCreated: 0,
    });

    const [sourceIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceIssue?.status).toBe("todo");

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("All direct blocker edges on this issue are now terminal"),
      }),
    ]);

    const wakeups = await db
      .select({
        source: agentWakeupRequests.source,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, coderId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      );
    expect(wakeups).toEqual([
      expect.objectContaining({
        source: "automation",
        reason: "heartbeat.wakeOnDemand.disabled",
        status: "skipped",
        payload: expect.objectContaining({
          issueId: blockedIssueId,
        }),
      }),
    ]);
  });

  it("caps repeat class A auto-recovery for a re-blocked issue and downgrades it to class B", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 1,
      classAOscillationCapped: 0,
    });

    // Control: the first pass must really have actuated, otherwise the second
    // pass proves nothing.
    const [afterFirst] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterFirst?.status).toBe("todo");
    const commentsAfterFirst = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId));
    expect(commentsAfterFirst).toHaveLength(1);

    // Re-block with no new first-class blocker edge — the plain
    // `PATCH status=blocked` an agent does for a founder gate or a narrative
    // blocker. The original terminal `blocks` edge is untouched.
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const second = await heartbeat.reconcileIssueGraphLiveness();
    expect(second).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 0,
      classAOscillationCapped: 1,
    });

    const [afterSecond] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterSecond?.status).toBe("blocked");

    // The Class A recovery comment must not be posted a second time. Other
    // subsystems may still comment on this issue, so count the Class A
    // comment specifically rather than the raw comment total.
    const commentsAfterSecond = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId));
    const classAComments = commentsAfterSecond.filter((comment) =>
      comment.body.includes("All direct blocker edges on this issue are now terminal"),
    );
    expect(classAComments).toHaveLength(1);

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockedIssueId),
        ),
      );
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: coderId,
      status: "active",
    });
    expect(recoveryActions[0]?.evidence).toMatchObject({
      stage: "class_a_oscillation_capped",
    });
    expect(recoveryActions[0]?.nextAction).toContain("keeps being re-blocked");

    const wakeups = await db
      .select({
        source: agentWakeupRequests.source,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, coderId),
        ),
      );
    const ownerNudge = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.sourceIssueId === blockedIssueId &&
        payload?.recoveryCause === "issue_graph_liveness";
    });
    expect(ownerNudge).toMatchObject({ source: "assignment" });

    // A further tick must not flip the issue back or re-post the Class A
    // comment — and it must be the *cap* that stops it. By now the legacy
    // escalation path may have attached its escalation issue as a real blocker
    // edge, which would make the issue open_non_terminal and let
    // `classAAutoRecovered: 0` pass for the wrong reason. Strip any blocker edge
    // other than the original terminal one so the classification is genuinely
    // terminal_only again, then assert the cap itself fired.
    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.relatedIssueId, blockedIssueId),
          sql`${issueRelations.issueId} <> ${blockerIssueId}`,
        ),
      );

    const third = await heartbeat.reconcileIssueGraphLiveness();
    expect(third).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 0,
      classAOscillationCapped: 1,
    });

    const [afterThird] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterThird?.status).toBe("blocked");

    const classACommentsAfterThird = (await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId)))
      .filter((comment) =>
        comment.body.includes("All direct blocker edges on this issue are now terminal"),
      );
    expect(classACommentsAfterThird).toHaveLength(1);

    const recoveryActionsAfterThird = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(recoveryActionsAfterThird).toHaveLength(1);
  });

  it("reads the blocked transition from the plugin-host activity shape, not the createdAt fallback", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, issuePrefix } = await seedCompanyWithAgents();
    const createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const blockedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const blockedIssueId = await insertBlockedIssueWithoutBlockerEdge({
      companyId,
      issuePrefix,
      issueNumber: 1,
      assigneeAgentId: coderId,
      createdAt,
      updatedAt: new Date(),
      title: "Blocked through the plugin host",
    });
    // The plugin host's `issues.update` logs `issue.updated` with
    // `details: { identifier, patch, _previous }`, so the new status lives at
    // details.patch.status — not details.status. Before the read predicate was
    // widened this row was invisible and the issue fell back to createdAt
    // (40 days), escalating to the owner instead of nudging the assignee.
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: coderId,
      agentId: coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: {
        identifier: `${issuePrefix}-1`,
        patch: { status: "blocked" },
        _previous: { status: "todo" },
      },
      createdAt: blockedAt,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      missingEdgeIssues: 1,
      // 9 days => wake_assignee. The createdAt fallback (40 days) would have
      // produced classBEscalated: 1 instead, so this discriminates.
      classBNudged: 1,
      classBEscalated: 0,
      blockedEnteredAtFallbacks: 0,
    });

    const recoveryActions = await db
      .select({ evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]?.evidence).toMatchObject({
      blockedEnteredAt: blockedAt.toISOString(),
      blockedEnteredAtSource: "activity_log",
      stage: "wake_assignee",
    });
  });

  it("never cancels an active escalation off a fallback timestamp, but still cancels off a real transition row", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, issuePrefix } = await seedCompanyWithAgents();
    const recentlyBlockedAt = new Date(Date.now() - 60 * 60 * 1000);

    // Guessed: no blocked-transition row exists, so blockedEnteredAt falls back
    // to createdAt. "Entered blocked recently" is therefore an inference, and
    // acting on it would silently retire a live escalation action.
    const guessedIssueId = await insertBlockedIssueWithoutBlockerEdge({
      companyId,
      issuePrefix,
      issueNumber: 1,
      assigneeAgentId: coderId,
      createdAt: recentlyBlockedAt,
      title: "Blocked recently, no transition row",
    });
    // Negative control: identical shape and identical age, but the blocked
    // transition is observable in activity_log. Here "recently blocked" is a
    // fact, so the cancellation must happen. Without this half the test would
    // pass even if cancellation were removed altogether.
    const observedIssueId = await insertBlockedIssueWithoutBlockerEdge({
      companyId,
      issuePrefix,
      issueNumber: 2,
      assigneeAgentId: coderId,
      createdAt: recentlyBlockedAt,
      title: "Blocked recently, transition row present",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: coderId,
      agentId: coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: observedIssueId,
      details: { identifier: `${issuePrefix}-2`, status: "blocked" },
      createdAt: recentlyBlockedAt,
    });

    const guessedActionId = await insertActiveGraphLivenessAction({
      companyId,
      sourceIssueId: guessedIssueId,
      ownerAgentId: coderId,
    });
    const observedActionId = await insertActiveGraphLivenessAction({
      companyId,
      sourceIssueId: observedIssueId,
      ownerAgentId: coderId,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 2,
      missingEdgeIssues: 2,
      classBNudged: 0,
      classBEscalated: 0,
      blockedEnteredAtFallbacks: 1,
      // Exactly one cancellation: the observed one.
      issueGraphRecoveryActionsResolved: 1,
    });

    const [guessedAction] = await db
      .select({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, guessedActionId));
    expect(guessedAction).toMatchObject({ status: "active", outcome: null });

    const [observedAction] = await db
      .select({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, observedActionId));
    expect(observedAction).toMatchObject({ status: "cancelled", outcome: "cancelled" });
  });

  it("re-arms class A when the blocker set changes after a cap", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.reconcileIssueGraphLiveness()).toMatchObject({
      classAAutoRecovered: 1,
      classAOscillationCapped: 0,
    });
    await reblock(blockedIssueId);
    await stripForeignBlockerEdges(blockedIssueId, blockerIssueId);
    expect(await heartbeat.reconcileIssueGraphLiveness()).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 0,
      classAOscillationCapped: 1,
    });

    // A different terminal blocker edge is new information: the cap is keyed on
    // the blocker-set fingerprint, so it must re-arm rather than suppress
    // forever. (A guard that can never clear is as broken as one that never
    // fires.)
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second terminal blocker",
      status: "done",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 90,
      identifier: `SECOND-90`,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await reblock(blockedIssueId);
    await stripForeignBlockerEdges(blockedIssueId, [blockerIssueId, secondBlockerIssueId]);

    const third = await heartbeat.reconcileIssueGraphLiveness();
    expect(third).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 1,
      classAOscillationCapped: 0,
    });

    const [afterThird] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterThird?.status).toBe("todo");
  });

  it("re-arms class A once the oscillation window expires", async () => {
    await enableAutoRecovery();
    const { blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.reconcileIssueGraphLiveness()).toMatchObject({
      classAAutoRecovered: 1,
    });

    // Same blocker set, but the recorded decision is now older than
    // CLASS_A_OSCILLATION_WINDOW_MS (7 days), so the cap must clear.
    await backdateClassAActuationRows(
      blockedIssueId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    await reblock(blockedIssueId);
    await stripForeignBlockerEdges(blockedIssueId, blockerIssueId);

    const second = await heartbeat.reconcileIssueGraphLiveness();
    expect(second).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 1,
      classAOscillationCapped: 0,
    });

    const [afterSecond] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterSecond?.status).toBe("todo");
  });

  it("keeps a re-blocked issue capped past the original window because each capped tick refreshes it", async () => {
    await enableAutoRecovery();
    const { blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.reconcileIssueGraphLiveness()).toMatchObject({
      classAAutoRecovered: 1,
    });
    await reblock(blockedIssueId);
    await stripForeignBlockerEdges(blockedIssueId, blockerIssueId);
    expect(await heartbeat.reconcileIssueGraphLiveness()).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 0,
      classAOscillationCapped: 1,
    });

    const markersAfterCap = await selectClassACappedMarkers(blockedIssueId);
    expect(markersAfterCap).toHaveLength(1);
    expect(markersAfterCap[0]?.details).toMatchObject({
      source: "recovery.reconcile_issue_graph_liveness",
      stage: "class_a_oscillation_capped",
      classABlockerSetFingerprint: blockerIssueId,
    });

    // Age the original *recovery* out of the window while leaving the capped
    // marker inside it — equivalent to a tick more than 7 days after the last
    // real recovery but less than 7 days after the last capped decision.
    // Before the window became self-refreshing, this tick force-flipped the
    // issue back to todo: oscillation throttled to weekly, not ended.
    await backdateClassAActuationRows(
      blockedIssueId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    await stripForeignBlockerEdges(blockedIssueId, blockerIssueId);

    const third = await heartbeat.reconcileIssueGraphLiveness();
    expect(third).toMatchObject({
      terminalOnlyIssues: 1,
      classAAutoRecovered: 0,
      classAOscillationCapped: 1,
    });

    const [afterThird] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(afterThird?.status).toBe("blocked");

    // Every capped tick extends the window, so the suppression is durable.
    expect(await selectClassACappedMarkers(blockedIssueId)).toHaveLength(2);
  });

  it("degrades to one action error instead of aborting the tick when a pre-loop loader throws", async () => {
    await enableAutoRecovery();
    const { coderId, issuePrefix, companyId } = await seedCompanyWithAgents();
    await insertBlockedIssueWithoutBlockerEdge({
      companyId,
      issuePrefix,
      issueNumber: 1,
      assigneeAgentId: coderId,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      title: "Blocked issue whose prescan will fail",
    });

    // Fail the two issue_recovery_actions reads the pre-loop loaders perform,
    // and only those. They used to sit outside all error handling: a throw there
    // aborted the whole reconciler while reporting actionErrors: 0, and took the
    // rest of the periodic heartbeat chain down with it. Later reads (the legacy
    // findings path) are left working so this test isolates the pre-loop hole
    // rather than blowing up the whole function.
    let recoveryActionReads = 0;
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "select" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...selectArgs: unknown[]) => {
          const builder = (value as (...args: unknown[]) => unknown).apply(target, selectArgs);
          return new Proxy(builder as object, {
            get(builderTarget, builderProp, builderReceiver) {
              const builderValue = Reflect.get(builderTarget, builderProp, builderReceiver);
              if (builderProp !== "from" || typeof builderValue !== "function") {
                return typeof builderValue === "function"
                  ? builderValue.bind(builderTarget)
                  : builderValue;
              }
              return (table: unknown, ...rest: unknown[]) => {
                if (table === issueRecoveryActions) {
                  recoveryActionReads += 1;
                  if (recoveryActionReads <= 2) {
                    throw new Error("simulated issue_recovery_actions read failure");
                  }
                }
                return (builderValue as (...args: unknown[]) => unknown)
                  .apply(builderTarget, [table, ...rest]);
              };
            },
          });
        };
      },
    }) as typeof db;

    const result = await heartbeatService(failingDb).reconcileIssueGraphLiveness();

    // Returned, not thrown: the caller's chain (silent-run scan, productivity
    // reviews) still runs, and the failure is visible because actionErrors is
    // in the reconciler log gate.
    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      actionErrors: 1,
      classBNudged: 0,
      classBEscalated: 0,
      classAAutoRecovered: 0,
    });
    // The injection really fired; otherwise this would assert nothing.
    expect(recoveryActionReads).toBeGreaterThanOrEqual(2);

    // No action was written for the issue that would otherwise have escalated,
    // i.e. this tick genuinely degraded rather than quietly half-succeeding.
    const recoveryActions = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(recoveryActions).toHaveLength(0);
  });

  it("routes a user-assigned class B nudge to a real owner instead of silently no-oping", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const projectId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const blockedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Control plane",
      status: "active",
      leadAgentId: managerId,
    });
    // Assigned to a human, so assigneeAgentId is null at the wake_assignee
    // stage. Before the fix this fell through to ownerType "board" and woke
    // nobody, indistinguishable from a nudge that reached someone.
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      projectId,
      title: "User-assigned blocked issue with no blocker edge",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: "founder-user-id",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt,
      updatedAt: blockedAt,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "founder-user-id",
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { identifier: `${issuePrefix}-1`, status: "blocked" },
      createdAt: blockedAt,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      missingEdgeIssues: 1,
      classBNudged: 1,
      classBBoardOnly: 0,
    });

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      ownerType: "agent",
      ownerAgentId: managerId,
    });

    const wakeups = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, managerId),
        ),
      );
    const ownerNudge = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.sourceIssueId === blockedIssueId &&
        payload?.recoveryCause === "issue_graph_liveness";
    });
    expect(ownerNudge).toBeDefined();
  });

  it("escalates on the createdAt fallback when no blocked-transition activity row exists", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const blockedAt = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    // Old issue, blocked an hour ago by a write path that does not put
    // `status` in the activity details, so there is no blocked-transition row
    // to read. The fallback is issues.createdAt — deliberately NOT
    // max(createdAt, updatedAt), because issues.addComment bumps updatedAt and
    // that made blocked-staleness a function of comment recency. createdAt
    // over-estimates staleness, so this escalates on a guess: one wake. The
    // opposite failure (a fallback timestamp cancelling a live action) is the
    // one that silently disables the detector, and is forbidden — see the
    // "never cancels an active escalation" test below.
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Old issue blocked a moment ago",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt,
      updatedAt: blockedAt,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: coderId,
      agentId: coderId,
      action: "issue.created",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { identifier: `${issuePrefix}-1`, status: "todo" },
      createdAt,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      missingEdgeIssues: 1,
      classBNudged: 0,
      classBEscalated: 1,
      classBNoop: 0,
      blockedEnteredAtFallbacks: 1,
    });

    const recoveryActions = await db
      .select({ evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(recoveryActions).toHaveLength(1);
    // The guess is recorded, not hidden: the action carries the source so a
    // human reading it can tell the age was inferred from createdAt.
    expect(recoveryActions[0]?.evidence).toMatchObject({
      blockedEnteredAt: createdAt.toISOString(),
      blockedEnteredAtSource: "fallback_created_at",
      stage: "escalate_owner",
    });
    expect(blockedAt.getTime()).toBeGreaterThan(createdAt.getTime());
  });

  it("treats child-only terminal gates as missing-edge work instead of auto-recovering", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const childIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Founder gate",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      },
      {
        id: childIssueId,
        companyId,
        parentId: blockedIssueId,
        title: "Upload one identity document",
        status: "done",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
        completedAt: staleTimestamp,
      },
    ]);

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      terminalOnlyIssues: 0,
      missingEdgeIssues: 1,
      classAAutoRecovered: 0,
      classBNudged: 1,
      classBEscalated: 0,
    });

    const [sourceIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceIssue?.status).toBe("blocked");

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockedIssueId),
        ),
      );
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      ownerAgentId: coderId,
      status: "active",
    });
  });

  it("leaves open direct blockers alone across runtime-state flips", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "todo",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first).toMatchObject({
      blockedIssuesScanned: 1,
      openNonTerminalIssues: 1,
      classAAutoRecovered: 0,
      classBNudged: 0,
      classBEscalated: 0,
      escalationsCreated: 0,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));

    const second = await heartbeat.reconcileIssueGraphLiveness();
    expect(second).toMatchObject({
      blockedIssuesScanned: 1,
      openNonTerminalIssues: 1,
      classAAutoRecovered: 0,
      classBNudged: 0,
      classBEscalated: 0,
      escalationsCreated: 0,
    });

    const [sourceIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceIssue?.status).toBe("blocked");

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockedIssueId),
        ),
      );
    expect(recoveryActions).toHaveLength(0);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      );
    expect(wakeups).toHaveLength(0);
  });

  it("creates one durable missing-edge recovery action and does not duplicate it on the next tick", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Blocked without a recorded blocker",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first).toMatchObject({
      blockedIssuesScanned: 1,
      missingEdgeIssues: 1,
      classBNudged: 1,
      classBEscalated: 0,
    });
    expect(second).toMatchObject({
      blockedIssuesScanned: 1,
      missingEdgeIssues: 1,
      classBNudged: 0,
      classBNoop: 1,
      classBEscalated: 0,
    });

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockedIssueId),
        ),
      );
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      ownerAgentId: coderId,
      status: "active",
    });

    const wakeups = await db
      .select({
        source: agentWakeupRequests.source,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, coderId),
        ),
      );
    const wake = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.issueId === blockedIssueId &&
        payload?.sourceIssueId === blockedIssueId &&
        payload?.recoveryCause === "issue_graph_liveness";
    });
    expect(wake).toMatchObject({
      source: "assignment",
      reason: "heartbeat.wakeOnDemand.disabled",
      status: "skipped",
      idempotencyKey: expect.stringContaining("issue_graph_liveness:"),
    });
  });

  it("measures missing-edge staleness from the last blocked transition, not comment-recency updatedAt", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const blockedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const recentCommentAt = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Chattery but stale blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt,
      updatedAt: recentCommentAt,
    });
    await db.insert(issueComments).values({
      issueId: blockedIssueId,
      companyId,
      body: "Heartbeat note that should not reset the blocked-age clock.",
      authorType: "agent",
      authorAgentId: coderId,
      createdAt: recentCommentAt,
      updatedAt: recentCommentAt,
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: coderId,
        agentId: coderId,
        action: "issue.created",
        entityType: "issue",
        entityId: blockedIssueId,
        details: {
          identifier: `${issuePrefix}-1`,
          status: "todo",
        },
        createdAt,
      },
      {
        companyId,
        actorType: "agent",
        actorId: coderId,
        agentId: coderId,
        action: "issue.updated",
        entityType: "issue",
        entityId: blockedIssueId,
        details: {
          identifier: `${issuePrefix}-1`,
          status: "blocked",
          _previous: {
            status: "todo",
          },
        },
        createdAt: blockedAt,
      },
    ]);

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      blockedIssuesScanned: 1,
      missingEdgeIssues: 1,
      classAAutoRecovered: 0,
      classBNudged: 1,
      classBEscalated: 0,
    });

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockedIssueId),
        ),
      );
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]?.evidence).toMatchObject({
      blockedEnteredAt: blockedAt.toISOString(),
      staleAgeMs: expect.any(Number),
      stage: "wake_assignee",
    });
  });

  it("creates one bounded escalation for an assigned backlog blocker leaf", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    expect(second.findings).toBe(0);
    expect(second.escalationsCreated).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: coderId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
  });

  it("creates one manager escalation, preserves blockers, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    const [sourceAfterFirst] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    const eventsAfterFirst = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(eventsAfterFirst.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);

    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(second.escalationsCreated).toBe(0);
    const [sourceAfterSecond] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceAfterSecond?.updatedAt.getTime()).toBe(sourceAfterFirst?.updatedAt.getTime());

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: {},
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("harness-level liveness incident");
    expect(comments[0]?.body).toContain(escalations[0]?.identifier ?? escalations[0]!.id);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryIssueId: blockerIssueId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceIssueId: blockerIssueId,
      },
      workspaceSelection: {
        reuseRecoveryExecutionWorkspace: false,
        inheritedExecutionWorkspaceFromIssueId: null,
        projectWorkspaceSourceIssueId: blockerIssueId,
      },
    });
    expect(events.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: issueTimestamp,
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("parents recovery under the leaf blocker without inheriting dependent or blocker execution state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      projectId: blockerProjectId,
      projectWorkspaceId: blockerProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: {},
    });
  });

  it("reuses one open recovery issue for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);

    const blockers = await db
      .select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.issueId, escalations[0]!.id)));
    expect(blockers.map((row) => row.blockedIssueId).sort()).toEqual(
      [blockedIssueId, secondBlockedIssueId].sort(),
    );
  });

  it("creates a fresh escalation when the previous matching escalation is terminal", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const closedEscalationId = randomUUID();

    await db.insert(issues).values({
      id: closedEscalationId,
      companyId,
      title: "Closed escalation",
      status: "done",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(0);

    const openEscalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.originId, incidentKey),
        ),
      );
    expect(openEscalations).toHaveLength(2);
    const freshEscalation = openEscalations.find((issue) => issue.status !== "done");
    expect(freshEscalation).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === closedEscalationId)).toBe(false);
    expect(blockers.some((row) => row.blockerIssueId === freshEscalation?.id)).toBe(true);
  });
});
