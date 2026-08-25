import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AUR-4135: hasActiveCheckoutManagementOverride() walks agents.reportsTo to let a
// manager mutate/comment on an active checkout owned by a report, without an
// explicit tasks:manage_active_checkouts grant. That walk had zero direct test
// coverage before this file. These tests exercise the walk itself (direct
// manager, transitive/grandparent manager, no-edge peer, reportsTo=null, and
// the depth-50 cycle guard) via PATCH /issues/:id, independent of the
// access.hasPermission grant path already covered in
// issue-agent-mutation-ownership-routes.test.ts.

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const assigneeAgentId = "33333333-3333-4333-8333-333333333333";
const actorAgentId = "44444444-4444-4444-8444-444444444444";
const middleManagerId = "55555555-5555-4555-8555-555555555555";
const noEdgePeerId = "66666666-6666-4666-8666-666666666666";
const cycleAgentBId = "77777777-7777-4777-8777-777777777777";
const cycleAgentCId = "88888888-8888-4888-8888-888888888888";
const actorRunId = "99999999-9999-4999-8999-999999999999";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
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
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    createdByAgentId: null,
    identifier: "PAP-1649",
    title: "Owned active issue",
    description: "Original description",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
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

describe("hasActiveCheckoutManagementOverride reporting-chain walk (AUR-4135)", () => {
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
    // No named-permission grant in any of these tests: the walk itself is what's
    // under test, not the access.hasPermission("tasks:manage_active_checkouts") path
    // (already covered by issue-agent-mutation-ownership-routes.test.ts).
    mockAccessService.hasPermission.mockResolvedValue(false);

    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });

    mockCompanyService.getById.mockReset();
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });

    mockIssueService.getById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
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

  it("grants when the assignee reports directly to the actor", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId, status: "in_progress" }));
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      makeAgent(assigneeAgentId, { reportsTo: actorAgentId }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Direct-manager override" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ title: "Direct-manager override" }),
    );
  });

  it("grants when the assignee's manager reports to the actor (transitive/grandparent manager)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId, status: "in_progress" }));
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      makeAgent(middleManagerId, { role: "manager", reportsTo: actorAgentId }),
      makeAgent(assigneeAgentId, { reportsTo: middleManagerId }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Grandparent-manager override" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ title: "Grandparent-manager override" }),
    );
  });

  it("denies a peer with no reporting-chain edge to the actor", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId, status: "in_progress" }));
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      // noEdgePeerId reports to some other, unrelated agent — never the actor.
      makeAgent(noEdgePeerId, { reportsTo: null }),
      makeAgent(assigneeAgentId, { reportsTo: noEdgePeerId }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be denied" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("denies when the assignee has reportsTo = null (no manager at all)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId, status: "in_progress" }));
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      makeAgent(assigneeAgentId, { reportsTo: null }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be denied" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("terminates and denies on a reporting-chain cycle that never reaches the actor (depth-50 guard)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId, status: "in_progress" }));
    mockAgentService.list.mockResolvedValue([
      makeAgent(actorAgentId, { role: "manager" }),
      // assignee -> cycleAgentBId -> cycleAgentCId -> cycleAgentBId -> ... a 2-node
      // cycle that never reaches actorAgentId. The depth<50 guard must terminate
      // this instead of looping forever.
      makeAgent(assigneeAgentId, { reportsTo: cycleAgentBId }),
      makeAgent(cycleAgentBId, { reportsTo: cycleAgentCId }),
      makeAgent(cycleAgentCId, { reportsTo: cycleAgentBId }),
    ]);

    const res = await request(await createApp(actorAsAgent()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be denied, not hang" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
