// AUR-4689: config-time validation of adapterConfig.model against the
// adapter's available-model list. Covers the four acceptance criteria:
//   1. PATCH with a bogus model id is rejected, error names the valid ids.
//   2. PATCH with a genuinely valid id succeeds.
//   3. Model-list fetch failure does not block the write (fail open).
//   4. (sweep — covered in agent-model-validation.test.ts)
// The bogus id used is gpt-5.3-codex — the exact retired model that burned 34
// Junior Coder runs.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

// agents.ts imports secretService directly from services/secrets.js (not via
// services/index.js), so the PATCH path's syncEnvBindingsForTarget would hit
// the real implementation and blow up on the fake db.
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
}

const brokenModelListAdapterType = "model_list_down_test";

const brokenModelListAdapter: ServerAdapterModule = {
  type: brokenModelListAdapterType,
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: brokenModelListAdapterType,
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  models: [{ id: "known-model", label: "Known Model" }],
  listModels: async () => {
    throw new Error("provider is down");
  },
};

const existingCodexAgent = {
  id: "22222222-2222-4222-8222-222222222222",
  companyId: "company-1",
  name: "Codex Agent",
  urlKey: "codex-agent",
  role: "general",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "codex_local",
  adapterConfig: { model: "gpt-5.4" },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  defaultEnvironmentId: null,
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("agent adapterConfig.model availability validation (AUR-4689)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    // Pin codex model resolution to the static fallback list: no OpenAI API
    // key, and CODEX_HOME pointed at an empty directory so a real
    // ~/.codex/models_cache.json on the host cannot leak into the test.
    delete process.env.OPENAI_API_KEY;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "aur4689-empty-codex-home-"));
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: { adapterConfig?: Record<string, unknown> }) => ({
        ...agent,
        adapterConfig: { ...(agent.adapterConfig ?? {}), instructionsBundleMode: "managed" },
      }),
    );
    mockAgentService.getById.mockResolvedValue({ ...existingCodexAgent });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existingCodexAgent,
      ...patch,
    }));
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...existingCodexAgent,
      id: "11111111-1111-4111-8111-111111111111",
      name: String(input.name ?? "Agent"),
      adapterType: String(input.adapterType ?? "process"),
      adapterConfig: (input.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown> | undefined) ?? {},
    }));
    await unregisterTestAdapter(brokenModelListAdapterType);
  });

  afterEach(async () => {
    await unregisterTestAdapter(brokenModelListAdapterType);
    delete process.env.CODEX_HOME;
  });

  it("rejects a PATCH setting adapterConfig.model to a bogus id, naming the valid ids", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${existingCodexAgent.id}`)
        .send({ adapterConfig: { model: "gpt-5.3-codex" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain("gpt-5.3-codex");
    expect(message).toContain("not in the available model list");
    // The error must be actionable without a source dive: valid ids listed.
    expect(message).toContain("gpt-5.4-mini");
    expect(message).toContain("gpt-5.5");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("accepts a PATCH setting adapterConfig.model to a genuinely valid id", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${existingCodexAgent.id}`)
        .send({ adapterConfig: { model: "gpt-5.4-mini" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    const patch = mockAgentService.update.mock.calls[0][1] as { adapterConfig: { model: string } };
    expect(patch.adapterConfig.model).toBe("gpt-5.4-mini");
  });

  it("does not block an unrelated adapterConfig PATCH when the stored model is stale", async () => {
    // Pre-existing drift is the sweep's job; an env-only PATCH must not 422.
    mockAgentService.getById.mockResolvedValue({
      ...existingCodexAgent,
      adapterConfig: { model: "gpt-5.3-codex" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${existingCodexAgent.id}`)
        .send({ adapterConfig: { env: { FOO: "bar" } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
  });

  it("fails open when the model list cannot be fetched: logs and allows the write", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(brokenModelListAdapter);
    mockAgentService.getById.mockResolvedValue({
      ...existingCodexAgent,
      adapterType: brokenModelListAdapterType,
      adapterConfig: {},
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${existingCodexAgent.id}`)
          .send({ adapterConfig: { model: "totally-unverifiable-model" } }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledTimes(1);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("allowing model 'totally-unverifiable-model' unvalidated")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects creating an agent with a bogus adapterConfig.model", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Bad Model Agent",
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-5.3-codex" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain("gpt-5.3-codex");
    expect(message).toContain("not in the available model list");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("creates an agent with a valid adapterConfig.model", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Good Model Agent",
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-5.4-mini" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterConfig.model).toBe("gpt-5.4-mini");
  });
});
