import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  resetEmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentMemoryService, cosineSimilarity } from "../services/agent-memory.ts";
import type { Embedder } from "../services/agent-memory-embeddings.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-memory tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Deterministic fake embedder: maps each distinct input string to a fixed
 * 3-dimensional vector so cosine similarity is predictable in assertions.
 * Never calls the network — real OpenAI calls are exercised only by
 * server/src/services/agent-memory-embeddings.ts, which this suite does not
 * import a live key for.
 */
function fakeEmbedder(vectors: Record<string, number[]>): Embedder {
  return {
    async embed(text: string) {
      const vector = vectors[text];
      if (!vector) throw new Error(`fakeEmbedder: no fixture vector for "${text}"`);
      return vector;
    },
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for mismatched lengths or zero vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describeEmbeddedPostgres("agentMemoryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MemoryTester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("stores a memory and finds it back by semantically-similar search, ranked over a dissimilar one", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const embedder = fakeEmbedder({
      "the deploy pipeline uses drizzle-kit for migrations": [1, 0, 0],
      "the cafeteria menu changes on fridays": [0, 1, 0],
      "how are database migrations run in this repo?": [0.9, 0.1, 0],
    });
    const svc = agentMemoryService(db, () => embedder);

    await svc.store({
      agentId,
      companyId,
      namespace: "default",
      content: "the deploy pipeline uses drizzle-kit for migrations",
    });
    await svc.store({
      agentId,
      companyId,
      namespace: "default",
      content: "the cafeteria menu changes on fridays",
    });

    const results = await svc.search({
      agentId,
      companyId,
      query: "how are database migrations run in this repo?",
      limit: 10,
    });

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("the deploy pipeline uses drizzle-kit for migrations");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("scopes search to the requesting agent, company, and namespace", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { companyId: otherCompanyId, agentId: otherAgentId } = await seedCompanyAndAgent();
    const embedder = fakeEmbedder({
      "mine": [1, 0],
      "other agent's": [1, 0],
      "other namespace": [1, 0],
      "query": [1, 0],
    });
    const svc = agentMemoryService(db, () => embedder);

    await svc.store({ agentId, companyId, namespace: "default", content: "mine" });
    await svc.store({ agentId: otherAgentId, companyId: otherCompanyId, namespace: "default", content: "other agent's" });
    await svc.store({ agentId, companyId, namespace: "scratch", content: "other namespace" });

    const results = await svc.search({ agentId, companyId, namespace: "default", query: "query", limit: 10 });
    expect(results.map((r) => r.content)).toEqual(["mine"]);
  });

  it("excludes expired memories from search", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const embedder = fakeEmbedder({ "stale note": [1, 0], "query": [1, 0] });
    const svc = agentMemoryService(db, () => embedder);

    await svc.store({
      agentId,
      companyId,
      namespace: "default",
      content: "stale note",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const results = await svc.search({ agentId, companyId, query: "query", limit: 10 });
    expect(results).toHaveLength(0);
  });

  it("forget deletes the memory and is scoped to the owning agent+company", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { companyId: otherCompanyId, agentId: otherAgentId } = await seedCompanyAndAgent();
    const embedder = fakeEmbedder({ "to delete": [1, 0] });
    const svc = agentMemoryService(db, () => embedder);

    const record = await svc.store({ agentId, companyId, namespace: "default", content: "to delete" });

    await expect(
      svc.forget({ id: record.id, agentId: otherAgentId, companyId: otherCompanyId }),
    ).rejects.toThrow(HttpError);

    await svc.forget({ id: record.id, agentId, companyId });

    await expect(svc.forget({ id: record.id, agentId, companyId })).rejects.toThrow(HttpError);
  });
});
