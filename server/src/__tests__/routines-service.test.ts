import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import * as issuesModule from "../services/issues.ts";
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

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
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
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
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
  }, opts?: { startedAt?: Date | null; createdAt?: Date; heartbeatStatus?: string }) {
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

    // startedAt defaults to the historical fixture date. AUR-4543 tests override
    // it with a `now`-relative age so the stale-active threshold is exercised
    // deterministically, and pass startedAt: null to model a queued run that
    // never launched (where only created_at can date the wedge).
    const heartbeatStartedAt = opts?.startedAt === undefined
      ? new Date("2026-03-20T12:01:00.000Z")
      : opts.startedAt;
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts?.heartbeatStatus ?? "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: heartbeatStartedAt,
      ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
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

  // AUR-4543: stale-active reaping. Ages are `now`-relative because the service
  // stamps triggeredAt from the wall clock; the schedule interval is read off the
  // cron period (two consecutive ticks), so both sides of every threshold below
  // are exact rather than dependent on when the suite happens to run.
  const HOUR_MS = 3_600_000;
  const MINUTE_MS = 60_000;

  async function addScheduleTrigger(svc: Awaited<ReturnType<typeof seedFixture>>["svc"], routineId: string, cronExpression: string) {
    const { trigger } = await svc.createTrigger(routineId, {
      kind: "schedule",
      label: "sched",
      cronExpression,
      timezone: "UTC",
    }, {});
    return trigger;
  }

  async function readStaleState(issueId: string, heartbeatRunId: string, routineRunId: string) {
    const [issueRow] = await db
      .select({ executionRunId: issues.executionRunId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    const [heartbeatRow] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, heartbeatRunId));
    const [routineRunRow] = await db
      .select({ status: routineRuns.status, failureReason: routineRuns.failureReason })
      .from(routineRuns)
      .where(eq(routineRuns.id, routineRunId));
    return { issue: issueRow, heartbeat: heartbeatRow, routineRun: routineRunRow };
  }

  it("reaps a stale scheduled run, detaches its issue, and dispatches fresh work", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    // Daily cron => a 24h schedule interval, so the threshold is 24h, not the 4h floor.
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");
    const { previousIssue, previousRunId, liveHeartbeatRunId } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 25 * HOUR_MS),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    // Fresh dispatch, not a fold.
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBeNull();

    const state = await readStaleState(previousIssue.id, liveHeartbeatRunId, previousRunId);
    // The wedged heartbeat run drops out of the live statuses.
    expect(state.heartbeat?.status).toBe("failed");
    expect(state.heartbeat?.errorCode).toBe("routine_stale_active_timeout");
    // The dispatch slot is freed by detaching, and the issue is NOT cancelled.
    expect(state.issue?.executionRunId).toBeNull();
    expect(state.issue?.status).toBe("in_progress");
    // The predecessor stops reporting green.
    expect(state.routineRun?.status).toBe("failed");
    expect(state.routineRun?.failureReason).toContain("stale-active timeout");

    // The new issue is genuinely fresh: distinct row, new originRunId.
    const routineIssues = await db
      .select({ id: issues.id, originRunId: issues.originRunId })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(routineIssues).toHaveLength(2);
    const freshIssue = routineIssues.find((row) => row.id !== previousIssue.id);
    expect(freshIssue?.originRunId).toBe(run.id);
    expect(freshIssue?.originRunId).not.toBe(previousRunId);

    const staleLogs = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.stale_active_timeout"));
    expect(staleLogs).toHaveLength(1);
    expect(staleLogs[0]?.entityId).toBe(previousIssue.id);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, previousIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stale-active timeout");
    expect(comments[0]?.body).toContain("detached");

    // Discrimination: the fire immediately after the reap folds into the FRESH
    // issue, whose run is young. The gate reaps wedges; it does not disable
    // coalescing.
    const followUp = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    expect(followUp.status).toBe("coalesced");
    expect(followUp.linkedIssueId).toBe(freshIssue?.id);
  });

  it("reaps a stale scheduled run that never started, dating it from created_at", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");
    // A queued run that never launched has startedAt NULL — keying staleness on
    // started_at alone would miss exactly this wedge class.
    const { previousIssue, liveHeartbeatRunId } = await seedWedgedRoutineIssue(fixture, {
      startedAt: null,
      createdAt: new Date(Date.now() - 25 * HOUR_MS),
      heartbeatStatus: "queued",
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);
    const [heartbeatRow] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, liveHeartbeatRunId));
    expect(heartbeatRow?.status).toBe("failed");
  });

  it("control: a scheduled fire does not reap a live run younger than the schedule interval", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");
    // 5h old: past the 4h floor, well inside the routine's own 24h interval.
    // This is the case that proves the threshold tracks the schedule period
    // rather than collapsing onto the floor.
    const { previousIssue, previousRunId, liveHeartbeatRunId } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 5 * HOUR_MS),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    const state = await readStaleState(previousIssue.id, liveHeartbeatRunId, previousRunId);
    expect(state.heartbeat?.status).toBe("running");
    expect(state.issue?.executionRunId).toBe(liveHeartbeatRunId);
    expect(state.routineRun?.status).toBe("issue_created");

    const staleLogs = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.stale_active_timeout"));
    expect(staleLogs).toHaveLength(0);
  });

  it("control: a manual fire never reaps a stale live run", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");
    const { previousIssue, previousRunId, liveHeartbeatRunId } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 25 * HOUR_MS),
    });

    // Same wedge as the reaping test, only the source differs.
    const run = await svc.runRoutine(routine.id, { source: "manual", triggerId: trigger.id });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    const state = await readStaleState(previousIssue.id, liveHeartbeatRunId, previousRunId);
    expect(state.heartbeat?.status).toBe("running");
    expect(state.issue?.executionRunId).toBe(liveHeartbeatRunId);
    expect(state.routineRun?.status).toBe("issue_created");

    const staleLogs = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.stale_active_timeout"));
    expect(staleLogs).toHaveLength(0);
  });

  it("control: does not reap while one of the issue's live runs is still young", async () => {
    // An issue can carry more than one live run — the execution-bound one plus
    // any run holding it in a context snapshot. Reaping keys on the YOUNGEST of
    // them, so a single fresh run means the issue is genuinely busy and the aged
    // sibling must not be enough to kill it.
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");
    const { previousIssue, previousRunId, liveHeartbeatRunId } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 25 * HOUR_MS),
    });
    const youngRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: youngRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date(Date.now() - 2 * MINUTE_MS),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    const state = await readStaleState(previousIssue.id, liveHeartbeatRunId, previousRunId);
    expect(state.heartbeat?.status).toBe("running");
    expect(state.issue?.executionRunId).toBe(liveHeartbeatRunId);
    expect(state.routineRun?.status).toBe("issue_created");
    const [youngRow] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, youngRunId));
    expect(youngRow?.status).toBe("running");
  });

  it("reaps a stale run that takes the slot after the pre-create check (slot-conflict path)", async () => {
    // The un-gated coalesce branch exists TWICE: once before issueSvc.create and
    // again in the slot-conflict catch. This covers the second one, reachable
    // only when a wedge occupies the dispatch slot after the first check has
    // already passed. The spy widens that window deterministically — the
    // constraint violation itself is a real issues_open_routine_execution_uq
    // conflict, not a synthesized error.
    //
    // Note where that conflict actually comes from: issueSvc.create inserts with
    // a null execution_run_id, so a fresh issue is outside the partial index and
    // the INSERT cannot collide. The colliding write is the wakeup's
    // execution_run_id binding, which is why the guard has to span both.
    type IssueServiceFactory = typeof issuesModule.issueService;
    const realIssueService: IssueServiceFactory = issuesModule.issueService;
    let makeWedgeLive: (() => Promise<void>) | null = null;
    const spy = vi.spyOn(issuesModule, "issueService").mockImplementation(((executor) => {
      const real = realIssueService(executor);
      return {
        ...real,
        create: async (companyId, payload) => {
          if (makeWedgeLive) {
            const hook = makeWedgeLive;
            makeWedgeLive = null;
            await hook();
          }
          return real.create(companyId, payload);
        },
      };
    }) as IssueServiceFactory);

    try {
      const fixture = await seedFixture();
      const { routine, svc } = fixture;
      const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");

      // Dispatch for real first, so the incumbent issue carries the same
      // originFingerprint the next dispatch will compute. A hand-seeded issue
      // has a NULL fingerprint, and NULLs are distinct in a unique index — it
      // would never actually collide.
      const firstRun = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
      expect(firstRun.status).toBe("issue_created");
      const incumbentId = firstRun.linkedIssueId!;
      const [incumbent] = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, incumbentId));
      const wedgedRunId = incumbent!.executionRunId!;

      // Age the run out, but park it in a non-live status so the pre-create
      // check misses and the dispatch proceeds all the way to the slot write.
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", startedAt: new Date(Date.now() - 25 * HOUR_MS) })
        .where(eq(heartbeatRuns.id, wedgedRunId));
      const detailBefore = await svc.getDetail(routine.id);
      expect(detailBefore?.activeIssue ?? null).toBeNull();

      // The race: the wedge becomes live after the check has already passed.
      makeWedgeLive = async () => {
        await db
          .update(heartbeatRuns)
          .set({ status: "running" })
          .where(eq(heartbeatRuns.id, wedgedRunId));
      };

      const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

      // Reaped inside the slot-conflict catch and retried, rather than folded.
      expect(run.status).toBe("issue_created");
      expect(run.linkedIssueId).not.toBe(incumbentId);
      const state = await readStaleState(incumbentId, wedgedRunId, firstRun.id);
      expect(state.heartbeat?.status).toBe("failed");
      expect(state.heartbeat?.errorCode).toBe("routine_stale_active_timeout");
      expect(state.issue?.executionRunId).toBeNull();
      // Detached, never cancelled.
      expect(state.issue?.status).toBe("todo");
      expect(state.routineRun?.status).toBe("failed");
      // The retried issue really is bound to a fresh live run.
      const [retried] = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, run.linkedIssueId!));
      expect(retried?.executionRunId).toBeTruthy();
      expect(retried?.executionRunId).not.toBe(wedgedRunId);
    } finally {
      spy.mockRestore();
    }
  });

  it("control: folds and cleans up its own issue when the run taking the slot is not yet stale", async () => {
    // Same race, non-stale incumbent. Proves the slot-conflict gate discriminates
    // instead of reaping everything that collides, and that the losing dispatch
    // does not leave the execution issue it had already created behind.
    type IssueServiceFactory = typeof issuesModule.issueService;
    const realIssueService: IssueServiceFactory = issuesModule.issueService;
    let makeWedgeLive: (() => Promise<void>) | null = null;
    const spy = vi.spyOn(issuesModule, "issueService").mockImplementation(((executor) => {
      const real = realIssueService(executor);
      return {
        ...real,
        create: async (companyId, payload) => {
          if (makeWedgeLive) {
            const hook = makeWedgeLive;
            makeWedgeLive = null;
            await hook();
          }
          return real.create(companyId, payload);
        },
      };
    }) as IssueServiceFactory);

    try {
      const fixture = await seedFixture();
      const { routine, svc } = fixture;
      const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");

      const firstRun = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
      const incumbentId = firstRun.linkedIssueId!;
      const [incumbent] = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, incumbentId));
      const liveRunId = incumbent!.executionRunId!;

      // One hour old against a 24h interval — genuinely busy, not wedged.
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", startedAt: new Date(Date.now() - 1 * HOUR_MS) })
        .where(eq(heartbeatRuns.id, liveRunId));
      makeWedgeLive = async () => {
        await db
          .update(heartbeatRuns)
          .set({ status: "running" })
          .where(eq(heartbeatRuns.id, liveRunId));
      };

      const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

      expect(run.status).toBe("coalesced");
      expect(run.linkedIssueId).toBe(incumbentId);
      const state = await readStaleState(incumbentId, liveRunId, firstRun.id);
      expect(state.heartbeat?.status).toBe("running");
      expect(state.heartbeat?.errorCode).toBeNull();
      expect(state.issue?.executionRunId).toBe(liveRunId);
      // The issue this dispatch created before losing the race is gone.
      const remaining = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.originKind, "routine_execution"));
      expect(remaining.map((row) => row.id)).toEqual([incumbentId]);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails loudly rather than folding a slot conflict into the dispatch's own issue", async () => {
    // The occupant holds the slot through a finished run: execution_run_id is
    // still set (so the partial index is occupied) but the run is not live (so
    // findLiveExecutionIssue's execution-bound join misses it). That combination
    // drops the conflict lookup onto its context-snapshot fallback, where the
    // only live run left in the company belongs to the issue THIS dispatch just
    // created — via the heartbeat run its failed wakeup left behind.
    //
    // Folding or reaping there would have the dispatch act on itself. That state
    // is an orphaned execution_run_id, a different defect from a stale-active
    // run, so the honest outcome is to surface the conflict.
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "0 10 * * *");

    const firstRun = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    const incumbentId = firstRun.linkedIssueId!;
    const [incumbent] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, incumbentId));
    const finishedRunId = incumbent!.executionRunId!;
    await db
      .update(heartbeatRuns)
      .set({ status: "completed", startedAt: new Date(Date.now() - 25 * HOUR_MS) })
      .where(eq(heartbeatRuns.id, finishedRunId));

    const run = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    expect(run.status).toBe("failed");
    // Drizzle's wrapper message names the statement, not the constraint (the
    // constraint lives on the wrapped cause) — so pin the slot-binding write.
    expect(run.failureReason).toContain('update "issues" set "execution_run_id"');
    // The occupant is left exactly as it was — no self-inflicted reap.
    const state = await readStaleState(incumbentId, finishedRunId, firstRun.id);
    expect(state.issue?.executionRunId).toBe(finishedRunId);
    expect(state.heartbeat?.errorCode).toBeNull();
    expect(state.routineRun?.status).toBe("issue_created");
    const remaining = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originKind, "routine_execution"));
    expect(remaining.map((row) => row.id)).toEqual([incumbentId]);
  });

  it("raises a coalesce anomaly on the FIRST fold when the live run outlived one schedule interval", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    // 5-minute cron => 5m interval, but the 4h floor still protects the run from
    // being reaped, so this genuinely exercises the age-based anomaly.
    const trigger = await addScheduleTrigger(svc, routine.id, "*/5 * * * *");
    const { previousIssue } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 30 * MINUTE_MS),
    });

    const first = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    expect(first.status).toBe("coalesced");

    const state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(1);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body).toContain("longer than the routine's");
    expect(state.comments[0]?.body).toContain("schedule interval");

    const anomalyLogs = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.coalesce_anomaly"));
    expect(anomalyLogs).toHaveLength(1);
    expect((anomalyLogs[0]?.details as { raiseReason?: string })?.raiseReason).toBe("age");
  });

  it("control: stays silent on the first fold when the live run is younger than one schedule interval", async () => {
    const fixture = await seedFixture();
    const { routine, svc } = fixture;
    const trigger = await addScheduleTrigger(svc, routine.id, "*/5 * * * *");
    // 1 minute old against a 5-minute interval.
    const { previousIssue } = await seedWedgedRoutineIssue(fixture, {
      startedAt: new Date(Date.now() - 1 * MINUTE_MS),
    });

    const first = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    expect(first.status).toBe("coalesced");

    const state = await readCoalesceState(routine.id, previousIssue.id);
    expect(state.count).toBe(1);
    expect(state.comments).toHaveLength(0);

    const anomalyLogs = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "routine.coalesce_anomaly"));
    expect(anomalyLogs).toHaveLength(0);
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
});
