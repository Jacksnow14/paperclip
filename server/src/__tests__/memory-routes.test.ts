import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { agents, createDb, companies, memoryBindings, memoryLocalRecords, memoryOperations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { memoryRoutes } from "../routes/memory.js";
import { memoryService as actualMemoryService } from "../services/memory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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
  getById: vi.fn(),
  getTombstoneByIdentifierOrUuid: vi.fn(),
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory route visibility tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
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
    // Default: resolve any id (identifier or UUID) back to itself in companyA.
    // Tests exercising a specific resolution outcome (miss, cross-company, etc.)
    // override with mockResolvedValueOnce.
    mockIssueService.getById.mockImplementation(async (id: string) => ({ id, companyId: companyA }));
    mockIssueService.getTombstoneByIdentifierOrUuid.mockResolvedValue(null);
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

    it("blocks a non-owner agent from updating a non-shared record with owner details and alternatives", async () => {
      const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const app = createApp({ type: "agent", agentId: otherAgent, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/non-shared memory records they do not own/i);
      expect(res.body.error).toMatch(/ask the owner/i);
      expect(res.body.details).toMatchObject({
        category: "experiment",
        ownerType: "agent",
        ownerId: agentId,
        ownerAgentId: agentId,
        rule: "agent_non_owner_patch_disallowed",
      });
      expect(res.body.details.sharedContributorCategories).toEqual(
        expect.arrayContaining(["lesson", "synthesis", "tool_gap"]),
      );
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("blocks an agent from updating a record with a non-allowlisted category with an actionable 403 (AUR-4022)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "misc" } }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { status: "approved" } });

      expect(res.status).toBe(403);
      // Names the category and states it's immutable, not a bare 403 (AUR-3938 regression:
      // a silent-403 PATCH was mistaken for success and left a stale runbook live for ~6h).
      expect(res.body.error).toMatch(/misc/);
      expect(res.body.error).toMatch(/immutable/i);
      expect(res.body.error).toMatch(/capture a new record/i);
      expect(res.body.details).toMatchObject({
        category: "misc",
        immutable: true,
        supportedAlternative: "capture_new_record",
      });
      expect(res.body.details.agentMutableCategories).toEqual(expect.arrayContaining(["lesson", "experiment"]));
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("allows an owner agent to update its own lesson record (AUR-3865)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "lesson" } }));
      mockMemoryService.agentUpdate.mockResolvedValue({
        operation: { id: "op-update-lesson-1" },
        record: makeRecord({ metadata: { category: "lesson", content: "corrected" } }),
      });
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ content: "corrected lesson text" });

      expect(res.status).toBe(200);
      expect(mockMemoryService.agentUpdate).toHaveBeenCalledWith(
        companyA,
        recordId,
        { content: "corrected lesson text" },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
    });

    it("allows a non-owner agent to update another agent's lesson record via the shared contributor path", async () => {
      const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "lesson" } }));
      mockMemoryService.agentUpdate.mockResolvedValue({
        operation: { id: "op-update-lesson-2" },
        record: makeRecord({ metadata: { category: "lesson" }, content: "attempted correction" }),
      });
      const app = createApp({ type: "agent", agentId: otherAgent, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ content: "attempted correction" });

      expect(res.status).toBe(200);
      expect(mockMemoryService.agentUpdate).toHaveBeenCalledWith(
        companyA,
        recordId,
        { content: "attempted correction" },
        expect.objectContaining({ actorType: "agent", agentId: otherAgent }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "memory.updated",
          details: expect.objectContaining({
            contributorAmendment: true,
            recordOwnerType: "agent",
            recordOwnerId: agentId,
          }),
        }),
      );
    });

    it("blocks a non-owner agent from retitling another agent's shared lesson record", async () => {
      const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ title: "Lesson", metadata: { category: "lesson" } }));
      const app = createApp({ type: "agent", agentId: otherAgent, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ title: "retitled lesson" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot change the title/i);
      expect(res.body.error).toMatch(/ask the owner to retitle/i);
      expect(res.body.details).toMatchObject({
        category: "lesson",
        ownerType: "agent",
        ownerId: agentId,
        ownerAgentId: agentId,
        currentTitle: "Lesson",
        requestedTitle: "retitled lesson",
        rule: "shared_contributor_title_change_disallowed",
      });
      expect(mockMemoryService.agentUpdate).not.toHaveBeenCalled();
    });

    it("blocks a non-owner agent from changing metadata.category on another agent's shared lesson record", async () => {
      const otherAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      mockMemoryService.getRecord.mockResolvedValue(makeRecord({ metadata: { category: "lesson" } }));
      const app = createApp({ type: "agent", agentId: otherAgent, companyId: companyA });

      const res = await request(app)
        .patch(`/api/companies/${companyA}/memory/records/${recordId}`)
        .send({ metadata: { category: "experiment", status: "approved" } });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot change metadata\.category/i);
      expect(res.body.error).toMatch(/ask the owner to reclassify/i);
      expect(res.body.details).toMatchObject({
        category: "lesson",
        ownerType: "agent",
        ownerId: agentId,
        ownerAgentId: agentId,
        currentCategory: "lesson",
        requestedCategory: "experiment",
        rule: "shared_contributor_category_change_disallowed",
      });
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
      mockIssueService.getById.mockResolvedValueOnce({ id: issueUuid, companyId: companyA });
      mockMemoryService.capture.mockResolvedValue(captureResult);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(201);
      expect(mockIssueService.getById).toHaveBeenCalledWith("AUR-1234");
      expect(mockMemoryService.capture).toHaveBeenCalledWith(
        companyA,
        expect.objectContaining({ source: { kind: "issue", issueId: issueUuid } }),
        expect.objectContaining({ actorType: "user" }),
      );
    });

    it("resolves a UUID-shaped issueId against the DB before persisting (AUR-3996: never trust shape alone)", async () => {
      mockMemoryService.capture.mockResolvedValue(captureResult);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...captureBody, source: { kind: "issue", issueId: issueUuid } });

      expect(res.status).toBe(201);
      expect(mockIssueService.getById).toHaveBeenCalledWith(issueUuid);
      expect(mockMemoryService.capture).toHaveBeenCalledWith(
        companyA,
        expect.objectContaining({ source: { kind: "issue", issueId: issueUuid } }),
        expect.anything(),
      );
    });

    it("returns 422 for a fabricated UUID-shaped issueId that does not resolve to a real issue", async () => {
      const fabricatedUuid = "10000000-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
      mockIssueService.getById.mockResolvedValueOnce(null);
      const app = createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...captureBody, source: { kind: "issue", issueId: fabricatedUuid } });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(new RegExp(fabricatedUuid));
      expect(mockIssueService.getById).toHaveBeenCalledWith(fabricatedUuid);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("returns 422 for an unknown AUR-NNNN identifier", async () => {
      mockIssueService.getById.mockResolvedValueOnce(null);
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
      mockIssueService.getById.mockResolvedValueOnce({ id: issueUuid, companyId: companyB });
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

    it("returns an actionable 403 when agent tries to revoke its own record with off-allowlist category (AUR-4022)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ metadata: { category: "misc" } }));
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Testing off-allowlist revoke" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/misc/);
      expect(res.body.error).toMatch(/immutable/i);
      expect(res.body.error).toMatch(/capture a new record/i);
      expect(res.body.details).toMatchObject({
        category: "misc",
        immutable: true,
        supportedAlternative: "capture_new_record",
      });
      expect(mockMemoryService.revoke).not.toHaveBeenCalled();
    });

    it("allows an agent to revoke its own lesson record (AUR-3865)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ metadata: { category: "lesson" } }));
      mockMemoryService.revoke.mockResolvedValue(revokeResult);
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "AUR-3865 retracting wrong lesson" });

      expect(res.status).toBe(200);
      expect(res.body.revokedRecordIds).toEqual([recordId]);
      expect(mockMemoryService.revoke).toHaveBeenCalledWith(
        companyA,
        { selector: { recordIds: [recordId] }, reason: "AUR-3865 retracting wrong lesson" },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
    });

    it("returns 403 when agent tries to revoke another agent's lesson record", async () => {
      mockMemoryService.getRecord.mockResolvedValue(
        makeRoutingRecord({ metadata: { category: "lesson" }, owner: { type: "agent", id: otherAgent } }),
      );
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Testing non-owner lesson revoke" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Agent can only revoke memory records it owns" });
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

    it("allows an agent to revoke its own routing_rationale record (AUR-3990)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(makeRoutingRecord({ metadata: { category: "routing_rationale" } }));
      mockMemoryService.revoke.mockResolvedValue(revokeResult);
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "AUR-3990 dedup of stale routing/* record" });

      expect(res.status).toBe(200);
      expect(res.body.revokedRecordIds).toEqual([recordId]);
      expect(mockMemoryService.revoke).toHaveBeenCalledWith(
        companyA,
        { selector: { recordIds: [recordId] }, reason: "AUR-3990 dedup of stale routing/* record" },
        expect.objectContaining({ actorType: "agent", agentId }),
      );
    });

    it("returns 403 when agent tries to revoke another agent's routing_rationale record (AUR-3990)", async () => {
      mockMemoryService.getRecord.mockResolvedValue(
        makeRoutingRecord({ metadata: { category: "routing_rationale" }, owner: { type: "agent", id: otherAgent } }),
      );
      const app = createApp({ type: "agent", agentId, companyId: companyA });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/records/${recordId}/revoke-own`)
        .send({ reason: "Testing non-owner routing_rationale revoke" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Agent can only revoke memory records it owns" });
      expect(mockMemoryService.revoke).not.toHaveBeenCalled();
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
      // AUR-4140: machine-readable visibility signal, and the warning must name
      // the record id so the author can actually verify the write.
      expect(res.body.visibility).toBe("pending_review");
      expect(res.body.warnings).toBeInstanceOf(Array);
      expect(res.body.warnings.length).toBeGreaterThan(0);
      expect(res.body.warnings[0]).toMatch(/pending review/);
      expect(res.body.warnings[0]).toContain("dd000000-0000-4000-8000-000000000000");
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
      expect(res.body.visibility).toBe("visible");
      expect(res.body.warnings).toEqual([]);
    });

    it("returns a shared-category collision warning via an exact-title system probe", async () => {
      const title = "lesson/false-zero-from-unvalidated-field-name";
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-2b", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ee100000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      mockMemoryService.listRecords.mockResolvedValue([
        {
          id: "ee100000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        },
        {
          id: "cc680000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "371a1b08-0286-4a12-a516-f587f42df5eb" },
          metadata: { category: "lesson" },
          reviewState: "pending",
          scopeType: "project",
          scope: {},
          sensitivityLabel: "internal",
        },
      ]);
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .send({ ...captureBody, title, metadata: { category: "lesson" } });

      expect(res.status).toBe(201);
      expect(mockMemoryService.listRecords).toHaveBeenCalledWith(
        companyA,
        expect.objectContaining({ key: title, limit: 200 }),
        expect.objectContaining({ actorType: "system", actorId: "memory-capture-collision-probe" }),
      );
      expect(res.body.warnings.some((w: string) => w.includes("cc680000-0000-4000-8000-000000000000"))).toBe(true);
      expect(res.body.warnings.some((w: string) => w.includes("371a1b08-0286-4a12-a516-f587f42df5eb"))).toBe(
        true,
      );
      expect(res.body.warnings.some((w: string) => w.includes("PATCH the existing record"))).toBe(true);
    });

    it("returns an owner-keyed collision warning without suggesting PATCH", async () => {
      const title = "routing/AUR-4147";
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-2c", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ee200000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "441a5729-1a2c-4f2e-83d4-1bdd65982872" },
          metadata: { category: "routing_rationale" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      mockMemoryService.listRecords.mockResolvedValue([
        {
          id: "ee200000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "441a5729-1a2c-4f2e-83d4-1bdd65982872" },
          metadata: { category: "routing_rationale" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        },
        {
          id: "ceo-row-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b" },
          metadata: { category: "routing_rationale" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
          sensitivityLabel: "internal",
        },
      ]);
      const app = createApp({
        type: "agent",
        agentId: "441a5729-1a2c-4f2e-83d4-1bdd65982872",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .send({
          ...captureBody,
          title,
          // chosen_agent is required for routing_rationale captures (AUR-4280/AUR-4303).
          metadata: { category: "routing_rationale", chosen_agent: "441a5729-1a2c-4f2e-83d4-1bdd65982872" },
        });

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => w.includes("PATCH the existing record"))).toBe(false);
      expect(res.body.warnings.some((w: string) => w.includes("Readers resolve routing/* by recency"))).toBe(true);
    });

    it("withholds collision details when the existing row is restricted", async () => {
      const title = "lesson/restricted-collision";
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-2d", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ee300000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      mockMemoryService.listRecords.mockResolvedValue([
        {
          id: "ee300000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        },
        {
          id: "restricted-row-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "restricted-owner" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
          sensitivityLabel: "restricted",
        },
      ]);
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .send({ ...captureBody, title, metadata: { category: "lesson" } });

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => /details withheld/i.test(w))).toBe(true);
      expect(res.body.warnings.some((w: string) => w.includes("restricted-row-0000-4000-8000-000000000000"))).toBe(
        false,
      );
    });

    it("does not fail capture when the post-write collision lookup errors", async () => {
      const title = "lesson/collision-check-failure";
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-2e", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "ee400000-0000-4000-8000-000000000000",
          title,
          owner: { type: "agent", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          metadata: { category: "lesson" },
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      mockMemoryService.listRecords.mockRejectedValue(new Error("transient db restart"));
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .send({ ...captureBody, title, metadata: { category: "lesson" } });

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => /collision check/i.test(w))).toBe(true);
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

    it("returns a dedup warning referencing the existing record id when the capture short-circuits (AUR-3991)", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-4", bindingId: bindingId, source: { kind: "issue" }, resultJson: { dedup: true } },
        records: [{
          id: "11000000-0000-4000-8000-000000000000",
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
        .send({
          ...captureBody,
          title: "routing/AUR-9999",
          // chosen_agent is required for routing_rationale captures (AUR-4280/AUR-4303).
          metadata: { category: "routing_rationale", chosen_agent: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        });

      expect(res.status).toBe(201);
      expect(res.body.warnings).toBeInstanceOf(Array);
      expect(
        res.body.warnings.some(
          (w: string) => w.includes("already existed") && w.includes("11000000-0000-4000-8000-000000000000"),
        ),
      ).toBe(true);
    });
  });

  // ── Part C.1: Destructive-upsert warning (AUR-4522) ─────────────────────────

  describe("POST /companies/:companyId/memory/capture — destructive upsert warning", () => {
    const captureBody = {
      source: { kind: "issue", issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      content: "Test capture content",
      upsert: true,
    };

    it("warns when an upsert overwrote a record belonging to a different issue", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-6", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "33300000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
        dedup: true,
        upsertOverwrite: {
          recordId: "33300000-0000-4000-8000-000000000000",
          previousIssueId: "AUR-1001",
          incomingIssueId: "AUR-1002",
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
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send(captureBody);

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => w.includes("AUR-1001") && w.includes("AUR-1002"))).toBe(true);
    });

    it("does not warn on a genuine same-issue upsert re-capture", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-7", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "44400000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
        dedup: true,
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
  });

  describeEmbeddedPostgres("POST /companies/:companyId/memory/capture — collision detection uses real service visibility rules", () => {
    let db!: ReturnType<typeof createDb>;
    let realMemory!: ReturnType<typeof actualMemoryService>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    const bindingKey = "primary";
    const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projectId = "77777777-7777-4777-8777-777777777777";

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-routes-");
      db = createDb(tempDb.connectionString);
      realMemory = actualMemoryService(db);
    }, 20_000);

    afterEach(async () => {
      await db.delete(memoryLocalRecords);
      await db.delete(memoryOperations);
      await db.delete(memoryBindings);
      await db.delete(projects);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    beforeEach(() => {
      mockMemoryService.capture.mockImplementation((companyId, payload, actor) =>
        realMemory.capture(companyId, payload, actor)
      );
      mockMemoryService.listRecords.mockImplementation((companyId, filters, actor) =>
        realMemory.listRecords(companyId, filters, actor)
      );
    });

    async function setUpCompanyWithBinding(options?: { projectId?: string }) {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: ownerA,
          companyId,
          name: "Owner A",
          role: "tester",
          adapterType: "process",
        },
        {
          id: ownerB,
          companyId,
          name: "Owner B",
          role: "tester",
          adapterType: "process",
        },
      ]);
      if (options?.projectId) {
        await db.insert(projects).values({
          id: options.projectId,
          companyId,
          name: "Memory collision project",
          status: "active",
        });
      }
      await db.insert(memoryBindings).values({
        id: randomUUID(),
        companyId,
        key: bindingKey,
        name: "Primary",
        providerKey: "local_basic",
        config: {},
        enabled: true,
      });
      return { companyId };
    }

    function agentActor(agentId: string) {
      return {
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        userId: null,
        runId: null,
      };
    }

    it("warns on a pending cross-owner collision that the capturing agent cannot see directly", async () => {
      const title = "lesson/false-zero-from-unvalidated-field-name";
      const { companyId } = await setUpCompanyWithBinding();
      const existing = await realMemory.capture(
        companyId,
        {
          bindingKey,
          source: { kind: "manual_note" as const },
          title,
          content: "Owner A lesson",
          metadata: { category: "lesson" },
        },
        agentActor(ownerA),
      );
      await db.update(memoryLocalRecords).set({ reviewState: "pending" }).where(eq(memoryLocalRecords.id, existing.records[0].id));

      const invisibleToCapturingAgent = await realMemory.listRecords(
        companyId,
        { key: title, limit: 200 },
        agentActor(ownerB),
      );
      expect(invisibleToCapturingAgent).toHaveLength(0);

      const app = createApp({ type: "agent", agentId: ownerB, companyId });
      const res = await request(app)
        .post(`/api/companies/${companyId}/memory/capture`)
        .send({
          bindingKey,
          source: { kind: "manual_note" },
          title,
          content: "Owner B lesson",
          metadata: { category: "lesson" },
        });

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => w.includes("reviewState=pending"))).toBe(true);
      expect(res.body.warnings.some((w: string) => w.includes("PATCH the existing record"))).toBe(true);
    });

    it("warns on a project-scoped cross-owner collision that the capturing agent cannot see directly", async () => {
      const title = "lesson/project-scoped-shadow";
      const { companyId } = await setUpCompanyWithBinding({ projectId });
      await realMemory.capture(
        companyId,
        {
          bindingKey,
          source: { kind: "manual_note" as const },
          title,
          content: "Owner A project lesson",
          scope: { projectId },
          metadata: { category: "lesson" },
        },
        agentActor(ownerA),
      );

      const invisibleToCapturingAgent = await realMemory.listRecords(
        companyId,
        { key: title, limit: 200 },
        agentActor(ownerB),
      );
      expect(invisibleToCapturingAgent).toHaveLength(0);

      const app = createApp({ type: "agent", agentId: ownerB, companyId });
      const res = await request(app)
        .post(`/api/companies/${companyId}/memory/capture`)
        .send({
          bindingKey,
          source: { kind: "manual_note" },
          title,
          content: "Owner B org lesson",
          metadata: { category: "lesson" },
        });

      expect(res.status).toBe(201);
      expect(res.body.warnings.some((w: string) => w.includes("scopeType=project"))).toBe(true);
      expect(res.body.warnings.some((w: string) => w.includes("PATCH the existing record"))).toBe(true);
    });
  });

  // ── Part D: Router-read category scope guard (AUR-3925) ────────────────────

  describe("POST /companies/:companyId/memory/capture — router-read scope guard", () => {
    const projectId = "88888888-8888-4888-8888-888888888888";
    const baseBody = {
      source: { kind: "issue", issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      content: "Test capture content",
    };

    it.each(["routing_rationale", "performance_scorecard", "scorecard_adjusted"])(
      "rejects a project-scoped capture (scope.projectId) for category '%s' before calling memory.capture",
      async (category) => {
        const app = createApp({
          type: "agent",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          companyId: companyA,
        });

        const res = await request(app)
          .post(`/api/companies/${companyA}/memory/capture`)
          .set("Origin", "http://localhost:3100")
          .send({ ...baseBody, metadata: { category }, scope: { projectId } });

        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(new RegExp(category));
        expect(res.body.error).toMatch(/metadata\.project_id/);
        expect(mockMemoryService.capture).not.toHaveBeenCalled();
      },
    );

    it("rejects a project-scoped capture via top-level scopeType/scopeId for a router-read category", async () => {
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({
          ...baseBody,
          metadata: { category: "performance_scorecard" },
          scopeType: "project",
          scopeId: projectId,
        });

      expect(res.status).toBe(422);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("allows an org-wide (unscoped) capture for a router-read category", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-4", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "11100000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "org",
          scope: {},
        }],
      });
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({
          ...baseBody,
          metadata: {
            category: "performance_scorecard",
            project_id: projectId,
            issue_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            quality_signal: 4,
            token_cost: 12000,
            agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            task_type: "bug",
          },
        });

      expect(res.status).toBe(201);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });

    it("does not reject a project-scoped capture for a non-router-read category", async () => {
      mockMemoryService.capture.mockResolvedValue({
        operation: { id: "op-5", bindingId: bindingId, source: { kind: "issue" } },
        records: [{
          id: "22200000-0000-4000-8000-000000000000",
          reviewState: "accepted",
          scopeType: "project",
          scope: { projectId },
        }],
      });
      const app = createApp({
        type: "agent",
        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
      });

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...baseBody, metadata: { category: "retrospective" }, scope: { projectId } });

      expect(res.status).toBe(201);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });
  });

  // ── Part E: Scorecard integrity guard (AUR-3993/AUR-3996) ──────────────────

  describe("POST /companies/:companyId/memory/capture — scorecard integrity guard", () => {
    const scorecardBaseBody = {
      source: { kind: "issue", issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      content: "Test capture content",
    };
    const scorecardCaptureResult = {
      operation: { id: "op-scorecard-1", bindingId: bindingId, source: { kind: "issue" } },
      records: [{ id: "ee000000-0000-4000-8000-000000000000", reviewState: "accepted", scopeType: "org", scope: {} }],
    };
    const validIssueUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const agentActor = {
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: companyA,
    };
    const completeMetadata = {
      category: "performance_scorecard",
      issue_id: validIssueUuid,
      quality_signal: 4,
      token_cost: 12000,
      agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      task_type: "bug",
    };

    it.each(["performance_scorecard", "scorecard_adjusted"])(
      "returns 422 for category '%s' with an unresolvable issue_id (TEST-0)",
      async (category) => {
        mockIssueService.getById.mockResolvedValueOnce(null);
        const app = createApp(agentActor);

        const res = await request(app)
          .post(`/api/companies/${companyA}/memory/capture`)
          .set("Origin", "http://localhost:3100")
          .send({ ...scorecardBaseBody, metadata: { ...completeMetadata, category, issue_id: "TEST-0" } });

        expect(res.status).toBe(422);
        expect(res.body.details.errors.some((e: string) => e.includes("TEST-0"))).toBe(true);
        expect(mockMemoryService.capture).not.toHaveBeenCalled();
      },
    );

    it("returns 422 for a UUID-shaped issue_id that does not resolve to a real issue (AUR-3996 CTO finding)", async () => {
      const fabricatedUuid = "10000000-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
      mockIssueService.getById.mockResolvedValueOnce(null);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: { ...completeMetadata, issue_id: fabricatedUuid } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes(fabricatedUuid))).toBe(true);
      expect(mockIssueService.getById).toHaveBeenCalledWith(fabricatedUuid);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("returns 422 when metadata.issue_id is absent", async () => {
      const app = createApp(agentActor);
      const { issue_id: _omit, ...metadataWithoutIssueId } = completeMetadata;

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: metadataWithoutIssueId });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes("metadata.issue_id"))).toBe(true);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it.each(["quality_signal", "token_cost", "agent_id", "task_type"])(
      "returns 422 when metadata.%s is absent",
      async (field) => {
        const app = createApp(agentActor);
        const metadata: Record<string, unknown> = { ...completeMetadata };
        delete metadata[field];

        const res = await request(app)
          .post(`/api/companies/${companyA}/memory/capture`)
          .set("Origin", "http://localhost:3100")
          .send({ ...scorecardBaseBody, metadata });

        expect(res.status).toBe(422);
        expect(res.body.details.errors.some((e: string) => e.includes(`metadata.${field}`))).toBe(true);
        expect(mockMemoryService.capture).not.toHaveBeenCalled();
      },
    );

    it("returns 422 when metadata.test_data is true, even with all required fields present", async () => {
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: { ...completeMetadata, test_data: true } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes("test_data"))).toBe(true);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("returns 201 for a scorecard with a real resolvable issue_id and all required fields", async () => {
      mockIssueService.getById.mockResolvedValueOnce({ id: validIssueUuid, companyId: companyA });
      mockMemoryService.capture.mockResolvedValue(scorecardCaptureResult);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: completeMetadata });

      expect(res.status).toBe(201);
      expect(mockIssueService.getById).toHaveBeenCalledWith(validIssueUuid);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });

    it("returns 201 for a scorecard whose issue_id was deleted after the work happened (AUR-4091)", async () => {
      // The issue no longer exists (hard-deleted), but a tombstone was left behind at delete time.
      mockIssueService.getById.mockResolvedValue(null);
      mockIssueService.getTombstoneByIdentifierOrUuid.mockImplementation(async (companyId: string, id: string) =>
        id === validIssueUuid || id === "AUR-2223"
          ? { id: "tomb-1", companyId, issueId: validIssueUuid, identifier: "AUR-2223", title: "Deleted issue", deletedAt: new Date() }
          : null,
      );
      mockMemoryService.capture.mockResolvedValue(scorecardCaptureResult);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({
          ...scorecardBaseBody,
          source: { kind: "issue", issueId: "AUR-2223" },
          metadata: { ...completeMetadata, issue_id: "AUR-2223" },
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.getTombstoneByIdentifierOrUuid).toHaveBeenCalledWith(companyA, "AUR-2223");
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });

    it("still returns 422 for an identifier with neither a live issue nor a tombstone (fabricated, AUR-4091)", async () => {
      mockIssueService.getById.mockResolvedValue(null);
      mockIssueService.getTombstoneByIdentifierOrUuid.mockResolvedValue(null);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: { ...completeMetadata, issue_id: "AUR-999999" } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes("AUR-999999"))).toBe(true);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("does not leak the guard to a non-scorecard category with no issue_id", async () => {
      mockMemoryService.capture.mockResolvedValue(scorecardCaptureResult);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: { category: "lesson" } });

      expect(res.status).toBe(201);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });

    it("returns all violations together in details.errors[]", async () => {
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...scorecardBaseBody, metadata: { category: "scorecard_adjusted" } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.length).toBeGreaterThanOrEqual(5);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });
  });

  describe("POST /companies/:companyId/memory/capture — routing_rationale chosen_agent guard (AUR-4280/AUR-4303)", () => {
    const routingAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const routingBaseBody = {
      title: "routing/AUR-4147/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      source: { kind: "issue", issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      content: "Routed AUR-4147 to the release-tooling owner on scorecard evidence.",
    };
    const routingCaptureResult = {
      operation: { id: "op-routing-1", bindingId: bindingId, source: { kind: "issue" } },
      records: [{ id: "ef000000-0000-4000-8000-000000000000", reviewState: "accepted", scopeType: "org", scope: {} }],
    };
    const agentActor = { type: "agent", agentId: routingAgentId, companyId: companyA };

    it("returns 422 naming metadata.chosen_agent when it is absent", async () => {
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...routingBaseBody, metadata: { category: "routing_rationale", issue_id: "AUR-4147" } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes("metadata.chosen_agent"))).toBe(true);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it.each([["empty string", ""], ["whitespace only", "   "], ["null", null]])(
      "returns 422 when metadata.chosen_agent is %s",
      async (_label, value) => {
        const app = createApp(agentActor);

        const res = await request(app)
          .post(`/api/companies/${companyA}/memory/capture`)
          .set("Origin", "http://localhost:3100")
          .send({ ...routingBaseBody, metadata: { category: "routing_rationale", chosen_agent: value } });

        expect(res.status).toBe(422);
        expect(res.body.details.errors.some((e: string) => e.includes("metadata.chosen_agent"))).toBe(true);
        expect(mockMemoryService.capture).not.toHaveBeenCalled();
      },
    );

    it("returns 422 when metadata.chosen_agent is present but not a string", async () => {
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...routingBaseBody, metadata: { category: "routing_rationale", chosen_agent: 42 } });

      expect(res.status).toBe(422);
      expect(res.body.details.errors.some((e: string) => e.includes("chosen_agent must be a string"))).toBe(true);
      expect(mockMemoryService.capture).not.toHaveBeenCalled();
    });

    it("returns 201 for a routing_rationale capture WITH chosen_agent (positive control)", async () => {
      mockMemoryService.capture.mockResolvedValue(routingCaptureResult);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({
          ...routingBaseBody,
          metadata: {
            category: "routing_rationale",
            issue_id: "AUR-4147",
            chosen_agent: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
        });

      expect(res.status).toBe(201);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
    });

    it("does not leak the guard to other categories that legitimately omit chosen_agent", async () => {
      mockMemoryService.capture.mockResolvedValue(routingCaptureResult);
      const app = createApp(agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyA}/memory/capture`)
        .set("Origin", "http://localhost:3100")
        .send({ ...routingBaseBody, title: "lesson/AUR-4147", metadata: { category: "lesson" } });

      expect(res.status).toBe(201);
      expect(mockMemoryService.capture).toHaveBeenCalledTimes(1);
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
