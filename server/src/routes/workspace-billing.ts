import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { memoryListRecordsQuerySchema } from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";
import { badGateway } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { memoryService } from "../services/index.js";
import { getWorkspaceBillingSummary, type WorkspaceBillingSummary } from "../services/workspace-billing.js";

const CACHE_TITLE_PREFIX = "workspace-billing/";
const CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function cacheTitleForToday(): string {
  return `${CACHE_TITLE_PREFIX}${new Date().toISOString().slice(0, 10)}`;
}

function isJsonRecord(value: unknown): value is WorkspaceBillingSummary {
  return typeof value === "object" && value !== null;
}

// memoryService's ActorInfo requires userId on every branch, unlike authz's
// getActorInfo — mirrors the local actorInfoFromReq() in routes/memory.ts.
function actorInfoFromReq(req: Request) {
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      userId: null,
      runId: req.actor.runId ?? null,
    };
  }
  return {
    actorType: req.actor.type === "board" ? ("user" as const) : ("system" as const),
    actorId: req.actor.type === "board" ? (req.actor.userId ?? "board") : "system",
    agentId: null,
    userId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    runId: req.actor.runId ?? null,
  };
}

export function workspaceBillingRoutes(db: Db) {
  const router = Router();
  const memory = memoryService(db);

  router.get("/companies/:companyId/workspace/billing-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = actorInfoFromReq(req);

    const cached = await memory
      .listRecords(
        companyId,
        memoryListRecordsQuerySchema.parse({ titlePrefix: CACHE_TITLE_PREFIX, limit: 1 }),
        actor,
      )
      .catch(() => []);
    const fresh = cached.find(
      (record) => record.createdAt && Date.now() - record.createdAt.getTime() < CACHE_FRESHNESS_MS,
    );
    if (fresh) {
      try {
        const parsed = JSON.parse(fresh.content);
        if (isJsonRecord(parsed)) {
          res.json(parsed);
          return;
        }
      } catch {
        // fall through to a live fetch below
      }
    }

    let summary: WorkspaceBillingSummary;
    try {
      summary = await getWorkspaceBillingSummary();
    } catch (err) {
      logger.error({ err, companyId }, "workspace-billing: failed to fetch summary from Google Workspace");
      throw badGateway("Failed to fetch Workspace billing summary from Google", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    res.json(summary);

    memory
      .capture(
        companyId,
        {
          scope: {},
          source: { kind: "manual_note" },
          title: cacheTitleForToday(),
          content: JSON.stringify(summary),
          metadata: { category: "workspace_billing" },
          upsert: true,
        },
        actor,
      )
      .catch((err) => {
        logger.warn({ err, companyId }, "workspace-billing: failed to cache summary");
      });
  });

  return router;
}
