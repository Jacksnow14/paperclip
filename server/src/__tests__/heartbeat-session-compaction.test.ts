import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

/**
 * AUR-4513 wiring coverage for the forced session rotation on context overflow.
 *
 * This suite deliberately drives `evaluateSessionCompaction` against REAL persisted
 * rows rather than hand-built fixtures. The guard is keyed on
 * `heartbeatRuns.errorCode`, and an earlier revision of this fix passed its unit
 * tests while being dead in production because the function's `.select()` never
 * projected that column -- so `latestRun.errorCode` read `undefined` on every real
 * row. Only a test that goes through the query can catch that.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping AUR-4513 session-compaction wiring tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("evaluateSessionCompaction forced rotation on overflow (AUR-4513)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-session-compaction-aur4513");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  async function seedAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Overflow Regression",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Coder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  /** Insert `count` runs on one session, oldest first, `minutesApart` apart. */
  async function seedSessionRuns(input: {
    companyId: string;
    agentId: string;
    sessionId: string;
    count: number;
    minutesApart: number;
    latest: { errorCode: string | null; error: string | null; usageJson?: unknown };
  }) {
    const now = Date.now();
    for (let i = 0; i < input.count; i += 1) {
      const isLatest = i === input.count - 1;
      // Oldest run first so the newest carries the terminal state under test.
      const createdAt = new Date(now - (input.count - 1 - i) * input.minutesApart * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        status: isLatest && input.latest.errorCode ? "failed" : "succeeded",
        sessionIdAfter: input.sessionId,
        errorCode: isLatest ? input.latest.errorCode : null,
        error: isLatest ? input.latest.error : null,
        usageJson: isLatest ? (input.latest.usageJson ?? null) : null,
        createdAt,
        updatedAt: createdAt,
      } as typeof heartbeatRuns.$inferInsert);
    }
  }

  async function loadAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!row) throw new Error(`seeded agent ${agentId} not found`);
    return row;
  }

  it("rotates when the latest run failed with a context overflow, even far under every threshold", async () => {
    const { companyId, agentId } = await seedAgent();
    const sessionId = `session-${randomUUID()}`;
    // 3 runs over ~30 minutes: nowhere near maxSessionRuns (12) or maxSessionAgeHours (8).
    // Zero usage on the failing run, matching the live rows (the prompt is rejected
    // before the model is invoked, so no tokens are billed).
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 3,
      minutesApart: 10,
      latest: {
        errorCode: CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
        error: "Claude run failed: subtype=success: Prompt is too long",
        usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      },
    });

    const agent = await loadAgent(agentId);
    const decision = await heartbeatService(db).evaluateSessionCompaction({
      agent,
      sessionId,
      issueId: null,
    });

    expect(decision.rotate).toBe(true);
    expect(decision.reason).toMatch(/context overflow/i);
    expect(decision.handoffMarkdown).toBeTruthy();
    expect(decision.previousRunId).toBeTruthy();
  });

  // Control: without this, a guard that always rotated would pass the test above.
  it("does NOT rotate a healthy session that is under every threshold", async () => {
    const { companyId, agentId } = await seedAgent();
    const sessionId = `session-${randomUUID()}`;
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 3,
      minutesApart: 10,
      latest: { errorCode: null, error: null },
    });

    const agent = await loadAgent(agentId);
    const decision = await heartbeatService(db).evaluateSessionCompaction({
      agent,
      sessionId,
      issueId: null,
    });

    expect(decision.rotate).toBe(false);
    expect(decision.reason).toBeNull();
  });

  // Discriminates the fix from "any failure rotates": a transient upstream failure is
  // expected to clear on its own and must NOT burn the session.
  it("does NOT rotate on a transient upstream failure under threshold", async () => {
    const { companyId, agentId } = await seedAgent();
    const sessionId = `session-${randomUUID()}`;
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 3,
      minutesApart: 10,
      latest: {
        errorCode: "claude_transient_upstream",
        error: "You've hit your session limit · resets 7:40pm (UTC)",
      },
    });

    const agent = await loadAgent(agentId);
    const decision = await heartbeatService(db).evaluateSessionCompaction({
      agent,
      sessionId,
      issueId: null,
    });

    expect(decision.rotate).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("still rotates on the ordinary run-count threshold (AUR-4513 must not regress AUR-2092)", async () => {
    const { companyId, agentId } = await seedAgent();
    const sessionId = `session-${randomUUID()}`;
    // 13 healthy runs > maxSessionRuns of 12.
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 13,
      minutesApart: 1,
      latest: { errorCode: null, error: null },
    });

    const agent = await loadAgent(agentId);
    const decision = await heartbeatService(db).evaluateSessionCompaction({
      agent,
      sessionId,
      issueId: null,
    });

    expect(decision.rotate).toBe(true);
    expect(decision.reason).toMatch(/exceeded 12 runs/);
  });

  // AUR-4557. The overflow branch used to sit BELOW an early
  // `if (!policy.enabled || !hasSessionCompactionThresholds(policy)) return {rotate:false}`,
  // so an agent that opted out of threshold compaction got no overflow rotation at
  // all -- and an overflow is exactly the case that cannot recover on its own. A
  // deterministic-failure rotation must not be subordinate to threshold config.
  async function seedAgentWithCompactionOverride(override: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Overflow Config Gate",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Coder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      runtimeConfig: { heartbeat: { sessionCompaction: override } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  async function overflowDecisionForOverride(override: Record<string, unknown>) {
    const { companyId, agentId } = await seedAgentWithCompactionOverride(override);
    const sessionId = `session-${randomUUID()}`;
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 3,
      minutesApart: 10,
      latest: {
        errorCode: CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
        error: "Claude run failed: subtype=success: Prompt is too long",
        usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      },
    });
    const agent = await loadAgent(agentId);
    return heartbeatService(db).evaluateSessionCompaction({ agent, sessionId, issueId: null });
  }

  it("rotates on overflow even when sessionCompaction is disabled", async () => {
    const decision = await overflowDecisionForOverride({ enabled: false });
    expect(decision.rotate).toBe(true);
    expect(decision.reason).toMatch(/context overflow/i);
    expect(decision.handoffMarkdown).toBeTruthy();
  });

  it("rotates on overflow even when every threshold is zero", async () => {
    const decision = await overflowDecisionForOverride({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(decision.rotate).toBe(true);
    expect(decision.reason).toMatch(/context overflow/i);
  });

  // Control: lifting the overflow branch above the config gate must NOT turn the gate
  // into a no-op. A disabled agent with no overflow must still never rotate, however
  // many runs it has accumulated.
  it("still honours the config gate for threshold rotation when disabled", async () => {
    const { companyId, agentId } = await seedAgentWithCompactionOverride({ enabled: false });
    const sessionId = `session-${randomUUID()}`;
    await seedSessionRuns({
      companyId,
      agentId,
      sessionId,
      count: 13,
      minutesApart: 1,
      latest: { errorCode: null, error: null },
    });
    const agent = await loadAgent(agentId);
    const decision = await heartbeatService(db).evaluateSessionCompaction({
      agent,
      sessionId,
      issueId: null,
    });

    expect(decision.rotate).toBe(false);
    expect(decision.reason).toBeNull();
  });
});
