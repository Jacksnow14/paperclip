import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, memoryBindings, memoryLocalRecords, memoryOperations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory capture idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-4022: `POST /memory/capture` was not idempotent by title, and the CTO's original
// fix ("upsert on title+scope") was explicitly rejected as dangerous — scorecard titles
// are deliberately one bucket per agent/task-type/day (many distinct captures share a
// title on purpose), so upserting on title alone would collapse them and silently delete
// history. The shipped fix is an opt-in `idempotencyKey`: exactly-once only when the
// caller asks for it, with upsert-by-title behavior for legitimate same-title records
// left completely unchanged.
describeEmbeddedPostgres("memoryService capture idempotency (AUR-4022)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof memoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-capture-idempotency-");
    db = createDb(tempDb.connectionString);
    svc = memoryService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(memoryOperations);
    await db.delete(memoryLocalRecords);
    await db.delete(memoryBindings);
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

  const actor = {
    actorType: "system" as const,
    actorId: "test-actor",
    agentId: null,
    userId: null,
    runId: null,
  };

  it("returns exactly one record for two identical back-to-back captures with the same idempotencyKey", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const capturePayload = {
      bindingKey: "primary",
      source: { kind: "manual_note" as const },
      content: "Disk usage crossed 85% on host-1",
      title: "disk-alert/host-1",
      metadata: { category: "tool_gap", issue_id: "AUR-9001" },
      idempotencyKey: "disk-alert-host-1-2026-07-25",
    };

    const first = await svc.capture(companyId, capturePayload, actor);
    const second = await svc.capture(companyId, capturePayload, actor);

    expect(first.records).toHaveLength(1);
    expect(second.dedup).toBe(true);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].id).toBe(first.records[0].id);

    const allRecords = await db
      .select()
      .from(memoryLocalRecords)
      .where(eq(memoryLocalRecords.companyId, companyId));
    expect(allRecords).toHaveLength(1);
  });

  it("creates two distinct records for the same title with different metadata.issue_id (upsert-by-title guardrail)", async () => {
    const { companyId } = await setUpCompanyWithBinding();
    const sharedTitle = "performance/agent-1/feature/2026-07-25";

    const first = await svc.capture(companyId, {
      bindingKey: "primary",
      source: { kind: "manual_note" as const },
      content: "Scorecard entry for issue AUR-1001",
      title: sharedTitle,
      metadata: { category: "performance_scorecard", issue_id: "AUR-1001" },
    }, actor);

    const second = await svc.capture(companyId, {
      bindingKey: "primary",
      source: { kind: "manual_note" as const },
      content: "Scorecard entry for issue AUR-1002",
      title: sharedTitle,
      metadata: { category: "performance_scorecard", issue_id: "AUR-1002" },
    }, actor);

    // Neither capture set `upsert: true` or an `idempotencyKey`, so a shared title alone
    // must never collapse these into one record — this is the exact scorecard-bucket
    // scenario the CTO flagged as the failure mode of a naive title-based upsert.
    expect(first.dedup).toBeFalsy();
    expect(second.dedup).toBeFalsy();
    expect(second.records[0].id).not.toBe(first.records[0].id);

    const allRecords = await db
      .select()
      .from(memoryLocalRecords)
      .where(eq(memoryLocalRecords.companyId, companyId));
    expect(allRecords).toHaveLength(2);
    expect(new Set(allRecords.map((r) => (r.metadata as { issue_id?: string })?.issue_id))).toEqual(
      new Set(["AUR-1001", "AUR-1002"]),
    );
  });
});
