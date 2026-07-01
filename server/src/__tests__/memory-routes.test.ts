import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { memoryRoutes } from "../routes/memory.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";

const mockMemoryService = vi.hoisted(() => ({
  providers: vi.fn(),
  listBindings: vi.fn(),
  listTargets: vi.fn(),
  createBinding: vi.fn(),
  getBindingById: vi.fn(),
  updateBinding: vi.fn(),
  setCompanyDefault: vi.fn(),
  resolveBinding: vi.fn(),
  setAgentOverride: vi.fn(),
  setProjectOverride: vi.fn(),
  query: vi.fn(),
  capture: vi.fn(),
  forget: vi.fn(),
  revoke: vi.fn(),
  correct: vi.fn(),
  agentUpdate: vi.fn(),
  promote: vi.fn(),
  review: vi.fn(),
  sweepRetention: vi.fn(),
  listRecords: vi.fn(),
  countRecords: vi.fn(),
  getRecord: vi.fn(),
  listOperations: vi.fn(),
  listExtractionJobs: vi.fn(),
  startRefreshJob: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getByIdentifier: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  memoryService: () => mockMemoryService,
  projectService: () => mockProjectService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", memoryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemoryService.getBindingById.mockResolvedValue({
      id: bindingId,
      companyId: companyA,
      key: "primary",
      name: "Primary",
      providerKey: "local_basic",
      config: {},
      enabled: true,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    mockMemoryService.updateBinding.mockResolvedValue({
      id: bindingId,
      companyId: companyA,
      key: "primary",
      name: "Primary",
      providerKey: "local_basic",
      config: {},
      enabled: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    mockProjectService.getById.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      companyId: companyA,
      name: "Project A",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("blocks binding updates for board users outside the binding company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/memory/bindings/${bindingId}`)
      .set("Origin", "http://localhost:3100")
      .send({ enabled: false });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mockMemoryService.getBindingById).toHaveBeenCalledWith(bindingId);
    expect(mockMemoryService.updateBinding).not.toHaveBeenCalled();
  });

  it("allows binding updates when the board user can access the binding company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/memory/bindings/${bindingId}`)
      .set("Origin", "http://localhost:3100")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(mockMemoryService.getBindingById).toHaveBeenCalledWith(bindingId);
    expect(mockMemoryService.updateBinding).toHaveBeenCalledWith(bindingId, { enabled: false });
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("blocks scoped revocation for agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: companyA,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/revoke`)
      .send({
        selector: { recordIds: ["44444444-4444-4444-8444-444444444444"] },
        reason: "Stale memory",
      });

    expect(res.status).toBe(403);
    expect(mockMemoryService.revoke).not.toHaveBeenCalled();
  });

  it("routes board scoped revocation through memory service and activity log", async () => {
    mockMemoryService.revoke.mockResolvedValue({
      operations: [],
      revokedRecordIds: ["44444444-4444-4444-8444-444444444444"],
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/revoke`)
      .set("Origin", "http://localhost:3100")
      .send({
        selector: { issueId: "55555555-5555-4555-8555-555555555555" },
        reason: "Issue memory should be revoked",
      });

    expect(res.status).toBe(200);
    expect(mockMemoryService.revoke).toHaveBeenCalledWith(
      companyA,
      {
        selector: { issueId: "55555555-5555-4555-8555-555555555555" },
        reason: "Issue memory should be revoked",
      },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("routes board correction through memory service", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    mockMemoryService.correct.mockResolvedValue({
      operation: { id: "op-1" },
      originalRecord: { id: recordId },
      correctedRecord: { id: "66666666-6666-4666-8666-666666666666" },
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/records/${recordId}/correct`)
      .set("Origin", "http://localhost:3100")
      .send({ content: "Corrected memory", reason: "User corrected stale fact" });

    expect(res.status).toBe(201);
    expect(mockMemoryService.correct).toHaveBeenCalledWith(
      companyA,
      recordId,
      { content: "Corrected memory", reason: "User corrected stale fact" },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("routes board review decisions through memory service", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    mockMemoryService.review.mockResolvedValue({
      operation: { id: "op-1" },
      record: { id: recordId, reviewState: "accepted" },
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyA}/memory/records/${recordId}/review`)
      .set("Origin", "http://localhost:3100")
      .send({ reviewState: "accepted", note: "Looks correct" });

    expect(res.status).toBe(200);
    expect(mockMemoryService.review).toHaveBeenCalledWith(
      companyA,
      recordId,
      { reviewState: "accepted", note: "Looks correct" },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("routes exact key lookup through memory service without semantic query", async () => {
    const keyRecord = {
      id: "44444444-4444-4444-8444-444444444444",
      title: "retrospective/AUR-1234/tool-gaps",
      content: "No fallbacks for image generation.",
    };
    mockMemoryService.listRecords.mockResolvedValue([keyRecord]);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/memory/records`)
      .query({ key: "retrospective/AUR-1234/tool-gaps" })
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([keyRecord]);
    expect(mockMemoryService.listRecords).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ key: "retrospective/AUR-1234/tool-gaps" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockMemoryService.query).not.toHaveBeenCalled();
  });

  it("routes title-prefix lookup for performance scorecards through memory service", async () => {
    const scorecard = {
      id: "55555555-5555-4555-8555-555555555555",
      title: "performance/agent-7/feature/2026-05-28",
      content: JSON.stringify({
        agent_id: "agent-7",
        task_type: "feature",
        outcome: "success",
        token_cost: 12500,
        quality_signal: 4,
        rework_required: false,
      }),
    };
    mockMemoryService.listRecords.mockResolvedValue([scorecard]);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/memory/records`)
      .query({ titlePrefix: "performance/agent-7/feature/", limit: "50" })
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([scorecard]);
    expect(mockMemoryService.listRecords).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ titlePrefix: "performance/agent-7/feature/", limit: 50 }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockMemoryService.query).not.toHaveBeenCalled();
  });

  it("routes count-only record queries through memory service", async () => {
    mockMemoryService.countRecords.mockResolvedValue({ count: 152 });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/memory/records`)
      .query({ count: "only", reviewState: "pending", includeRevoked: "false", includeExpired: "false" })
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 152 });
    expect(mockMemoryService.countRecords).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({
        count: "only",
        reviewState: "pending",
        includeRevoked: false,
        includeExpired: false,
      }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockMemoryService.listRecords).not.toHaveBeenCalled();
  });

  it("sets project memory overrides through the owning project company", async () => {
    const projectId = "77777777-7777-4777-8777-777777777777";
    mockMemoryService.setProjectOverride.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      companyId: companyA,
      bindingId,
      targetType: "project",
      targetId: projectId,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .put(`/api/projects/${projectId}/memory-binding`)
      .set("Origin", "http://localhost:3100")
      .send({ bindingId });

    expect(res.status).toBe(200);
    expect(mockProjectService.getById).toHaveBeenCalledWith(projectId);
    expect(mockMemoryService.setProjectOverride).toHaveBeenCalledWith(projectId, bindingId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "memory.project_override_set",
        entityType: "project",
        entityId: projectId,
      }),
    );
  });

  it("blocks project memory overrides outside the board user's companies", async () => {
    const projectId = "77777777-7777-4777-8777-777777777777";
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .put(`/api/projects/${projectId}/memory-binding`)
      .set("Origin", "http://localhost:3100")
      .send({ bindingId });

    expect(res.status).toBe(403);
    expect(mockMemoryService.setProjectOverride).not.toHaveBeenCalled();
  });

  it("blocks promote for agent callers", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    const app = createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: companyA,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/records/${recordId}/promote`)
      .send({ targetScope: { scopeType: "org" }, reason: "Promote to org" });

    expect(res.status).toBe(403);
    expect(mockMemoryService.promote).not.toHaveBeenCalled();
  });

  it("blocks promote for board users outside the record's company", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/records/${recordId}/promote`)
      .set("Origin", "http://localhost:3100")
      .send({ targetScope: { scopeType: "org" }, reason: "Promote to org" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mockMemoryService.promote).not.toHaveBeenCalled();
  });

  it("routes board promote through memory service and logs activity", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    const promotedId = "66666666-6666-4666-8666-666666666666";
    mockMemoryService.promote.mockResolvedValue({
      operation: { id: "op-promote-1" },
      originalRecord: {
        id: recordId,
        scope: { scopeType: "run", scopeId: "run-scope-id" },
      },
      promotedRecord: {
        id: promotedId,
        scope: { scopeType: "org", scopeId: companyA },
      },
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/records/${recordId}/promote`)
      .set("Origin", "http://localhost:3100")
      .send({ targetScope: { scopeType: "org" }, reason: "Widen run memory to org" });

    expect(res.status).toBe(201);
    expect(mockMemoryService.promote).toHaveBeenCalledWith(
      companyA,
      recordId,
      { targetScope: { scopeType: "org" }, reason: "Widen run memory to org" },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "memory.promoted",
        entityType: "memory_record",
        entityId: promotedId,
        details: expect.objectContaining({
          originalRecordId: recordId,
          promotedRecordId: promotedId,
          reason: "Widen run memory to org",
        }),
      }),
    );
  });

  describe("PATCH /companies/:companyId/memory/records/:recordId (agent update)", () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    function makeRecord(overrides: Record<string, unknown> = {}) {
      return {
        id: recordId,
        owner: { type: "agent", id: agentId },
        metadata: { category: "experiment", status: "proposed" },
        content: "Hypothesis: X causes Y",
        ...overrides,
      };
    }

    beforeEach(() => {
      mockMemoryService.agentUpdate = vi.fn();
      mockMemoryService.getRecord.mockResolvedValue(makeRecord());
      mockMemoryService.agentUpdate.mockResolvedValue({
        operation: { id: "op-update-1" },
        record: makeRecord({ metadata: { category: "experiment", status: "approved", board_approval_id: "cd95d0c6" } }),
      });
    });

    it("allows an owner agent to update metadata on an experiment record", async () => {
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved", board_approval_id: "cd95d0c6" } });

      expect(res.status).toBe(200);
      expect(mockMemoryService.agentUpdate).toHaveBeenCalledWith(
        companyA,
        recordId,
        { metadata: { status: "approved", board_approval_id: "cd95d0c6" } },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
      expect(mockLogActivity).toHaveBeenCalledOnce();
    });

    it("blocks a non-owner agent from updating the record", async () => {
      const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const app = createApp({ type: "agent", agentId: otherAgent, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Agent can only update memory records it owns" });
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("blocks an agent from updating a record with a non-allowlisted category", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "lesson" } }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/lesson/);
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("blocks an agent from updating a record with no category", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: {} }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(403);
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("allows board users to update any record without category restriction", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "lesson" } }));
      const app = createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: [companyA],
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .set("Origin", "http://localhost:3100")
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(200);
      expect(mockMemoryService.agentUpdate).toHaveBeenCalled();
    });

    it("returns 400 for an empty update body", async () => {
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({});

      expect(res.status).toBe(400);
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });
  });

  describe("POST /companies/:companyId/memory/capture — AUR-NNNN source.issueId resolution", () => {
    const issueUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const captureBody = {
      source: { kind: "issue", issueId: "AUR-1234" },
      content: "Resolved issue ref test",
      sensitivityLabel: "internal",
    };
    const captureResult = {
      operation: { id: "op-capture-1", bindingId: bindingId, source: { kind: "issue", issueId: issueUuid } },
      records: [{ id: "dd000000-0000-4000-8000-000000000000" }],
    };
    const boardActor = {
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    };

    it("resolves AUR-NNNN to UUID before persisting", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue({ id: issueUuid, companyId: companyA });
      mockMemoryService.capture.mockResolvedValue(captureResult);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(201);
      expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("AUR-1234");
      expect(mockMemoryService.capture).toHaveBeenCalledWith(
        companyA,
        expect.objectContaining({ source: { kind: "issue", issueId: issueUuid } }),
        expect.objectContaining({ actorType: "user" }),
      );
    });

    it("passes through a valid UUID without extra lookup", async () => {
      mockMemoryService.capture.mockResolvedValue(captureResult);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...captureBody, source: { kind: "issue", issueId: issueUuid } });

      expect(res.status).toBe(201);
      expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
      expect(mockMemoryService.capture).toHaveBeenCalledWith(
        companyA,
        expect.objectContaining({ source: { kind: "issue", issueId: issueUuid } }),
        expect.anything(),
      );
    });

    it("returns 422 for an unknown AUR-NNNN identifier", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue(null);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...captureBody, source: { kind: "issue", issueId: "AUR-9999" } });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/AUR-9999/);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("returns 422 when the resolved issue belongs to a different company", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue({ id: issueUuid, companyId: companyB });
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(422);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });
  });

  // ── Part A: Pagination ────────────────────────────────────────────────────

  it("passes offset to listRecords for paginated queries", async () => {
    mockMemoryService.listRecords.mockResolvedValue([]);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/memory/records`)
      .query({ limit: "50", offset: "100" })
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(200);
    expect(mockMemoryService.listRecords).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ limit: 50, offset: 100 }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
  });

  it("defaults offset to 0 when not provided", async () => {
    mockMemoryService.listRecords.mockResolvedValue([]);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/memory/records`)
      .query({ limit: "50" })
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(200);
    expect(mockMemoryService.listRecords).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ offset: 0 }),
      expect.anything(),
    );
  });

  // ── Part B: Agent self-service revoke ─────────────────────────────────────

  describe("POST /companies/:companyId/memory/records/:recordId/revoke-own", () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    function makeRoutingRecord(overrides: Record<string, unknown> = {}) {
      return {
        id: recordId,
        owner: { type: "agent", id: agentId },
        metadata: { category: "routing" },
        scopeType: "agent",
        scope: { agentId },
        reviewState: "accepted",
        content: "routing/AUR-2066 decision",
        ...overrides,
      };
    }

    const revokeResult = {
      operations: [],
      revokedRecordIds: [recordId],
    };

    it("allows an agent to revoke its own routing record", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord());
      mockMemoryService.revoke.mockResolvedValue(revokeResult);
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Duplicate routing entry" });

      expect(res.status).toBe(200);
      expect(res.body.revokedRecordIds).toEqual([recordId]);
      expect(mockMemoryService.revoke).toHaveBeenCalledWith(
        companyA,
        { selector: { recordIds: [recordId] }, reason: "Duplicate routing entry" },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "memory.revoked", details: expect.objectContaining({ selfService: true }) }),
      );
    });

    it("returns 403 when agent tries to revoke a record owned by another agent", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ owner: { type: "agent", id: otherAgent } }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Testing non-owner revoke" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Agent can only revoke memory records it owns" });
      expect(mockMemoryService.revoke).not.toHaveBeenCalled();
    });

    it("returns 403 when agent tries to revoke its own record with off-allowlist category", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ metadata: { category: "lesson" } }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Testing off-allowlist revoke" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/lesson/);
      expect(mockMemoryService.revoke).not.toHaveBeenCalled();
    });

    it("allows an agent to revoke its own synthesis record (AUR-3072)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ metadata: { category: "synthesis" } }));
      mockMemoryService.revoke.mockResolvedValue(revokeResult);
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "AUR-3072 dedup" });

      expect(res.status).toBe(200);
      expect(res.body.revokedRecordIds).toEqual([recordId]);
      expect(mockMemoryService.revoke).toHaveBeenCalledWith(
        companyA,
        { selector: { recordIds: [recordId] }, reason: "AUR-3072 dedup" },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
    });

    it("returns 403 when a board user tries to use the revoke-own endpoint", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord());
      const app = createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: [companyA],
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .set("Origin", "http://localhost:3100")
        .send({ reason: "Testing board user revoke-own" });

      expect(res.status).toBe(403);
      expect(mockMemoryService.revoke).not.toHaveBeenCalled();
    });
  });

  // ── Part C: Capture visibility warnings ───────────────────────────────────

  describe("POST /companies/:companyId/memory/capture — visibility warnings", () => {
    const captureBody = {
      source: { kind: "issue", issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      content: "Test capture content",
    };

    it("returns non-empty warnings when captured record is pending review", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-1", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "dd000000-0000-4000-8000-000000000000",
          reviewState: "pending",
          scopeType: "org",
          scope: {},
        }],
      });
      const app = createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: [companyA],
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(201);
      expect(res.body.warnings).toBeInstanceOf(Array);
      expect(res.body.warnings.length).toBeGreaterThan(0);
      expect(res.body.warnings[0]).toMatch(/pending review/);
    });

    it("returns no warnings for an auto-accepted org-scoped record", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-2", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ee000000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      const app = createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: [companyA],
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual([]);
    });

    it("returns a warning when captured record is project-scoped", async () => {
      const projectId = "77777777-7777-4777-8777-777777777777";
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-3", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ff000000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "project",
          scope: { projectId },
        }],
      });
      const app = createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: [companyA],
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...captureBody, scope: { projectId } });

      expect(res.status).toBe(201);
      expect(res.body.warnings).toBeInstanceOf(Array);
      expect(res.body.warnings.some((w: string) => w.includes("project-scoped"))).toBe(true);
    });
  });

  it("starts memory refresh jobs through the memory service and logs activity", async () => {
    mockMemoryService.startRefreshJob.mockResolvedValue({
      job: {
        id: "99999999-9999-4999-8999-999999999999",
        companyId: companyA,
        key: "memory.refresh",
        jobType: "memory_refresh",
      },
      run: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
        jobKey: "memory.refresh",
        jobType: "memory_refresh",
        status: "queued",
      },
      dryRun: false,
      sourceCounts: {
        issue: 1,
        issue_comment: 2,
        issue_document: 1,
        run: 0,
      },
      recordCount: 0,
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/refresh-jobs`)
      .set("Origin", "http://localhost:3100")
      .send({
        sourceKinds: ["issue", "issue_comment", "issue_document"],
        issueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        dryRun: false,
      });

    expect(res.status).toBe(202);
    expect(mockMemoryService.startRefreshJob).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({
        sourceKinds: ["issue", "issue_comment", "issue_document"],
        issueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        dryRun: false,
      }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "memory.refresh_job_started",
        entityType: "background_job_run",
        entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
  });
});
