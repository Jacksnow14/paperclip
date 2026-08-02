/**
 * Memory API — pagination, agent self-service revoke, and capture visibility warnings.
 *
 * Pagination (GET /memory/records):
 *   Use ?limit=200&offset=0 then ?limit=200&offset=200 to page through large result sets.
 *   Use ?count=only with the same filters to get the total count for determining page boundaries.
 *
 * Agent self-service revoke (POST /memory/records/:id/revoke-own):
 *   Agents may revoke their own records when the record's metadata.category is in
 *   AGENT_MUTABLE_CATEGORIES (experiment, experiment_conclusion, hypothesis, observation,
 *   performance_scorecard, scorecard_adjusted, tool_gap, routing, routing_rationale, synthesis,
 *   lesson).
 *   Returns 403 for non-owner or off-allowlist categories.
 *   `synthesis` is agent-mutable (AUR-3072) so SGI loops that author synthesis records
 *   (Loop E nightly, Loop H quarterly) can PATCH-upsert / revoke-own their own duplicates.
 *   `lesson` is agent-mutable (AUR-3865) so agents can correct or retract their own
 *   distilled retrospective lessons instead of leaving a wrong lesson live forever.
 *
 * Capture visibility warnings (POST /memory/capture):
 *   The response includes a non-breaking `warnings: string[]` field when the captured
 *   record(s) won't appear in the default GET /memory/records or memory/query response
 *   (e.g. reviewState=pending, project-scoped, or agent-scoped to a different agent).
 *
 * Scorecard integrity guard (POST /memory/capture, AUR-3993/AUR-3996):
 *   A capture with metadata.category `performance_scorecard` or `scorecard_adjusted` is
 *   rejected with 422 unless metadata.issue_id/quality_signal/token_cost/agent_id/task_type
 *   are all present, metadata.issue_id resolves to a real issue in this company, and
 *   metadata.test_data is not `true`. All violations are returned together in
 *   `details.errors[]`. `outcome` and `value_signal` stay optional.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  memoryAgentUpdateSchema,
  memoryCaptureSchema,
  memoryCorrectSchema,
  memoryForgetSchema,
  memoryPromoteSchema,
  memoryListExtractionJobsQuerySchema,
  memoryListOperationsQuerySchema,
  memoryListRecordsQuerySchema,
  memoryQuerySchema,
  memoryRefreshJobSchema,
  memoryRetentionSweepSchema,
  memoryReviewSchema,
  memoryRevokeSchema,
  memoryRevokeOwnSchema,
  setAgentMemoryBindingSchema,
  setCompanyMemoryBindingSchema,
  setProjectMemoryBindingSchema,
  updateMemoryBindingSchema,
  createMemoryBindingSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { agentService, issueService, logActivity, memoryService, projectService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Categories consumed by org-wide `titlePrefix` sweeps (routing-rationale
 * watchdog, performance/scorecard-adjusted routing queries — see AGENTS.md
 * "Before Closing Any Issue"). A record in one of these categories captured
 * with a project scope is invisible to those sweeps, which never pass
 * `?projectId=`, so the record silently fails to satisfy its consumer
 * (AUR-3849 for routing_rationale; generalized to all three by AUR-3925,
 * which found 241 pre-existing violations). Project affiliation belongs in
 * `metadata.project_id` instead — a plain field the org-wide query still
 * returns.
 */
export const ROUTER_READ_ONLY_ORG_SCOPE_CATEGORIES = new Set([
  "routing_rationale",
  "performance_scorecard",
  "scorecard_adjusted",
]);

/**
 * Returns a rejection message if `payload` would capture a router-read
 * category record with a project scope, or null if the capture is fine.
 * Checked against both the nested `scope.projectId` shorthand and the
 * top-level `scopeType`/`scopeId` pair the capture schema also accepts.
 */
export function checkRouterReadScopeViolation(payload: {
  metadata?: Record<string, unknown>;
  scope?: { projectId?: string | null };
  scopeType?: string | null;
}): string | null {
  const category = payload.metadata?.category;
  if (typeof category !== "string" || !ROUTER_READ_ONLY_ORG_SCOPE_CATEGORIES.has(category)) return null;
  const isProjectScoped = Boolean(payload.scope?.projectId) || payload.scopeType === "project";
  if (!isProjectScoped) return null;
  return (
    `metadata.category '${category}' is a router-read class queried org-wide by titlePrefix sweeps ` +
    "(routing-rationale watchdog, performance/scorecard-adjusted routing queries) that never pass " +
    "?projectId=, so a project-scoped record is invisible to them (AUR-3849, AUR-3925). " +
    "Omit scope.projectId / scopeType and put the project id in metadata.project_id instead."
  );
}

/**
 * Categories subject to the scorecard integrity guard (AUR-3993 found 218
 * synthetic performance_scorecard/scorecard_adjusted records polluting the
 * routing registry's quartile math; AUR-3996 closes the write path that let
 * them in). A capture in one of these categories must carry the fields the
 * router groups and scores on, and must resolve to a real issue — otherwise
 * it is unusable by construction and should never have been written.
 */
export const SCORECARD_INTEGRITY_CATEGORIES = new Set(["performance_scorecard", "scorecard_adjusted"]);

/**
 * `outcome` and `value_signal` are deliberately NOT required here: a sweep of
 * the live registry (AUR-3993 thread, CTO, 2026-07-25) found `outcome` absent
 * on 1,872 of 3,896 scorecards — 48% of the entire registry — so requiring it
 * would 422 roughly every other honest capture. `issue_id` is checked
 * separately below because it also needs DB-backed resolution, not just
 * presence.
 */
const SCORECARD_REQUIRED_METADATA_FIELDS = ["issue_id", "quality_signal", "token_cost", "agent_id", "task_type"] as const;

function isBlankMetadataValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

/**
 * Synchronous half of the scorecard integrity guard: checks the metadata
 * fields the router groups/scores on are present, that `issue_id` is a
 * string (so the caller-facing message can tell them to fix it before the
 * DB-backed resolution check runs), and rejects a capture self-declared as
 * test data (AUR-3993 thread: 46 live fixtures self-declared
 * `metadata.test_data: true`, all traced to the same synthetic burst this
 * guard exists to stop recurring). Returns an empty array when
 * `metadata.category` isn't a scorecard category, or when every check passes.
 */
export function checkScorecardMetadataViolations(metadata: Record<string, unknown> | undefined): string[] {
  const category = metadata?.category;
  if (typeof category !== "string" || !SCORECARD_INTEGRITY_CATEGORIES.has(category)) return [];

  const errors: string[] = [];
  for (const field of SCORECARD_REQUIRED_METADATA_FIELDS) {
    const value = metadata?.[field];
    if (isBlankMetadataValue(value)) {
      errors.push(
        `metadata.${field} is required for category '${category}' — the router groups and scores on it.`,
      );
    } else if (field === "issue_id" && typeof value !== "string") {
      errors.push("metadata.issue_id must be a string identifier (AUR-NNNN or UUID)");
    }
  }
  if (metadata?.test_data === true) {
    errors.push(
      `metadata.test_data: true is not permitted on a '${category}' capture; use a scoped test company, not production.`,
    );
  }
  return errors;
}

function actorInfoFromReq(req: any) {
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

export function memoryRoutes(
  db: Db,
  opts?: {
    pluginMemoryProviders?: import("../services/plugin-memory-provider-dispatcher.js").PluginMemoryProviderDispatcher;
  },
) {
  const router = Router();
  const memory = memoryService(db, {
    pluginMemoryProviders: opts?.pluginMemoryProviders,
  });
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const issuesSvc = issueService(db);

  /**
   * Resolves an `AUR-NNNN` identifier or a UUID to a real issue id in this
   * company. Always DB-backed: a UUID-shaped string is never trusted on
   * shape alone (CTO review, AUR-3996) — `issuesSvc.getById` looks it up by
   * primary key the same way it looks up an identifier, so a fabricated
   * UUID with no matching row is rejected just like a fabricated `AUR-NNNN`.
   *
   * Falls back to the issue_tombstones table (AUR-4091) when the identifier
   * doesn't resolve to a live issue: a hard-deleted issue leaves a tombstone
   * behind, so a capture referencing "this issue existed when the work
   * happened and was deleted afterwards" still resolves, while a fabricated
   * identifier that never existed still returns null.
   */
  async function resolveSourceIssueId(companyId: string, issueId: string): Promise<string | null> {
    const trimmed = issueId.trim();
    if (!trimmed) return null;
    const issue = await issuesSvc.getById(trimmed);
    if (issue) return issue.companyId === companyId ? issue.id : null;
    const tombstone = await issuesSvc.getTombstoneByIdentifierOrUuid(companyId, trimmed);
    return tombstone ? tombstone.issueId : null;
  }

  router.get("/companies/:companyId/memory/providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.providers());
  });

  router.get("/companies/:companyId/memory/bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.listBindings(companyId));
  });

  router.get("/companies/:companyId/memory/targets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.listTargets(companyId));
  });

  router.post("/companies/:companyId/memory/bindings", validate(createMemoryBindingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const binding = await memory.createBinding(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.binding_created",
      entityType: "memory_binding",
      entityId: binding.id,
      details: {
        key: binding.key,
        providerKey: binding.providerKey,
        enabled: binding.enabled,
        configKeys: Object.keys(binding.config ?? {}).sort(),
      },
    });
    res.status(201).json(binding);
  });

  router.patch("/memory/bindings/:bindingId", validate(updateMemoryBindingSchema), async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await memory.getBindingById(bindingId);
    if (!existing) throw notFound("Memory binding not found");
    assertCompanyAccess(req, existing.companyId);
    const binding = await memory.updateBinding(bindingId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.binding_updated",
      entityType: "memory_binding",
      entityId: binding.id,
      details: {
        changedKeys: Object.keys(req.body as Record<string, unknown>).sort(),
        enabled: binding.enabled,
        configKeys: Object.keys(binding.config ?? {}).sort(),
      },
    });
    res.json(binding);
  });

  router.put("/companies/:companyId/memory/default-binding", validate(setCompanyMemoryBindingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const target = await memory.setCompanyDefault(companyId, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.default_set",
      entityType: "memory_binding",
      entityId: target.bindingId,
      details: {
        targetType: target.targetType,
        targetId: target.targetId,
      },
    });
    res.json(target);
  });

  router.get("/agents/:agentId/memory-binding", async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agentsSvc.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    res.json(await memory.resolveBinding(agent.companyId, { agentId: agent.id }));
  });

  router.put("/agents/:agentId/memory-binding", validate(setAgentMemoryBindingSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agentsSvc.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);
    const target = await memory.setAgentOverride(agent.id, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: target ? "memory.agent_override_set" : "memory.agent_override_cleared",
      entityType: "agent",
      entityId: agent.id,
      details: {
        bindingId: target?.bindingId ?? null,
      },
    });
    res.json(target);
  });

  router.get("/projects/:projectId/memory-binding", async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await projectsSvc.getById(projectId);
    if (!project) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    res.json(await memory.resolveBinding(project.companyId, { projectId: project.id }));
  });

  router.put("/projects/:projectId/memory-binding", validate(setProjectMemoryBindingSchema), async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await projectsSvc.getById(projectId);
    if (!project) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    assertBoard(req);
    const target = await memory.setProjectOverride(project.id, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: target ? "memory.project_override_set" : "memory.project_override_cleared",
      entityType: "project",
      entityId: project.id,
      details: {
        bindingId: target?.bindingId ?? null,
      },
    });
    res.json(target);
  });

  router.post("/companies/:companyId/memory/query", validate(memoryQuerySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const payload = req.body;
    if (req.actor.type === "agent" && payload.scope?.agentId && payload.scope.agentId !== req.actor.agentId) {
      throw forbidden("Agent cannot query memory for another agent scope");
    }
    res.json(await memory.query(companyId, payload, actorInfoFromReq(req)));
  });

  router.post("/companies/:companyId/memory/capture", validate(memoryCaptureSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const payload = req.body;
    if (req.actor.type === "agent" && payload.scope?.agentId && payload.scope.agentId !== req.actor.agentId) {
      throw forbidden("Agent cannot capture memory for another agent scope");
    }
    const routerReadScopeViolation = checkRouterReadScopeViolation(payload);
    if (routerReadScopeViolation) {
      throw unprocessable(routerReadScopeViolation);
    }
    const scorecardErrors = checkScorecardMetadataViolations(payload.metadata);
    const scorecardIssueId = payload.metadata?.issue_id;
    if (
      typeof payload.metadata?.category === "string" &&
      SCORECARD_INTEGRITY_CATEGORIES.has(payload.metadata.category) &&
      typeof scorecardIssueId === "string" &&
      scorecardIssueId.trim().length > 0
    ) {
      const resolved = await resolveSourceIssueId(companyId, scorecardIssueId);
      if (!resolved) {
        scorecardErrors.push(
          `metadata.issue_id '${scorecardIssueId}' does not resolve to a real issue in this company; ` +
          "use a scoped test company, not production.",
        );
      }
    }
    if (scorecardErrors.length > 0) {
      throw unprocessable(
        `Invalid '${payload.metadata?.category}' capture: ${scorecardErrors.length} validation error(s)`,
        { errors: scorecardErrors },
      );
    }
    if (payload.source?.issueId) {
      const resolvedId = await resolveSourceIssueId(companyId, payload.source.issueId);
      if (!resolvedId) {
        throw unprocessable(
          `source.issueId '${payload.source.issueId}' could not be resolved to an issue in this company`,
        );
      }
      payload.source = { ...payload.source, issueId: resolvedId };
    }
    const result = await memory.capture(companyId, payload, actorInfoFromReq(req));
    const warnings: string[] = [];
    const firstRecord = result.records[0];
    if (firstRecord) {
      if (firstRecord.reviewState === "pending") {
        warnings.push(
          "Record is pending review; it won't appear in the default GET /memory/records or memory/query response. " +
          "Read it back with ?reviewState=pending.",
        );
      }
      if (firstRecord.scopeType === "project") {
        warnings.push(
          `Record is project-scoped (projectId=${firstRecord.scope.projectId ?? "unknown"}); ` +
          "invisible to org-wide reads without ?projectId=<id>.",
        );
      }
      if (
        req.actor.type === "agent" &&
        firstRecord.scopeType === "agent" &&
        firstRecord.scope.agentId &&
        firstRecord.scope.agentId !== req.actor.agentId
      ) {
        warnings.push(
          `Record is agent-scoped to ${firstRecord.scope.agentId}, not the calling agent; ` +
          "it won't appear in default agent-scoped reads for this caller.",
        );
      }
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.captured",
      entityType: "memory_operation",
      entityId: result.operation.id,
      details: {
        bindingId: result.operation.bindingId,
        recordIds: result.records.map((record) => record.id),
        sourceKind: result.operation.source?.kind ?? null,
      },
    });
    res.status(201).json({ ...result, warnings });
  });

  router.post("/companies/:companyId/memory/forget", validate(memoryForgetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.forget(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.forgotten",
      entityType: "memory_operation",
      entityId: result.operation.id,
      details: {
        forgottenRecordIds: result.forgottenRecordIds,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/records", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = memoryListRecordsQuerySchema.parse(req.query);
    if (parsed.count === "only") {
      res.json(await memory.countRecords(companyId, parsed, actorInfoFromReq(req)));
      return;
    }
    res.json(await memory.listRecords(companyId, parsed, actorInfoFromReq(req)));
  });

  router.get("/companies/:companyId/memory/records/:recordId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const record = await memory.getRecord(companyId, req.params.recordId as string, actorInfoFromReq(req));
    if (!record) throw notFound("Memory record not found");
    res.json(record);
  });

  // Categories that agents are permitted to update (PATCH) or revoke-own on their own records.
  // "routing_rationale" is included so agents can deduplicate stale routing/* records via
  // revoke-own — every routing/* record is captured with metadata.category = "routing_rationale"
  // (see AUTO_ACCEPT_CATEGORIES in services/memory.ts and backfill-router-read-scope.mjs). The
  // plain "routing" entry is kept for back-compat in case any legacy record used that string.
  const AGENT_MUTABLE_CATEGORIES = new Set([
    "experiment",
    "experiment_conclusion",
    "hypothesis",
    "observation",
    "performance_scorecard",
    "scorecard_adjusted",
    "tool_gap",
    "routing",
    "routing_rationale",
    // synthesis: agent-authored + auto-accepted; owning SGI loops must be able to
    // PATCH-upsert / revoke-own their own duplicate synthesis records (AUR-3072).
    "synthesis",
    // lesson: agent-authored retrospective lessons; owning agents must be able to
    // correct or retract their own lessons rather than leaving a wrong one live
    // forever for every agent to read (AUR-3865).
    "lesson",
  ]);

  router.patch(
    "/companies/:companyId/memory/records/:recordId",
    validate(memoryAgentUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const recordId = req.params.recordId as string;
      const record = await memory.getRecord(companyId, recordId, actorInfoFromReq(req));
      if (!record) throw notFound("Memory record not found");

      if (req.actor.type === "agent") {
        // Agents may only update records they own.
        if (record.owner?.type !== "agent" || record.owner.id !== req.actor.agentId) {
          throw forbidden("Agent can only update memory records it owns");
        }
        // Restrict to allowlisted categories to prevent arbitrary record mutation.
        const category = typeof record.metadata?.category === "string" ? record.metadata.category : null;
        if (!category || !AGENT_MUTABLE_CATEGORIES.has(category)) {
          throw forbidden(
            `Category '${category ?? "(none)"}' is immutable — agents cannot PATCH records in this category. ` +
              `Supported alternative: capture a new record via POST /memory/capture instead of editing this one. ` +
              `Agent-mutable categories: ${[...AGENT_MUTABLE_CATEGORIES].join(", ")}.`,
            {
              category: category ?? null,
              immutable: true,
              supportedAlternative: "capture_new_record",
              agentMutableCategories: [...AGENT_MUTABLE_CATEGORIES],
            },
          );
        }
      } else {
        // Board users have unrestricted update access (they can already use /correct).
        assertBoard(req);
      }

      const result = await memory.agentUpdate(companyId, recordId, req.body, actorInfoFromReq(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.updated",
        entityType: "memory_record",
        entityId: result.record.id,
        details: {
          recordId: result.record.id,
          updatedFields: Object.keys(req.body as Record<string, unknown>),
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/memory/records/:recordId/revoke-own",
    validate(memoryRevokeOwnSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      if (req.actor.type !== "agent") {
        throw forbidden("Only agents can use revoke-own; board users should use POST /memory/revoke");
      }

      const recordId = req.params.recordId as string;
      const record = await memory.getRecord(companyId, recordId, actorInfoFromReq(req));
      if (!record) throw notFound("Memory record not found");

      if (record.owner?.type !== "agent" || record.owner.id !== req.actor.agentId) {
        throw forbidden("Agent can only revoke memory records it owns");
      }

      const category = typeof record.metadata?.category === "string" ? record.metadata.category : null;
      if (!category || !AGENT_MUTABLE_CATEGORIES.has(category)) {
        throw forbidden(
          `Category '${category ?? "(none)"}' is immutable — agents cannot revoke records in this category. ` +
            `Supported alternative: capture a new record via POST /memory/capture instead; ask a board user to ` +
            `use POST /memory/revoke if this record must be removed. ` +
            `Agent-mutable categories: ${[...AGENT_MUTABLE_CATEGORIES].join(", ")}.`,
          {
            category: category ?? null,
            immutable: true,
            supportedAlternative: "capture_new_record",
            agentMutableCategories: [...AGENT_MUTABLE_CATEGORIES],
          },
        );
      }

      const { reason } = req.body as { reason: string };
      const result = await memory.revoke(
        companyId,
        { selector: { recordIds: [recordId] }, reason },
        actorInfoFromReq(req),
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.revoked",
        entityType: "memory_record",
        entityId: recordId,
        details: {
          revokedRecordIds: result.revokedRecordIds,
          reason,
          selfService: true,
        },
      });
      res.json(result);
    },
  );

  router.post("/companies/:companyId/memory/revoke", validate(memoryRevokeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const payload = req.body;
    if (payload.selector?.source?.issueId) {
      const resolvedId = await resolveSourceIssueId(companyId, payload.selector.source.issueId);
      if (!resolvedId) {
        throw unprocessable(
          `selector.source.issueId '${payload.selector.source.issueId}' could not be resolved to an issue in this company`,
        );
      }
      payload.selector = { ...payload.selector, source: { ...payload.selector.source, issueId: resolvedId } };
    }
    const result = await memory.revoke(companyId, payload, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.revoked",
      entityType: "memory_record",
      entityId: result.revokedRecordIds[0] ?? "none",
      details: {
        revokedRecordIds: result.revokedRecordIds,
        selector: req.body.selector,
        reason: req.body.reason,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/memory/records/:recordId/correct", validate(memoryCorrectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.correct(companyId, req.params.recordId as string, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.corrected",
      entityType: "memory_record",
      entityId: result.correctedRecord.id,
      details: {
        originalRecordId: result.originalRecord.id,
        correctedRecordId: result.correctedRecord.id,
        reason: req.body.reason,
      },
    });
    res.status(201).json(result);
  });

  router.post(
    "/companies/:companyId/memory/records/:recordId/promote",
    validate(memoryPromoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const result = await memory.promote(
        companyId,
        req.params.recordId as string,
        req.body,
        actorInfoFromReq(req),
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.promoted",
        entityType: "memory_record",
        entityId: result.promotedRecord.id,
        details: {
          originalRecordId: result.originalRecord.id,
          promotedRecordId: result.promotedRecord.id,
          fromScope: {
            scopeType: result.originalRecord.scope.scopeType,
            scopeId: result.originalRecord.scope.scopeId,
          },
          toScope: {
            scopeType: result.promotedRecord.scope.scopeType,
            scopeId: result.promotedRecord.scope.scopeId,
          },
          reason: req.body.reason,
        },
      });
      res.status(201).json(result);
    },
  );

  router.patch("/companies/:companyId/memory/records/:recordId/review", validate(memoryReviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.review(companyId, req.params.recordId as string, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.reviewed",
      entityType: "memory_record",
      entityId: result.record.id,
      details: {
        recordId: result.record.id,
        reviewState: result.record.reviewState,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/memory/retention/sweep", validate(memoryRetentionSweepSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await memory.sweepRetention(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.retention_swept",
      entityType: "memory_record",
      entityId: result.expiredRecordIds[0] ?? "none",
      details: {
        expiredRecordIds: result.expiredRecordIds,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = memoryListOperationsQuerySchema.parse(req.query);
    res.json(await memory.listOperations(companyId, parsed));
  });

  router.get("/companies/:companyId/memory/extraction-jobs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = memoryListExtractionJobsQuerySchema.parse(req.query);
    res.json(await memory.listExtractionJobs(companyId, parsed));
  });

  router.post("/companies/:companyId/memory/refresh-jobs", validate(memoryRefreshJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.startRefreshJob(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.refresh_job_started",
      entityType: "background_job_run",
      entityId: result.run.id,
      details: {
        jobId: result.job.id,
        dryRun: result.dryRun,
        sourceCounts: result.sourceCounts,
      },
    });
    res.status(202).json(result);
  });

  return router;
}
