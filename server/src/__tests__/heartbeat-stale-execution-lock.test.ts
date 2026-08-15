import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunWatchdogDecisions, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "noop",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stale execution lock sweep", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLockedRun(opts: { now: Date; lockAgeMs: number; withRecentOutput?: boolean }) {
    const companyId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lockedAt = new Date(opts.now.getTime() - opts.lockAgeMs);
    const lastOutputAt = opts.withRecentOutput ? new Date(opts.now.getTime() - 60_000) : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Stale Lock Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: coderId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wedged execution",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: lockedAt,
      createdAt: lockedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: lockedAt,
      processStartedAt: lockedAt,
      lastOutputAt,
      lastOutputSeq: opts.withRecentOutput ? 3 : 0,
      lastOutputStream: opts.withRecentOutput ? "stdout" : null,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionLockedAt: lockedAt, executionAgentNameKey: "coder" })
      .where(eq(issues.id, issueId));

    return { companyId, coderId, issueId, runId };
  }

  it("force-cancels a running run whose issue lock is stale and silent, and releases the lock", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;
    const { issueId, runId } = await seedLockedRun({
      now,
      lockAgeMs: thresholdMs + 5 * 60 * 1000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStaleExecutionLocks({ now, thresholdMs });

    expect(result.cancelled).toBe(1);
    expect(result.cancelledRunIds).toContain(runId);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();
    expect(issue?.executionAgentNameKey).toBeNull();
  });

  it("does not cancel a stale-locked run that still shows recent output activity", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;
    const { issueId, runId } = await seedLockedRun({
      now,
      lockAgeMs: thresholdMs + 5 * 60 * 1000,
      withRecentOutput: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStaleExecutionLocks({ now, thresholdMs });

    expect(result.cancelled).toBe(0);
    expect(result.skippedRecentActivity).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).toBe(runId);
  });

  it("does not cancel a stale-locked run that has an active snooze decision", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;
    const { companyId, runId } = await seedLockedRun({
      now,
      lockAgeMs: thresholdMs + 5 * 60 * 1000,
    });
    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId,
      runId,
      decision: "snooze",
      snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      reason: "known long-running task, continuing on purpose",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStaleExecutionLocks({ now, thresholdMs });

    expect(result.cancelled).toBe(0);
    expect(result.skippedSnoozed).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("leaves a lock in place when it has not yet crossed the threshold", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;
    const { runId } = await seedLockedRun({
      now,
      lockAgeMs: thresholdMs - 5 * 60 * 1000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStaleExecutionLocks({ now, thresholdMs });

    expect(result.scanned).toBe(0);
    expect(result.cancelled).toBe(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });
});
