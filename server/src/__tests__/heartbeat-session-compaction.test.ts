import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-claude-local/server";
import {
  agentRuntimeState,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "session-1" },
    sessionDisplayId: "session-1",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_local",
      execute: mockAdapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session-compaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("evaluateSessionCompaction runtime wiring (AUR-4513)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-session-compaction-wiring-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 20_000);

  it("forces a fresh session when the latest persisted run for the active session overflowed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const overflowSessionId = "session-overflow";
    const overflowRunId = randomUUID();
    const overflowAt = new Date("2026-07-29T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "claude_local",
      sessionId: overflowSessionId,
      stateJson: {},
      createdAt: overflowAt,
      updatedAt: overflowAt,
    });
    await db.insert(heartbeatRuns).values({
      id: overflowRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "Claude run failed: subtype=success: Prompt is too long",
      errorCode: CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
      resultJson: {},
      sessionIdBefore: overflowSessionId,
      sessionIdAfter: overflowSessionId,
      createdAt: overflowAt,
      updatedAt: overflowAt,
      finishedAt: overflowAt,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    const latest = await heartbeat.getRun(run!.id);
    const contextSnapshot = latest?.contextSnapshot as Record<string, unknown> | null;
    const adapterInput = mockAdapterExecute.mock.calls[0]?.[0] as
      | { runtime?: { sessionId?: string | null; sessionDisplayId?: string | null } }
      | undefined;

    expect(contextSnapshot?.paperclipPreviousSessionId).toBe(overflowSessionId);
    expect(String(contextSnapshot?.paperclipSessionRotationReason ?? "")).toContain("prompt-size limit");
    expect(String(contextSnapshot?.paperclipSessionHandoffMarkdown ?? "")).toContain("Paperclip session handoff:");
    expect(latest?.sessionIdBefore).toBeNull();
    expect(latest?.sessionIdAfter).toBe("session-1");
    expect(adapterInput?.runtime).toMatchObject({
      sessionId: null,
      sessionDisplayId: null,
    });
  }, 15_000);
});
