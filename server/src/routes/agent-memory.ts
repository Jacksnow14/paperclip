/**
 * AUR-5952: agent memory store MVP — POST /v1/memory, GET /v1/memory/search,
 * DELETE /v1/memory/:id. Mounted directly on the app (like llmRoutes), not
 * nested under /api — this is meant to be a versioned, SDK-facing surface
 * (see packages/memory-sdk) rather than an internal control-plane route.
 *
 * Auth: the platform's existing per-agent API key (agentApiKeys, checked by
 * the global actorMiddleware) — no new key type. "Namespace" is a caller-
 * supplied partition string within the calling agent's own memories, not a
 * separate credential.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentMemorySearchQuerySchema, agentMemoryStoreSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { agentMemoryService } from "../services/agent-memory.js";
import { resolveDefaultEmbedder } from "../services/agent-memory-embeddings.js";
import type { Embedder } from "../services/agent-memory-embeddings.js";

export function agentMemoryRoutes(db: Db, opts?: { embedder?: Embedder }) {
  const router = Router();
  const memory = agentMemoryService(db, () => opts?.embedder ?? resolveDefaultEmbedder());

  function requireAgentActor(req: import("express").Request) {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Agent API key required");
    }
    return { agentId: req.actor.agentId, companyId: req.actor.companyId };
  }

  router.post("/v1/memory", async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    const input = agentMemoryStoreSchema.parse(req.body);
    const record = await memory.store({
      agentId,
      companyId,
      namespace: input.namespace,
      content: input.content,
      expiresAt: input.expiresAt ?? null,
    });
    res.status(201).json({ memory: record });
  });

  router.get("/v1/memory/search", async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    const input = agentMemorySearchQuerySchema.parse(req.query);
    const results = await memory.search({
      agentId,
      companyId,
      namespace: input.namespace,
      query: input.q,
      limit: input.limit,
    });
    res.status(200).json({ results });
  });

  router.delete("/v1/memory/:id", async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    const id = req.params.id;
    if (!id) {
      throw badRequest("Missing memory id");
    }
    await memory.forget({ id, agentId, companyId });
    res.status(204).end();
  });

  return router;
}
