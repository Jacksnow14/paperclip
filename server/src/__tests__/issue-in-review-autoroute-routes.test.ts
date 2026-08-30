import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listForIssue: vi.fn(async () => []),
  resolve: vi.fn(async () => undefined),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  list: vi.fn(async () => []),
  resolveByReference: vi.fn(async (_companyId: string, ref: string) => ({
    agent: { id: ref, companyId: "company-1" },
    ambiguous: false,
  })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({}),
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
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({
      listApprovalsForIssue: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

const fakeDb = {
  select: vi.fn(() => ({
    from: () => ({
      where: (..._args: unknown[]) => ({
        orderBy: async () => [],
      }),
    }),
  })),
};

async function createAgentApp(agentId = "agent-1") {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      source: "agent_key",
      runId: "test-run-id",
    };
    next();
  });
  app.use("/api", issueRoutes(fakeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function createBoardApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(fakeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const BASE_ISSUE = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "company-1",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  createdByUserId: "user-creator",
  createdByAgentId: null,
  identifier: "AUR-999",
  title: "Test issue",
  executionPolicy: null,
  executionState: null,
};

describe("in_review auto-route guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, ref: string) => ({
      agent: { id: ref, companyId: "company-1" },
      ambiguous: false,
    }));
  });

  it("auto-routes agent in_review to createdByUserId when no explicit reassignment", async () => {
    mockIssueService.getById.mockResolvedValue(BASE_ISSUE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...BASE_ISSUE,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "user-creator",
      }),
    );
  });

  it("rejects with 422 when no createdByUserId and no explicit reassignment", async () => {
    mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, createdByUserId: null });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/in_review requires reassignment/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows agent in_review with explicit assigneeAgentId pointing to another agent", async () => {
    mockIssueService.getById.mockResolvedValue(BASE_ISSUE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...BASE_ISSUE,
      ...patch,
      updatedAt: new Date(),
    }));
    // Agent needs tasks:assign to reassign to a different agent
    mockAccessService.hasPermission.mockResolvedValue(true);
    // Provide a pending interaction so assertAgentInReviewReviewPath passes
    mockIssueThreadInteractionService.listForIssue.mockResolvedValueOnce([{ status: "pending" }]);

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", assigneeAgentId: "agent-reviewer" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "agent-reviewer",
      }),
    );
    // Guard must NOT have overridden the explicit assignee with createdByUserId
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.assigneeUserId).not.toBe("user-creator");
  });

  it("allows agent in_review with explicit assigneeUserId", async () => {
    mockIssueService.getById.mockResolvedValue(BASE_ISSUE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...BASE_ISSUE,
      ...patch,
      updatedAt: new Date(),
    }));
    // Agent needs tasks:assign to reassign to a user other than createdByUserId
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", assigneeUserId: "explicit-reviewer" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeUserId: "explicit-reviewer",
      }),
    );
  });

  it("board user PATCH to in_review without reassignment bypasses guard", async () => {
    const boardIssue = { ...BASE_ISSUE, assigneeAgentId: null, assigneeUserId: "local-board" };
    mockIssueService.getById.mockResolvedValue(boardIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...boardIssue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createBoardApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    // Guard must not have forced reassignment for board actors
    expect(patch.assigneeAgentId).toBeUndefined();
    expect(patch.assigneeUserId).toBeUndefined();
  });

  it("agent in_review with assigneeAgentId: null and explicit assigneeUserId passes through without tasks:assign", async () => {
    mockIssueService.getById.mockResolvedValue(BASE_ISSUE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...BASE_ISSUE,
      ...patch,
      updatedAt: new Date(),
    }));

    // Assigning to createdByUserId is the returning-to-creator path — no tasks:assign needed
    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: "user-creator" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeUserId: "user-creator",
      }),
    );
  });

  it("AUR-5832: auto-routes agent in_review to reporting-chain manager when issue has no creator", async () => {
    const creatorlessIssue = { ...BASE_ISSUE, createdByUserId: null, createdByAgentId: null };
    mockIssueService.getById.mockResolvedValue(creatorlessIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...creatorlessIssue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "manager-agent-1",
        assigneeUserId: null,
      }),
    );
    // assertCanAssignTasks must not have been consulted for this auto-routed path
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
  });

  it("AUR-5832: rejects with 422 when issue has no creator and requesting agent has no manager", async () => {
    const creatorlessIssue = { ...BASE_ISSUE, createdByUserId: null, createdByAgentId: null };
    mockIssueService.getById.mockResolvedValue(creatorlessIssue);
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: null });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/in_review requires reassignment/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("AUR-5832: existing auto-route-to-creator behavior is unchanged when createdByAgentId exists but createdByUserId does not (no manager fallback)", async () => {
    const issueWithAgentCreator = {
      ...BASE_ISSUE,
      createdByUserId: null,
      createdByAgentId: "other-creator-agent",
    };
    mockIssueService.getById.mockResolvedValue(issueWithAgentCreator);
    // Even if the requesting agent has a manager, this path must still 422 —
    // the manager fallback only activates when there is NO creator at all.
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/in_review requires reassignment/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("AUR-6429: allows self-assigned agent in_review transition when a scheduled monitor is present (createdByAgentId exists, no createdByUserId)", async () => {
    const issueWithAgentCreatorAndMonitor = {
      ...BASE_ISSUE,
      createdByUserId: null,
      createdByAgentId: "other-creator-agent",
      executionPolicy: {
        monitor: {
          status: "scheduled",
          scheduledBy: "assignee",
          nextCheckAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          maxAttempts: 4,
        },
      },
    };
    mockIssueService.getById.mockResolvedValue(issueWithAgentCreatorAndMonitor);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issueWithAgentCreatorAndMonitor,
      ...patch,
      updatedAt: new Date(),
    }));
    // If the guard incorrectly fired, this would 422 (no manager fallback is even consulted here).
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.status).toBe("in_review");
    // Self-assignment must be preserved -- no forced reassignment to the manager or creator.
    expect(patch.assigneeAgentId).toBeUndefined();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("AUR-5832: no-creator issue with a scheduled monitor is exempted from the guard (no manager fallback consulted)", async () => {
    const creatorlessIssueWithMonitor = {
      ...BASE_ISSUE,
      createdByUserId: null,
      createdByAgentId: null,
      executionPolicy: {
        monitor: {
          status: "scheduled",
          scheduledBy: "assignee",
          nextCheckAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          maxAttempts: 4,
        },
      },
    };
    mockIssueService.getById.mockResolvedValue(creatorlessIssueWithMonitor);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...creatorlessIssueWithMonitor,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.status).toBe("in_review");
    expect(patch.assigneeAgentId).toBeUndefined();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("AUR-5985: comment-only PATCH on an already-in_review creator-less issue with a scheduled assignee monitor keeps the assignment (no bounce to manager)", async () => {
    const creatorlessInReviewIssue = {
      ...BASE_ISSUE,
      status: "in_review",
      createdByUserId: null,
      createdByAgentId: null,
      executionPolicy: {
        monitor: {
          status: "scheduled",
          scheduledBy: "assignee",
          nextCheckAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          maxAttempts: 4,
        },
      },
    };
    mockIssueService.getById.mockResolvedValue(creatorlessInReviewIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...creatorlessInReviewIssue,
      ...patch,
      updatedAt: new Date(),
    }));
    // If the guard incorrectly fired here, it would consult reportsTo to bounce to a manager.
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId: BASE_ISSUE.id,
      companyId: "company-1",
      body: "still working the monitor wake, no status change",
    });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ comment: "still working the monitor wake, no status change" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    // No status in updateFields (comment-only PATCH), and no auto-route reassignment.
    expect(patch.status).toBeUndefined();
    expect(patch.assigneeAgentId).toBeUndefined();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(res.body.warnings).toBeUndefined();
  });

  it("AUR-5985: transitioning into in_review still fires the guard even with a stale monitor field present", async () => {
    // Sanity check that the transition-based gate didn't accidentally disable the guard
    // entirely — it must still fire the very first time status flips to in_review.
    const creatorlessIssue = {
      ...BASE_ISSUE,
      createdByUserId: null,
      createdByAgentId: null,
      executionPolicy: null,
    };
    mockIssueService.getById.mockResolvedValue(creatorlessIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...creatorlessIssue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "manager-agent-1",
        assigneeUserId: null,
      }),
    );
  });

  it("AUR-5985: silently-discarded explicit assigneeAgentId is surfaced as a response warning", async () => {
    const creatorlessIssue = {
      ...BASE_ISSUE,
      createdByUserId: null,
      createdByAgentId: null,
    };
    mockIssueService.getById.mockResolvedValue(creatorlessIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...creatorlessIssue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", reportsTo: "manager-agent-1" });

    const res = await request(await createAgentApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", assigneeAgentId: "agent-1" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ assigneeAgentId: "manager-agent-1" }),
    );
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/auto-route guard/)]),
    );
  });

  it("rejects non-owner agent with 409 before guard fires", async () => {
    const issue = { ...BASE_ISSUE, assigneeAgentId: "other-agent" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.assertCheckoutOwner.mockRejectedValueOnce(
      Object.assign(new Error("checked out by another agent"), { statusCode: 409 }),
    );

    const res = await request(await createAgentApp("agent-1"))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
