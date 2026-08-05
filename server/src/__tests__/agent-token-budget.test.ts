import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_MAX_TOKENS_PER_RUN,
  DEFAULT_MAX_TOKENS_PER_WINDOW,
  findAgentTokenBudgetBreach,
  resolveAgentTokenBudgetPolicy,
} from "../services/agent-token-budget.ts";

/**
 * AUR-4669: CFO burned 187,985,770 tokens across 113 runs (97.9% cache re-send) and
 * stranded all 5 codex_local lane agents for days. These tests exercise the guard
 * against REAL persisted heartbeat_runs rows (not hand-built in-memory fixtures) so a
 * future .select() column-projection regression -- the exact AUR-4513 failure mode --
 * would be caught here, and prove both a firing case and a self-clearing case per
 * AUR-4185 ("a guard that can never clear is as broken as one that never fires").
 */

describe("resolveAgentTokenBudgetPolicy", () => {
  it("returns the shipped default for codex_local", () => {
    const policy = resolveAgentTokenBudgetPolicy({ adapterType: "codex_local", adapterConfig: null });
    expect(policy).toEqual({
      windowMs: 24 * 60 * 60 * 1000,
      maxTokensPerRun: DEFAULT_MAX_TOKENS_PER_RUN,
      maxTokensPerWindow: DEFAULT_MAX_TOKENS_PER_WINDOW,
    });
  });

  it("returns the shipped default for claude_local", () => {
    const policy = resolveAgentTokenBudgetPolicy({ adapterType: "claude_local", adapterConfig: {} });
    expect(policy?.maxTokensPerWindow).toBe(DEFAULT_MAX_TOKENS_PER_WINDOW);
  });

  it("returns null for an adapter type with no default and no override", () => {
    const policy = resolveAgentTokenBudgetPolicy({ adapterType: "process", adapterConfig: null });
    expect(policy).toBeNull();
  });

  it("merges a per-agent adapterConfig.tokenBudget override onto the default", () => {
    const policy = resolveAgentTokenBudgetPolicy({
      adapterType: "codex_local",
      adapterConfig: { tokenBudget: { maxTokensPerRun: 1_000 } },
    });
    expect(policy?.maxTokensPerRun).toBe(1_000);
    // Unspecified fields keep the adapter-type default.
    expect(policy?.maxTokensPerWindow).toBe(DEFAULT_MAX_TOKENS_PER_WINDOW);
  });

  it("treats maxTokensPerWindow: 0 as an explicit opt-out, even for a defaulted adapter", () => {
    const policy = resolveAgentTokenBudgetPolicy({
      adapterType: "codex_local",
      adapterConfig: { tokenBudget: { maxTokensPerWindow: 0 } },
    });
    expect(policy).toBeNull();
  });

  it("lets an unlisted adapter type opt in via an explicit override", () => {
    const policy = resolveAgentTokenBudgetPolicy({
      adapterType: "process",
      adapterConfig: { tokenBudget: { maxTokensPerRun: 500 } },
    });
    expect(policy?.maxTokensPerRun).toBe(500);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping AUR-4669 agent-token-budget wiring tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("findAgentTokenBudgetBreach (AUR-4669)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-token-budget-aur4669");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  async function seedAgent(adapterType: string): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Token Budget Fixture",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Fixture Agent",
      role: "engineer",
      status: "idle",
      adapterType,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    createdAt: Date;
    usageJson: unknown;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      usageJson: input.usageJson,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    } as typeof heartbeatRuns.$inferInsert);
  }

  async function loadAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!row) throw new Error(`seeded agent ${agentId} not found`);
    return row;
  }

  // AUR-4693 measured CFO's lane-scale outlier run at 22.9M tokens (48.5M/9 runs
  // total) -- a single-row breach, unlike the average CFO row (~1.66M/run across the
  // original 187,985,770/113-run history), which only crosses the ceiling in
  // aggregate and is covered by the rolling_window_budget case below.
  it("fires on the real CFO outlier run (22.9M tokens, AUR-4693 measurement)", async () => {
    const { companyId, agentId } = await seedAgent("codex_local");
    await seedRun({
      companyId,
      agentId,
      createdAt: new Date(),
      // rawInputTokens already includes cache-read tokens; rawCachedInputTokens is a
      // non-additive breakdown of it (the 97.9% cache-resend AUR-4669 measured).
      usageJson: {
        rawInputTokens: 22_600_000,
        rawCachedInputTokens: 22_120_000,
        rawOutputTokens: 300_000,
      },
    });

    const agent = await loadAgent(agentId);
    const breach = await findAgentTokenBudgetBreach(db, agent, new Date());

    expect(breach).not.toBeNull();
    expect(breach?.reason).toBe("per_run_ceiling");
    expect(breach?.breachingRunTokens).toBe(22_600_000 + 300_000);
  });

  it("fires on cumulative spend across several runs under the per-run ceiling (rolling_window_budget)", async () => {
    const { companyId, agentId } = await seedAgent("codex_local");
    const now = Date.now();
    // 4 runs of 8M tokens each, 1 hour apart: none alone crosses the 12M per-run
    // ceiling, but the 32M cumulative crosses the 30M window budget on the 4th.
    for (let i = 0; i < 4; i += 1) {
      await seedRun({
        companyId,
        agentId,
        createdAt: new Date(now - (3 - i) * 60 * 60 * 1000),
        usageJson: { rawInputTokens: 7_900_000, rawOutputTokens: 100_000 },
      });
    }

    const agent = await loadAgent(agentId);
    const breach = await findAgentTokenBudgetBreach(db, agent, new Date());

    expect(breach).not.toBeNull();
    expect(breach?.reason).toBe("rolling_window_budget");
    expect(breach?.windowTokens).toBeGreaterThanOrEqual(DEFAULT_MAX_TOKENS_PER_WINDOW);
  });

  // Control: without a real threshold, any usage would "fire." This proves the guard
  // discriminates rather than always returning a breach.
  it("does NOT fire for an agent well under both thresholds", async () => {
    const { companyId, agentId } = await seedAgent("codex_local");
    await seedRun({
      companyId,
      agentId,
      createdAt: new Date(),
      usageJson: { rawInputTokens: 500_000, rawOutputTokens: 10_000 },
    });

    const agent = await loadAgent(agentId);
    const breach = await findAgentTokenBudgetBreach(db, agent, new Date());

    expect(breach).toBeNull();
  });

  // AUR-4185: a guard that can never clear is as broken as one that never fires. The
  // breach is derived live from rows inside the rolling window, so a breaching run
  // that has aged out must stop counting -- no stuck flag, no manual unpause.
  it("self-clears once the breaching run ages out of the rolling window", async () => {
    const { companyId, agentId } = await seedAgent("codex_local");
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedRun({
      companyId,
      agentId,
      createdAt: twentyFiveHoursAgo,
      usageJson: { rawInputTokens: 20_000_000, rawOutputTokens: 0 },
    });

    const agent = await loadAgent(agentId);
    const breach = await findAgentTokenBudgetBreach(db, agent, new Date());

    expect(breach).toBeNull();
  });

  // AUR-4669's core acceptance criterion: a breach must suppress only the offending
  // agent. Two agents sharing the same adapterType, one over budget and one clean.
  it("scopes the breach to a single agent, leaving a sibling on the same adapter admissible", async () => {
    const { companyId, agentId: hotAgentId } = await seedAgent("codex_local");
    const coldAgentId = randomUUID();
    await db.insert(agents).values({
      id: coldAgentId,
      companyId,
      name: "Codex Sibling Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await seedRun({
      companyId,
      agentId: hotAgentId,
      createdAt: new Date(),
      usageJson: { rawInputTokens: 19_100_000, rawOutputTokens: 0 },
    });
    await seedRun({
      companyId,
      agentId: coldAgentId,
      createdAt: new Date(),
      usageJson: { rawInputTokens: 200_000, rawOutputTokens: 0 },
    });

    const hotAgent = await loadAgent(hotAgentId);
    const coldAgent = await loadAgent(coldAgentId);

    expect(await findAgentTokenBudgetBreach(db, hotAgent, new Date())).not.toBeNull();
    expect(await findAgentTokenBudgetBreach(db, coldAgent, new Date())).toBeNull();
  });

  it("honours an explicit opt-out via adapterConfig.tokenBudget.maxTokensPerWindow: 0", async () => {
    const { companyId, agentId } = await seedAgent("codex_local");
    await db
      .update(agents)
      .set({ adapterConfig: { tokenBudget: { maxTokensPerWindow: 0 } } })
      .where(eq(agents.id, agentId));
    await seedRun({
      companyId,
      agentId,
      createdAt: new Date(),
      usageJson: { rawInputTokens: 999_000_000, rawOutputTokens: 0 },
    });

    const agent = await loadAgent(agentId);
    expect(await findAgentTokenBudgetBreach(db, agent, new Date())).toBeNull();
  });
});
