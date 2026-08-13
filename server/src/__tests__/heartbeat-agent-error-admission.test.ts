// AUR-5644: an agent whose last run failed sits in `status='error'`. Before
// this fix, a refused wake against that agent (enqueueWakeup's admission
// check) threw BEFORE writeSkippedRequest ever ran, so the refusal left zero
// trace in agent_wakeup_requests — the one table operators query for
// wake-health. And `error` was a purely-manual absorbing state: nothing but
// a due scheduled_retry promotion cleared it, so a failure that scheduled no
// retry (or exhausted all 3 attempts) wedged the agent permanently.
//
// This file proves, against the real DB:
//   A) a refused admission now writes a `skipped` row before throwing, and a
//      HEALTHY wake still produces a normal (non-skipped) row — no spurious
//      skips.
//   B) a genuine new-assignment wake (source: "assignment") self-heals an
//      `error` agent and lets the wake proceed, while an ordinary on_demand
//      wake against the SAME error agent does NOT self-heal — proving the
//      fix does not re-flood a dead lane via arbitrary wake traffic.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-error-admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent status=error admission (AUR-5644)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-error-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, status: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });
    return agentId;
  }

  async function latestWakeupRequest(companyId: string, agentId: string) {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .orderBy(agentWakeupRequests.createdAt);
    return rows.at(-1) ?? null;
  }

  async function agentStatus(agentId: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    return row?.status ?? null;
  }

  it("FIRE: a refused wake against an error agent writes a skipped row before throwing", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "error");
    const heartbeat = heartbeatService(db);

    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_wake",
      }),
    ).rejects.toMatchObject({ status: 409, message: "Agent is not invokable in its current state" });

    const request = await latestWakeupRequest(companyId, agentId);
    expect(request).not.toBeNull();
    expect(request?.status).toBe("skipped");
    expect(request?.reason).toBe("agent_status_ineligible");
    // The agent must still be `error` — an ordinary on_demand wake is not a
    // self-heal trigger.
    expect(await agentStatus(agentId)).toBe("error");
  });

  it("PASS: a healthy wake still produces a normal (non-skipped) row", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
    });
    expect(run).not.toBeNull();

    const request = await latestWakeupRequest(companyId, agentId);
    expect(request).not.toBeNull();
    expect(request?.status).not.toBe("skipped");
  });

  it("B/FIRE: a genuine new-assignment wake self-heals an error agent and proceeds", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "error");
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: randomUUID(), mutation: "create" },
    });

    expect(run).not.toBeNull();
    expect(await agentStatus(agentId)).not.toBe("error");

    const request = await latestWakeupRequest(companyId, agentId);
    expect(request?.status).not.toBe("skipped");
  });

  it("B/CLEARING: an ordinary on_demand wake does NOT self-heal an error agent (no dead-lane re-flood)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "error");
    const heartbeat = heartbeatService(db);

    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_wake",
      }),
    ).rejects.toBeInstanceOf(HttpError);

    expect(await agentStatus(agentId)).toBe("error");
  });

  it("B/CLEARING: a timer wake does NOT self-heal an error agent", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "error");
    const heartbeat = heartbeatService(db);

    await expect(
      heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
      }),
    ).rejects.toBeInstanceOf(HttpError);

    expect(await agentStatus(agentId)).toBe("error");
  });
});
