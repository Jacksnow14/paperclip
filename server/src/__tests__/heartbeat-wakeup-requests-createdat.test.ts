import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wakeup-requests createdAt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * AUR-4523: `listWakeupRequests` selected specific columns rather than `select *`,
 * and the projection omitted `createdAt`/`updatedAt` even though both columns exist
 * on `agent_wakeup_requests`. A wake that was enqueued and then skipped was
 * therefore indistinguishable from one that never happened -- there was no
 * timestamp to sort or diff against run history.
 */
describeEmbeddedPostgres("heartbeat listWakeupRequests createdAt/updatedAt", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wakeup-requests-createdat-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("serialises non-null createdAt/updatedAt ordered by requestedAt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const olderId = randomUUID();
    const newerId = randomUUID();
    const olderAt = new Date("2026-06-05T19:55:59.826Z");
    const newerAt = new Date("2026-06-05T20:10:00.000Z");

    await db.insert(agentWakeupRequests).values([
      {
        id: olderId,
        companyId,
        agentId,
        source: "timer",
        status: "skipped",
        requestedAt: olderAt,
        createdAt: olderAt,
        updatedAt: olderAt,
      },
      {
        id: newerId,
        companyId,
        agentId,
        source: "assignment",
        status: "completed",
        requestedAt: newerAt,
        createdAt: newerAt,
        updatedAt: newerAt,
      },
    ]);

    const rows = await heartbeat.listWakeupRequests(agentId, 50);

    expect(rows).toHaveLength(2);
    // Ordered newest-first by requestedAt -- createdAt must be present on both.
    expect(rows[0]?.id).toBe(newerId);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.createdAt?.toISOString()).toBe(newerAt.toISOString());
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
    expect(rows[0]?.updatedAt?.toISOString()).toBe(newerAt.toISOString());

    expect(rows[1]?.id).toBe(olderId);
    expect(rows[1]?.createdAt).toBeInstanceOf(Date);
    expect(rows[1]?.createdAt?.toISOString()).toBe(olderAt.toISOString());
    expect(rows[1]?.updatedAt).toBeInstanceOf(Date);
  });
});
