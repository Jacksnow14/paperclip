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
    `Skipping embedded Postgres memory record readback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-4140: `POST /memory/capture` returned `status: succeeded` for records that no
// agent read path could ever return — non-allowlisted categories landed
// reviewState=pending, and every agent read AND-ed a hardcoded `accepted` condition,
// so even the author's own `?reviewState=pending` compiled to `accepted AND pending`
// (provably empty). These tests pin the fix from both sides: the author can always
// read back their own record whatever its reviewState, and no other agent can ever
// see someone else's pending record — by id, by list, or by explicit reviewState
// filter. Each fix is exercised separately so reverting any one of them fails at
// least one test.
describeEmbeddedPostgres("memoryService record readback (AUR-4140)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof memoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-record-readback-");
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
    // memory_operations.agent_id has an FK to agents — the capturing/reading
    // agent actors must exist as real rows.
    for (const [agentId, name] of [
      [agentA, "Author Agent"],
      [agentB, "Other Agent"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    return { companyId, binding };
  }

  function agentActor(agentId: string) {
    return {
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      userId: null,
      runId: null,
    };
  }

  function listFilters(overrides: Record<string, unknown> = {}) {
    return memoryListRecordsQuerySchema.parse(overrides);
  }

  const agentA = randomUUID();
  const agentB = randomUUID();

  async function capturePendingAsA(companyId: string) {
    const result = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "deploy-safety/aur4140-probe",
        content: "Doctrine capture that lands pending review",
        metadata: { category: "doctrine" },
      },
      agentActor(agentA),
    );
    return result.records[0];
  }

  it("author reads back their own pending record by id; a non-allowlisted category still lands pending", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const record = await capturePendingAsA(companyId);

    expect(record.reviewState).toBe("pending");

    const readBack = await svc.getRecord(companyId, record.id, agentActor(agentA));
    expect(readBack).not.toBeNull();
    expect(readBack?.id).toBe(record.id);
    expect(readBack?.reviewState).toBe("pending");
  });

  it("?reviewState=pending returns the author's own pending records instead of the old accepted-AND-pending empty set", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const record = await capturePendingAsA(companyId);

    const listed = await svc.listRecords(companyId, listFilters({ reviewState: "pending" }), agentActor(agentA));
    expect(listed.map((row) => row.id)).toContain(record.id);

    const { count } = await svc.countRecords(companyId, listFilters({ reviewState: "pending", count: "only" }), agentActor(agentA));
    expect(count).toBe(1);
  });

  it("security boundary: another agent can never see a pending record — by id, by list, or by explicit reviewState filter", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const record = await capturePendingAsA(companyId);

    const byId = await svc.getRecord(companyId, record.id, agentActor(agentB));
    expect(byId).toBeNull();

    const byPendingFilter = await svc.listRecords(companyId, listFilters({ reviewState: "pending" }), agentActor(agentB));
    expect(byPendingFilter).toHaveLength(0);

    const byDefaultList = await svc.listRecords(companyId, listFilters(), agentActor(agentB));
    expect(byDefaultList.map((row) => row.id)).not.toContain(record.id);

    const byTitlePrefix = await svc.listRecords(
      companyId,
      listFilters({ titlePrefix: "deploy-safety/" }),
      agentActor(agentB),
    );
    expect(byTitlePrefix).toHaveLength(0);
  });

  it("retrospective and retrospective_lesson are auto-accepted and land in the default titlePrefix sweep for other agents", async () => {
    const { companyId } = await setUpCompanyWithBinding();

    const retro = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "retrospective/AUR-4140/tool-gaps",
        content: "Distilled retrospective lesson",
        metadata: { category: "retrospective" },
      },
      agentActor(agentA),
    );
    expect(retro.records[0].reviewState).toBe("accepted");

    const retroLesson = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "retrospective/AUR-4140/patterns",
        content: "Distilled retrospective pattern",
        metadata: { category: "retrospective_lesson" },
      },
      agentActor(agentA),
    );
    expect(retroLesson.records[0].reviewState).toBe("accepted");

    // The mandated closing-checklist sweep: another agent, default params, titlePrefix only.
    const sweep = await svc.listRecords(
      companyId,
      listFilters({ titlePrefix: "retrospective/" }),
      agentActor(agentB),
    );
    expect(sweep.map((row) => row.id).sort()).toEqual(
      [retro.records[0].id, retroLesson.records[0].id].sort(),
    );
  });

  it("regression: default list is accepted-only for a non-author (count unchanged), while the author additionally sees their own pending", async () => {
    const { companyId } = await setUpCompanyWithBinding();

    const accepted = await svc.capture(
      companyId,
      {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "lesson/aur4140-accepted-control",
        content: "Auto-accepted control record",
        metadata: { category: "lesson" },
      },
      agentActor(agentA),
    );
    expect(accepted.records[0].reviewState).toBe("accepted");
    const pending = await capturePendingAsA(companyId);
    expect(pending.reviewState).toBe("pending");

    const nonAuthorDefault = await svc.listRecords(companyId, listFilters(), agentActor(agentB));
    expect(nonAuthorDefault.map((row) => row.id)).toEqual([accepted.records[0].id]);
    const nonAuthorCount = await svc.countRecords(companyId, listFilters({ count: "only" }), agentActor(agentB));
    expect(nonAuthorCount.count).toBe(1);

    const authorDefault = await svc.listRecords(companyId, listFilters(), agentActor(agentA));
    expect(new Set(authorDefault.map((row) => row.id))).toEqual(
      new Set([accepted.records[0].id, pending.id]),
    );
  });
});
