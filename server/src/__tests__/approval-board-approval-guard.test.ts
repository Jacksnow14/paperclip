import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AUR-5353/AUR-5383. Write-path guard on POST /companies/:companyId/approvals
// for type "request_board_approval": payload.title/valueAtStake/costOfInaction
// are required non-empty strings. Proven in both directions — it must REJECT
// an incomplete board-approval payload with 422 naming every missing field,
// and it must ACCEPT a complete one, and it must leave other approval types
// (e.g. hire_agent) completely unaffected.

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

async function createAgentApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/approvals — board-approval payload guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.create.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("422s naming costOfInaction when only it is missing", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve X", valueAtStake: "$500/mo" },
      });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("costOfInaction");
    expect(JSON.stringify(res.body)).not.toContain("payload.title ");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("422s naming valueAtStake when only it is missing", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve X", costOfInaction: "Nothing ships" },
      });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("valueAtStake");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("422s naming title when only it is missing", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { valueAtStake: "$500/mo", costOfInaction: "Nothing ships" },
      });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("title");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("422s naming all three fields when payload is omitted entirely (not just empty)", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval" });

    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain("title");
    expect(body).toContain("valueAtStake");
    expect(body).toContain("costOfInaction");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("422s naming all three fields when payload is empty", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });

    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain("title");
    expect(body).toContain("valueAtStake");
    expect(body).toContain("costOfInaction");
    expect(res.body.details?.errors ?? res.body.errors).toHaveLength(3);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("422s on whitespace-only field values (blank, not just missing)", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "   ", valueAtStake: "$500/mo", costOfInaction: "Nothing ships" },
      });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("title");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("201s a complete request_board_approval payload and the row is readable", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-9",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve X",
        valueAtStake: "$500/mo",
        costOfInaction: "Nothing ships",
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          title: "Approve X",
          valueAtStake: "$500/mo",
          costOfInaction: "Nothing ships",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "approval-9",
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Approve X",
        valueAtStake: "$500/mo",
        costOfInaction: "Nothing ships",
      },
    });
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  });

  it("leaves non-board approval types (hire_agent) unaffected by the guard", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-10",
      companyId: "company-1",
      type: "hire_agent",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { role: "engineer" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockResolvedValue({
      role: "engineer",
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { role: "engineer" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  });
});
