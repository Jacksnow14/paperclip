import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  memoryBindings,
  memoryBindingTargets,
  memoryLocalRecords,
  memoryOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory.js";

// AUR-3991: the fake-db test in memory-routing-rationale-dedup.test.ts proves the
// query-first check dedupes SEQUENTIAL captures, but a plain select-then-insert
// has a TOCTOU gap under genuinely concurrent writers: both selects can run
// before either insert commits. This test exercises the real Postgres path
// (real network round-trips, real transactions) with two capture() calls fired
// via Promise.all — with no locking, that would produce 2 accepted rows. The
// partial unique index on (company_id, title) for accepted routing_rationale
// records is what actually closes the gap: the loser gets a 23505 and
// captureLocalBasic() falls back to reading the winner.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routing_rationale concurrency test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routing_rationale capture concurrency (AUR-3991)", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof memoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routing-rationale-concurrent-");
    db = createDb(tempDb.connectionString);
    service = memoryService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(memoryOperations);
    await db.delete(memoryLocalRecords);
    await db.delete(memoryBindingTargets);
    await db.delete(memoryBindings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompanyWithLocalBasicBinding() {
    const companyId = randomUUID();
    const bindingId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routing Concurrency Co" });
    await db.insert(memoryBindings).values({
      id: bindingId,
      companyId,
      key: "default",
      providerKey: "local_basic",
      enabled: true,
    });
    await db.insert(memoryBindingTargets).values({
      companyId,
      bindingId,
      targetType: "company",
      targetId: companyId,
    });
    return { companyId };
  }

  async function createAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("collapses two truly concurrent backfills of the same routing/{issueId} key into one accepted record", async () => {
    const { companyId } = await createCompanyWithLocalBasicBinding();
    const ceoAgentId = await createAgent(companyId, "CEO");
    const ctoAgentId = await createAgent(companyId, "CTO");
    const ceoActor = { actorType: "agent" as const, actorId: ceoAgentId, agentId: ceoAgentId, userId: null, runId: null };
    const ctoActor = { actorType: "agent" as const, actorId: ctoAgentId, agentId: ctoAgentId, userId: null, runId: null };

    const captureInput = {
      scope: {},
      source: { kind: "issue" as const },
      title: "routing/AUR-9999",
      content: "Routed AUR-9999 to Claude Code Fast.",
      metadata: { category: "routing_rationale" },
    };

    // No await between these two calls: both start executing (and both reach
    // their query-first select) before either has committed an insert.
    const [first, second] = await Promise.all([
      service.capture(companyId, captureInput, ceoActor),
      service.capture(companyId, captureInput, ctoActor),
    ]);

    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(first.records[0].id).toBe(second.records[0].id);
    expect([first.operation.resultJson?.dedup, second.operation.resultJson?.dedup].filter(Boolean)).toHaveLength(1);

    const persisted = await db
      .select()
      .from(memoryLocalRecords)
      .where(eq(memoryLocalRecords.companyId, companyId));
    expect(persisted).toHaveLength(1);
  });

  it("still captures distinct routing/{issueId} keys as separate records under concurrency", async () => {
    const { companyId } = await createCompanyWithLocalBasicBinding();
    const agentId = await createAgent(companyId, "CFO");
    const actor = { actorType: "agent" as const, actorId: agentId, agentId, userId: null, runId: null };

    await Promise.all([
      service.capture(
        companyId,
        {
          scope: {},
          source: { kind: "issue" as const },
          title: "routing/AUR-1000",
          content: "Routed AUR-1000 to CFO.",
          metadata: { category: "routing_rationale" },
        },
        actor,
      ),
      service.capture(
        companyId,
        {
          scope: {},
          source: { kind: "issue" as const },
          title: "routing/AUR-1001",
          content: "Routed AUR-1001 to CTO.",
          metadata: { category: "routing_rationale" },
        },
        actor,
      ),
    ]);

    const persisted = await db
      .select()
      .from(memoryLocalRecords)
      .where(eq(memoryLocalRecords.companyId, companyId));
    expect(persisted).toHaveLength(2);
  });
});
