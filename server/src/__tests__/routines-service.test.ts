import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("filters listed routines by project", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other routines",
      status: "in_progress",
    });
    const otherRoutine = await svc.create(
      companyId,
      {
        projectId: otherProjectId,
        goalId: null,
        parentIssueId: null,
        title: "other project routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const projectRoutines = await svc.list(companyId, { projectId });
    const allRoutines = await svc.list(companyId);

    expect(projectRoutines.map((entry) => entry.id)).toEqual([routine.id]);
    expect(allRoutines.map((entry) => entry.id)).toEqual(expect.arrayContaining([routine.id, otherRoutine.id]));
  });

  // AUR-5001: this used to mint a fresh duplicate umbrella every tick because
  // findLiveExecutionIssue only recognizes an issue bound to a LIVE heartbeat run —
  // an open-but-idle issue (no live run) fell through and got duplicated. Fixed:
  // reuse + re-wake the idle issue instead of duplicating it (67 zombies in 3 days
  // on the live fleet before this fix).
  it("reuses the previous routine issue when it is open but idle instead of duplicating it", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(wakeups.some((w) => w.agentId === routine.assigneeAgentId)).toBe(true);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("dispatches a fresh execution issue when no open routine issue exists (PASSES — fix does not make the routine inert)", async () => {
    const { routine, svc } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(run.linkedIssueId);
  });

  it("reuses a stranded blocked execution issue with no live run and reopens it to todo (FIRES, coalesce_if_active)", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const previousRunId = randomUUID();
    const strandedIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "failed",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: strandedIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBe(strandedIssue.id);
    expect(wakeups.some((w) => w.agentId === routine.assigneeAgentId)).toBe(true);

    const [reopened] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, strandedIssue.id));
    expect(reopened?.status).toBe("todo");

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(1);
  });

  it("reuses a stranded blocked execution issue with no live run instead of silently skipping the tick (FIRES, skip_if_active)", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const strandedIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });
    // Must re-wake, not silently skip — a stranded skip_if_active issue would
    // otherwise permanently suppress the routine even after it could recover.
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBe(strandedIssue.id);
    expect(wakeups.some((w) => w.agentId === routine.assigneeAgentId)).toBe(true);

    const [reopened] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, strandedIssue.id));
    expect(reopened?.status).toBe("todo");

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(1);
  });

  // Guards the opposite failure mode from the two FIRES cases above: widening reuse must
  // not convert a legitimately-blocked umbrella into a dispatched one. A real unresolved
  // `blocks` edge still suppresses execution — we reuse the issue (so no duplicate is
  // minted) but leave it `blocked` and do not wake it. The blocker going `done` is what
  // releases it, which is exactly what a first-class blocker is for.
  it("reuses but does NOT reopen or wake an execution issue held by a real unresolved blocker", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const blockerIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "real blocker",
      description: "still open",
      status: "todo",
      priority: routine.priority,
    });
    const blockedIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssue.id,
      relatedIssueId: blockedIssue.id,
      type: "blocks",
    });

    const wakeupsBefore = wakeups.length;
    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    // Reused, not duplicated.
    expect(run.linkedIssueId).toBe(blockedIssue.id);
    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(1);

    // ...but still suppressed: status untouched and no wake queued.
    const [stillBlocked] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssue.id));
    expect(stillBlocked?.status).toBe("blocked");
    expect(wakeups.length).toBe(wakeupsBefore);

    // A tick that dispatched NOTHING must be recorded as a fold, not as a dispatch.
    // Recording `issue_created` here would reset consecutiveCoalesceCount to 0 every
    // tick and permanently disarm the AUR-4373 wedge guard for exactly the routines
    // that are stranded — the routine would go dark with green telemetry.
    expect(run.status).toBe("coalesced");
    const [afterOne] = await db
      .select({ count: routines.consecutiveCoalesceCount })
      .from(routines)
      .where(eq(routines.id, routine.id));
    expect(afterOne?.count).toBe(1);

    // ...and the counter must keep CLIMBING across ticks, which is what lets the
    // wedge guard fire at 2 and each doubling.
    const second = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(second.status).toBe("coalesced");
    const [afterTwo] = await db
      .select({ count: routines.consecutiveCoalesceCount })
      .from(routines)
      .where(eq(routines.id, routine.id));
    expect(afterTwo?.count).toBe(2);
  });

  // AUR-5466 (E) group: a routine must never keep more than one open execution
  // umbrella. The reuse finders above are fingerprint-scoped, so a daily routine that
  // interpolates a date into its title mints a new fingerprint every occurrence and
  // yesterday's still-open umbrella is invisible to them (the open-umbrella unique
  // index is also per-fingerprint since migration 0062, so nothing at the DB layer
  // stops the pile-up — 5 accrued on one routine during the 08-06 outage). The new
  // dispatch supersedes and cancels the stale ones.
  it("collapses stale open umbrellas from earlier fingerprints when a new occurrence dispatches (AUR-5466 FIRE)", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const staleDayOne = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: `${routine.title} — day 1`,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "occurrence-day-1",
    });
    const staleDayTwo = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: `${routine.title} — day 2`,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "occurrence-day-2",
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(run.linkedIssueId).not.toBe(staleDayOne.id);
    expect(run.linkedIssueId).not.toBe(staleDayTwo.id);

    const staleRows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, [staleDayOne.id, staleDayTwo.id]));
    expect(staleRows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);

    const [target] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(target?.status).toBe("todo");

    const staleComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, staleDayOne.id));
    expect(staleComments.some((row) => row.body.includes("superseded stale routine umbrella"))).toBe(true);
    expect(staleComments.some((row) => row.body.includes(run.linkedIssueId!))).toBe(true);
  });

  it("leaves a stale umbrella held by a real unresolved blocker open when a new occurrence dispatches (AUR-5466 PASS)", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const blockerIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "real blocker",
      description: "still open",
      status: "todo",
      priority: routine.priority,
    });
    const heldUmbrella = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: `${routine.title} — held`,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "occurrence-held",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssue.id,
      relatedIssueId: heldUmbrella.id,
      type: "blocks",
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(heldUmbrella.id);

    // Held by a real dependency: superseding must not cancel it out from under the blocker.
    const [held] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, heldUmbrella.id));
    expect(held?.status).toBe("blocked");
  });

  it("does not collapse umbrellas for always_enqueue routines (AUR-5466 PASS)", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    await db
      .update(routines)
      .set({ concurrencyPolicy: "always_enqueue" })
      .where(eq(routines.id, routine.id));
    const priorUmbrella = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: `${routine.title} — parallel`,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "occurrence-parallel",
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(priorUmbrella.id);

    // Parallel umbrellas are by design under always_enqueue.
    const [prior] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, priorUmbrella.id));
    expect(prior?.status).toBe("todo");
  });

  // The mirror of the `blocked` FIRES case, and the more dangerous one: `backlog` is
  // also in OPEN_ISSUE_STATUSES so it is matched as a stranded umbrella, but
  // queueIssueAssignmentWakeup hard-returns on `backlog` BEFORE queueing anything —
  // so reopening only `blocked` left a backlog umbrella reused-but-never-woken on
  // every tick, forever, with no wake, no throw and no error. Permanent suppression,
  // silently. Reopening `backlog` too is what makes the re-wake actually reach it.
  it("reuses a stranded backlog execution issue, reopens it to todo and wakes it (FIRES, backlog)", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const strandedIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "backlog",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.linkedIssueId).toBe(strandedIssue.id);
    const [reopened] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, strandedIssue.id));
    expect(reopened?.status).toBe("todo");
    expect(wakeups.some((w) => w.agentId === routine.assigneeAgentId)).toBe(true);
    expect(run.status).toBe("issue_created");

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(1);
  });

  it("always_enqueue keeps duplicating even when a stranded blocked issue exists (unchanged behaviour)", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    await db
      .update(routines)
      .set({ concurrencyPolicy: "always_enqueue" })
      .where(eq(routines.id, routine.id));

    const strandedIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(strandedIssue.id);

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(2);
  });

  it("threads a routine's assigneeAdapterOverrides onto its execution issue", async () => {
    const { companyId, projectId, agentId, svc } = await seedFixture();

    const cheapRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "cheap-lane routine",
        description: "Runs on the cheap model profile",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      },
      {},
    );
    expect(cheapRoutine.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });

    const run = await svc.runRoutine(cheapRoutine.id, { source: "manual" });
    const [issue] = await db
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId as string));
    expect(issue.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
  });

  it("leaves assigneeAdapterOverrides null on execution issues for routines that don't opt in", async () => {
    const { routine, svc } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [issue] = await db
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId as string));
    expect(issue.assigneeAdapterOverrides).toBeNull();
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("creates revision 1 on routine create and appends revisions for real updates only", async () => {
    const { routine, svc } = await seedFixture();

    const initialRevisions = await svc.listRevisions(routine.id);
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toMatchObject({
      id: routine.latestRevisionId,
      revisionNumber: 1,
      title: "ascii frog",
      changeSummary: "Created routine",
    });
    expect(initialRevisions[0]?.snapshot.routine.description).toBe("Run the frog routine");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: routine.latestRevisionId,
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.latestRevisionId).not.toBe(routine.latestRevisionId);

    const noOp = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[1]?.snapshot.routine.description).toBe("Run the frog routine");
  });

  it("persists assigneeAdapterOverrides set via routine update", async () => {
    const { routine, svc } = await seedFixture();
    expect(routine.assigneeAdapterOverrides).toBeNull();

    const updated = await svc.update(
      routine.id,
      { assigneeAdapterOverrides: { modelProfile: "cheap" } },
      {},
    );
    expect(updated?.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });

    const reloaded = await svc.getDetail(routine.id);
    expect(reloaded?.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
  });

  it("rejects stale routine baseRevisionId updates", async () => {
    const { routine, svc } = await seedFixture();
    const updated = await svc.update(routine.id, { description: "new description" }, {});
    await expect(
      svc.update(routine.id, {
        title: "stale update",
        baseRevisionId: routine.latestRevisionId,
      }, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: updated?.latestRevisionId,
      },
    });
  });

  it("restores an older routine revision append-only and preserves run history", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const revision2Routine = await svc.update(routine.id, { description: "revision 2" }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("rejects restoring the current latest routine revision", async () => {
    const { routine, svc } = await seedFixture();

    await expect(
      svc.restoreRevision(routine.id, routine.latestRevisionId!, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: routine.latestRevisionId,
      },
    });
  });

  it("recreates deleted webhook trigger secrets when restoring a historical revision", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    await svc.deleteTrigger(created.trigger.id, {});

    const restored = await svc.restoreRevision(routine.id, created.revision.id, {});

    expect(restored.secretMaterials).toHaveLength(1);
    expect(restored.secretMaterials[0]).toMatchObject({
      triggerId: created.trigger.id,
    });
    expect(restored.secretMaterials[0]?.webhookSecret).toBeTruthy();
    expect(restored.secretMaterials[0]?.webhookUrl).toContain("/api/routine-triggers/public/");

    const restoredTrigger = await svc.getTrigger(created.trigger.id);
    expect(restoredTrigger?.secretId).toBeTruthy();
    expect(restoredTrigger?.publicId).toBeTruthy();
    expect(restoredTrigger?.publicId).not.toBe(created.trigger.publicId);
  });

  it("blocks agents from restoring routine revisions assigned to another agent", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revision1Id = routine.latestRevisionId!;

    await svc.update(routine.id, { assigneeAgentId: otherAgentId }, {});

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { agentId: otherAgentId }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agents can only restore routine revisions assigned to themselves",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: otherAgentId,
      latestRevisionNumber: 2,
    });
  });

  it("blocks restoring routine revisions assigned to agents that are no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    await svc.update(routine.id, { description: "revision 2" }, {});
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
    });
  });

  it("appends safe trigger metadata revisions without leaking webhook secrets", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    expect(created.revision.revisionNumber).toBe(2);
    expect(created.secretMaterial?.webhookSecret).toBeTruthy();

    const updated = await svc.updateTrigger(created.trigger.id, { label: "deploy hook" }, {});
    expect(updated?.revision.revisionNumber).toBe(3);

    const rotated = await svc.rotateTriggerSecret(created.trigger.id, {});
    expect(rotated.revision.revisionNumber).toBe(4);
    expect(rotated.secretMaterial.webhookSecret).toBeTruthy();

    const deleted = await svc.deleteTrigger(created.trigger.id, {});
    expect(deleted.revision?.revisionNumber).toBe(5);

    const revisions = await svc.listRevisions(routine.id);
    const serialized = JSON.stringify(revisions.map((revision) => revision.snapshot));
    expect(serialized).toContain(created.trigger.publicId!);
    expect(serialized).not.toContain(created.secretMaterial!.webhookSecret);
    expect(serialized).not.toContain(rotated.secretMaterial.webhookSecret);
    expect(serialized).not.toContain(created.trigger.secretId!);
    expect(revisions[0]?.snapshot.triggers).toHaveLength(0);
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("records the manual board runner on fresh routine issues so they appear in that user's inbox", async () => {
    const { companyId, agentId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [createdIssue] = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  async function seedWedgedRoutineIssue(fixture: {
    agentId: string;
    companyId: string;
    issueSvc: ReturnType<typeof issueService>;
    routine: { id: string; projectId: string | null; title: string; description: string | null; priority: string; assigneeAgentId: string | null };
  }) {
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await fixture.issueSvc.create(fixture.companyId, {
      projectId: fixture.routine.projectId,
      title: fixture.routine.title,
      description: fixture.routine.description,
      status: "in_progress",
      priority: fixture.routine.priority,
      assigneeAgentId: fixture.routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: fixture.routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId: fixture.companyId,
      routineId: fixture.routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    return { previousIssue, previousRunId, liveHeartbeatRunId };
  }

  async function readCoalesceState(routineId: string, issueId: string) {
    const [routineRow] = await db
      .select({ consecutiveCoalesceCount: routines.consecutiveCoalesceCount })
      .from(routines)
      .where(eq(routines.id, routineId));
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return { count: routineRow?.consecutiveCoalesceCount, comments };
  }

  it("raises a coalesce anomaly on the second consecutive fold and stays silent on the first", async () => {
    const fixture = await seedFixture();
    const { previousIssue } = await seedWedgedRoutineIssue(fixture);
    const { routine, svc } = fixture;

    const first = await svc.runRoutine(routine.id, { source: "manual" });
    expect(first.status).toBe("coalesced");
    let state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(1);
    expect(state.comments).toHaveLength(0);

    const second = await svc.runRoutine(routine.id, { source: "manual" });
    expect(second.status).toBe("coalesced");
    state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(2);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.authorType).toBe("system");
    expect(state.comments[0]?.body).toContain("2 consecutive fires coalesced");
    expect(state.comments[0]?.body).toContain(routine.title);
    expect(state.comments[0]?.body).toContain("none on record");

    const anomalyLogs = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.coalesce_anomaly"));
    expect(anomalyLogs).toHaveLength(1);
    expect(anomalyLogs[0]?.entityId).toBe(previousIssue.id);

    // Third fold is not a doubling point: counter advances, no new comment.
    const third = await svc.runRoutine(routine.id, { source: "manual" });
    expect(third.status).toBe("coalesced");
    state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(3);
    expect(state.comments).toHaveLength(1);

    // Fourth fold doubles: a fresh comment lands.
    const fourth = await svc.runRoutine(routine.id, { source: "manual" });
    expect(fourth.status).toBe("coalesced");
    state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(4);
    expect(state.comments).toHaveLength(2);
  });

  it("resets the consecutive coalesce counter when a fire dispatches fresh work", async () => {
    const fixture = await seedFixture();
    const { previousIssue } = await seedWedgedRoutineIssue(fixture);
    const { routine, svc } = fixture;

    const folded = await svc.runRoutine(routine.id, { source: "manual" });
    expect(folded.status).toBe("coalesced");
    let state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(1);
    expect(state.comments).toHaveLength(0);

    const completedAt = new Date("2026-03-21T09:00:00.000Z");
    await db
      .update(issues)
      .set({ status: "done", completedAt, updatedAt: completedAt })
      .where(eq(issues.id, previousIssue.id));

    const dispatched = await svc.runRoutine(routine.id, { source: "manual" });
    expect(dispatched.status).toBe("issue_created");
    expect(dispatched.linkedIssueId).not.toBe(previousIssue.id);
    state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(0);
    expect(state.comments).toHaveLength(0);

    const detail = await svc.getDetail(routine.id);
    expect(detail?.consecutiveCoalesceCount).toBe(0);
    expect(detail?.lastSuccessfulCompletionAt?.toISOString()).toBe(completedAt.toISOString());
  });

  it("touches a coalesced routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("touches a skipped active routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("does not coalesce live routine runs with different resolved variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "pre-pr for {{branch}}",
        description: "Create a pre-PR from {{branch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "branch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const first = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/a" },
    });
    const second = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/b" },
    });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originId, variableRoutine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.title).sort()).toEqual([
      "pre-pr for feature/a",
      "pre-pr for feature/b",
    ]);
    expect(new Set(routineIssues.map((issue) => issue.originFingerprint)).size).toBe(2);
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("auto-populates workspaceBranch from a reused isolated workspace", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
      branchName: "pap-1634-routine-branch",
    });

    const branchRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Review {{workspaceBranch}}",
        description: "Use branch {{workspaceBranch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const run = await svc.runRoutine(branchRoutine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("Review pap-1634-routine-branch");
    expect(storedIssue?.description).toBe("Use branch pap-1634-routine-branch");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("computes a real nextRunAt for a midnight-hour schedule (regression: en-US hour12:false formats 00:00 as '24', never matching hour 0)", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "daily-midnight",
      cronExpression: "30 0 * * *",
      timezone: "UTC",
    }, {});
    expect(trigger.nextRunAt).not.toBeNull();
    expect(trigger.nextRunAt!.getUTCHours()).toBe(0);
    expect(trigger.nextRunAt!.getUTCMinutes()).toBe(30);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("uses the configured provider for generated webhook trigger secrets", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") {
        return originalGetSecretProvider(provider);
      }
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v1" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v1",
        }),
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v2",
        }),
        linkExternalSecret: async ({ externalRef, providerVersionRef }) => ({
          material: { source: "external", secretId: externalRef, versionId: providerVersionRef ?? null },
          valueSha256: "external",
          fingerprintSha256: "external",
          externalRef,
          providerVersionRef: providerVersionRef ?? null,
        }),
        resolveVersion: async () => "resolved-secret",
        deleteOrArchive: async () => undefined,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { routine, svc } = await seedFixture();
      const { trigger } = await svc.createTrigger(
        routine.id,
        {
          kind: "webhook",
          signingMode: "hmac_sha256",
          replayWindowSec: 300,
        },
        {},
      );

      const [secret] = await db
        .select({
          id: companySecrets.id,
          provider: companySecrets.provider,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trigger.secretId!));

      expect(secret).toMatchObject({
        id: trigger.secretId,
        provider: "aws_secrets_manager",
      });
    } finally {
      getSecretProviderSpy.mockRestore();
    }
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("reuse_and_rewake creates a fresh issue on first fire", async () => {
    const { companyId, agentId, projectId, svc, wakeups } = await seedFixture();
    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog",
        description: "Watchdog that reuses its issue",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.opts.reason).toBe("issue_assigned");

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, rollingRoutine.id));
    expect(allIssues).toHaveLength(1);
  });

  it("reuse_and_rewake rewakes the open rolling issue without creating a new one", async () => {
    const { companyId, agentId, projectId, svc, issueSvc, wakeups } = await seedFixture();
    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    // First fire creates the issue
    const run1 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run1.status).toBe("issue_created");
    const rollingIssueId = run1.linkedIssueId!;

    // Second fire must reuse the same issue
    const run2 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run2.status).toBe("issue_created");
    expect(run2.linkedIssueId).toBe(rollingIssueId);

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, rollingRoutine.id));
    expect(allIssues).toHaveLength(1);
    expect(wakeups).toHaveLength(2);
  });

  it("reuse_and_rewake reopens a closed rolling issue instead of spawning a new one", async () => {
    const { companyId, agentId, projectId, svc, issueSvc, wakeups } = await seedFixture();
    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    // First fire creates the issue
    const run1 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    const rollingIssueId = run1.linkedIssueId!;

    // Simulate agent marking the issue done
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, rollingIssueId));

    // Second fire must reopen the same issue, not create a new one
    const run2 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run2.status).toBe("issue_created");
    expect(run2.linkedIssueId).toBe(rollingIssueId);

    const [reopenedIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, rollingIssueId));
    expect(reopenedIssue?.status).toBe("todo");

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, rollingRoutine.id));
    expect(allIssues).toHaveLength(1);
  });

  it("reuse_and_rewake reuses the open issue even when a closed one was updated more recently", async () => {
    const { companyId, agentId, projectId, issueSvc, svc } = await seedFixture();
    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    // First fire creates the live (open) rolling issue.
    const run1 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    const openIssueId = run1.linkedIssueId!;

    // Legacy churn: a stale closed execution issue exists and was touched MORE
    // recently than the open one (mirrors the pre-reform backlog of done issues).
    const staleClosed = await issueSvc.create(companyId, {
      projectId,
      title: "stale closed execution issue",
      description: null,
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: rollingRoutine.id,
      originRunId: randomUUID(),
    });
    const newer = new Date(Date.now() + 60_000);
    await db.update(issues).set({ updatedAt: newer }).where(eq(issues.id, staleClosed.id));
    await db.update(issues).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(issues.id, openIssueId));

    // Next fire must reuse the OPEN issue, not reopen the more-recent closed one.
    const run2 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run2.status).toBe("issue_created");
    expect(run2.linkedIssueId).toBe(openIssueId);

    const [staleAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, staleClosed.id));
    expect(staleAfter?.status).toBe("done");

    const openIssues = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.originId, rollingRoutine.id));
    const stillOpen = openIssues.filter((i) =>
      ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(i.status),
    );
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.id).toBe(openIssueId);
  });

  it("reuse_and_rewake does not affect other concurrency policies", async () => {
    const { routine, svc } = await seedFixture();
    // default concurrencyPolicy is coalesce_if_active — confirm it still creates fresh issues
    const run1 = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run1.status).toBe("issue_created");

    // Mark done so engine sees no live issue
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, run1.linkedIssueId!));

    const run2 = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run2.status).toBe("issue_created");
    expect(run2.linkedIssueId).not.toBe(run1.linkedIssueId);

    const allIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(allIssues).toHaveLength(2);
  });

  async function readAlarmIssues(companyId: string, routineId: string) {
    const alarmIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_coalesce_alarm"), eq(issues.originId, routineId)));
    return alarmIssues;
  }

  // AUR-5387 Defect 2 (FIRES): a reuse_and_rewake umbrella that gets re-waked into
  // a lane that never actually completes the work must still count toward the
  // wedge counter — it used to reset to 0 on every rewake (isCoalesceAnomalyRaisePoint
  // could never fire), which is exactly the AUR-3504 shape: 50 comments, 0 alarms,
  // 25 dark days. This also exercises Defect 1: the alarm must land on a live agent,
  // not just as a comment on the wedged issue itself.
  it("reuse_and_rewake: repeated rewakes into a non-completing lane raise the wedge alarm on a live agent (AUR-5387 FIRES)", async () => {
    const { companyId, agentId, projectId, svc, wakeups } = await seedFixture();
    const ctoAgentId = randomUUID();
    await db.insert(agents).values({
      id: ctoAgentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog that never completes",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    // Fire 1: no prior rolling issue — genuine dispatch, counter stays 0.
    const run1 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run1.status).toBe("issue_created");
    const rollingIssueId = run1.linkedIssueId!;
    let [routineRow] = await db.select().from(routines).where(eq(routines.id, rollingRoutine.id));
    expect(routineRow?.consecutiveCoalesceCount).toBe(0);
    expect(await readAlarmIssues(companyId, rollingRoutine.id)).toHaveLength(0);

    // The wedged lane never completes the issue — it just re-wakes on every fire.
    // Fire 2: fold #1, below the raise threshold.
    const run2 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run2.status).toBe("issue_created");
    expect(run2.linkedIssueId).toBe(rollingIssueId);
    [routineRow] = await db.select().from(routines).where(eq(routines.id, rollingRoutine.id));
    expect(routineRow?.consecutiveCoalesceCount).toBe(1);
    expect(await readAlarmIssues(companyId, rollingRoutine.id)).toHaveLength(0);

    // Fire 3: fold #2 — raise point. This is the case that was previously
    // unreachable for reuse_and_rewake, because the counter reset to 0 every time.
    const run3 = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(run3.status).toBe("issue_created");
    [routineRow] = await db.select().from(routines).where(eq(routines.id, rollingRoutine.id));
    expect(routineRow?.consecutiveCoalesceCount).toBe(2);

    const wedgedComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, rollingIssueId));
    expect(wedgedComments).toHaveLength(1);

    const alarmsAfterFirstRaise = await readAlarmIssues(companyId, rollingRoutine.id);
    expect(alarmsAfterFirstRaise).toHaveLength(1);
    const alarmIssue = alarmsAfterFirstRaise[0]!;
    expect(alarmIssue.assigneeAgentId).toBe(ctoAgentId);
    expect(alarmIssue.priority).toBe("high");
    expect(alarmIssue.status).toBe("todo");
    expect(alarmIssue.description).toContain(rollingRoutine.title);

    const ctoWakeups = wakeups.filter((w) => w.agentId === ctoAgentId);
    expect(ctoWakeups.length).toBeGreaterThanOrEqual(1);
    expect(ctoWakeups[0]?.opts.reason).toBe("routine_coalesce_anomaly");

    // Fire 4: fold #3, not a doubling point — no new alarm issue or comment.
    await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    expect(await readAlarmIssues(companyId, rollingRoutine.id)).toHaveLength(1);

    // Fire 5: fold #4 — second raise point. Must update the existing alarm issue
    // (dedup), not mint a second one.
    await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
    [routineRow] = await db.select().from(routines).where(eq(routines.id, rollingRoutine.id));
    expect(routineRow?.consecutiveCoalesceCount).toBe(4);

    const alarmsAfterSecondRaise = await readAlarmIssues(companyId, rollingRoutine.id);
    expect(alarmsAfterSecondRaise).toHaveLength(1);
    expect(alarmsAfterSecondRaise[0]?.id).toBe(alarmIssue.id);

    const alarmComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, alarmIssue.id));
    expect(alarmComments).toHaveLength(1);

    const ctoWakeupsAfterSecondRaise = wakeups.filter((w) => w.agentId === ctoAgentId);
    expect(ctoWakeupsAfterSecondRaise.length).toBeGreaterThanOrEqual(2);
  });

  // AUR-5387 (CLEARS): a healthy reuse_and_rewake routine whose issue is actually
  // completed between fires never folds, so the counter must reset to 0 and no
  // wedge alarm should ever be raised — even with a CTO/CEO agent available to
  // receive one.
  it("reuse_and_rewake: genuine dispatch between fires never alarms and keeps the counter at 0 (AUR-5387 CLEARS)", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const ctoAgentId = randomUUID();
    await db.insert(agents).values({
      id: ctoAgentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const rollingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "rolling watchdog that completes cleanly",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "reuse_and_rewake",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    for (let i = 0; i < 4; i += 1) {
      const run = await svc.runRoutine(rollingRoutine.id, { source: "schedule" });
      expect(run.status).toBe("issue_created");
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, run.linkedIssueId!));

      const [routineRow] = await db.select().from(routines).where(eq(routines.id, rollingRoutine.id));
      expect(routineRow?.consecutiveCoalesceCount).toBe(0);
    }

    expect(await readAlarmIssues(companyId, rollingRoutine.id)).toHaveLength(0);
  });
});
