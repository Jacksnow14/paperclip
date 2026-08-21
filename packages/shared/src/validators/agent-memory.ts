import { z } from "zod";

/**
 * AUR-5952: agent memory MVP validators. Deliberately separate from
 * validators/memory.ts (the existing control-plane note/lesson memory
 * system) — this is a distinct pgvector-style store keyed by
 * agentId+namespace with embeddings, not manual notes with categories.
 */
export const agentMemoryStoreSchema = z
  .object({
    namespace: z.string().trim().min(1).max(200).optional().default("default"),
    content: z.string().trim().min(1).max(20000),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

export const agentMemorySearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(2000),
    namespace: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(100).optional().default(10),
  })
  .strict();

export type AgentMemoryStoreInput = z.infer<typeof agentMemoryStoreSchema>;
export type AgentMemorySearchQueryInput = z.infer<typeof agentMemorySearchQuerySchema>;
