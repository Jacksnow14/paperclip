import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, memoryBindings, memoryLocalRecords } from "@paperclipai/db";
import {
  clusterSynthesisObservations,
  evaluateSynthesisClusterGates,
  memoryService,
  renderSynthesisCandidate,
  synthesisSimilarity,
  tokenizeForSynthesis,
  type SynthesisObservation,
} from "../services/memory.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function observation(overrides: Partial<SynthesisObservation> & { content: string }): SynthesisObservation {
  return {
    id: overrides.id ?? randomUUID(),
    title: overrides.title ?? null,
    metadata: overrides.metadata ?? {},
    agentKey: overrides.agentKey ?? "agent-1",
    sensitivityLabel: overrides.sensitivityLabel ?? "internal",
    createdAt: overrides.createdAt ?? new Date("2026-07-01T00:00:00Z"),
    content: overrides.content,
  };
}

describe("synthesis clustering helpers", () => {
  it("tokenizes with stop-word and short-token removal", () => {
    const tokens = tokenizeForSynthesis("The deploy script fails on IPv6 DNS at startup");
    expect(tokens.has("deploy")).toBe(true);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("on")).toBe(false);
    expect(tokens.has("ipv6")).toBe(true);
  });

  it("computes jaccard similarity", () => {
    const a = tokenizeForSynthesis("deploy script fails ipv6 dns");
    const b = tokenizeForSynthesis("deploy script fails ipv6 timeout");
    expect(synthesisSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(synthesisSimilarity(a, tokenizeForSynthesis("etsy shop listings expired oauth"))).toBe(0);
    expect(synthesisSimilarity(new Set(), a)).toBe(0);
  });

  it("clusters similar observations and keeps dissimilar ones apart", () => {
    const clusters = clusterSynthesisObservations(
      [
        observation({ content: "pnpm install fails with IPv6 DNS resolution timeout on the VPS" }),
        observation({ content: "pnpm install failed again: IPv6 DNS resolution timeout (VPS network)" }),
        observation({ content: "Etsy OAuth token expired, billing pull returns 401 invalid_token" }),
      ],
      0.5,
    );
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((cluster) => cluster.members.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("is deterministic regardless of input order", () => {
    const base = [
      observation({ id: "00000000-0000-4000-8000-000000000001", content: "alpha beta gamma delta", createdAt: new Date("2026-07-01T00:00:00Z") }),
      observation({ id: "00000000-0000-4000-8000-000000000002", content: "alpha beta gamma epsilon", createdAt: new Date("2026-07-02T00:00:00Z") }),
      observation({ id: "00000000-0000-4000-8000-000000000003", content: "totally unrelated words here", createdAt: new Date("2026-07-03T00:00:00Z") }),
    ];
    const forward = clusterSynthesisObservations(base, 0.5);
    const reversed = clusterSynthesisObservations([...base].reverse(), 0.5);
    expect(forward.map((c) => c.members.map((m) => m.id))).toEqual(reversed.map((c) => c.members.map((m) => m.id)));
  });

  it("applies support, distinct-agent, and observation-age gates", () => {
    const now = new Date("2026-07-06T00:00:00Z");
    const old = new Date(now.getTime() - 10 * DAY_MS);
    const fresh = new Date(now.getTime() - 1 * DAY_MS);
    const cluster = clusterSynthesisObservations(
      [
        observation({ content: "alpha beta gamma delta", agentKey: "a1", createdAt: old }),
        observation({ content: "alpha beta gamma epsilon", agentKey: "a2", createdAt: fresh }),
      ],
      0.5,
    )[0]!;

    expect(evaluateSynthesisClusterGates(cluster, { minSupport: 3, minDistinctAgents: 2, minObservationAgeDays: 3, now }))
      .toEqual({ pass: false, reason: "minSupport" });
    expect(evaluateSynthesisClusterGates(cluster, { minSupport: 2, minDistinctAgents: 3, minObservationAgeDays: 3, now }))
      .toEqual({ pass: false, reason: "minDistinctAgents" });
    expect(evaluateSynthesisClusterGates(cluster, { minSupport: 2, minDistinctAgents: 2, minObservationAgeDays: 30, now }))
      .toEqual({ pass: false, reason: "minObservationAge" });
    expect(evaluateSynthesisClusterGates(cluster, { minSupport: 2, minDistinctAgents: 2, minObservationAgeDays: 3, now }))
      .toEqual({ pass: true });
  });

  it("renders a bounded candidate with provenance", () => {
    const now = new Date("2026-07-06T00:00:00Z");
    const cluster = clusterSynthesisObservations(
      [
        observation({ title: "IPv6 DNS breaks pnpm", content: "pnpm install fails with IPv6 DNS resolution timeout", agentKey: "a1" }),
        observation({ title: null, content: "pnpm install failed again due to IPv6 DNS resolution timeout", agentKey: "a2" }),
      ],
      0.5,
    )[0]!;
    const rendered = renderSynthesisCandidate(cluster, { since: new Date(now.getTime() - 14 * DAY_MS), until: now });
    expect(rendered.title).toMatch(/^synthesis: /);
    expect(rendered.content).toContain("2 accepted memory record(s)");
    expect(rendered.content).toContain("2 distinct agent(s)");
    expect(rendered.content.length).toBeLessThanOrEqual(20000);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("memory.startSynthesisJob", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-synthesis-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const actor = {
    actorType: "user" as const,
    actorId: "board-user",
    agentId: null,
    userId: "board-user",
    runId: null,
  };

  async function seedCompanyWithBinding() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthesis Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    const bindingId = randomUUID();
    await db.insert(memoryBindings).values({
      id: bindingId,
      companyId,
      key: "default",
      providerKey: "local_basic",
      config: {},
      enabled: true,
    });
    return { companyId, bindingId };
  }

  async function seedObservation(input: {
    companyId: string;
    bindingId: string;
    content: string;
    agentKey?: string;
    ageDays: number;
    reviewState?: "accepted" | "pending" | "rejected";
    metadata?: Record<string, unknown>;
    sensitivityLabel?: "public" | "internal" | "confidential" | "restricted";
  }) {
    const createdAt = new Date(Date.now() - input.ageDays * DAY_MS);
    await db.insert(memoryLocalRecords).values({
      id: randomUUID(),
      companyId: input.companyId,
      bindingId: input.bindingId,
      providerKey: "local_basic",
      content: input.content,
      metadata: input.metadata ?? {},
      createdByActorType: "agent",
      createdByActorId: input.agentKey ?? "agent-1",
      sensitivityLabel: input.sensitivityLabel ?? "internal",
      reviewState: input.reviewState ?? "accepted",
      createdAt,
      updatedAt: createdAt,
    });
  }

  it("consolidates a recurring multi-agent pattern into an auto-accepted synthesis record", async () => {
    const { companyId, bindingId } = await seedCompanyWithBinding();
    const svc = memoryService(db);

    // Recurring pattern: 3 observations, 2 agents, oldest 8 days old.
    await seedObservation({ companyId, bindingId, content: "pnpm install fails with IPv6 DNS resolution timeout on the VPS", agentKey: "agent-a", ageDays: 8 });
    await seedObservation({ companyId, bindingId, content: "pnpm install failed: IPv6 DNS resolution timeout again on the VPS", agentKey: "agent-b", ageDays: 5 });
    await seedObservation({ companyId, bindingId, content: "IPv6 DNS resolution timeout broke pnpm install on the VPS worker", agentKey: "agent-a", ageDays: 4 });
    // Noise below the support gate.
    await seedObservation({ companyId, bindingId, content: "Etsy OAuth token expired and billing pull returned 401", agentKey: "agent-c", ageDays: 6 });

    const result = await svc.startSynthesisJob(
      companyId,
      { bindingId, lookbackDays: 14, similarityThreshold: 0.4, minSupport: 3, minDistinctAgents: 2, minObservationAgeDays: 3 },
      actor,
      { runInline: true },
    );

    expect(result.dryRun).toBe(false);
    expect(result.bindingId).toBe(bindingId);
    expect(result.summary.sourceRecordCount).toBe(4);
    expect(result.summary.candidateCount).toBe(1);
    expect(result.summary.skipped.minSupport).toBeGreaterThanOrEqual(1);
    expect(result.candidateRecordIds).toHaveLength(1);
    expect(result.run?.status).toBe("succeeded");

    const record = await svc.getRecord(companyId, result.candidateRecordIds[0]!);
    expect(record).not.toBeNull();
    expect(record?.metadata?.category).toBe("synthesis");
    expect(record?.metadata?.generated_by).toBe("memory.synthesis");
    expect((record?.metadata?.source_record_ids as string[]).length).toBe(3);
    // synthesis is an auto-accepted category, so the loop closes without review.
    expect(record?.reviewState).toBe("accepted");
  });

  it("dry run counts candidates without writing records", async () => {
    const { companyId, bindingId } = await seedCompanyWithBinding();
    const svc = memoryService(db);
    await seedObservation({ companyId, bindingId, content: "retry queue backlog grows when worker restarts mid-batch", agentKey: "agent-a", ageDays: 9 });
    await seedObservation({ companyId, bindingId, content: "retry queue backlog observed growing after worker restarts mid-batch", agentKey: "agent-b", ageDays: 4 });

    const result = await svc.startSynthesisJob(
      companyId,
      { bindingId, lookbackDays: 14, similarityThreshold: 0.4, minSupport: 2, minDistinctAgents: 2, minObservationAgeDays: 3, dryRun: true },
      actor,
    );

    expect(result.dryRun).toBe(true);
    expect(result.summary.candidateCount).toBe(1);
    expect(result.candidateRecordIds).toHaveLength(0);
  });

  it("respects sensitivity ceilings and rejected-synthesis vetoes", async () => {
    const { companyId, bindingId } = await seedCompanyWithBinding();
    const svc = memoryService(db);

    // Restricted records are excluded by the default internal ceiling.
    await seedObservation({ companyId, bindingId, content: "secret credential rotation drift on prod vault", agentKey: "agent-a", ageDays: 8, sensitivityLabel: "restricted" });
    await seedObservation({ companyId, bindingId, content: "secret credential rotation drift on prod vault again", agentKey: "agent-b", ageDays: 5, sensitivityLabel: "restricted" });

    // A recurring pattern whose synthesis was previously rejected.
    await seedObservation({ companyId, bindingId, content: "database connection pool exhausted during nightly batch import", agentKey: "agent-a", ageDays: 8 });
    await seedObservation({ companyId, bindingId, content: "database connection pool exhausted again during nightly batch import", agentKey: "agent-b", ageDays: 4 });
    await seedObservation({
      companyId,
      bindingId,
      content: "Consolidated observation: database connection pool exhausted during nightly batch import",
      agentKey: "agent-x",
      ageDays: 2,
      reviewState: "rejected",
      metadata: { category: "synthesis", generated_by: "memory.synthesis" },
    });

    const result = await svc.startSynthesisJob(
      companyId,
      { bindingId, lookbackDays: 14, similarityThreshold: 0.4, minSupport: 2, minDistinctAgents: 2, minObservationAgeDays: 3 },
      actor,
      { runInline: true },
    );

    expect(result.summary.skipped.maxSensitivity).toBe(2);
    expect(result.summary.skipped.recentlyRejected).toBe(1);
    expect(result.summary.candidateCount).toBe(0);
    expect(result.candidateRecordIds).toHaveLength(0);
  });

  it("does not re-synthesize an already-synthesized pattern", async () => {
    const { companyId, bindingId } = await seedCompanyWithBinding();
    const svc = memoryService(db);
    await seedObservation({ companyId, bindingId, content: "webhook retries exceed limit when downstream service flaps", agentKey: "agent-a", ageDays: 8 });
    await seedObservation({ companyId, bindingId, content: "webhook retries exceeded limit again while downstream service flapped", agentKey: "agent-b", ageDays: 4 });

    const request = { bindingId, lookbackDays: 14, similarityThreshold: 0.4, minSupport: 2, minDistinctAgents: 2, minObservationAgeDays: 3 };
    const first = await svc.startSynthesisJob(companyId, request, actor, { runInline: true });
    expect(first.candidateRecordIds).toHaveLength(1);

    const second = await svc.startSynthesisJob(companyId, request, actor, { runInline: true });
    expect(second.candidateRecordIds).toHaveLength(0);
    expect(second.summary.candidateCount).toBe(0);
  });
});
