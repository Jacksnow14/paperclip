import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AUR-5344. Actor guard on POST /approvals/:id/withdraw.
//
// The guard is proven in both directions: it must REFUSE a foreign agent and
// ALLOW the requesting agent. A 403-only proof cannot distinguish a correct
// guard from one that refuses everybody.

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  withdraw: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// Real uuid: the withdraw schema validates supersededByApprovalId as a uuid,
// so a placeholder string would 400 before the actor guard is ever reached.
const REPLACEMENT_ID = "9a1f2c34-5b6d-4e7f-8a90-1b2c3d4e5f60";

const agentActor = (agentId: string) => ({
  type: "agent",
  agentId,
  companyId: "company-1",
  source: "api_key",
  isInstanceAdmin: false,
});

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { title: "Approve ONE email" },
    requestedByAgentId: "requester-1",
    ...overrides,
  };
}

function withdrawnRow(overrides: Record<string, unknown> = {}) {
  return pendingRow({
    status: "withdrawn",
    supersededByApprovalId: REPLACEMENT_ID,
    withdrawalReason: "recipient list is unusable",
    ...overrides,
  });
}

describe("POST /approvals/:id/withdraw", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.getById.mockReset();
    mockApprovalService.withdraw.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  // ---- PASSES ---------------------------------------------------------------

  it("lets the requesting agent withdraw its own pending approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow());
    mockApprovalService.withdraw.mockResolvedValue({ approval: withdrawnRow(), applied: true });

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "recipient list is unusable", supersededByApprovalId: REPLACEMENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect(res.body.supersededByApprovalId).toBe(REPLACEMENT_ID);
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith(
      "approval-1",
      { agentId: "requester-1", userId: null },
      { reason: "recipient list is unusable", supersededByApprovalId: REPLACEMENT_ID },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.withdrawn",
        entityId: "approval-1",
        actorType: "agent",
        actorId: "requester-1",
      }),
    );
  });

  it("lets the board withdraw an agent's approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow());
    mockApprovalService.withdraw.mockResolvedValue({ approval: withdrawnRow(), applied: true });

    const res = await request(await createApp(boardActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith(
      "approval-1",
      { agentId: null, userId: "user-1" },
      { reason: undefined, supersededByApprovalId: undefined },
    );
  });

  it("does not re-log a repeated withdrawal that changed nothing", async () => {
    mockApprovalService.getById.mockResolvedValue(withdrawnRow());
    mockApprovalService.withdraw.mockResolvedValue({ approval: withdrawnRow(), applied: false });

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  // ---- FIRES ----------------------------------------------------------------

  it("refuses an agent withdrawing another agent's approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow());

    const res = await request(await createApp(agentActor("intruder-9")))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("refuses an agent withdrawing a board-requested approval with no requesting agent", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow({ requestedByAgentId: null }));

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("refuses an agent reaching into another company", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow({ companyId: "company-2" }));

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("404s an unknown approval", async () => {
    mockApprovalService.getById.mockResolvedValue(null);

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(404);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid supersession pointer at the schema boundary", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingRow());

    const res = await request(await createApp(agentActor("requester-1")))
      .post("/api/approvals/approval-1/withdraw")
      .send({ supersededByApprovalId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });
});
