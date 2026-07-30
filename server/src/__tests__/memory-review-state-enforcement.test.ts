import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, memoryBindings, memoryLocalRecords, memoryOperations } from "@paperclipai/db";
import type { MemoryProviderCaptureOutput, MemoryRecord } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory.js";
import type { PluginMemoryProviderDispatcher } from "../services/plugin-memory-provider-dispatcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review-state enforcement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AUR-4145: records in AUTO_ACCEPT_CATEGORIES were landing (or staying)
// reviewState=pending through write paths that never consulted the allowlist:
// an explicit reviewState on capture overrode the resolver (33 live rows), the
// upsert-by-title update never recomputed it, agentUpdate could re-categorize a
// pending row into an allowlisted category without accepting it (the 3 most
// recent live strandings), and persistCatalogRecords defaulted plugin records
// to pending regardless of category. Each write path below asserts the
// allowlist now holds, with controls proving the guard still discriminates
// (non-allowlisted stays pending; a board rejection is never resurrected).
describeEmbeddedPostgres("memoryService review-state enforcement (AUR-4145)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof memoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-review-state-");
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

  async function setUpCompanyWithBinding(providerKey = "local_basic") {
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
        providerKey,
        config: {},
        enabled: true,
      })
      .returning();
    return { companyId, binding };
  }

  function actorFor(actorId: string) {
    return {
      actorType: "system" as const,
      actorId,
      agentId: null,
      userId: null,
      runId: null,
    };
  }

  const actor = actorFor("test-actor");

  async function rowById(recordId: string) {
    const rows = await db
      .select()
      .from(memoryLocalRecords)
      .where(eq(memoryLocalRecords.id, recordId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  describe("write path 1: captureLocalBasic insert", () => {
    it("accepts an allowlisted category even when the caller explicitly requests pending", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const result = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9001/test-agent",
        content: "Routed to agent X: queue depth 7 vs 23.",
        metadata: { category: "routing_rationale", issue_id: "AUR-9001" },
        reviewState: "pending" as const,
      }, actor);

      expect(result.records[0].reviewState).toBe("accepted");
      expect((await rowById(result.records[0].id)).reviewState).toBe("accepted");
    });

    it("control: a non-allowlisted category still lands pending", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const result = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "notes/AUR-9002",
        content: "Free-form prose that genuinely needs board review.",
        metadata: { category: "observation" },
      }, actor);

      expect(result.records[0].reviewState).toBe("pending");
    });
  });

  describe("write path 2: captureLocalBasic upsert-by-title update", () => {
    it("self-heals a pending row to accepted when re-captured under an allowlisted category", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const first = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9003/test-agent",
        content: "v1",
        metadata: { category: "observation" },
      }, actor);
      expect(first.records[0].reviewState).toBe("pending");

      const second = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9003/test-agent",
        content: "v2",
        metadata: { category: "routing_rationale", issue_id: "AUR-9003" },
        upsert: true,
      }, actor);

      expect(second.dedup).toBe(true);
      expect(second.records[0].id).toBe(first.records[0].id);
      expect(second.records[0].reviewState).toBe("accepted");
      expect((await rowById(first.records[0].id)).reviewState).toBe("accepted");
    });

    it("heals a legacy pre-allowlist row on the next doctrine-mandated upsert", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const first = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9004/test-agent",
        content: "v1",
        metadata: { category: "routing_rationale", issue_id: "AUR-9004" },
      }, actor);
      // Simulate a row captured before its category joined the allowlist.
      await db
        .update(memoryLocalRecords)
        .set({ reviewState: "pending" })
        .where(eq(memoryLocalRecords.id, first.records[0].id));

      const second = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9004/test-agent",
        content: "v2",
        metadata: { category: "routing_rationale", issue_id: "AUR-9004" },
        upsert: true,
      }, actor);

      expect(second.dedup).toBe(true);
      expect((await rowById(first.records[0].id)).reviewState).toBe("accepted");
    });

    it("control: a board-rejected row is never resurrected by upsert", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const first = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9005/test-agent",
        content: "v1",
        metadata: { category: "routing_rationale", issue_id: "AUR-9005" },
      }, actor);
      await db
        .update(memoryLocalRecords)
        .set({ reviewState: "rejected" })
        .where(eq(memoryLocalRecords.id, first.records[0].id));

      const second = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "routing/AUR-9005/test-agent",
        content: "v2",
        metadata: { category: "routing_rationale", issue_id: "AUR-9005" },
        upsert: true,
      }, actor);

      expect(second.dedup).toBe(true);
      expect((await rowById(first.records[0].id)).reviewState).toBe("rejected");
    });
  });

  describe("write path 3: agentUpdate metadata merge", () => {
    it("accepts a pending row re-categorized into an allowlisted category", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const captured = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "retrospective/AUR-9006/lessons",
        content: "Distilled lesson prose.",
        metadata: { category: "retrospective" },
      }, actor);
      expect(captured.records[0].reviewState).toBe("pending");

      // The live stranding path: durability doctrine told agents to re-home
      // stranded prose under category "lesson" via the agent PATCH route.
      const updated = await svc.agentUpdate(
        companyId,
        captured.records[0].id,
        { metadata: { category: "lesson" } },
        actor,
      );

      expect(updated.record.reviewState).toBe("accepted");
      expect((await rowById(captured.records[0].id)).reviewState).toBe("accepted");
    });

    it("control: a content-only update leaves a pending non-allowlisted row pending", async () => {
      const { companyId } = await setUpCompanyWithBinding();
      const captured = await svc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        title: "retrospective/AUR-9007/lessons",
        content: "v1",
        metadata: { category: "retrospective" },
      }, actor);

      const updated = await svc.agentUpdate(
        companyId,
        captured.records[0].id,
        { content: "v2" },
        actor,
      );

      expect(updated.record.reviewState).toBe("pending");
    });
  });

  describe("write path 4: persistCatalogRecords (plugin provider)", () => {
    function providerRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
      const now = new Date();
      return {
        id: randomUUID(),
        companyId: "",
        bindingId: "",
        providerKey: "plugin_test",
        scope: {},
        source: { kind: "manual_note" },
        scopeType: "org",
        scopeId: null,
        owner: null,
        createdBy: null,
        sensitivityLabel: "internal",
        retentionPolicy: null,
        expiresAt: null,
        retentionState: "active",
        // Plugins routinely omit reviewState in their JSON; the old code
        // defaulted that to "pending" regardless of category.
        reviewState: undefined as unknown as MemoryRecord["reviewState"],
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
        citation: null,
        supersedesRecordId: null,
        supersededByRecordId: null,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        title: null,
        content: "provider content",
        summary: null,
        metadata: {},
        createdByOperationId: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it("persists an allowlisted-category provider record as accepted, a category-less one as pending", async () => {
      const { companyId } = await setUpCompanyWithBinding("plugin_test");
      const allowlisted = providerRecord({
        title: "routing/AUR-9008/test-agent",
        metadata: { category: "routing_rationale", issue_id: "AUR-9008" },
      });
      const uncategorized = providerRecord({ title: "raw/provider-note" });
      const stubDispatcher = {
        capture: async (): Promise<MemoryProviderCaptureOutput> => ({
          records: [allowlisted, uncategorized],
        }),
      } as unknown as PluginMemoryProviderDispatcher;
      const pluginSvc = memoryService(db, { pluginMemoryProviders: stubDispatcher });

      await pluginSvc.capture(companyId, {
        bindingKey: "primary",
        source: { kind: "manual_note" as const },
        content: "ignored by stub",
        metadata: {},
      }, actor);

      expect((await rowById(allowlisted.id)).reviewState).toBe("accepted");
      expect((await rowById(uncategorized.id)).reviewState).toBe("pending");
    });
  });
});
