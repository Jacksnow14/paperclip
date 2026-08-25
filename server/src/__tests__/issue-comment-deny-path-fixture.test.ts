import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AUR-4135: falsifiable deny-path fixture using the CTO's exact live-measured
// shape. Two threads, screened for all four "doors" a non-owner agent could use
// to post on someone else's issue — (1) author, (2) mentioned,
// (3) prior participant, (4) assertAgentIssueMutationAllowed fallback
// (assignee match or reporting-chain override) — differ ONLY in whether the
// assignee's reportsTo edge reaches the actor:
//
//   AUR-1566-shaped: assignee.reportsTo === actorAgentId (direct manager)  -> 201
//   AUR-871-shaped:  assignee.reportsTo does not reach actorAgentId at all -> 403
//
// Falsifiability: each of the four doors is then flipped open in isolation
// (with the other three still shut) on top of the AUR-871-shaped base, and each
// flip must turn the 403 into a 201.

const issueId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const actorAgentId = "cccccccc-3333-4333-8333-cccccccccccc";
const assigneeAgentId = "dddddddd-4444-4444-8444-dddddddddddd";
const creatorAgentId = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const unrelatedManagerId = "ffffffff-6666-4666-8666-ffffffffffff";
const actorRunId = "11111111-7777-4777-8777-111111111111";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
  wasAgentMentionedInThread: vi.fn(),
  wasAgentPriorParticipantInThread: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "blocked",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId,
    assigneeUserId: null,
    createdByUserId: null,
    createdByAgentId: creatorAgentId,
    identifier: "PAP-871",
    title: "Deny-path fixture issue",
    description: "Original description",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    executionWorkspaceId: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function actorAsAgent(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: actorAgentId,
    companyId,
    source: "agent_key",
    runId: actorRunId,
    ...overrides,
  };
}

// All four doors shut: not author, not mentioned, not prior participant, and the
// assignee's reportsTo chain never reaches the actor.
function seedAllDoorsShut() {
  mockIssueService.getById.mockResolvedValue(makeIssue());
  mockIssueService.wasAgentMentionedInThread.mockResolvedValue(false);
  mockIssueService.wasAgentPriorParticipantInThread.mockResolvedValue(false);
  mockAgentService.list.mockResolvedValue([
    makeAgent(actorAgentId, { role: "engineer" }),
    // assignee reports to an unrelated manager, not the actor -- no override edge.
    makeAgent(assigneeAgentId, { reportsTo: unrelatedManagerId }),
    makeAgent(unrelatedManagerId, { role: "manager", reportsTo: null }),
  ]);
}

describe("falsifiable comment deny-path fixture (AUR-1566/AUR-871, AUR-4135)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);

    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    // wouldOwnershipGateReject (checked before assertAgentCommentAllowed on every
    // POST /comments) always calls hasActiveCheckoutManagementOverride, which
    // calls agentsSvc.list() unconditionally -- every test needs a resolvable
    // default here even when the mention/author/participant door is what's
    // actually granting access.
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "engineer" }),
      makeAgent(assigneeAgentId, { reportsTo: unrelatedManagerId }),
      makeAgent(unrelatedManagerId, { role: "manager", reportsTo: null }),
    ]);
    mockAgentService.resolveByReference.mockReset();
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });

    mockCompanyService.getById.mockReset();
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });

    mockIssueService.getById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.wasAgentMentionedInThread.mockReset();
    mockIssueService.wasAgentMentionedInThread.mockResolvedValue(false);
    mockIssueService.wasAgentPriorParticipantInThread.mockReset();
    mockIssueService.wasAgentPriorParticipantInThread.mockResolvedValue(false);
    mockIssueService.update.mockReset();
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockReset();
    mockIssueService.addComment.mockResolvedValue({
      id: "22222222-8888-4888-8888-222222222222",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listAttachments.mockResolvedValue([]);

    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
  });

  it("AUR-871-shaped: denies with all four doors shut (403, exact deny body shape)", async () => {
    seedAllDoorsShut();

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "trying to comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Agent cannot mutate another agent's issue",
      details: {
        issueId,
        assigneeAgentId,
        actorAgentId,
        status: "blocked",
        isAuthor: false,
        rule: "issue is assigned to another agent; you are not its author",
      },
    });
    expect(res.body.details.alternatives).toEqual(
      expect.arrayContaining([
        "@mention the assignee in a comment",
        "add a blocker with blockedByIssueIds",
        "escalate to the assignee's reporting-chain manager",
      ]),
    );
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("AUR-1566-shaped: grants when the assignee reports directly to the actor (201, activity log contains ONLY issue.comment_added)", async () => {
    seedAllDoorsShut();
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      makeAgent(assigneeAgentId, { reportsTo: actorAgentId }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "manager follow-up" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.comment_added" }),
    );
  });

  // --- Falsifiability: flip exactly one door open on top of the all-shut base,
  // and confirm the 403 flips to 201. Proves the deny fixture is not vacuously
  // true (e.g. from a fixture bug that always denies regardless of state).

  it("falsifiability: flipping ONLY the author door open turns the 403 into a 201", async () => {
    seedAllDoorsShut();
    mockIssueService.getById.mockResolvedValue(makeIssue({ createdByAgentId: actorAgentId }));

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "author follow-up" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.author_reply" }),
    );
  });

  it("falsifiability: flipping ONLY the mention door open turns the 403 into a 201", async () => {
    seedAllDoorsShut();
    mockIssueService.wasAgentMentionedInThread.mockResolvedValue(true);

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "mentioned follow-up" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.mention_reply" }),
    );
  });

  it("falsifiability: flipping ONLY the prior-participant door open turns the 403 into a 201", async () => {
    seedAllDoorsShut();
    mockIssueService.wasAgentPriorParticipantInThread.mockResolvedValue(true);

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "participant follow-up" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.participant_reply" }),
    );
  });

  // --- Wake tests (e) and (f) ---

  it("(e) out-of-scope (non-)mention on a closed issue is still denied (403) and never wakes anyone", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.wasAgentMentionedInThread.mockResolvedValue(false);
    mockIssueService.wasAgentPriorParticipantInThread.mockResolvedValue(false);
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "engineer" }),
      makeAgent(assigneeAgentId, { reportsTo: unrelatedManagerId }),
      makeAgent(unrelatedManagerId, { role: "manager", reportsTo: null }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "out of scope" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("(f) [supersedes CEO's literal wording per already-merged AUR-6027] a genuine fresh mention on a closed issue is granted (201, appendOnly) but does NOT wake the assignee absent explicit resume/reopen intent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.wasAgentMentionedInThread.mockResolvedValue(true);
    mockIssueService.addComment.mockResolvedValue({
      id: "33333333-9999-4999-8999-333333333333",
      issueId,
      companyId,
      body: "fresh mention reply",
      metadata: { version: 1, mentionReply: true, mentionRepliedByAgentId: actorAgentId },
    });

    const res = await request(await createApp(actorAsAgent()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "fresh mention reply" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
    // AUR-6027: appendOnly (mention-granted) comments on a closed issue never
    // reopen it and never wake the assignee absent an explicit resume/reopen.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
