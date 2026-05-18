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
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenCalledWith(AGENT_ID, 20);
    expect(res.body).toHaveLength(2);
    expect(res.body[1]).toMatchObject({ status: "skipped", reason: "wakeup_skipped", runId: null });
  });

  it("clamps wakeup-requests limit to 500 and defaults to 50", async () => {
    mockHeartbeatService.listWakeupRequests.mockResolvedValue([]);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests?limit=99999");
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenLastCalledWith(AGENT_ID, 500);

    await request(createApp()).get("/api/agents/11111111-1111-4111-8111-111111111111/wakeup-requests");
    expect(mockHeartbeatService.listWakeupRequests).toHaveBeenLastCalledWith(AGENT_ID, 50);
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
