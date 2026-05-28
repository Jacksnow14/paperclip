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
  issueRecoveryActions,
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
    await db.delete(issueRecoveryActions);
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

  async function seedRateLimitedBlockedIssue(input?: {
    assigneeAgentId?: string;
    rateLimitRetryCount?: number;
    retryAfter?: Date | null;
    runError?: string | null;
    runErrorCode?: string | null;
    runFinishedAt?: Date;
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
      contextSnapshot: { issueId },
      errorCode: input?.runErrorCode ?? "adapter_failed",
      error: input?.runError ?? "Codex CLI: usage limit reached, try again at 14:00",
      startedAt: new Date("2026-05-17T08:00:00.000Z"),
      finishedAt: input?.runFinishedAt ?? new Date("2026-05-17T08:01:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked rate-limited issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: input?.assigneeAgentId ?? agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      retryAfter: input?.retryAfter === undefined ? null : input.retryAfter,
      rateLimitRetryCount: input?.rateLimitRetryCount ?? 0,
    });

    return { companyId, agentId, runId, issueId };
  }

  describe("rate-limit escalation", () => {
    it("blocks with retryAfter and does not create a source-scoped recovery action", async () => {
      const { companyId, issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "usage limit reached, try again in 5 minutes",
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
      expect(issue?.retryAfter).toBeInstanceOf(Date);
      expect(issue?.rateLimitRetryCount).toBe(1);

      const recoveryActions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.companyId, companyId));
      expect(recoveryActions).toHaveLength(0);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments[0]?.body).toContain("Rate-limit detected");
      expect(comments[0]?.body).toContain("attempt 1 of 5");
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
      expect(wakeups.some((row) => row.reason === "rate_limit_retry")).toBe(true);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((comment) => comment.body.includes("Rate-limit window expired"))).toBe(true);
    });

    it("restores the original assignee and resolves the active recovery action", async () => {
      const recoveryOwnerId = randomUUID();
      const { companyId, agentId, issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 1,
        retryAfter: new Date(Date.now() - 60_000),
      });
      await db.insert(agents).values({
        id: recoveryOwnerId,
        companyId,
        name: "CTO Ops",
        role: "manager",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.update(issues).set({ assigneeAgentId: recoveryOwnerId }).where(eq(issues.id, issueId));
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: recoveryOwnerId,
        previousOwnerAgentId: agentId,
        returnOwnerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `source_scoped_recovery:${issueId}`,
        evidence: {},
        nextAction: "restore execution",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileBlockedRetryableIssues();
      expect(result.resumed).toBe(1);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("todo");
      expect(issue?.assigneeAgentId).toBe(agentId);

      const [recoveryAction] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(recoveryAction?.status).toBe("resolved");
      expect(recoveryAction?.outcome).toBe("restored");
    });
  });

  describe("backfillStuckRateLimitedIssues", () => {
    it("schedules immediate retry when the original reset window is already in the past", async () => {
      const now = new Date("2026-05-18T09:00:00.000Z");
      const { issueId } = await seedRateLimitedBlockedIssue({
        rateLimitRetryCount: 0,
        retryAfter: null,
        runError: "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.",
        runFinishedAt: new Date("2026-05-17T20:00:00.000Z"),
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.backfillStuckRateLimitedIssues(now);
      expect(result.scheduled).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.retryAfter?.toISOString()).toBe(now.toISOString());
      expect(issue?.rateLimitRetryCount).toBe(1);
    });
  });
});
