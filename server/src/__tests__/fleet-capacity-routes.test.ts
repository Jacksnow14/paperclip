import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Route-level tests for GET /companies/:companyId/fleet-capacity (AUR-4385).
 *
 * The classifier has its own unit suite (services/fleet-capacity.test.ts);
 * these tests exercise what that suite cannot: the express handler itself —
 * authz, the run-fetch queries, and the response shape.
 *
 * The regression pair here guards the fetch layer, not the classifier: queued
 * rows are the newest rows in heartbeat_runs, so a single shared run window
 * lets a deep backlog evict the terminal history the classifier needs and a
 * quota-starved agent reads as healthy `no_recent_runs`. The fix reads
 * terminal runs (`succeeded`/`failed`) and queue depth with separate queries;
 * the SQL assertions below fail if either filter is reverted to a shared
 * window.
 */

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  wakeup: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
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

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp(db: Record<string, unknown>, actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

const localBoardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

interface CapturedQuery {
  where?: unknown;
  limit?: number;
  ordered: boolean;
}

/**
 * Db stub for the fleet-capacity fetch chains. Each `db.select()` consumes the
 * next fixture in `plan` (route order is deterministic: terminal then queue,
 * per agent in list order) and records the `where` condition plus any `limit`
 * so the tests can render them to SQL and assert the status filters.
 */
function createCapacityDbStub(plan: Array<Array<Record<string, unknown>>>) {
  const captured: CapturedQuery[] = [];
  let call = 0;
  const db = {
    select: vi.fn(() => {
      const rows = plan[call] ?? [];
      call += 1;
      const cap: CapturedQuery = { ordered: false };
      captured.push(cap);
      const afterWhere = {
        orderBy: () => {
          cap.ordered = true;
          return {
            limit: async (value: number) => {
              cap.limit = value;
              return rows.slice(0, value);
            },
          };
        },
        then: (
          resolve: (rows: Array<Record<string, unknown>>) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return {
        from: () => ({
          where: (condition: unknown) => {
            cap.where = condition;
            return afterWhere;
          },
        }),
      };
    }),
  };
  return { db, captured };
}

function renderSql(condition: unknown): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(condition as never);
  return { sql: query.sql, params: query.params as unknown[] };
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

// Quota signature with no parseable reset clock, so classification cannot
// depend on the wall time the test happens to run at.
const QUOTA_ERROR = "You've hit your usage limit for gpt-5.5.";

function runRows(
  n: number,
  status: string,
  newestIso: string,
  error: string | null = null,
): Array<Record<string, unknown>> {
  const newest = Date.parse(newestIso);
  return Array.from({ length: n }, (_, i) => {
    const createdAt = new Date(newest - i * 60_000);
    return { status, createdAt, finishedAt: createdAt, error };
  });
}

const starvedAgent = {
  id: "agent-starved",
  name: "CTO Ops",
  adapterType: "codex_local",
  pausedAt: null,
};

const healthyAgent = {
  id: "agent-healthy",
  name: "CEO",
  adapterType: "claude_local",
  pausedAt: null,
};

describe("fleet capacity route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAgentService.list.mockResolvedValue([starvedAgent, healthyAgent]);
  });

  it("classifies a quota-starved agent as blocked even when its queue backlog exceeds the run window", async () => {
    // Probe: 220 queued rows are all NEWER than the 6 quota failures. Under
    // the reverted (single shared window of 200) fetch, the queue evicts every
    // terminal run and this agent classifies healthy `no_recent_runs`.
    const starvedTerminal = runRows(6, "failed", "2026-07-29T14:00:00Z", QUOTA_ERROR);
    const starvedQueue = runRows(220, "queued", "2026-07-29T23:00:00Z");
    // Control: a deep queue on a healthy agent must NOT read as blocked.
    const healthyTerminal = [
      ...runRows(1, "succeeded", "2026-07-29T22:30:00Z"),
      ...runRows(4, "succeeded", "2026-07-29T20:00:00Z"),
    ];
    const healthyQueue = runRows(40, "queued", "2026-07-29T23:05:00Z");

    const { db, captured } = createCapacityDbStub([
      starvedTerminal,
      starvedQueue,
      healthyTerminal,
      healthyQueue,
    ]);

    const res = await requestApp(
      await createApp(db, localBoardActor),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/fleet-capacity"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(mockAgentService.list).toHaveBeenCalledWith("company-1");

    // Blocked rows sort first.
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[0]).toMatchObject({
      agentId: "agent-starved",
      name: "CTO Ops",
      lane: "codex_local",
      canExecuteNow: false,
      reason: "quota_exhausted",
      queueDepth: 220,
      consecutiveFailures: 6,
      lastSuccessfulRunAt: null,
    });
    expect(res.body.agents[1]).toMatchObject({
      agentId: "agent-healthy",
      lane: "claude_local",
      canExecuteNow: true,
      reason: "ok",
      queueDepth: 40,
    });
    expect(res.body.rollup).toMatchObject({
      totalQueued: 260,
      executableNow: 1,
      blockedCount: 1,
      byReason: { quota_exhausted: 1, ok: 1 },
    });

    // The regression teeth: classification and queue depth must come from
    // SEPARATE queries with disjoint status filters. Reverting to one shared
    // window changes these rendered predicates and fails here.
    expect(captured).toHaveLength(4);
    const [starvedTerminalQ, starvedQueueQ, healthyTerminalQ, healthyQueueQ] = captured;

    for (const [terminalQ, agentId] of [
      [starvedTerminalQ, "agent-starved"],
      [healthyTerminalQ, "agent-healthy"],
    ] as const) {
      const { sql, params } = renderSql(terminalQ.where);
      expect(sql).toContain('"status" in');
      expect(params).toEqual(expect.arrayContaining(["company-1", agentId, "succeeded", "failed"]));
      expect(params).not.toEqual(expect.arrayContaining(["queued"]));
      expect(terminalQ.ordered).toBe(true);
      expect(terminalQ.limit).toBe(200);
    }

    for (const [queueQ, agentId] of [
      [starvedQueueQ, "agent-starved"],
      [healthyQueueQ, "agent-healthy"],
    ] as const) {
      const { sql, params } = renderSql(queueQ.where);
      expect(sql).toContain('"status" in');
      expect(params).toEqual(
        expect.arrayContaining(["company-1", agentId, "queued", "scheduled_retry"]),
      );
      expect(params).not.toEqual(expect.arrayContaining(["succeeded"]));
      // Queue depth is exact: no limit may cap it.
      expect(queueQ.limit).toBeUndefined();
    }
  }, 15_000);

  it("rejects a cross-tenant caller before touching agents or run history", async () => {
    const { db } = createCapacityDbStub([]);
    const res = await requestApp(
      await createApp(db, {
        type: "board",
        userId: "mallory",
        companyIds: ["other-company"],
        source: "session",
        isInstanceAdmin: false,
      }),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/fleet-capacity"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("does not have access");
    expect(mockAgentService.list).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  }, 15_000);
});
