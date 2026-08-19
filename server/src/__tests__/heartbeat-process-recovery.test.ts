import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issueWorkProducts,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
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

import {
  heartbeatService,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
  PROCESS_LOST_RETRY_DELAYS_MS,
  PROCESS_LOST_RETRY_MAX_ATTEMPTS,
} from "../services/heartbeat.ts";
import {
  recoveryService,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  ORPHAN_BLOCKER_MENTION_HANDOFF_GRACE_MS,
} from "../services/recovery/index.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
        ),
      );

    if (activeRuns.length === 0) return;

    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by heartbeat-process-recovery test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, runIds));

    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Background recovery work (settling runs, deferred wakes, work-product
    // writes) can still insert rows during teardown despite the idle-waits
    // above — the shared reset truncates every table in one atomic statement
    // so there is no between-deletes window to race (AUR-5103).
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(environments).values({
      id: environmentId,
      companyId: input.companyId,
      name: "Local test environment",
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
    });

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function expectSourceScopedStrandedRecoveryAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    cause?: string;
    kind?: string;
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: input.kind ?? "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.agentId,
      returnOwnerAgentId: input.agentId,
      cause: input.cause ?? "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
    });
    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      retryReason: input.retryReason ?? null,
    });
    expect(action.nextAction).toContain(
      input.kind === "missing_disposition" ? "valid issue disposition" : "Restore a live execution path",
    );

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, input.issueId),
      ));
    expect(recoveryIssues).toHaveLength(0);

    const recoveryWakeup = await waitForValue(async () => {
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, input.agentId));
      return wakeups.find((wakeup) => {
        const payload = wakeup.payload as Record<string, unknown> | null;
        return payload?.issueId === input.issueId &&
          payload?.sourceIssueId === input.issueId &&
          payload?.recoveryActionId === action.id &&
          payload?.strandedRunId === input.runId;
      }) ?? null;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.any(Object),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
    });
    await waitForHeartbeatIdle(db);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    // AUR-4250: escalation only mints `blocked` when there are real unresolved blockers. Every
    // caller of this helper has none, so the source issue is left dispatchable under the recovery
    // owner. The genuinely-blocked path is covered by "still blocks stranded work that has a real
    // unresolved blocker", which asserts against the wake/action rows directly (a blocked issue
    // records its recovery wake as `issue_dependencies_blocked`/`skipped`, not as a dispatch).
    expect(sourceIssue?.status).toBe("todo");

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  // AUR-4250: put an already-escalated issue back in front of the sweep. Escalation now leaves
  // the issue dispatchable instead of `blocked`, so the 30s scheduler tick keeps seeing it as a
  // candidate; this reproduces the next tick with a fresh dead recovery run as its latest run.
  async function restrandEscalatedIssueForNextSweep(input: {
    companyId: string;
    agentId: string;
    issueId: string;
  }) {
    const followUpRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: followUpRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "assignment_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "process_lost",
      error: "recovery wake run died again",
    });
    await db
      .update(issues)
      .set({ status: "todo", checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, input.issueId));
    return followUpRunId;
  }

  async function strandedRecoveryActionFor(companyId: string, issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
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

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("schedules exactly one backoff retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const reapStartedAt = Date.now();
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.scheduledRetryReason).toBe("process_lost");
    expect(retryRun?.scheduledRetryAttempt).toBe(1);
    // Attempt 1 backs off 30s with ±50% jitter — never an immediate re-dispatch.
    const dueInMs = new Date(retryRun!.scheduledRetryAt!).getTime() - reapStartedAt;
    expect(dueInMs).toBeGreaterThanOrEqual(PROCESS_LOST_RETRY_DELAYS_MS[0] * 0.5 - 5_000);
    expect(dueInMs).toBeLessThanOrEqual(PROCESS_LOST_RETRY_DELAYS_MS[0] * 1.5 + 5_000);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("process_lost");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("escalates the issue when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: PROCESS_LOST_RETRY_MAX_ATTEMPTS,
    });
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });

    // AUR-4250: the only `blocks` edge here points at an already-`done` prerequisite, so there
    // is nothing unresolved to block on — the issue stays dispatchable under the recovery owner.
    const escalatedIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue && !issue.checkoutRunId && !issue.executionRunId ? issue : null;
      })
    );
    expect(escalatedIssue?.status).toBe("todo");
    expect(escalatedIssue?.executionRunId).toBeNull();
    expect(escalatedIssue?.checkoutRunId).toBeNull();
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    // AUR-4250: the edge to the already-`done` prerequisite is preserved. Escalation used to pass
    // `blockedByIssueIds: []`, which deleted every `blocks` relation including resolved ones.
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([resolvedBlockerId]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("returns failed recovery work to todo in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: PROCESS_LOST_RETRY_MAX_ATTEMPTS,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "todo" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: PROCESS_LOST_RETRY_MAX_ATTEMPTS,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.contextSnapshot).toMatchObject({
      codexTransientFallbackMode: "same_session",
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("queues one finish-handoff wake when a successful run leaves in-progress work without a next action", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented the backend detector, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented the backend detector, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);
    expect(handoffWakeups[0]?.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: runId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.authorType).toBe("system");
    expect(handoffComment?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    });
    expect(handoffComment?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Required action",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "run_link", runId }),
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          ]),
        }),
      ]),
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_required")).toBe(true);
  });

  it("requeues a missing-disposition handoff when the previous corrective wake was cancelled", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const idempotencyKey = `finish_successful_run_handoff:${issueId}:${runId}:1`;
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "finish_successful_run_handoff",
      payload: {
        issueId,
        sourceRunId: runId,
        handoffRequired: true,
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      },
      status: "cancelled",
      idempotencyKey,
      requestedAt: new Date("2026-03-19T00:00:01.000Z"),
      finishedAt: new Date("2026-03-19T00:00:02.000Z"),
      updatedAt: new Date("2026-03-19T00:00:02.000Z"),
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented recovery handling, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented recovery handling, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      const requeued = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return requeued.length > 1 ? requeued : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(2);
    expect(handoffWakeups.filter((wakeup) => wakeup.status === "cancelled")).toHaveLength(1);
    expect(handoffWakeups.some((wakeup) => wakeup.status !== "cancelled")).toBe(true);
  });

  it("queues one missing-disposition handoff for artifact-producing successful runs left in progress", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Drafted the Phase 3 test plan but did not choose a final issue disposition.",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Regression test plan",
        format: "markdown",
        latestBody: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Regression test plan",
        format: "markdown",
        body: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "report",
        provider: "test",
        externalId: "phase-3-report",
        title: "Phase 3 regression notes",
        status: "ready",
        summary: "Successful run produced a visible artifact.",
        createdByRunId: ctx.runId,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Created comments, a plan document, and a work product without choosing a disposition.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);
    const classifiedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(classifiedRun?.status ?? settledRun?.status).toBe("succeeded");
    expect(classifiedRun?.livenessState).toBe("advanced");
    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toHaveLength(1);
    expect(comments.some((comment) => comment.body.startsWith("Drafted the Phase 3 test plan"))).toBe(true);

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(1);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("redacts secret-bearing successful-run detected progress before handoff disclosure", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const bearerSecret = "live-bearer-token-value";
    const apiKeySecret = "sk-testsuccessfulhandoffsecret";
    const redactedDetectedSummary = redactDetectedSuccessfulRunProgressSummaryForBoard(
      `Next action noted: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      { enabled: false },
    );
    expect(redactedDetectedSummary).toContain("***REDACTED***");
    expect(redactedDetectedSummary).not.toContain(bearerSecret);
    expect(redactedDetectedSummary).not.toContain(apiKeySecret);

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Made progress but left the issue open.",
      resultJson: {
        message: `Next action: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      },
      provider: "test",
      model: "test-model",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    const wakeupPayloadText = JSON.stringify(handoffWakeups[0]?.payload ?? {});
    expect(wakeupPayloadText).not.toContain(bearerSecret);
    expect(wakeupPayloadText).not.toContain(apiKeySecret);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.body).not.toContain(bearerSecret);
    expect(handoffComment?.body).not.toContain(apiKeySecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(bearerSecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(apiKeySecret);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const handoffActivity = activity.find((event) => event.action === "issue.successful_run_handoff_required");
    expect(handoffActivity).toBeTruthy();
    const activityDetailsText = JSON.stringify(handoffActivity?.details ?? {});
    expect(activityDetailsText).not.toContain(bearerSecret);
    expect(activityDetailsText).not.toContain(apiKeySecret);
  });

  it("escalates an exhausted failed successful-run handoff without using generic continuation recovery first", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "adapter_failed",
      runError: "Authorization: Bearer sk-test-successful-handoff-secret",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      missingDisposition: "clear_next_step",
      latestRunStatus: "failed",
      latestRunErrorCode: "adapter_failed",
      recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-successful-handoff-secret");

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("todo");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0]?.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(comments[0]?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery owner",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Recovery action", value: recoveryAction.id }),
            expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CodexCoder" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
      ]),
    });
    expect(comments[0]?.body).not.toContain("sk-test-successful-handoff-secret");
    expect(JSON.stringify(comments[0]?.metadata ?? {})).not.toContain("sk-test-successful-handoff-secret");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_escalated")).toBe(true);
  });

  it("escalates an exhausted successful handoff run that still leaves no disposition", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      latestRunStatus: "succeeded",
      missingDisposition: "clear_next_step",
    });
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
    });
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
      });

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  // AUR-4647: before this fix, reconcileStrandedAssignedIssues had no
  // dependency-readiness check, so it re-called enqueueWakeup for the same
  // dependency-blocked issue on every scheduler tick forever -- the storm of
  // skipped/issue_dependencies_blocked wakes (AUR-4149 alone produced 481 of
  // them in ~2h). FIRE case: the blocker is still open, so recovery must not
  // redispatch at all this tick.
  it("suppresses stranded-todo recovery redispatch while the issue is dependency-blocked (AUR-4647 FIRE)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Open blocker",
      status: "todo",
      priority: "medium",
      issueNumber: 900,
      identifier: `${issuePrefix}-900`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const wakesBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.assignmentDispatched).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.dependencyBlockedSkipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const wakesAfter = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesAfter).toHaveLength(wakesBefore.length);
  });

  // PASS case: the same shape, but the blocker has resolved. Recovery must
  // still dispatch normally -- suppression must not become a permanent block.
  it("still dispatches stranded-todo recovery once the blocker resolves (AUR-4647 PASS)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Resolved blocker",
      status: "done",
      priority: "medium",
      issueNumber: 900,
      identifier: `${issuePrefix}-900`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dependencyBlockedSkipped).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun).toBeTruthy();
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("escalates assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-recovery-secret");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  // AUR-5466 group: an outage must not manufacture work that blames an agent. A retry
  // that died at the provider wall (NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES, minus the
  // process_lost carve-out) is lane evidence, not agent evidence — it requeues instead
  // of filing `stranded_assigned_issue`/`missing_disposition` against the assignee.
  it("requeues instead of escalating when the dispatch retry died at the provider wall (AUR-5466 FIRE)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "claude_auth_required",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.infraExcusedRequeued).toBe(1);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    // The core assertion: no blame filed against the assignee.
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(actions).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    // And a live execution path exists instead: the retry was requeued.
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("still escalates a genuine strand whose retry failed without a provider-wall code (AUR-5466 PASS)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      // The 08-06 outage also emitted `adapter_failed`, but that code covers adapter
      // bugs and config errors that re-running reproduces — it stays attributable.
      runErrorCode: "adapter_failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.infraExcusedRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
  });

  it("holds an infra-excused issue without requeueing while its lane is under an active quota pause (AUR-5466)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "claude_auth_required",
    });
    // An active quota pause on the same adapter lane: a scheduled_retry run carrying a
    // future transient horizon. Its context references a different issue so it does not
    // count as this issue's own execution path.
    const pauseHorizon = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: pauseHorizon,
      contextSnapshot: {
        issueId: randomUUID(),
        transientRetryNotBefore: pauseHorizon.toISOString(),
      },
      updatedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.infraPauseHeld).toBe(1);
    expect(result.infraExcusedRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    // No blame filed, and no new run manufactured into a lane that cannot execute it.
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(actions).toHaveLength(0);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.map((row) => row.status).sort()).toEqual(["failed", "scheduled_retry"]);
    expect(runs.some((row) => row.id === runId)).toBe(true);
  });

  it("requeues instead of filing missing_disposition when the exhausted handoff died at the provider wall (AUR-5466 FIRE)", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "claude_quota_exhausted",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffEscalated).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.infraExcusedRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(1);

    // The exhausted handoff never gave the agent a chance to record a disposition —
    // no `missing_disposition` blame, and a fresh continuation run instead.
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(actions).toHaveLength(0);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  // AUR-4250 regression group. Escalation used to write `status: "blocked"` with an empty
  // `blockedByIssueIds`, which per AUR-4257 drops the issue out of execution entirely — undoing
  // the invokable owner + enqueued wake it had just built. `blocked` was load-bearing only as a
  // loop-breaker, so it was replaced by a 24h recovery-action cooldown.
  it("does not mint a zero-edge `blocked` issue when stranded recovery escalates", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(recoveryAction.ownerAgentId).toBe(agentId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.status).not.toBe("blocked");
    expect(issue?.assigneeAgentId).toBe(recoveryAction.ownerAgentId);

    // The whole point: no `blocked` status, and no blocker edge that could justify one.
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const escalation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) =>
        rows.find((row) =>
          (row.details as Record<string, unknown> | null)?.source === "recovery.reconcile_stranded_assigned_issue"
        ) ?? null
      );
    expect(escalation?.details).toMatchObject({
      status: "todo",
      keptDispatchable: true,
      blockerIssueIds: [],
    });
  });

  it("suppresses immediate stranded recovery re-escalation while the recovery action is still warm", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    await expect(strandedRecoveryActionFor(companyId, issueId)).resolves.toMatchObject({ attemptCount: 1 });

    // Next scheduler tick, without advancing the clock: the issue is a candidate again.
    await restrandEscalatedIssueForNextSweep({ companyId, agentId, issueId });

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.escalated).toBe(0);
    expect(secondResult.issueIds).toEqual([]);
    expect(secondResult.skipped).toBeGreaterThanOrEqual(1);

    // No second attempt was recorded, so the wake idempotency key was not rotated and the
    // AUR-4168 durable `missing_edge` sweep is not re-suppressed.
    const action = await strandedRecoveryActionFor(companyId, issueId);
    expect(action?.attemptCount).toBe(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("re-escalates stranded recovery once the recovery action has gone dormant", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });

    await restrandEscalatedIssueForNextSweep({ companyId, agentId, issueId });

    // Push the action past the 24h dormancy window the cooldown keys on.
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const action = await strandedRecoveryActionFor(companyId, issueId);
    expect(action?.attemptCount).toBe(2);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    await waitForHeartbeatIdle(db);
  });

  // AUR-4250 convergence guard.
  //
  // Escalation used to write `status: "blocked"`, which removed the issue from the
  // `["todo","in_progress"]` candidate filter of `reconcileStrandedAssignedIssues` permanently.
  // It no longer does: a dispatchable stranded issue stays a candidate on every 30s scheduler
  // tick for ~3 days. That means the sweep's *other* wake-minting exits, which never had to be
  // loop-safe before, now run against the same issue repeatedly.
  //
  // They converge, and the bound is two wakes per escalation cycle:
  //
  //   tick 1 — `escalateStrandedAssignedIssue` mints the `source_scoped_recovery_action` wake.
  //   tick 2 — that wake's run carries no `retryReason`, so `didAutomaticRecoveryFail` is false
  //            and the sweep falls through to `enqueueStrandedIssueRecovery`, which mints one
  //            wake whose contextSnapshot carries `retryReason: "assignment_recovery"`.
  //   tick 3+ — that reason makes `didAutomaticRecoveryFail(latestRun, "assignment_recovery")`
  //            true, so the sweep re-enters `escalateStrandedAssignedIssue`, which short-circuits
  //            on the 24h recovery-action cooldown and returns null. Steady state until the
  //            action goes dormant a day later.
  //
  // The entire bound therefore rests on one string matching across two functions:
  // `enqueueStrandedIssueRecovery`'s `retryReason: "assignment_recovery"` and the literal
  // `didAutomaticRecoveryFail` keys on. Break that match and the handoff into the cooldown is
  // gone, the sweep never re-enters escalation, and every tick mints another wake forever. This
  // test is here so that regression fails loudly instead of shipping to the fleet.
  const MAX_WAKES_PER_ESCALATION_CYCLE = 2;

  it("converges to a bounded number of wakes when a dispatchable stranded issue stays a candidate", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });

    // Count at the mint boundary and model the worst case explicitly: every wake we mint is
    // claimed and its run dies, leaving the issue stranded again with that wake's contextSnapshot
    // as its new latest run. Driving the real heartbeat executor instead would fold in wakes this
    // sweep did not mint (process-loss retries, the same-name execution guard) and make the count
    // jitter, which would defeat the point of asserting a tight bound.
    const mintedWakes: { reason: string; retryReason: string | null }[] = [];
    let mintedRunSequence = 0;
    const recovery = recoveryService(db, {
      enqueueWakeup: (async (wakeAgentId: string, wake: any) => {
        const contextSnapshot = (wake?.contextSnapshot ?? {}) as Record<string, unknown>;
        mintedWakes.push({
          reason: String(wake?.reason),
          retryReason: (contextSnapshot.retryReason as string | undefined) ?? null,
        });
        mintedRunSequence += 1;
        // Fixed, strictly increasing timestamps: `getLatestIssueRun` orders by
        // `createdAt desc, id desc`, and random UUIDs would make a same-millisecond tie
        // non-deterministic.
        const mintedAt = new Date(Date.UTC(2030, 2, 19) + mintedRunSequence * 60_000);
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId: wakeAgentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "failed",
          contextSnapshot,
          startedAt: mintedAt,
          finishedAt: mintedAt,
          createdAt: mintedAt,
          updatedAt: mintedAt,
          errorCode: "process_lost",
          error: "recovery wake run died again",
        });
        return { id: runId };
      }) as never,
    });

    const TICKS = 5;
    const statusPerTick: (string | undefined)[] = [];
    const wakeCountPerTick: number[] = [];
    for (let tick = 0; tick < TICKS; tick += 1) {
      await recovery.reconcileStrandedAssignedIssues();
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      statusPerTick.push(issue?.status);
      wakeCountPerTick.push(mintedWakes.length);
    }

    // The bound, across all five ticks — not per tick.
    expect(mintedWakes.length).toBeLessThanOrEqual(MAX_WAKES_PER_ESCALATION_CYCLE);
    // ...and it is tight: the two wakes are exactly the escalation wake and the single
    // `assignment_recovery` requeue that hands the next tick into the cooldown.
    expect(mintedWakes).toEqual([
      { reason: "source_scoped_recovery_action", retryReason: null },
      { reason: "issue_assignment_recovery", retryReason: "assignment_recovery" },
    ]);
    // Minting stops rather than merely slowing down: nothing new after tick 2.
    expect(wakeCountPerTick).toEqual([1, 2, 2, 2, 2]);

    // No oscillation: escalation leaves the issue dispatchable and every later tick is a no-op,
    // so the status never flips (in particular it never falls back to a zero-edge `blocked`).
    expect(statusPerTick).toEqual(Array(TICKS).fill("todo"));
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    // One escalation, one attempt, one comment — the repeats were absorbed by the cooldown and
    // did not rotate the wake idempotency key or refresh the AUR-4168 sweep suppression.
    const action = await strandedRecoveryActionFor(companyId, issueId);
    expect(action).toMatchObject({ status: "active", attemptCount: 1, ownerAgentId: agentId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("still blocks stranded work that has a real unresolved blocker", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Genuinely unresolved prerequisite",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    // Composed with AUR-4647: the sweep's dependency-readiness gate runs before the
    // escalation branch, so while the blocker is still open the reconciler skips the issue
    // (edge-triggered — it escalates on the first tick after the blocker resolves) instead
    // of escalating it mid-blocked.
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.dependencyBlockedSkipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    // The zero-edge fix must not leak into the real-blocker case. When escalation does run
    // (heartbeat's retry-exhaustion promotion path calls `escalateStrandedAssignedIssue`
    // directly, without the sweep's dependency gate), an issue with a genuinely unresolved
    // blocker must still fall back to `blocked` and keep its edges.
    const recovery = recoveryService(db, {
      enqueueWakeup: (async () => null) as never,
    });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    const latestRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "todo",
      latestRun,
      comment: "Paperclip escalated this stranded issue for intervention.",
    });
    expect(updated?.status).toBe("blocked");

    const recoveryAction = await waitForValue(() => strandedRecoveryActionFor(companyId, issueId));
    expect(recoveryAction).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "active",
      ownerAgentId: agentId,
      attemptCount: 1,
    });

    const after = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(after?.status).toBe("blocked");
    // The blocker edge survives: escalation must not reconcile `blockedByIssueIds` to an empty list.
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([blockerIssueId]);

    const escalation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) =>
        rows.find((row) =>
          (row.details as Record<string, unknown> | null)?.source === "recovery.reconcile_stranded_assigned_issue"
        ) ?? null
      );
    expect(escalation?.details).toMatchObject({
      status: "blocked",
      keptDispatchable: false,
      blockerIssueIds: [blockerIssueId],
    });
  });

  it("returns an already stranded recovery issue to todo without creating a recovery child", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const sourceIssueId = randomUUID();
    const sourceRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original source issue",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue from previous adapter failure",
        parentId: sourceIssueId,
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
        originRunId: sourceRunId,
        originFingerprint: [
          "stranded_issue_recovery",
          companyId,
          sourceIssueId,
          sourceRunId,
        ].join(":"),
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]).toMatchObject({
      id: issueId,
      status: "todo",
      parentId: sourceIssueId,
      originId: sourceIssueId,
      originRunId: sourceRunId,
    });
    expect(recoveryIssues[0]?.checkoutRunId).toBeNull();
    expect(recoveryIssues[0]?.executionRunId).toBeNull();

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recoveryIssues[0]?.identifier}]`);
    expect(comments[0]?.body).toContain("Next action:");
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("does not reassign an unassigned blocker while a mention handoff to another agent is pending (AUR-5830 FIRE)", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "CTO",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "CTO Ops",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    // The in-flight half of a deliberate "unassigned + bracket-mention" handoff to a
    // specific other agent, requested well inside the grace window.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: mentionedAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId: blockerIssueId, commentId: randomUUID() },
      status: "queued",
      requestedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(0);
    expect(result.issueIds).not.toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBeNull();
    expect(blocker?.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments).toHaveLength(0);

    const creatorWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(creatorWakeups).toHaveLength(0);
  });

  it("still reassigns the blocker once the mention handoff grace window has elapsed (AUR-5830 PASS)", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "CTO",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "CTO Ops",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    // A mention wake that was never processed (agent crashed, paused, etc.) — old enough
    // that it has fallen outside the grace window, so it must not orphan the blocker forever.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: mentionedAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId: blockerIssueId, commentId: randomUUID() },
      status: "queued",
      requestedAt: new Date(Date.now() - ORPHAN_BLOCKER_MENTION_HANDOFF_GRACE_MS - 60_000),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, creatorAgentId), eq(agentWakeupRequests.reason, "issue_assigned")));
    expect(wakeups).toHaveLength(1);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("does not auto-assign an orphan blocker that already has a human assignee (AUR-3962 exemption regression)", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const humanUserId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Human-owned todo blocker",
        status: "todo",
        priority: "high",
        assigneeUserId: humanUserId,
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(0);
    expect(result.issueIds).not.toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeUserId).toBe(humanUserId);
    expect(blocker?.assigneeAgentId).toBeNull();
    expect(blocker?.status).toBe("todo");
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("escalates stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recoveryAction.evidence).toMatchObject({
      latestRunErrorCode: "adapter_exit_code",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("reuses the raced stranded recovery issue when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.attemptCount).toBeGreaterThanOrEqual(1);
    const recoveries = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, issueId),
      ));
    expect(recoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("returns stranded recovery issues to todo in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("todo");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure details were withheld from the issue thread");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("re-enqueues recovery when the latest in-progress continuation made progress but left no live path", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });

  it("escalates stranded in-progress work after a productive continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("automatically retried continuation");
    expect(comments[0]?.body).toContain("still has no live execution path");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("allows one productive-terminal recovery after regular continuation recovery made progress", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
  });

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });

  it("skips in_progress issues whose latest run was cancelled with issue_continuation_waiting_on_review", async () => {
    const { issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Cancelled because the continuation summary says the executor should wait for reviewer feedback",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParkedSkipped).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("skips in_progress issue whose recovery retry was cancelled with issue_continuation_waiting_on_review", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Cancelled because the continuation summary says the executor should wait for reviewer feedback",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParkedSkipped).toBe(1);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  // AUR-5102 (P0b): reconcileStrandedAssignedIssues decides off a candidates
  // snapshot taken at sweep start; under backlog a pass runs for minutes and the
  // issue may be cancelled/reassigned/re-dispatched in the meantime. The
  // at-enqueue revalidation must drop those stale dispatches (fire) without
  // suppressing a legitimate one (pass).
  describe("AUR-5102 recovery dispatch revalidation", () => {
    it("validates a genuinely stranded todo issue (pass case)", async () => {
      const { agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(true);
    });

    it("refuses a dispatch when the issue reached a terminal status since the snapshot", async () => {
      const { agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(false);
    });

    it("refuses a dispatch when the issue was reassigned since the snapshot", async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      const newAssigneeId = randomUUID();
      await db.insert(agents).values({
        id: newAssigneeId,
        companyId,
        name: "NewOwner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.update(issues).set({ assigneeAgentId: newAssigneeId }).where(eq(issues.id, issueId));
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(false);
    });

    it("refuses a dispatch when the issue already has a queued execution-path run", async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assignment_recovery" },
      });
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(false);
    });

    // The 2026-08-05 incident shape: an issue is cancelled while a slow sweep is
    // mid-pass, and the sweep then dispatches recovery for it off the stale
    // candidates row (18 wake-runs in one minute for one cancelled issue).
    // Simulated deterministically: two stranded issues in one company; when the
    // sweep dispatches the first, the "operator" cancels the other; the sweep
    // must then refuse the second dispatch instead of waking a cancelled issue.
    it("drops a dispatch for an issue cancelled mid-sweep (fire case, via the public reconciler)", async () => {
      const first = await seedStrandedIssueFixture({ status: "todo", runStatus: "failed" });
      // Second stranded issue in the SAME company/agent so one sweep sees both.
      const issueBId = randomUUID();
      const runBId = randomUUID();
      const issuePrefix = `T${first.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: issueBId,
        companyId: first.companyId,
        title: "Second stranded issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: first.agentId,
        issueNumber: 90,
        identifier: `${issuePrefix}-90`,
      });
      await db.insert(heartbeatRuns).values({
        id: runBId,
        companyId: first.companyId,
        agentId: first.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId: issueBId, taskId: issueBId, wakeReason: "issue_assigned" },
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt: new Date("2026-03-19T00:05:00.000Z"),
        errorCode: "process_lost",
        error: "run failed before issue advanced",
      });

      const dispatched: string[] = [];
      const recovery = recoveryService(db, {
        enqueueWakeup: (async (_wakeAgentId: string, wake: any) => {
          const wakeIssueId = String((wake?.payload as Record<string, unknown>)?.issueId ?? "");
          dispatched.push(wakeIssueId);
          if (dispatched.length === 1) {
            // Concurrent actor cancels the OTHER stranded issue mid-sweep.
            const otherId = wakeIssueId === first.issueId ? issueBId : first.issueId;
            await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, otherId));
          }
          return { id: randomUUID() };
        }) as never,
      });

      await recovery.reconcileStrandedAssignedIssues();

      // Exactly one dispatch: the second issue was cancelled before its enqueue
      // and the revalidation refused it.
      expect(dispatched).toHaveLength(1);
    });
  });

  // AUR-5846: an issue that owns a `reuse_and_rewake` routine never gets woken
  // directly by that routine (the routine fires against its own separate
  // routine_execution issue instead), so hasActiveExecutionPath used to always
  // miss it between fires even though the routine will legitimately re-fire
  // later. This widened hasActiveExecutionPath to also treat a still-active
  // owning routine (routines.parentIssueId) as a live path. Exercised through
  // isRecoveryDispatchStillValid, one of the two call sites, the same way the
  // AUR-5102 suite above exercises the pre-existing branches.
  describe("AUR-5846 hasActiveExecutionPath via owning routine", () => {
    it("treats a still-active owning routine as a live path (positive case)", async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      await db.insert(routines).values({
        id: randomUUID(),
        companyId,
        parentIssueId: issueId,
        title: "Owning routine (AUR-5846 fixture)",
        status: "active",
      });
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(false);
    });

    it("does not treat a paused owning routine as a live path (negative case)", async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "todo",
        runStatus: "failed",
      });
      await db.insert(routines).values({
        id: randomUUID(),
        companyId,
        parentIssueId: issueId,
        title: "Paused owning routine (AUR-5846 fixture)",
        status: "paused",
      });
      const recovery = recoveryService(db, { enqueueWakeup: (async () => null) as never });
      await expect(
        recovery.isRecoveryDispatchStillValid({ issueId, agentId, expectedStatus: "todo" }),
      ).resolves.toBe(true);
    });
  });

  // AUR-5102 (P1): the unclaimability gauntlet must run on the periodic sweep,
  // not only at admission — with the global cap saturated 100% of the time,
  // admission never ran it and stale queued runs sat until operator trims.
  describe("AUR-5102 reapUnclaimableQueuedRuns", () => {
    async function seedQueuedRunFixture(input: {
      issueStatus: "todo" | "cancelled";
      withUnresolvedBlocker?: boolean;
    }) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Queued work",
        status: input.issueStatus,
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
      if (input.withUnresolvedBlocker) {
        const blockerIssueId = randomUUID();
        await db.insert(issues).values({
          id: blockerIssueId,
          companyId,
          title: "Unresolved prerequisite",
          status: "todo",
          priority: "medium",
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        });
        await db.insert(issueRelations).values({
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: issueId,
          type: "blocks",
        });
      }
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });
      return { companyId, agentId, issueId, runId, wakeupRequestId };
    }

    it("reaps a queued run against a terminal issue even while the global cap is saturated", async () => {
      const fixture = await seedQueuedRunFixture({ issueStatus: "cancelled" });
      // Saturate the global concurrency ceiling well past its 2..12 clamp so the
      // admission path could never have run the gauntlet for this queued run.
      const saturationRunIds: string[] = [];
      for (let i = 0; i < 16; i += 1) {
        const saturationRunId = randomUUID();
        saturationRunIds.push(saturationRunId);
        await db.insert(heartbeatRuns).values({
          id: saturationRunId,
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "running",
          contextSnapshot: {},
          startedAt: new Date(),
        });
      }
      try {
        const heartbeat = heartbeatService(db);
        const result = await heartbeat.reapUnclaimableQueuedRuns();
        expect(result.reaped).toBeGreaterThanOrEqual(1);

        const run = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, fixture.runId))
          .then((rows) => rows[0] ?? null);
        expect(run?.status).toBe("cancelled");
        expect(run?.errorCode).toBe("issue_terminal_status");

        const wake = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId))
          .then((rows) => rows[0] ?? null);
        expect(wake?.status).toBe("skipped");
      } finally {
        // Drop the synthetic saturation rows so afterEach idle-polling does not
        // spend its budget cancelling them one by one.
        await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, saturationRunIds));
      }
    });

    it("reaps a dependency-blocked queued run", async () => {
      const fixture = await seedQueuedRunFixture({ issueStatus: "todo", withUnresolvedBlocker: true });
      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapUnclaimableQueuedRuns();
      expect(result.reaped).toBeGreaterThanOrEqual(1);

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("issue_dependencies_blocked");
    });

    it("leaves a healthy queued run untouched (pass case)", async () => {
      const fixture = await seedQueuedRunFixture({ issueStatus: "todo" });
      const heartbeat = heartbeatService(db);
      await heartbeat.reapUnclaimableQueuedRuns();

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("queued");
    });
  });
});
