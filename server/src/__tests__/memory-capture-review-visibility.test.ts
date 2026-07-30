import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, memoryBindings, memoryLocalRecords, memoryOperations } from "@paperclipai/db";
import { memoryListRecordsQuerySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory review-visibility tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-4060: `POST /memory/capture` reported 201 + a real recordId for records whose
// category is not on the AUTO_ACCEPT allowlist (they land as reviewState "pending"),
// but the record was then unreadable through *every* read path for *any* agent actor —
// including the agent that just created it, and including an explicit
// `?reviewState=pending` filter, which is the exact workaround the capture response's
// own warning message advertises. Root cause: buildRecordVisibilityConditions()
// unconditionally ANDed in `reviewState = 'accepted'` for agent actors, which made it
// impossible to ever satisfy a query for a non-accepted reviewState, and
// canReadRecord() rejected non-accepted records for agent actors with no owner
// exception. This asserts the read-back the route's warning promises actually works,
// and that it does not leak other agents' unreviewed records in the process.
describeEmbeddedPostgres("memoryService pending-record visibility (AUR-4060)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof memoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-review-visibility-");
    db = createDb(tempDb.connectionString);
    svc = memoryService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(memoryOperations);
    await db.delete(memoryLocalRecords);
    await db.delete(memoryBindings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setUpCompanyWithBinding() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [binding] = await db
      .insert(memoryBindings)
      .values({
        id: randomUUID(),
        companyId,
        key: "primary",
        name: "Primary",
        providerKey: "local_basic",
        config: {},
        enabled: true,
      })
      .returning();
    return { companyId, binding };
  }

  async function createAgentActor(companyId: string, name: string) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name, role: "general" })
      .returning();
    return {
      actorType: "agent" as const,
      actorId: agent.id,
      agentId: agent.id,
      userId: null,
      runId: null,
    };
  }

  it("lets the capturing agent read back its own pending (non-allowlisted-category) record by id", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const agent = await createAgentActor(companyId, "Agent A");

    const captured = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        content: "Routing rationale for issue AUR-9002",
        title: "routing-probe/AUR-4060",
        metadata: { category: "routing" }, // not on AUTO_ACCEPT_CATEGORIES -> reviewState "pending"
      },
      agent,
    );

    expect(captured.records).toHaveLength(1);
    const recordId = captured.records[0].id;
    expect(captured.records[0].reviewState).toBe("pending");

    const readBack = await svc.getRecord(companyId, recordId, agent);
    expect(readBack).not.toBeNull();
    expect(readBack?.id).toBe(recordId);
  });

  it("lets the capturing agent list its own pending record via ?reviewState=pending, but hides it by default", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const agent = await createAgentActor(companyId, "Agent A");

    const captured = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        content: "Observation pending review",
        title: "observation/AUR-4060",
        metadata: { category: "observation" },
      },
      agent,
    );
    const recordId = captured.records[0].id;

    const defaultList = await svc.listRecords(
      companyId,
      memoryListRecordsQuerySchema.parse({}),
      agent,
    );
    expect(defaultList.some((r) => r.id === recordId)).toBe(false);

    const pendingList = await svc.listRecords(
      companyId,
      memoryListRecordsQuerySchema.parse({ reviewState: "pending" }),
      agent,
    );
    expect(pendingList.some((r) => r.id === recordId)).toBe(true);
  });

  it("does not let a different agent read or list another agent's pending record", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const owner = await createAgentActor(companyId, "Owner Agent");
    const otherAgent = await createAgentActor(companyId, "Other Agent");

    const captured = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        content: "Owner-only pending content",
        title: "observation/owner-only",
        metadata: { category: "observation" },
      },
      owner,
    );
    const recordId = captured.records[0].id;

    const readByOther = await svc.getRecord(companyId, recordId, otherAgent);
    expect(readByOther).toBeNull();

    const listByOther = await svc.listRecords(
      companyId,
      memoryListRecordsQuerySchema.parse({ reviewState: "pending" }),
      otherAgent,
    );
    expect(listByOther.some((r) => r.id === recordId)).toBe(false);
  });
});
