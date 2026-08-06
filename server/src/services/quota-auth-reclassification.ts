import { and, desc, eq, gt, gte, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
  extractClaudeRetryNotBefore,
} from "@paperclipai/adapter-claude-local/server";
import { QUOTA_SIGNATURE_RE } from "./fleet-capacity.js";

/**
 * AUR-5038: the Claude CLI renders weekly-quota exhaustion as
 * `Not logged in · Please run /login` once it stops emitting the honest
 * `You've hit your weekly limit` wording. 1,326 zero-token runs between
 * 2026-08-02T09:59Z and 2026-08-05T11:33Z carried `claude_auth_required` for a
 * wall that then reset itself on the quota clock, with no credential action by
 * anyone — and AUR-4949 root-caused the same rows as per-agent credential state
 * and named the founder as unblock owner for a working credential.
 *
 * The error STRING is the thing that lied, so this classifier deliberately does
 * not read it. It re-derives the class from lane history, per the discriminator
 * in AUR-5038's acceptance criteria:
 *
 *   (a) zero/null usage tokens on this run AND a quota-wall run on the same
 *       lane (companyId + adapterType) with no Anthropic-credential success
 *       since ⇒ the wall is still standing; the auth text is the wall's
 *       dishonest rendering ⇒ reclassify as quota.
 *   (b) any Anthropic-credential success on the lane after the last quota-wall
 *       run ⇒ the credential proved itself post-wall ⇒ genuine auth failure;
 *       leave the classification alone.
 *
 * Two live-data refinements to that discriminator (validated against the
 * Aug 2–5 incident rows directly, 2026-08-06):
 *
 * - Lane grain is the CREDENTIAL, not the adapterType alone. Model-profile
 *   overrides run non-Anthropic models under `claude_local` (CMO ran
 *   `gpt-5.4-mini`, provider `openai`, and SUCCEEDED mid-wall at
 *   2026-08-02T13:00Z; its ChatGPT-worded quota failures also match the quota
 *   regex). Successes therefore count only with `usageJson.provider =
 *   'anthropic'`, and prose-matched anchors only with a claude-family
 *   errorCode. Without both guards the one openai success mid-incident would
 *   have flipped the whole window back to "genuine auth".
 * - Anchors must carry zero usage tokens themselves. `error` embeds the
 *   model's final message (`subtype=success: <prose>`), and this fleet
 *   discusses quota wording constantly — 79 failed runs in the trailing 30d
 *   match the quota regex but reached the model (tokens > 0). A real wall run
 *   never reaches the model, so zero tokens is what separates the wall from
 *   an agent quoting the wall's wording (same contamination class as
 *   AUR-4144/AUR-4557).
 */

export const CLAUDE_AUTH_REQUIRED_ERROR_CODE = "claude_auth_required";
export { CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE };

/**
 * How far back a quota-wall anchor can be. Matches the AUR-4679 park trust
 * horizon: the longest genuine reset cycle is weekly, plus a day of slack. In
 * the live incident the honest wording kept being emitted until seconds before
 * the first dishonest rendering, so the anchor is usually minutes-to-hours old,
 * but the wording can stop days before the wall clears (Aug 2 12:17Z was the
 * last honest row; the lies ran through Aug 5 11:33Z).
 */
export const QUOTA_WALL_ANCHOR_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

const ANTHROPIC_PROVIDER = "anthropic";

export interface UsageTokenCounts {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * True when the usage proves the run actually reached the model. A quota- or
 * auth-refused run dies upstream with all counts zero/null; any positive count
 * means this was a real model conversation and the wall rendering cannot apply.
 */
export function usageProvesModelWasReached(usage: UsageTokenCounts | null | undefined): boolean {
  if (!usage) return false;
  for (const value of [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

export interface QuotaWallAnchor {
  runId: string;
  createdAt: Date;
  /** Reset instant the anchor knows about, if any (structured metadata first, prose fallback). */
  resetAt: Date | null;
}

export interface ClaudeAuthQuotaLaneHistory {
  /**
   * Newest zero-usage quota-wall failure on the lane inside the lookback,
   * EXCLUDING reclassified rows (AUR-5064). A reclassified run persists
   * `claude_quota_exhausted` with zero usage, so letting it anchor later
   * reclassifications made the chain self-sustaining: the 8-day lookback could
   * never expire it, and a genuine credential expiry that started inside a wall
   * window was latched as quota permanently — parked, adapter-paused, never
   * escalated for credentials — because no success can occur to break the
   * chain. Anchors are therefore required to carry independent wall evidence
   * (no `resultJson.authRenderedQuotaWall` marker), so the chain expires
   * `QUOTA_WALL_ANCHOR_LOOKBACK_MS` after the last REAL wall row. Live data
   * shows real anchors are plentiful during any standing wall (5-hour
   * session-limit rows run thousands per day), so a genuine wall keeps its
   * chain alive without help from reclassified rows.
   */
  anchor: QuotaWallAnchor | null;
  /** Discriminator (b): an Anthropic-credential success after the anchor. */
  anthropicSuccessAfterAnchor: boolean;
}

export interface ClaudeAuthQuotaReclassification {
  errorCode: typeof CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE;
  errorFamily: "transient_upstream";
  /**
   * The anchor's reset instant when it is still in the future — this is what
   * lets the AUR-4144/AUR-4679 machinery park the retry at the reset instead of
   * burning the bounded ladder against a standing wall, and what arms the
   * AUR-4139 adapter-wide admission pause. Null when the anchor carried no
   * usable reset; the bounded 4-rung ladder then applies, same as any quota
   * failure without a reset hint.
   */
  retryNotBefore: Date | null;
  anchorRunId: string;
  anchorCreatedAt: Date;
}

/**
 * Pure decision, split from the DB gather so FIRE/CLEAR can be proven in unit
 * tests against the recorded incident shape (AUR-5038 AC: one test that fires
 * on the Aug 2–5 signature, one that clears on a genuine auth failure).
 */
export function decideClaudeAuthQuotaReclassification(input: {
  errorCode: string | null;
  usage: UsageTokenCounts | null;
  history: ClaudeAuthQuotaLaneHistory;
  now: Date;
}): ClaudeAuthQuotaReclassification | null {
  if (input.errorCode !== CLAUDE_AUTH_REQUIRED_ERROR_CODE) return null;
  if (usageProvesModelWasReached(input.usage)) return null;
  const anchor = input.history.anchor;
  if (!anchor) return null;
  if (input.history.anthropicSuccessAfterAnchor) return null;
  const retryNotBefore =
    anchor.resetAt && anchor.resetAt.getTime() > input.now.getTime() ? anchor.resetAt : null;
  return {
    errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
    errorFamily: "transient_upstream",
    retryNotBefore,
    anchorRunId: anchor.runId,
    anchorCreatedAt: anchor.createdAt,
  };
}

function readDateish(value: unknown): Date | null {
  if (!(typeof value === "string" || typeof value === "number" || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveAnchorResetAt(row: {
  error: string | null;
  resultJson: Record<string, unknown> | null;
  finishedAt: Date | null;
  createdAt: Date;
}): Date | null {
  const resultJson = row.resultJson ?? {};
  const quotaExhaustion = resultJson.quotaExhaustion;
  if (quotaExhaustion && typeof quotaExhaustion === "object" && !Array.isArray(quotaExhaustion)) {
    const structured = readDateish((quotaExhaustion as Record<string, unknown>).resetAt);
    if (structured) return structured;
  }
  const persisted =
    readDateish(resultJson.retryNotBefore) ?? readDateish(resultJson.transientRetryNotBefore);
  if (persisted) return persisted;
  // Legacy rows (pre-AUR-4144 deploy) carry the reset only inside the honest
  // prose ("resets Aug 5, 11am (UTC)"). Same read-only reuse of the adapter's
  // extractor as fleet-capacity.ts, anchored at the failure instant.
  if (!row.error) return null;
  return extractClaudeRetryNotBefore({ errorMessage: row.error }, row.finishedAt ?? row.createdAt);
}

/**
 * Gather the lane history the discriminator needs. Candidates are rare — the
 * caller only reaches this for failed runs already carrying
 * `claude_auth_required` with zero usage — but the anchor lookup fires exactly
 * when the fleet is degraded (686 times on Aug 2 vs ~2/day steady state), so it
 * must stay cheap under load. It scopes by `heartbeatRuns.companyId` (AUR-5064;
 * the original `agents.companyId` scoping made every heartbeat_runs index
 * unusable and planned as a 2-second scan of the 1.3 GB table) and is served by
 * the partial index `hb_runs_quota_anchor_idx`, whose predicate mirrors the
 * anchor conditions below — keep them in sync when either changes.
 */
export async function gatherClaudeAuthQuotaLaneHistory(
  db: Db,
  input: {
    companyId: string;
    adapterType: string;
    /** The run being classified — excluded defensively from its own history. */
    excludeRunId: string;
    now: Date;
  },
): Promise<ClaudeAuthQuotaLaneHistory> {
  const lookbackStart = new Date(input.now.getTime() - QUOTA_WALL_ANCHOR_LOOKBACK_MS);
  const zeroUsage = and(
    sql`coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::numeric, 0) = 0`,
    sql`coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::numeric, 0) = 0`,
  );
  // Quota-wall evidence, most trustworthy first: the dedicated errorCode
  // (AUR-4144), the structured metadata, then the honest prose — the prose
  // branch additionally requires a claude-family errorCode so model-profile
  // runs of OTHER providers on this adapterType (codex wording,
  // `codex_transient_upstream`) can never anchor an Anthropic wall.
  const quotaEvidence = sql`(
    ${heartbeatRuns.errorCode} = ${CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE}
    or ${heartbeatRuns.resultJson} ->> 'quotaExhausted' = 'true'
    or (
      ${heartbeatRuns.error} ~* ${QUOTA_SIGNATURE_RE.source}
      and (${heartbeatRuns.errorCode} is null or ${heartbeatRuns.errorCode} like 'claude%')
    )
  )`;
  // AUR-5064 latch bound: a reclassified row must not anchor further
  // reclassifications, or the chain never expires (see ClaudeAuthQuotaLaneHistory).
  const anchorIsNotItselfReclassified = sql`${heartbeatRuns.resultJson} -> 'authRenderedQuotaWall' is null`;
  // AUR-5064 hardening: model-profile overrides run other providers under this
  // adapterType, and their zero-usage failures can match the prose regex with a
  // claude-family errorCode. `usageJson.provider` is populated on 44,111 of
  // 44,497 zero-usage failed claude_local rows in a trailing 30d window (67 of
  // them `openai`), so require anthropic-or-absent — strictly tighter than the
  // errorCode family guard alone.
  const anchorProviderIsAnthropicOrUnknown = sql`(
    ${heartbeatRuns.usageJson} ->> 'provider' is null
    or ${heartbeatRuns.usageJson} ->> 'provider' = ${ANTHROPIC_PROVIDER}
  )`;

  const anchorRow = await db
    .select({
      runId: heartbeatRuns.id,
      createdAt: heartbeatRuns.createdAt,
      finishedAt: heartbeatRuns.finishedAt,
      error: heartbeatRuns.error,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        // Scoping by heartbeatRuns.companyId (not agents.companyId) is what
        // lets the planner use the heartbeat_runs indexes; the join survives
        // only to check adapterType.
        eq(heartbeatRuns.companyId, input.companyId),
        eq(agents.adapterType, input.adapterType),
        eq(heartbeatRuns.status, "failed"),
        ne(heartbeatRuns.id, input.excludeRunId),
        gte(heartbeatRuns.createdAt, lookbackStart),
        lt(heartbeatRuns.createdAt, input.now),
        quotaEvidence,
        anchorIsNotItselfReclassified,
        anchorProviderIsAnthropicOrUnknown,
        zeroUsage,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!anchorRow) {
    return { anchor: null, anthropicSuccessAfterAnchor: false };
  }

  const successRow = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(agents.companyId, input.companyId),
        eq(agents.adapterType, input.adapterType),
        eq(heartbeatRuns.status, "succeeded"),
        gt(heartbeatRuns.createdAt, anchorRow.createdAt),
        sql`${heartbeatRuns.usageJson} ->> 'provider' = ${ANTHROPIC_PROVIDER}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return {
    anchor: {
      runId: anchorRow.runId,
      createdAt: anchorRow.createdAt,
      resetAt: resolveAnchorResetAt(anchorRow),
    },
    anthropicSuccessAfterAnchor: successRow != null,
  };
}

export async function maybeReclassifyClaudeAuthFailureAsQuotaWall(
  db: Db,
  input: {
    companyId: string;
    adapterType: string;
    excludeRunId: string;
    errorCode: string | null;
    usage: UsageTokenCounts | null;
    now: Date;
  },
): Promise<ClaudeAuthQuotaReclassification | null> {
  // Both cheap pre-checks repeat inside decide(); running them here keeps the
  // DB untouched for every failure that is not the auth-rendered signature.
  if (input.errorCode !== CLAUDE_AUTH_REQUIRED_ERROR_CODE) return null;
  if (usageProvesModelWasReached(input.usage)) return null;
  const history = await gatherClaudeAuthQuotaLaneHistory(db, input);
  return decideClaudeAuthQuotaReclassification({
    errorCode: input.errorCode,
    usage: input.usage,
    history,
    now: input.now,
  });
}

/**
 * resultJson payload for a reclassified run. `quotaExhausted`/`quotaExhaustion`
 * mirror the AUR-4144 shape so every existing quota consumer (fleet capacity,
 * productivity review, the out-of-credits escalator) sees the run as what it
 * was. `outOfCredits` is deliberately false: nothing about this signature
 * proves a credit problem, so it must never trip the founder escalation in
 * quota-founder-escalation.ts — per AUR-5038 AC3 the founder is paged for
 * credentials/credits only on a lane that has proven itself since the wall.
 */
export function claudeAuthQuotaReclassificationResultJson(
  reclassification: ClaudeAuthQuotaReclassification,
): Record<string, unknown> {
  return {
    quotaExhausted: true,
    quotaExhaustion: {
      source: "lane_history",
      resetAt: reclassification.retryNotBefore ? reclassification.retryNotBefore.toISOString() : null,
      rateLimitType: null,
      overageDisabledReason: null,
      outOfCredits: false,
    },
    authRenderedQuotaWall: {
      originalErrorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      anchorRunId: reclassification.anchorRunId,
      anchorCreatedAt: reclassification.anchorCreatedAt.toISOString(),
    },
  };
}
