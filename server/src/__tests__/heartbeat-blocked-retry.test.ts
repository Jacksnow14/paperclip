import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat blocked-retry auto-resume", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-retry-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(agents);
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRateLimitedBlockedIssue(input: {
    rateLimitRetryCount?: number;
    retryAfter?: Date | null;
    runError?: string | null;
    runErrorCode?: string | null;
    contextSnapshotIssueId?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: input.contextSnapshotIssueId === false ? {} : { issueId },
      errorCode: input.runErrorCode ?? "adapter_failed",
      error: input.runError ?? "Codex CLI: usage limit reached, try again at 14:00",
      startedAt: new Date("2026-05-17T08:00:00.000Z"),
      finishedAt: new Date("2026-05-17T08:01:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked rate-limited issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      retryAfter: input.retryAfter === undefined ? null : input.retryAfter,
      rateLimitRetryCount: input.rateLimitRetryCount ?? 0,
    });

    return { companyId, agentId, runId, issueId };
  }

  describe("escalateStrandedAssignedIssue (rate-limit path)", () => {
    it("schedules retryAfter when the latest run is a rate-limit failure", async () => {
      const { companyId, agentId, issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "usage limit reached, try again in 5 minutes",
      });
      // Re-set the issue to in_progress so reconcile escalates it via the in_progress path.
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      // Mark the run as having already attempted continuation recovery so the next pass escalates.
      await db.update(heartbeatRuns).set({
        contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
      expect(issue?.retryAfter).toBeInstanceOf(Date);
      expect(issue?.rateLimitRetryCount).toBe(1);

      // Sanity: companyId + agentId still set
      expect(issue?.companyId).toBe(companyId);
      expect(issue?.assigneeAgentId).toBe(agentId);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments[0]?.body).toContain("Rate-limit detected");
      expect(comments[0]?.body).toContain("attempt 1 of 5");
    });

    it("marks permanent block after max retries exhausted", async () => {
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 5,
        retryAfter: null,
        runError: "rate limit exceeded, retry after 60 seconds",
      });
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({
        contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
      expect(issue?.retryAfter).toBeNull();

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments[0]?.body).toContain("Rate-limit auto-retry budget exhausted");
    });
  });

  describe("reconcileBlockedRetryableIssues", () => {
    it("resumes a blocked issue when retryAfter has passed", async () => {
      const past = new Date(Date.now() - 60_000);
      const { issueId, agentId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 1,
        retryAfter: past,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileBlockedRetryableIssues();
      expect(result.resumed).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("todo");
      expect(issue?.retryAfter).toBeNull();
      expect(issue?.assigneeAgentId).toBe(agentId);

      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups.length).toBeGreaterThan(0);
      const rateLimitWake = wakeups.find((row) => row.reason === "rate_limit_retry");
      expect(rateLimitWake).toBeTruthy();

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("Rate-limit window expired"))).toBe(true);
    });

    it("skips issues whose retryAfter is in the future", async () => {
      const future = new Date(Date.now() + 60 * 60_000);
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 1,
        retryAfter: future,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileBlockedRetryableIssues();
      expect(result.resumed).toBe(0);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
      expect(issue?.retryAfter?.toISOString()).toBe(future.toISOString());
    });

    it("skips blocked issues with retryAfter = null", async () => {
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 5,
        retryAfter: null,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileBlockedRetryableIssues();
      expect(result.resumed).toBe(0);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
    });
  });

  describe("backfillStuckRateLimitedIssues", () => {
    it("schedules retry for blocked issues whose last run was a rate-limit adapter failure", async () => {
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "usage limit reached, try again at 14:00",
        runErrorCode: "adapter_failed",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.backfillStuckRateLimitedIssues();
      expect(result.scheduled).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.retryAfter).toBeInstanceOf(Date);
      expect(issue?.rateLimitRetryCount).toBe(1);
    });

    it("skips blocked issues whose last run was not a rate-limit error", async () => {
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "ECONNREFUSED",
        runErrorCode: "adapter_failed",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.backfillStuckRateLimitedIssues();
      expect(result.scheduled).toBe(0);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.retryAfter).toBeNull();
      expect(issue?.rateLimitRetryCount).toBe(0);
    });

    it("skips blocked issues whose last run was not adapter_failed", async () => {
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "usage limit reached, retry after 30 seconds",
        runErrorCode: "process_lost",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.backfillStuckRateLimitedIssues();
      expect(result.scheduled).toBe(0);
    });

    it("does not double-schedule issues that already have a retryAfter", async () => {
      const future = new Date(Date.now() + 60_000);
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 1,
        retryAfter: future,
        runError: "usage limit reached",
        runErrorCode: "adapter_failed",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.backfillStuckRateLimitedIssues();
      expect(result.scheduled).toBe(0);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.retryAfter?.toISOString()).toBe(future.toISOString());
    });
  });
});
