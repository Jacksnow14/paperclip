import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CLAUDE_AUTH_REQUIRED_ERROR_CODE,
  CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
  gatherClaudeAuthQuotaLaneHistory,
} from "../services/quota-auth-reclassification.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quota-auth gather tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-08-06T12:00:00.000Z");
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

const ZERO_USAGE_ANTHROPIC = { inputTokens: 0, outputTokens: 0, provider: "anthropic" };

/** The persisted shape of an AUR-5038 reclassified run (see heartbeat.ts finalization). */
function reclassifiedResultJson(anchorRunId: string): Record<string, unknown> {
  return {
    quotaExhausted: true,
    quotaExhaustion: {
      source: "lane_history",
      resetAt: null,
      rateLimitType: null,
      overageDisabledReason: null,
      outOfCredits: false,
    },
    authRenderedQuotaWall: {
      originalErrorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      anchorRunId,
      anchorCreatedAt: new Date(NOW.getTime() - 2 * DAYS).toISOString(),
    },
  };
}

// AUR-5064: gatherClaudeAuthQuotaLaneHistory is where both follow-up guarantees
// live — the latch bound (a reclassified row must never anchor further
// reclassifications, or the 8-day lookback can never expire the chain) and the
// company/provider scoping that the perf rewrite (heartbeatRuns.companyId
// instead of agents.companyId) must not have changed. These are SQL-predicate
// behaviors, so they are proven against a real Postgres, not a mock.
describeEmbeddedPostgres("gatherClaudeAuthQuotaLaneHistory (AUR-5064)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quota-auth-gather-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setUpLane(adapterType = "claude_local") {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CC Max",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  async function insertRun(input: {
    companyId?: string;
    agentId?: string;
    status?: string;
    createdAt: Date;
    errorCode?: string | null;
    error?: string | null;
    usageJson?: Record<string, unknown> | null;
    resultJson?: Record<string, unknown> | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId ?? companyId,
      agentId: input.agentId ?? agentId,
      status: input.status ?? "failed",
      createdAt: input.createdAt,
      errorCode: input.errorCode ?? null,
      error: input.error ?? null,
      usageJson: input.usageJson === undefined ? ZERO_USAGE_ANTHROPIC : input.usageJson,
      resultJson: input.resultJson ?? null,
    });
    return id;
  }

  function gather() {
    return gatherClaudeAuthQuotaLaneHistory(db, {
      companyId,
      adapterType: "claude_local",
      excludeRunId: randomUUID(),
      now: NOW,
    });
  }

  const realWallRow = (createdAt: Date) => ({
    createdAt,
    errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
    error: "Claude run failed: You've hit your weekly limit · resets Aug 5, 11am (UTC)",
  });

  it("a chain of reclassified-only anchors expires: no real wall in the lookback means no anchor", async () => {
    await setUpLane();
    // A wall that latched long ago: the last REAL wall evidence is outside the
    // 8-day lookback, and the lane has been kept "walled" purely by its own
    // reclassified rows since. Pre-AUR-5064 every one of these rows re-anchored
    // the chain and it could never expire.
    const staleAnchor = await insertRun(realWallRow(new Date(NOW.getTime() - 9 * DAYS)));
    for (let day = 7; day >= 1; day--) {
      await insertRun({
        createdAt: new Date(NOW.getTime() - day * DAYS),
        errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
        error: "Claude run failed: subtype=success: Not logged in · Please run /login",
        resultJson: reclassifiedResultJson(staleAnchor),
      });
    }

    const history = await gather();
    expect(history.anchor).toBeNull();
  });

  it("a real wall still anchors while newer reclassified rows exist, and the REAL row is the anchor", async () => {
    await setUpLane();
    const realWall = await insertRun(realWallRow(new Date(NOW.getTime() - 2 * DAYS)));
    await insertRun({
      createdAt: new Date(NOW.getTime() - 1 * DAYS),
      errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
      error: "Claude run failed: subtype=success: Not logged in · Please run /login",
      resultJson: reclassifiedResultJson(realWall),
    });

    const history = await gather();
    expect(history.anchor?.runId).toBe(realWall);
    expect(history.anthropicSuccessAfterAnchor).toBe(false);
  });

  it("prose-matched session-limit rows anchor (the dominant real-wall shape on live data)", async () => {
    await setUpLane();
    const sessionLimit = await insertRun({
      createdAt: new Date(NOW.getTime() - 3 * HOURS),
      errorCode: "claude_transient_upstream",
      error: "Claude run failed: You've hit your session limit · resets 3pm",
    });

    const history = await gather();
    expect(history.anchor?.runId).toBe(sessionLimit);
  });

  it("provider scoping: an openai-provider row cannot anchor even with claude-family errorCode and quota prose", async () => {
    await setUpLane();
    await insertRun({
      createdAt: new Date(NOW.getTime() - 3 * HOURS),
      errorCode: "claude_transient_upstream",
      error: "Run failed: You've hit your usage limit",
      usageJson: { inputTokens: 0, outputTokens: 0, provider: "openai" },
    });

    expect((await gather()).anchor).toBeNull();
  });

  it("provider scoping: a row with no provider recorded still anchors (legacy rows predate the field)", async () => {
    await setUpLane();
    const legacy = await insertRun({
      createdAt: new Date(NOW.getTime() - 3 * HOURS),
      errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
      error: "You've hit your weekly limit",
      usageJson: null,
    });

    expect((await gather()).anchor?.runId).toBe(legacy);
  });

  it("company scoping survives the perf rewrite: another company's wall never anchors this lane", async () => {
    await setUpLane();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other CC",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertRun({
      ...realWallRow(new Date(NOW.getTime() - 2 * HOURS)),
      companyId: otherCompanyId,
      agentId: otherAgentId,
    });

    expect((await gather()).anchor).toBeNull();
  });

  it("adapterType scoping survives the join rewrite: a codex agent's row never anchors the claude lane", async () => {
    await setUpLane();
    const codexAgentId = randomUUID();
    await db.insert(agents).values({
      id: codexAgentId,
      companyId,
      name: "Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Same company, claude-family evidence — only the adapterType differs.
    await insertRun({ ...realWallRow(new Date(NOW.getTime() - 2 * HOURS)), agentId: codexAgentId });

    expect((await gather()).anchor).toBeNull();
  });

  it("an anthropic success after the anchor terminates the chain; a non-anthropic success does not", async () => {
    await setUpLane();
    await insertRun(realWallRow(new Date(NOW.getTime() - 2 * DAYS)));
    await insertRun({
      status: "succeeded",
      createdAt: new Date(NOW.getTime() - 1 * DAYS),
      usageJson: { inputTokens: 1200, outputTokens: 300, provider: "openai" },
    });
    expect((await gather()).anthropicSuccessAfterAnchor).toBe(false);

    await insertRun({
      status: "succeeded",
      createdAt: new Date(NOW.getTime() - 12 * HOURS),
      usageJson: { inputTokens: 900, outputTokens: 150, provider: "anthropic" },
    });
    expect((await gather()).anthropicSuccessAfterAnchor).toBe(true);
  });
});
