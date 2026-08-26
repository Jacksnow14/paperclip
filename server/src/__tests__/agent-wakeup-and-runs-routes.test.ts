import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  listWakeupRequests: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: vi.fn(),
  requireServerAdapter: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

function createApp() {
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
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("agent wakeup-requests and runs routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-1",
      name: "Builder",
      adapterType: "claude_local",
    });
  });

  it("returns recent wakeup requests including skipped ones", async () => {
    mockHeartbeatService.listWakeupRequests.mockResolvedValue([
      {
        id: "wake-1",
        agentId: AGENT_ID,
        companyId: "company-1",
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        status: "completed",
        coalescedCount: 0,
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
        runId: "run-1",
        requestedAt: new Date("2026-05-18T01:00:00.000Z"),
        claimedAt: new Date("2026-05-18T01:00:01.000Z"),
        finishedAt: new Date("2026-05-18T01:00:10.000Z"),
        error: null,
        createdAt: new Date("2026-05-18T01:00:00.000Z"),
        updatedAt: new Date("2026-05-18T01:00:10.000Z"),
      },
      {
        id: "wake-2",
        agentId: AGENT_ID,
        companyId: "company-1",
        source: "assignment",
        triggerDetail: "system",
        reason: "wakeup_skipped",
        status: "skipped",
        coalescedCount: 0,
        requestedByActorType: "system",
        requestedByActorId: null,
        runId: null,
        requestedAt: new Date("2026-05-18T01:05:00.000Z"),
        claimedAt: null,
        finishedAt: null,
        error: null,
      },
    ]);

    const res = await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?limit=20");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenCalledWith(AGENT_ID, 20, {});
    expect(res.body).toHaveLength(2);
    expect(res.body[1]).toMatchObject({ status: "skipped", reason: "wakeup_skipped", runId: null });
    // AUR-4523: an enqueued-then-skipped wake must carry a timestamp so it can be
    // ordered against run history -- without it, it's indistinguishable from a
    // wake that never happened.
    expect(res.body[0].createdAt).toBe("2026-05-18T01:00:00.000Z");
    expect(res.body[0].updatedAt).toBe("2026-05-18T01:00:10.000Z");
  });

  it("clamps wakeup-requests limit to 500 and defaults to 50", async () => {
    mockHeartbeatService.listWakeupRequests.mockResolvedValue([]);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?limit=99999");
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenLastCalledWith(AGENT_ID, 500, {});

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests");
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenLastCalledWith(AGENT_ID, 50, {});
  });

  // AUR-4647: `offset`/`before`/`page` used to be silently ignored, so the
  // endpoint always returned the newest 500 rows no matter what was asked
  // for -- a bounded read masquerading as complete. These pin down that the
  // params are now honoured (offset/before) or explicitly rejected (page,
  // malformed offset/before) instead of silently doing nothing.
  it("honours the offset query param", async () => {
    mockHeartbeatService.listWakeupRequests.mockResolvedValue([]);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?offset=500");
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenLastCalledWith(AGENT_ID, 50, { offset: 500 });
  });

  it("honours the before query param as a parsed Date", async () => {
    mockHeartbeatService.listWakeupRequests.mockResolvedValue([]);

    await request(createApp()).get(
      "/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?before=2026-07-30T08:04:00.000Z",
    );
    const call = mockHeartbeatService.listWakeupRequests.mock.calls.at(-1);
    expect(call?.[0]).toBe(AGENT_ID);
    expect(call?.[1]).toBe(50);
    expect(call?.[2]?.before).toBeInstanceOf(Date);
    expect((call?.[2]?.before as Date).toISOString()).toBe("2026-07-30T08:04:00.000Z");
  });

  it("rejects a malformed before param instead of silently ignoring it", async () => {
    const res = await request(createApp()).get(
      "/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?before=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(mockHeartbeatService.listWakeupRequests).not.toHaveBeenCalled();
  });

  it("rejects a negative or non-integer offset instead of silently ignoring it", async () => {
    const negative = await request(createApp()).get(
      "/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?offset=-1",
    );
    expect(negative.status).toBe(400);

    const nonInteger = await request(createApp()).get(
      "/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?offset=1.5",
    );
    expect(nonInteger.status).toBe(400);
    expect(mockHeartbeatService.listWakeupRequests).not.toHaveBeenCalled();
  });

  it("rejects the unsupported page param instead of silently ignoring it", async () => {
    const res = await request(createApp()).get(
      "/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?page=2",
    );
    expect(res.status).toBe(400);
    expect(mockHeartbeatService.listWakeupRequests).not.toHaveBeenCalled();
  });

  it("404s when agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValueOnce(null);
    const res = await request(createApp()).get(
      "/api/agents/22222222-2222-4222-8222-222222222222/wakeup-requests",
    );
    expect(res.status).toBe(404);
  });

  it("returns recent runs for the agent (per-agent shortcut for /companies/:id/heartbeat-runs)", async () => {
    mockHeartbeatService.list.mockResolvedValue([
      {
        id: "run-1",
        companyId: "company-1",
        agentId: AGENT_ID,
        status: "succeeded",
        invocationSource: "timer",
        triggerDetail: "system",
        startedAt: new Date("2026-05-18T01:00:01.000Z"),
        finishedAt: new Date("2026-05-18T01:00:10.000Z"),
        createdAt: new Date("2026-05-18T01:00:00.000Z"),
        contextSnapshot: { issueId: "issue-9" },
      },
    ]);

    const res = await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/runs?limit=5");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", AGENT_ID, 5);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: "run-1", status: "succeeded" });
  });

  it("clamps runs limit to 1000 and defaults to 50", async () => {
    mockHeartbeatService.list.mockResolvedValue([]);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/runs?limit=99999");
    expect(mockHeartbeatService.list).toHaveBeenLastCalledWith("company-1", AGENT_ID, 1000);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/runs");
    expect(mockHeartbeatService.list).toHaveBeenLastCalledWith("company-1", AGENT_ID, 50);
  });
});
