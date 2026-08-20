// AUR-4598 (carried from the AUR-4557 adversarial review, deliberately not fixed
// in PR #177): a forced session rotation nulled `previousSessionDisplayId` but not
// the outer `previousSessionParams` const. On the adapter-throw launch-failure
// path, `upsertTaskSession` persisted that stale, un-nulled value -- resurrecting
// the very session the rotation had just retired.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Completed heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

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

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping AUR-4598 session-resurrection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "rotation followed by an adapter-throw launch failure does not resurrect the retired session (AUR-4598)",
  () => {
    let stopDb: (() => Promise<void>) | null = null;
    let db!: ReturnType<typeof createDb>;

    beforeAll(async () => {
      const started = await startEmbeddedPostgresTestDatabase("heartbeat-aur4598-resurrection");
      stopDb = started.stop;
      db = createDb(started.connectionString);
    }, 20_000);

    afterEach(async () => {
      // heartbeat's post-failure processing (resumeQueuedRuns / promotion) keeps
      // running in the background after a run reaches its terminal status, and it
      // is not scoped to the seeding company -- it can consume the NEXT test's
      // queued mockRejectedValueOnce before that test's own wakeup call does,
      // making the two tests interfere when run in the same file. Reset both the
      // DB (so no cross-test row is left to drive) and the mock (so no leaked
      // once-queued implementation survives) between tests.
      mockAdapterExecute.mockReset();
      mockAdapterExecute.mockImplementation(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Completed heartbeat work.",
        provider: "test",
        model: "test-model",
      }));
      await resetEmbeddedPostgresTestDatabase(db);
    });

    afterAll(async () => {
      await db.$client.end();
      await stopDb?.();
    });

    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const staleSessionId = `session-stale-${randomUUID()}`;
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "AUR-4598 Regression",
        issuePrefix,
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
        // claude_local's default sessionCompaction policy rotates past 12 runs
        // on one session -- see parseSessionCompactionPolicy (AUR-4513).
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "AUR-4598 regression issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // The task session that rotation is about to retire. This is exactly what
      // upsertTaskSession must NOT write back after the adapter-throw failure below.
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: issueId,
        sessionParamsJson: { sessionId: staleSessionId, cwd: "/tmp/paperclip-aur4598-regression" },
        sessionDisplayId: staleSessionId,
        lastRunId: null,
        lastError: null,
      });

      // 13 healthy runs on that session > the claude_local default maxSessionRuns (12),
      // forcing evaluateSessionCompaction to rotate on the next wake.
      const now = Date.now();
      for (let i = 0; i < 13; i += 1) {
        const createdAt = new Date(now - (12 - i) * 60_000);
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          status: "succeeded",
          sessionIdAfter: staleSessionId,
          errorCode: null,
          error: null,
          createdAt,
          updatedAt: createdAt,
        } as typeof heartbeatRuns.$inferInsert);
      }

      return { companyId, agentId, issueId, staleSessionId };
    }

    it("FIRE: leaves no stale sessionParamsJson/sessionDisplayId on the task session", async () => {
      const { companyId, agentId, issueId } = await seedFixture();
      mockAdapterExecute.mockRejectedValueOnce(new Error("simulated adapter launch failure"));

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_wake",
        contextSnapshot: { issueId },
      });

      expect(run).not.toBeNull();
      await vi.waitFor(
        async () => {
          const latest = await heartbeat.getRun(run!.id);
          expect(latest?.status).toBe("failed");
        },
        { timeout: 10_000 },
      );

      // `setRunStatus` (which the poll above observes) runs many awaited steps
      // before the catch block's own `upsertTaskSession` call -- reading
      // agentTaskSessions as soon as the run flips to "failed" races that write.
      // Poll for the write's own effect (lastRunId advancing to this failed run)
      // so the assertions below only run once it has actually landed.
      await vi.waitFor(
        async () => {
          const [latestSession] = await db
            .select()
            .from(agentTaskSessions)
            .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.taskKey, issueId)));
          expect(latestSession?.lastRunId).toBe(run!.id);
        },
        { timeout: 10_000 },
      );

      const [session] = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.taskKey, issueId)));

      expect(session).toBeTruthy();
      // Pre-fix: sessionParamsJson still held the retired session's params here,
      // even though sessionDisplayId was correctly nulled by the same rotation.
      expect(session?.sessionParamsJson).toBeNull();
      expect(session?.sessionDisplayId).toBeNull();
    }, 15_000);

    // Control: without a rotation, an adapter-throw failure is expected to persist
    // the previous session params as-is so the next wake can still resume it.
    it("PASS: without rotation, an adapter-throw failure still persists the previous session params", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const sessionId = `session-${randomUUID()}`;
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "AUR-4598 Control",
        issuePrefix,
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
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "AUR-4598 control issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: issueId,
        sessionParamsJson: { sessionId, cwd: "/tmp/paperclip-aur4598-control" },
        sessionDisplayId: sessionId,
        lastRunId: null,
        lastError: null,
      });
      // Only 2 runs on this session -- well under the rotation threshold, so no
      // rotation should fire.
      const now = Date.now();
      for (let i = 0; i < 2; i += 1) {
        const createdAt = new Date(now - (1 - i) * 60_000);
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          status: "succeeded",
          sessionIdAfter: sessionId,
          errorCode: null,
          error: null,
          createdAt,
          updatedAt: createdAt,
        } as typeof heartbeatRuns.$inferInsert);
      }

      mockAdapterExecute.mockRejectedValueOnce(new Error("simulated adapter launch failure"));

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_wake",
        contextSnapshot: { issueId },
      });

      expect(run).not.toBeNull();
      await vi.waitFor(
        async () => {
          const latest = await heartbeat.getRun(run!.id);
          expect(latest?.status).toBe("failed");
        },
        { timeout: 10_000 },
      );

      // See the FIRE test above: the run-status flip happens well before the
      // catch block's own upsertTaskSession write; poll for that write's own
      // effect instead of racing it.
      await vi.waitFor(
        async () => {
          const [latestSession] = await db
            .select()
            .from(agentTaskSessions)
            .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.taskKey, issueId)));
          expect(latestSession?.lastRunId).toBe(run!.id);
        },
        { timeout: 10_000 },
      );

      const [session] = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.taskKey, issueId)));

      expect(session).toBeTruthy();
      expect(session?.sessionDisplayId).toBe(sessionId);
      expect(session?.sessionParamsJson).toMatchObject({ sessionId });
    }, 15_000);
  },
);
