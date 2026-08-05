import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { buildIssueGraphLivenessIncidentKey } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PBA") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      },
      {
        id: pausedAgentId,
        companyId,
        name: `${prefix} Paused`,
        role: "engineer",
        status: "paused",
      },
    ]);
    return { companyId, agentId, pausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    originFingerprint?: string | null;
    executionState?: Record<string, unknown> | null;
    description?: string | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      description: input.description ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function sourceScopedRecoveryAction(input: {
    companyId: string;
    sourceIssueId: string;
    lastAttemptAt: Date;
  }) {
    await db.insert(issueRecoveryActions).values({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      cause: "stranded_assigned_issue",
      fingerprint: `test:${input.sourceIssueId}`,
      nextAction: "Restore a live execution path.",
      lastAttemptAt: input.lastAttemptAt,
    });
  }

  async function activeRun(input: { companyId: string; agentId: string; issueId: string; status?: string; current?: boolean }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
    });
    if (input.current !== false) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, input.issueId));
    }
    return runId;
  }

  it("classifies a blocked parent as covered when its child has a running execution path", async () => {
    const { companyId, agentId } = await createCompany("PBC");
    const parentId = await insertIssue({ companyId, identifier: "PBC-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PBC-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: childId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBC-2",
    });
  });

  it("classifies an assigned backlog blocker leaf without a waiting path as attention-needed", async () => {
    const { companyId, agentId } = await createCompany("PBB");
    const parentId = await insertIssue({ companyId, identifier: "PBB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBB-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBB-2",
    });
  });

  it("treats a human-owned backlog blocker as a covered waiting path", async () => {
    const { companyId } = await createCompany("PBU");
    const parentId = await insertIssue({ companyId, identifier: "PBU-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBU-2",
      title: "Human-owned parked blocker",
      status: "backlog",
      assigneeUserId: "board-user-1",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBU-2",
    });
  });

  it("treats a freshly-attempted recovery action as a covered waiting path (AUR-4300)", async () => {
    const { companyId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBR-2",
      title: "Stranded blocker with a live recovery action",
      status: "blocked",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await sourceScopedRecoveryAction({
      companyId,
      sourceIssueId: blockerId,
      lastAttemptAt: new Date(),
    });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-2",
    });
  });

  it("stops treating a dormant recovery action as a waiting path once its one-shot wake goes stale (AUR-4300)", async () => {
    const { companyId } = await createCompany("PBD");
    const parentId = await insertIssue({ companyId, identifier: "PBD-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBD-2",
      title: "Stranded blocker whose one-shot wake was lost",
      status: "blocked",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await sourceScopedRecoveryAction({
      companyId,
      sourceIssueId: blockerId,
      lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBD-2",
    });
  });

  it("keeps mixed blockers attention-required when any path lacks active work", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("PBM");
    const parentId = await insertIssue({ companyId, identifier: "PBM-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PBM-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    // Assigned to a paused (non-invokable) agent — the one path that must keep raising
    // attentionBlockerCount even after AUR-4273 makes an idle/active/running assignee a
    // covered waiting path.
    const idleBlockerId = await insertIssue({
      companyId,
      identifier: "PBM-3",
      title: "Parked blocker",
      status: "todo",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: idleBlockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBM-3",
    });
  });

  // AUR-4273: the invokability branch in classifyPath was dead code — both the
  // invokable and non-invokable paths returned `covered: false`, so assignee status
  // never affected the outcome. These two tests prove the fix in both directions.
  it("covers a queued blocker leaf assigned to a healthy invokable agent with no active run yet (AUR-4273)", async () => {
    const { companyId, agentId } = await createCompany("PIA");
    const parentId = await insertIssue({ companyId, identifier: "PIA-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PIA-2",
      title: "Queued blocker, idle assignee",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PIA-2",
    });
  });

  it("still flags a queued blocker leaf assigned to a non-invokable (paused) agent (AUR-4273)", async () => {
    const { companyId, pausedAgentId } = await createCompany("PIB");
    const parentId = await insertIssue({ companyId, identifier: "PIB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PIB-2",
      title: "Queued blocker, paused assignee",
      status: "todo",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PIB-2",
    });
  });

  it("still flags a queued blocker leaf assigned to an agent stuck in error status (AUR-4273)", async () => {
    const { companyId } = await createCompany("PIC");
    const erroredAgentId = randomUUID();
    await db.insert(agents).values({
      id: erroredAgentId,
      companyId,
      name: "PIC Errored",
      role: "engineer",
      status: "error",
    });
    const parentId = await insertIssue({ companyId, identifier: "PIC-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PIC-2",
      title: "Queued blocker, errored assignee",
      status: "todo",
      assigneeAgentId: erroredAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PIC-2",
    });
  });

  it("can flip from needs_attention to covered without changing the blocker edges", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("PBF");
    const parentId = await insertIssue({ companyId, identifier: "PBF-1", title: "Parent", status: "blocked" });
    // Assigned to a paused agent so the "before" state isn't already covered by the
    // AUR-4273 invokable-assignee path — the transition demonstrated here is the active
    // run appearing, not the assignee's own status.
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBF-2",
      title: "Assigned blocker",
      status: "todo",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const before = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);
    expect(before?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBF-2",
    });

    await activeRun({ companyId, agentId, issueId: blockerId });

    const after = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);
    expect(after?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBF-2",
    });
  });

  it("covers recursive blocker chains when the downstream leaf has active work", async () => {
    const { companyId, agentId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({ companyId, identifier: "PBR-2", title: "Blocked dependency", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBR-3",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: blockerId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-3",
    });
  });

  it("does not let another company's active run cover the blocker", async () => {
    const { companyId, pausedAgentId } = await createCompany("PBS");
    const other = await createCompany("PBT");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    // Assigned to a paused (non-invokable) agent so the only candidate coverage path is
    // the cross-company run this test means to rule out — an idle/active assignee would
    // otherwise cover it via the AUR-4273 invokable-assignee path regardless.
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Same-company blocker",
      status: "todo",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId: other.companyId, agentId: other.agentId, issueId: blockerId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBS-2",
    });
  });

  it("does not cover a blocker from a stale run the issue no longer owns", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    // Assigned to a paused (non-invokable) agent so the stale run is the only candidate
    // coverage path this test means to rule out.
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Previously running blocker",
      status: "blocked",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, current: false });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBX-2",
    });
  });

  it("flags a chain whose leaf is in_review without an action path as stalled", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBV-2",
      sampleStalledBlockerIdentifier: "PBV-2",
    });
  });

  it("does not flag an in_review leaf as stalled when an active run is still progressing it", async () => {
    const { companyId, agentId } = await createCompany("PBW");
    const parentId = await insertIssue({ companyId, identifier: "PBW-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBW-2",
      title: "Active review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: reviewLeafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      stalledBlockerCount: 0,
    });
  });

  it("flags a deep chain whose leaf is stalled in_review through multiple layers", async () => {
    const { companyId, agentId } = await createCompany("PBZ");
    const rootId = await insertIssue({ companyId, identifier: "PBZ-1", title: "Root", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PBZ-2", title: "Mid blocker", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBZ-3",
      title: "Stalled leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const root = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBZ-3",
    });
  });

  it("prefers needs_attention over stalled when the chain also has a hard attention case", async () => {
    const { companyId, agentId } = await createCompany("PBQ");
    const parentId = await insertIssue({ companyId, identifier: "PBQ-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-3",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "cancelled_blocker",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBQ-3",
      sampleStalledBlockerIdentifier: "PBQ-2",
    });
  });

  it("clears the unresolved count for a cancelled-only child but still flags the empty frontier as needing attention (AUR-3956 Defect 2, CTO review on PR #112)", async () => {
    const { companyId, agentId } = await createCompany("PCC");
    const parentId = await insertIssue({ companyId, identifier: "PCC-1", title: "Parent", status: "blocked" });
    const cancelledChildId = await insertIssue({
      companyId,
      identifier: "PCC-2",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: cancelledChildId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    // A "blocked" root with no live blocker edge needs attention regardless of how it got
    // there (no known blocker at all, or every blocker resolved) — a cancelled-only child
    // must not read as *more* resolved than a done-only child would. See the identical
    // "done vs cancelled" fixture test below, which locks this equivalence directly.
    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 0,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: null,
    });
  });

  it("counts exactly one unresolved blocker when one child is cancelled and one is open (AUR-3956 Defect 2)", async () => {
    const { companyId, agentId } = await createCompany("PCM");
    const parentId = await insertIssue({ companyId, identifier: "PCM-1", title: "Parent", status: "blocked" });
    const cancelledChildId = await insertIssue({
      companyId,
      identifier: "PCM-2",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    const openChildId = await insertIssue({
      companyId,
      identifier: "PCM-3",
      title: "Open child",
      status: "backlog",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: cancelledChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: openChildId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PCM-3",
    });
  });

  it("keeps a cancelled explicit blocker unresolved with a cancelled_blocker reason (AUR-3956 Defect 2)", async () => {
    const { companyId, agentId } = await createCompany("PCX");
    const parentId = await insertIssue({ companyId, identifier: "PCX-1", title: "Parent", status: "blocked" });
    const cancelledBlockerId = await insertIssue({
      companyId,
      identifier: "PCX-2",
      title: "Cancelled explicit blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: cancelledBlockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "cancelled_blocker",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PCX-2",
    });
  });

  it("agrees with getWakeableParentAfterChildCompletion that a cancelled child completes the parent", async () => {
    const { companyId, agentId } = await createCompany("PCW");
    const parentId = await insertIssue({
      companyId,
      identifier: "PCW-1",
      title: "Parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const doneChildId = await insertIssue({
      companyId,
      identifier: "PCW-2",
      title: "Done child",
      status: "done",
      parentId,
      assigneeAgentId: agentId,
    });
    const cancelledChildId = await insertIssue({
      companyId,
      identifier: "PCW-3",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: doneChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledChildId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);
    // Both children resolved (one done, one cancelled) -> empty frontier -> attention,
    // same as the pre-existing "no known blocker" anomaly (CTO review on PR #112).
    expect(parent?.blockerAttention).toMatchObject({ state: "needs_attention", reason: "attention_required" });

    const wakeableParent = await svc.getWakeableParentAfterChildCompletion(parentId);
    expect(wakeableParent?.id).toBe(parentId);
    expect(wakeableParent?.childIssueIds).toEqual(expect.arrayContaining([doneChildId, cancelledChildId]));
  });

  it("reports an identical blockerAttention object whether an only child resolved via done or cancelled (regression guard, CTO review on PR #112)", async () => {
    const doneCompany = await createCompany("PCD");
    const doneParentId = await insertIssue({ companyId: doneCompany.companyId, identifier: "PCD-1", title: "Parent", status: "blocked" });
    const doneChildId = await insertIssue({
      companyId: doneCompany.companyId,
      identifier: "PCD-2",
      title: "Done child",
      status: "done",
      parentId: doneParentId,
      assigneeAgentId: doneCompany.agentId,
    });
    await block({ companyId: doneCompany.companyId, blockerIssueId: doneChildId, blockedIssueId: doneParentId });

    const cancelledCompany = await createCompany("PCE");
    const cancelledParentId = await insertIssue({ companyId: cancelledCompany.companyId, identifier: "PCE-1", title: "Parent", status: "blocked" });
    const cancelledChildId = await insertIssue({
      companyId: cancelledCompany.companyId,
      identifier: "PCE-2",
      title: "Cancelled child",
      status: "cancelled",
      parentId: cancelledParentId,
      assigneeAgentId: cancelledCompany.agentId,
    });
    await block({ companyId: cancelledCompany.companyId, blockerIssueId: cancelledChildId, blockedIssueId: cancelledParentId });

    const doneParent = (await svc.list(doneCompany.companyId, { status: "blocked" })).find((issue) => issue.id === doneParentId);
    const cancelledParent = (await svc.list(cancelledCompany.companyId, { status: "blocked" })).find((issue) => issue.id === cancelledParentId);

    // Locks the premise the whole fix rests on: a cancelled child must classify identically
    // to a done child. Flipping either fixture's status must not change this assertion.
    expect(cancelledParent?.blockerAttention).toEqual(doneParent?.blockerAttention);
    expect(doneParent?.blockerAttention).toMatchObject({ state: "needs_attention", reason: "attention_required", unresolvedBlockerCount: 0 });
  });

  it("does not let cancelling an already-covered blocker increase attentionBlockerCount (monotonicity, CTO review on PR #112)", async () => {
    const { companyId, agentId } = await createCompany("PCN");
    const parentId = await insertIssue({ companyId, identifier: "PCN-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PCN-2",
      title: "Active child",
      status: "in_progress",
      parentId,
      assigneeAgentId: agentId,
    });
    const cancelledChildId = await insertIssue({
      companyId,
      identifier: "PCN-3",
      title: "Already-cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledChildId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const before = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);
    expect(before?.blockerAttention).toMatchObject({ state: "covered", attentionBlockerCount: 0, unresolvedBlockerCount: 1 });

    await db.update(issues).set({ status: "cancelled", executionRunId: null }).where(eq(issues.id, activeChildId));

    const after = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);
    expect(after?.blockerAttention.attentionBlockerCount).toBeLessThanOrEqual(before?.blockerAttention.attentionBlockerCount ?? 0);
    expect(after?.blockerAttention).toMatchObject({ state: "needs_attention", reason: "attention_required", attentionBlockerCount: 0 });
  });

  it("treats open liveness escalation blockers as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBL");
    const parentId = await insertIssue({ companyId, identifier: "PBL-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBL-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const incidentKey = [
      "harness_liveness",
      companyId,
      parentId,
      "blocked_by_cancelled_issue",
      cancelledLeafId,
    ].join(":");
    const escalationId = await insertIssue({
      companyId,
      identifier: "PBL-3",
      title: "Liveness escalation",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: escalationId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked,todo" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
    });
  });

  it("does not treat a scheduled retry as actively covered work", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("PBY");
    const parentId = await insertIssue({ companyId, identifier: "PBY-1", title: "Parent", status: "blocked" });
    // Assigned to a paused (non-invokable) agent so the scheduled_retry run is the only
    // candidate coverage path this test means to rule out.
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBY-2",
      title: "Retrying blocker",
      status: "blocked",
      assigneeAgentId: pausedAgentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, status: "scheduled_retry" });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBY-2",
    });
  });

  it("returns blocked inbox attention for an unassigned blocker leaf and supports count/search", async () => {
    const { companyId } = await createCompany("BIA");
    const parentId = await insertIssue({ companyId, identifier: "BIA-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIA-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", q: "BIA-2" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parentId);
    expect(rows[0]?.blockedBy).toEqual([
      expect.objectContaining({ id: blockerId, identifier: "BIA-2" }),
    ]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      owner: { type: "unknown", agentId: null, userId: null },
      action: { label: "Assign blocker" },
      leafIssue: { id: blockerId, identifier: "BIA-2" },
      redaction: { secretFieldsOmitted: true },
    });
    await expect(svc.count(companyId, { attention: "blocked" })).resolves.toBe(1);
  });

  it("redacts external wait details from blocked inbox payloads and search", async () => {
    const { companyId } = await createCompany("BIX");
    const owner = "Private Vendor Security Team";
    const action = "Send the confidential access token for customer Alpha";
    const issueId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked on vendor",
      status: "blocked",
      description: [
        "Public context stays visible.",
        `external owner: ${owner}`,
        `external action: ${action}`,
        "Continue after the vendor confirms receipt.",
      ].join("\n"),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const issue = rows.find((row) => row.id === issueId);

    expect(issue?.description).toContain("Public context stays visible.");
    expect(issue?.description).toContain("Continue after the vendor confirms receipt.");
    expect(issue?.description).not.toContain(owner);
    expect(issue?.description).not.toContain(action);
    expect(issue?.blockedInboxAttention).toMatchObject({
      state: "external_wait",
      reason: "external_owner_action",
      owner: { type: "external", label: null },
      action: { label: "External owner action", detail: null },
      redaction: { externalDetailsRedacted: true, secretFieldsOmitted: true },
    });
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(owner);
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(action);

    await expect(svc.list(companyId, { attention: "blocked", q: owner })).resolves.toEqual([]);
    await expect(svc.count(companyId, { attention: "blocked", q: action })).resolves.toBe(0);
    await expect(svc.count(companyId, { attention: "blocked", q: "Public context" })).resolves.toBe(1);
  });

  it("excludes healthy active blockers from blocked inbox attention", async () => {
    const { companyId, agentId } = await createCompany("BIB");
    const parentId = await insertIssue({ companyId, identifier: "BIB-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIB-2",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
  });

  it("classifies assigned backlog and invalid review leaves for blocked inbox attention", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BIC");
    const backlogParentId = await insertIssue({ companyId, identifier: "BIC-1", title: "Blocked by parked work", status: "blocked" });
    const backlogLeafId = await insertIssue({
      companyId,
      identifier: "BIC-2",
      title: "Parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: backlogLeafId, blockedIssueId: backlogParentId });

    const reviewId = await insertIssue({
      companyId,
      identifier: "BIC-3",
      title: "Invalid review",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedAgentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(backlogParentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: backlogLeafId },
    });
    expect(byId.get(reviewId)?.blockedInboxAttention).toMatchObject({
      reason: "invalid_review_participant",
      severity: "critical",
      action: { label: "Repair review participant" },
    });
  });

  it("agrees with the scheduler's dependency readiness for a todo issue with a genuine open blocker (AUR-4710 FIRE case)", async () => {
    const { companyId } = await createCompany("PDR");
    const dependentId = await insertIssue({ companyId, identifier: "PDR-1", title: "Dependent", status: "todo" });
    const blockerId = await insertIssue({ companyId, identifier: "PDR-2", title: "Open blocker", status: "todo" });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: dependentId });

    const readiness = await svc.getDependencyReadiness(dependentId);
    expect(readiness.isDependencyReady).toBe(false);

    const dependent = (await svc.list(companyId, { status: "todo" })).find((issue) => issue.id === dependentId);
    expect(dependent?.blockerAttention?.state).not.toBe("none");
    expect(dependent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      unresolvedBlockerCount: 1,
      sampleBlockerIdentifier: "PDR-2",
    });
  });

  it("clears blockerAttention once the blocker resolves, matching dependency readiness (AUR-4710 PASS case)", async () => {
    const { companyId } = await createCompany("PDP");
    const dependentId = await insertIssue({ companyId, identifier: "PDP-1", title: "Dependent", status: "in_progress" });
    const blockerId = await insertIssue({ companyId, identifier: "PDP-2", title: "Blocker", status: "todo" });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: dependentId });

    const before = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === dependentId);
    expect(before?.blockerAttention?.state).toBe("needs_attention");

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));

    const readiness = await svc.getDependencyReadiness(dependentId);
    expect(readiness.isDependencyReady).toBe(true);

    const after = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === dependentId);
    expect(after?.blockerAttention).toMatchObject({ state: "none", unresolvedBlockerCount: 0 });
  });

  it("does not disagree with readiness for a done issue's stale explicit blocker", async () => {
    const { companyId } = await createCompany("PDD");
    const dependentId = await insertIssue({ companyId, identifier: "PDD-1", title: "Done dependent", status: "done" });
    const blockerId = await insertIssue({ companyId, identifier: "PDD-2", title: "Open blocker", status: "todo" });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: dependentId });

    const dependent = (await svc.list(companyId, { status: "done" })).find((issue) => issue.id === dependentId);
    expect(dependent?.blockerAttention).toMatchObject({ state: "none", unresolvedBlockerCount: 0 });
  });

  it("classifies recovery issues and missing successful-run dispositions", async () => {
    const { companyId, agentId } = await createCompany("BID");
    const sourceId = await insertIssue({ companyId, identifier: "BID-1", title: "Stopped source", status: "blocked" });
    const leafId = await insertIssue({ companyId, identifier: "BID-2", title: "Stopped leaf", status: "todo" });
    const recoveryId = await insertIssue({
      companyId,
      identifier: "BID-3",
      title: "Recovery issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: buildIssueGraphLivenessIncidentKey({
        companyId,
        issueId: sourceId,
        state: "blocked_by_unassigned_issue",
        blockerIssueId: leafId,
      }),
    });
    const handoffId = await insertIssue({
      companyId,
      identifier: "BID-4",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "Progress was made" },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(recoveryId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      leafIssue: { id: leafId },
      recoveryIssue: { id: recoveryId },
    });
    expect(byId.get(handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId },
      action: { label: "Choose disposition" },
    });
  });
});
