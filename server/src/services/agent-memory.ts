import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories } from "@paperclipai/db";
import { notFound } from "../errors.js";
import type { Embedder } from "./agent-memory-embeddings.js";

export interface AgentMemoryRecord {
  id: string;
  agentId: string;
  companyId: string;
  namespace: string;
  content: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface AgentMemorySearchResult extends AgentMemoryRecord {
  score: number;
}

type AgentMemoryRow = typeof agentMemories.$inferSelect;

function toRecord(row: AgentMemoryRow): AgentMemoryRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    companyId: row.companyId,
    namespace: row.namespace,
    content: row.content,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Cosine similarity over plain float arrays. There is no pgvector index
 * behind this (see the 0107 migration and packages/db/src/schema/agent_memories.ts
 * for why) so ranking happens in application code after a scoped fetch —
 * fine at MVP scale (an agent's memories in the hundreds to low thousands),
 * not something that will scale to millions of rows without a real vector
 * index as a follow-up.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * `getEmbedder` is resolved lazily (called inside store/search, not up
 * front) so a server without OPENAI_API_KEY configured still boots — only
 * requests that actually hit this store fail, not every process on the box.
 */
export function agentMemoryService(db: Db, getEmbedder: () => Embedder) {
  async function store(params: {
    agentId: string;
    companyId: string;
    namespace: string;
    content: string;
    expiresAt?: Date | null;
  }): Promise<AgentMemoryRecord> {
    const embedding = await getEmbedder().embed(params.content);
    const [row] = await db
      .insert(agentMemories)
      .values({
        id: randomUUID(),
        agentId: params.agentId,
        companyId: params.companyId,
        namespace: params.namespace,
        content: params.content,
        embedding,
        expiresAt: params.expiresAt ?? null,
      })
      .returning();
    return toRecord(row);
  }

  async function search(params: {
    agentId: string;
    companyId: string;
    namespace?: string;
    query: string;
    limit: number;
  }): Promise<AgentMemorySearchResult[]> {
    const queryEmbedding = await getEmbedder().embed(params.query);
    const now = new Date();
    const conditions = [
      eq(agentMemories.agentId, params.agentId),
      eq(agentMemories.companyId, params.companyId),
      or(isNull(agentMemories.expiresAt), gt(agentMemories.expiresAt, now)),
    ];
    if (params.namespace) {
      conditions.push(eq(agentMemories.namespace, params.namespace));
    }

    const rows = await db
      .select()
      .from(agentMemories)
      .where(and(...conditions));

    return rows
      .map((row) => ({ ...toRecord(row), score: cosineSimilarity(queryEmbedding, row.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit);
  }

  async function forget(params: { id: string; agentId: string; companyId: string }): Promise<void> {
    const deleted = await db
      .delete(agentMemories)
      .where(
        and(
          eq(agentMemories.id, params.id),
          eq(agentMemories.agentId, params.agentId),
          eq(agentMemories.companyId, params.companyId),
        ),
      )
      .returning({ id: agentMemories.id });
    if (deleted.length === 0) {
      throw notFound("Memory not found");
    }
  }

  return { store, search, forget };
}

export type AgentMemoryService = ReturnType<typeof agentMemoryService>;
