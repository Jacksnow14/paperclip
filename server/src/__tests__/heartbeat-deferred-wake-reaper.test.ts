import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Promotion admits the new run into the scheduler immediately. Stub the adapter so
// it completes instantly instead of shelling out mid-assertion or mid-teardown.
const mockAdapterExecute = vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "stubbed adapter run",
  provider: "test",
  model: "test-model",
}));

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
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred-wake reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * AUR-4329: a `deferred_issue_execution` wake is parked behind whichever run holds
 * the issue-level execution lock. If that run reaches a terminal status without the
 * release path running — or its row disappears — the wake is a dead letter that
 * still reads as an active execution path, so nothing ever re-drives the work.
 */
describeEmbeddedPostgres("heartbeat stranded deferred-wake reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-deferred-wake-reaper-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // Cancel anything still queued *first*. AUR-4143 made a completing run
    // reallocate the freed slot in starvation order, so waiting on `running`
    // alone never converges: each run that drains lets the next queued row in,
    // and a run admitted between the check below and the truncate holds a
    // RowShareLock that deadlocks the AccessExclusiveLock the cascade needs.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));

    // Then let any already-in-flight run finish against the stubbed adapter, so
    // the cascade below cannot deadlock against an in-flight run transaction.
    // Not filtered by invocationSource: reallocation can admit runs from any
    // source, and a missed one is exactly what deadlocks the truncate.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["running"]));
      if (active.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Cascade: promoted runs create runtime state and other company-scoped rows,
    // so ordered deletes trip foreign keys. Everything here hangs off companies.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedParkedDeferredWake(input?: {
    issueStatus?: "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
    agentStatus?: "idle" | "active" | "paused";
    /** Terminal status of the run that parked the wake, or null to omit the row entirely. */
    ownerRunStatus?: "failed" | "cancelled" | "timed_out" | "succeeded" | "queued" | "running" | null;
    /** Leave the issue-level execution lock pointing at the owner run. */
    staleExecutionLock?: boolean;
    /** Drop the issue row after seeding the wake. */
    dropIssue?: boolean;
    parkedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const ownerRunId = randomUUID();
    const wakeId = randomUUID();
    const parkedAt = input?.parkedAt ?? new Date("2026-06-05T19:55:59.826Z");
    const issueStatus = input?.issueStatus ?? "todo";
    const ownerRunStatus = input?.ownerRunStatus === undefined ? "failed" : input.ownerRunStatus;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (ownerRunStatus) {
      await db.insert(heartbeatRuns).values({
        id: ownerRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: ownerRunStatus,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        createdAt: parkedAt,
        updatedAt: parkedAt,
      });
    }

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded work",
      status: issueStatus,
      priority: "critical",
      assigneeAgentId: agentId,
      executionRunId: input?.staleExecutionLock ? ownerRunId : null,
      executionAgentNameKey: input?.staleExecutionLock ? "codexcoder" : null,
      executionLockedAt: input?.staleExecutionLock ? parkedAt : null,
    });

    // The dead letter itself: parked, issue-scoped, and never promoted.
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      payload: {
        issueId,
        deferredWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
        },
      },
      requestedAt: parkedAt,
      createdAt: parkedAt,
      updatedAt: parkedAt,
    });

    if (input?.dropIssue) {
      await db.delete(issues).where(eq(issues.id, issueId));
    }

    return { companyId, agentId, issueId, ownerRunId, wakeId, parkedAt };
  }

  const wakeById = async (wakeId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0] ?? null);

  it("promotes a wake stranded by a run that terminated without releasing the issue", async () => {
    const { companyId, agentId, issueId, wakeId } = await seedParkedDeferredWake();

    // Control: the defect state. The wake is parked, and nothing is driving the
    // issue — this is exactly what the sweep must not leave alone.
    const before = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
    expect(before).toHaveLength(0);
    expect((await wakeById(wakeId))?.status).toBe("deferred_issue_execution");

    const result = await heartbeat.reapStrandedDeferredWakes();

    expect(result.candidateIssues).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.retired).toBe(0);
    expect(result.skippedLiveExecutionPath).toBe(0);
    expect(result.truncated).toBe(false);

    // The wake is no longer a dead letter: it now carries a real run. Its exact
    // status past promotion belongs to the scheduler, which may already have
    // admitted the run, so assert on what the reaper itself guarantees.
    const promoted = await wakeById(wakeId);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    expect(promoted?.reason).toBe("issue_execution_promoted");
    expect(promoted?.runId).toBeTruthy();

    const promotedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promoted!.runId!))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun).toMatchObject({ agentId, companyId });
    expect(promotedRun?.contextSnapshot as Record<string, unknown>).toMatchObject({ issueId });

    // The issue now has a real execution path instead of a dead letter posing as one.
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.executionRunId).toBe(promoted!.runId);
  });

  it("promotes past a stale issue-level execution lock left by the vanished run", async () => {
    const { issueId, ownerRunId, wakeId } = await seedParkedDeferredWake({
      ownerRunStatus: "cancelled",
      staleExecutionLock: true,
    });

    const result = await heartbeat.reapStrandedDeferredWakes();
    expect(result.promoted).toBe(1);

    const promoted = await wakeById(wakeId);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    expect(promoted?.runId).toBeTruthy();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.executionRunId).toBe(promoted!.runId);
    expect(issue?.executionRunId).not.toBe(ownerRunId);
  });

  it("promotes a wake whose owning run row no longer exists at all", async () => {
    const { wakeId } = await seedParkedDeferredWake({ ownerRunStatus: null });

    const result = await heartbeat.reapStrandedDeferredWakes();
    expect(result.promoted).toBe(1);
    const promoted = await wakeById(wakeId);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    expect(promoted?.runId).toBeTruthy();
  });

  it("leaves a wake parked while a live execution-path run still owns the issue", async () => {
    const { companyId, wakeId } = await seedParkedDeferredWake({ ownerRunStatus: "running" });

    const result = await heartbeat.reapStrandedDeferredWakes();

    expect(result.candidateIssues).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.retired).toBe(0);
    expect(result.skippedLiveExecutionPath).toBe(1);
    expect((await wakeById(wakeId))?.status).toBe("deferred_issue_execution");

    const queuedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    expect(queuedRuns).toHaveLength(0);
  });

  it.each(["done", "cancelled"] as const)(
    "retires a wake parked on a %s issue instead of waking an agent on closed work",
    async (issueStatus) => {
      const { companyId, wakeId } = await seedParkedDeferredWake({ issueStatus });

      const result = await heartbeat.reapStrandedDeferredWakes();

      expect(result.promoted).toBe(0);
      expect(result.retired).toBe(1);

      const retired = await wakeById(wakeId);
      expect(retired?.status).toBe("cancelled");
      expect(retired?.error).toContain(`issue is ${issueStatus}`);
      expect(retired?.finishedAt).toBeTruthy();

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
      expect(queuedRuns).toHaveLength(0);
    },
  );

  it("retires a wake whose issue row no longer exists", async () => {
    const { wakeId } = await seedParkedDeferredWake({ dropIssue: true });

    const result = await heartbeat.reapStrandedDeferredWakes();

    expect(result.promoted).toBe(0);
    expect(result.retired).toBe(1);

    const retired = await wakeById(wakeId);
    expect(retired?.status).toBe("cancelled");
    expect(retired?.error).toContain("issue no longer exists");
  });

  it("retires a wake whose agent can no longer be invoked", async () => {
    const { wakeId } = await seedParkedDeferredWake({ agentStatus: "paused" });

    const result = await heartbeat.reapStrandedDeferredWakes();

    expect(result.promoted).toBe(0);
    expect(result.retired).toBe(1);

    const retired = await wakeById(wakeId);
    expect(retired?.status).toBe("failed");
    expect(retired?.error).toContain("agent is not invokable");
  });

  it("is idempotent: a second sweep finds nothing left to drain", async () => {
    await seedParkedDeferredWake();

    const first = await heartbeat.reapStrandedDeferredWakes();
    expect(first.promoted).toBe(1);

    const second = await heartbeat.reapStrandedDeferredWakes();
    expect(second.candidateIssues).toBe(0);
    expect(second.promoted).toBe(0);
    expect(second.retired).toBe(0);
  });

  it("bounds work per sweep and reports the truncation instead of dropping it silently", async () => {
    await seedParkedDeferredWake({ parkedAt: new Date("2026-06-01T00:00:00.000Z") });
    await seedParkedDeferredWake({ parkedAt: new Date("2026-06-02T00:00:00.000Z") });

    const result = await heartbeat.reapStrandedDeferredWakes({ limit: 1 });

    expect(result.candidateIssues).toBe(2);
    expect(result.scannedIssues).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.truncated).toBe(true);

    // The remainder is not lost — the next sweep drains it.
    const next = await heartbeat.reapStrandedDeferredWakes({ limit: 1 });
    expect(next.promoted).toBe(1);
    expect(next.truncated).toBe(false);
  });
});
