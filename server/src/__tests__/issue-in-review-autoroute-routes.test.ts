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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  resolveByReference: vi.fn(async (_companyId: string, ref: string) => ({
    agent: { id: ref, companyId: "company-1" },
    ambiguous: false,
  })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
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
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    memoryService: () => ({
      captureIssueComment: vi.fn(async () => undefined),
      captureIssueDocument: vi.fn(async () => undefined),
    }),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

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
  app.use("/api", issueRoutes({} as any, {} as any));
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
  app.use("/api", issueRoutes({} as any, {} as any));
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

  it("guard does not fire when agent is not the current assignee", async () => {
    const issue = { ...BASE_ISSUE, assigneeAgentId: "other-agent" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    // agent-1 patches an issue currently assigned to other-agent -> no guard fires
    const res = await request(await createAgentApp("agent-1"))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.assigneeAgentId).toBeUndefined();
    expect(patch.assigneeUserId).toBeUndefined();
  });
});
