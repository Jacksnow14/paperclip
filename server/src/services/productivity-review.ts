import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-utils";
import {
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import { findActiveAdapterQuotaPause } from "./quota-pause.js";

export const PRODUCTIVITY_REVIEW_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.issueProductivityReview;
export const DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS = 6;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS = 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW = 3;
// AUR-3926: infra-kill (control-plane restart / OOM) outage detection thresholds.
// See "Process lost" classification in heartbeat.ts:2263-2277 (errorCode "process_lost").
export const DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_DISTINCT_AGENTS = 2;
export const DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_TERMINAL_RUNS = 5;
export const DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_INFRA_SHARE = 0.5;

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const MAX_CANDIDATE_ISSUES = 250;
const MAX_RUNS_FOR_STREAK = 100;
const MAX_PARENT_WALK_DEPTH = 25;
export const PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX = "Productivity review evidence refreshed.";
// Matches server/src/services/heartbeat.ts buildProcessLossMessage()/errorCode "process_lost" —
// the only code path that produces these four message variants. A run in this state died because
// the control plane restarted or lost track of its child process; it carries no signal about the
// assigned agent's behavior and must not count toward churn/no-comment thresholds.
export const PROCESS_LOST_ERROR_CODE = "process_lost";
// AUR-4016: provider-capacity/auth failures that never reach the agent process -- the run dies
// (zero tokens, zero cost) before the model is invoked, so like PROCESS_LOST_ERROR_CODE it carries
// no signal about the assigned agent's behavior. See packages/adapters/claude-local/src/server/execute.ts
// for the code paths that emit these. Keep this list narrow and fail closed: only add codes proven
// non-attributable (AUR-4016 forensics on AUR-3963's 11-run streak).
export const NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES = [
  PROCESS_LOST_ERROR_CODE,
  "claude_transient_upstream",
  "claude_auth_required",
] as const;

// AUR-4513: codes for failures that are DETERMINISTIC -- re-running the same work
// unchanged reproduces them. Unlike the provider-capacity codes above, nothing
// external will ever clear these, so a run carrying one is real evidence that the
// agent is wedged and must stay attributable and escalate. AUR-4212 reported a
// permanently-wedged agent as "0 attributable" precisely because its overflow runs
// were mis-coded `claude_transient_upstream` and swallowed by the exclusion above.
//
// Adding a code to BOTH lists would reproduce that bug under a new name, so the
// invariant is enforced at module load rather than left to a comment.
export const DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES = [
  CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
] as const;

for (const code of DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES) {
  if ((NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(
      `productivity-review misconfigured: "${code}" is both deterministic-attributable and ` +
        `non-attributable. A deterministic error must escalate (AUR-4513/AUR-4212).`,
    );
  }
}

// AUR-4062: adapter-agnostic backstop for the *next* provider failure mode that isn't in
// NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES yet. AUR-3943 forensics found a clean, bimodal split
// independent of errorCode: runs that never reached the model logged ~6.0-6.2 KB and recorded
// zero tokens/cost, vs. 257-311 KB for runs that actually invoked it. Gate on logBytes (not just
// zero usage) so a genuine $0 agent failure that already reached the model -- a real transcript,
// just no billed usage -- is not swept in; that risk is exactly why AUR-4062 asked for this to be
// its own change with its own test coverage instead of folding into AUR-4016's errorCode list.
const ZERO_TOKEN_BACKSTOP_LOG_BYTES_CEILING = 32 * 1024;

function hasZeroUsage(usageJson: HeartbeatRunRow["usageJson"]) {
  const usage = usageJson as { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown } | null;
  const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
  const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
  const costUsd = typeof usage?.costUsd === "number" ? usage.costUsd : 0;
  return inputTokens === 0 && outputTokens === 0 && costUsd === 0;
}

function isZeroTokenBackstopRun(run: Pick<HeartbeatRunRow, "usageJson" | "logBytes">) {
  return (
    hasZeroUsage(run.usageJson) &&
    typeof run.logBytes === "number" &&
    run.logBytes > 0 &&
    run.logBytes <= ZERO_TOKEN_BACKSTOP_LOG_BYTES_CEILING
  );
}

function isInfraKilledRun(
  run: Pick<HeartbeatRunRow, "errorCode" | "error" | "usageJson" | "logBytes">,
) {
  // A deterministic failure is never an infra kill, even if a future edit adds its
  // code to the non-attributable list.
  if (
    run.errorCode != null &&
    (DETERMINISTIC_ATTRIBUTABLE_ERROR_CODES as readonly string[]).includes(run.errorCode)
  ) {
    return false;
  }
  return (
    (run.errorCode != null &&
      (NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES as readonly string[]).includes(run.errorCode)) ||
    Boolean(run.error?.startsWith("Process lost")) ||
    isZeroTokenBackstopRun(run)
  );
}

function nonAttributableErrorCodeSqlList() {
  return sql.join(
    NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES.map((code) => sql`${code}`),
    sql`, `,
  );
}

function zeroTokenBackstopSqlPredicate() {
  return sql`(
    coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::numeric, 0) = 0
    and coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::numeric, 0) = 0
    and coalesce((${heartbeatRuns.usageJson} ->> 'costUsd')::numeric, 0) = 0
    and ${heartbeatRuns.logBytes} is not null
    and ${heartbeatRuns.logBytes} > 0
    and ${heartbeatRuns.logBytes} <= ${ZERO_TOKEN_BACKSTOP_LOG_BYTES_CEILING}
  )`;
}

function infraKilledRunSqlExclusion() {
  return sql`(
    coalesce(${heartbeatRuns.errorCode}, '') not in (${nonAttributableErrorCodeSqlList()})
    and (${heartbeatRuns.error} is null or ${heartbeatRuns.error} not like ${"Process lost%"})
    and not ${zeroTokenBackstopSqlPredicate()}
  )`;
}

function infraKilledRunSqlPredicate() {
  return sql`(
    coalesce(${heartbeatRuns.errorCode}, '') in (${nonAttributableErrorCodeSqlList()})
    or ${heartbeatRuns.error} like ${"Process lost%"}
    or ${zeroTokenBackstopSqlPredicate()}
  )`;
}

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type ProductivityReviewTrigger =
  | "no_comment_streak"
  | "long_active_duration"
  | "high_churn"
  | "stalled_active_episode";

type ProductivityReviewThresholds = {
  noCommentStreakRuns: number;
  longActiveMs: number;
  highChurnHourly: number;
  highChurnSixHours: number;
  resolvedSnoozeMs: number;
  refreshIntervalMs: number;
  maxRefreshComments: number;
  creationWindowMs: number;
  maxCreationsPerWindow: number;
  outageWindowMs: number;
  outageMinDistinctAgents: number;
  outageMinTerminalRuns: number;
  outageInfraShare: number;
};

type ProductivityReviewEvidence = {
  trigger: ProductivityReviewTrigger;
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  noCommentStreak: number;
  totalRunCount: number;
  terminalRunCount: number;
  infraKilledTerminalRunCount: number;
  infraKilledTerminalRunBreakdown: Array<{ errorCode: string; count: number }>;
  attributableTerminalRunCount: number;
  activeRunCount: number;
  runCountLastHour: number;
  runCountLastSixHours: number;
  commentCount: number;
  commentCountLastHour: number;
  commentCountLastSixHours: number;
  elapsedMs: number | null;
  zeroRecentActivity: boolean;
  quotaPaused: boolean;
  quotaPausedUntil: Date | null;
  latestRuns: HeartbeatRunRow[];
  latestComments: Array<typeof issueComments.$inferSelect>;
  costCents: number;
  usageSamples: Array<{ runId: string; usageJson: Record<string, unknown> | null }>;
  nextAction: string | null;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
};

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

function productivityReviewFingerprint(sourceIssueId: string) {
  return `productivity-review:${sourceIssueId}`;
}

function issueRunScopeSql(issueId: string) {
  return sql`(
    ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskKey' = ${issueId}
  )`;
}

function msToHuman(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h ${minutes % 60}m`;
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function truncateInline(value: string | null | undefined, max = 260) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readFraction(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function coerceDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function buildThresholds(overrides?: Partial<ProductivityReviewThresholds>): ProductivityReviewThresholds {
  return {
    noCommentStreakRuns: readPositiveInteger(
      overrides?.noCommentStreakRuns ?? DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
    ),
    longActiveMs: readPositiveInteger(
      overrides?.longActiveMs ?? DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
      DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
    ),
    highChurnHourly: readPositiveInteger(
      overrides?.highChurnHourly ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
    ),
    highChurnSixHours: readPositiveInteger(
      overrides?.highChurnSixHours ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
    ),
    resolvedSnoozeMs: readPositiveInteger(
      overrides?.resolvedSnoozeMs ?? DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
    ),
    refreshIntervalMs: readPositiveInteger(
      overrides?.refreshIntervalMs ?? DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
    ),
    maxRefreshComments: readPositiveInteger(
      overrides?.maxRefreshComments ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
    ),
    creationWindowMs: readPositiveInteger(
      overrides?.creationWindowMs ?? DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
    ),
    maxCreationsPerWindow: readPositiveInteger(
      overrides?.maxCreationsPerWindow ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
    ),
    outageWindowMs: readPositiveInteger(
      overrides?.outageWindowMs ?? DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_WINDOW_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_WINDOW_MS,
    ),
    outageMinDistinctAgents: readPositiveInteger(
      overrides?.outageMinDistinctAgents ?? DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_DISTINCT_AGENTS,
      DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_DISTINCT_AGENTS,
    ),
    outageMinTerminalRuns: readPositiveInteger(
      overrides?.outageMinTerminalRuns ?? DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_TERMINAL_RUNS,
      DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_MIN_TERMINAL_RUNS,
    ),
    outageInfraShare: readFraction(
      overrides?.outageInfraShare ?? DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_INFRA_SHARE,
      DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_INFRA_SHARE,
    ),
  };
}

function choosePrimaryTrigger(input: {
  noComment: boolean;
  longActive: boolean;
  highChurn: boolean;
  stalled: boolean;
}): ProductivityReviewTrigger | null {
  if (input.noComment) return "no_comment_streak";
  // AUR-4014: a long-running episode with zero runs, zero assignee comments, and zero active
  // runs in the last hour is a stall (the issue went dark), not churn -- report it as its own
  // trigger with wake/block remedies instead of the churn-shaped menu. Only fires when the
  // episode is also long-lived; a short silent gap is just "between heartbeats" (see the
  // zeroRecentActivity guard in collectEvidence, which requires longActive as well).
  //
  // Checked BEFORE highChurn: highChurn's 6h window can still be true from a burst that happened
  // 2-6h ago even though the last hour (zeroRecentActivity) is completely dark. Checking highChurn
  // first would reclassify a currently-dark issue as churn whenever it happened to churn earlier
  // in its own 6h window -- reproducing the exact "dark issue gets a churn-shaped menu" failure
  // (AUR-3924) this trigger exists to prevent, just via the 6h path instead of elapsedMs alone.
  if (input.stalled) return "stalled_active_episode";
  if (input.highChurn) return "high_churn";
  if (input.longActive) return "long_active_duration";
  return null;
}

function isSoftStopTrigger(trigger: ProductivityReviewTrigger) {
  return trigger === "no_comment_streak" || trigger === "high_churn";
}

function formatTrigger(trigger: ProductivityReviewTrigger) {
  if (trigger === "no_comment_streak") return "No-comment streak";
  if (trigger === "high_churn") return "High churn";
  if (trigger === "stalled_active_episode") return "Stalled active episode";
  return "Long active duration";
}

export function productivityReviewService(db: Db, deps?: { enqueueWakeup?: EnqueueWakeup }) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  async function isProductivityReviewDescendant(issue: Pick<IssueRow, "companyId" | "parentId">) {
    let parentId = issue.parentId;
    let depth = 0;
    while (parentId && depth < MAX_PARENT_WALK_DEPTH) {
      const parent = await db
        .select({ id: issues.id, parentId: issues.parentId, originKind: issues.originKind })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, parentId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) return false;
      if (parent.originKind === PRODUCTIVITY_REVIEW_ORIGIN_KIND) return true;
      parentId = parent.parentId;
      depth += 1;
    }
    return false;
  }

  async function findOpenProductivityReview(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findRecentResolvedProductivityReview(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.resolvedSnoozeMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function countRecentProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.creationWindowMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          sql`${issues.status} <> 'cancelled'`,
          sql`${issues.createdAt} >= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function getRefreshCommentState(companyId: string, reviewIssueId: string) {
    return db
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
        ),
      )
      .then((rows) => {
        const row = rows[0];
        return {
          count: Number(row?.count ?? 0),
          latestCreatedAt: coerceDate(row?.latestCreatedAt),
        };
      });
  }

  async function addRefreshComment(
    reviewIssueId: string,
    body: string,
    generatedAt: Date,
  ) {
    const comment = await issuesSvc.addComment(reviewIssueId, body, {});
    await db
      .update(issueComments)
      .set({ createdAt: generatedAt, updatedAt: generatedAt })
      .where(eq(issueComments.id, comment.id));
    await db
      .update(issues)
      .set({ updatedAt: generatedAt })
      .where(eq(issues.id, reviewIssueId));
    return comment;
  }

  async function countIssueRunsSince(companyId: string, agentId: string, issueId: string, since: Date) {
    // AUR-3926: infra-killed ("Process lost") runs are excluded so a control-plane
    // restart storm cannot masquerade as agent churn. See infraKilledRunSqlExclusion().
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
          infraKilledRunSqlExclusion(),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function countIssueCommentsSince(companyId: string, issueId: string, agentId: string, since?: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, agentId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          since ? sql`${issueComments.createdAt} >= ${since.toISOString()}::timestamptz` : undefined,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function collectEvidence(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ): Promise<ProductivityReviewEvidence | null> {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const latestRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, sourceIssue.companyId),
          eq(heartbeatRuns.agentId, sourceAgent.id),
          issueRunScopeSql(sourceIssue.id),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_RUNS_FOR_STREAK);

    const runIds = latestRuns.map((run) => run.id);
    const commentRunIds = new Set<string>();
    if (runIds.length > 0) {
      const commentRows = await db
        .select({ createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            inArray(issueComments.createdByRunId, runIds),
          ),
        );
      for (const row of commentRows) {
        if (row.createdByRunId) commentRunIds.add(row.createdByRunId);
      }
    }

    const terminalRuns = latestRuns.filter((run) =>
      TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]),
    );
    // AUR-3926: a "Process lost" run died because the control plane restarted, not because the
    // agent went silent. It is skipped entirely (not counted, not treated as a streak-breaking
    // comment) so a retry storm during an outage cannot inflate the no-comment streak.
    const infraKilledTerminalRuns = terminalRuns.filter(isInfraKilledRun);
    const attributableTerminalRuns = terminalRuns.filter((run) => !isInfraKilledRun(run));
    const infraKilledTerminalRunBreakdownMap = new Map<string, number>();
    for (const run of infraKilledTerminalRuns) {
      const key =
        run.errorCode ??
        (isZeroTokenBackstopRun(run) ? "(zero-token/logBytes backstop)" : "(unlabeled Process lost)");
      infraKilledTerminalRunBreakdownMap.set(key, (infraKilledTerminalRunBreakdownMap.get(key) ?? 0) + 1);
    }
    const infraKilledTerminalRunBreakdown = Array.from(
      infraKilledTerminalRunBreakdownMap,
      ([errorCode, count]) => ({ errorCode, count }),
    ).sort((a, b) => b.count - a.count);
    let noCommentStreak = 0;
    for (const run of attributableTerminalRuns) {
      if (commentRunIds.has(run.id)) break;
      noCommentStreak += 1;
    }

    const [
      runCountLastHour,
      runCountLastSixHours,
      assigneeRunCommentCount,
      assigneeRunCommentCountLastHour,
      assigneeRunCommentCountLastSixHours,
      latestComments,
      costRow,
    ] = await Promise.all([
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, oneHourAgo),
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, sixHoursAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, oneHourAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, sixHoursAgo),
      db
        .select({ comment: issueComments })
        .from(issueComments)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            eq(issueComments.authorAgentId, sourceAgent.id),
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            issueRunScopeSql(sourceIssue.id),
          ),
        )
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(5)
        .then((rows) => rows.map((row) => row.comment)),
      db
        .select({ costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, sourceIssue.companyId), eq(costEvents.issueId, sourceIssue.id)))
        .then((rows) => rows[0] ?? { costCents: 0 }),
    ]);

    const activeRunCount = latestRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]),
    ).length;
    const activeStartedAt = sourceIssue.startedAt ?? sourceIssue.executionLockedAt ?? null;
    const elapsedMs = sourceIssue.status === "in_progress" && activeStartedAt
      ? Math.max(0, now.getTime() - activeStartedAt.getTime())
      : null;

    const noComment = noCommentStreak >= thresholds.noCommentStreakRuns;
    const longActiveRaw = elapsedMs !== null && elapsedMs >= thresholds.longActiveMs;
    // AUR-4139: a wall-clock "long active" episode can be entirely explained by a
    // provider quota pause shared across every agent on this adapter's credential
    // (AUR-4055/quota-pause.ts) -- the issue isn't dark, admission is correctly
    // refusing to burn zero-token runs against a wall that hasn't cleared yet. Gate
    // longActive on the absence of an active pause so the stall watchdog doesn't
    // mistake a suppressed run queue for agent inactivity.
    const activeQuotaPause = longActiveRaw
      ? await findActiveAdapterQuotaPause(db, sourceIssue.companyId, sourceAgent.adapterType, now)
      : null;
    const quotaPaused = activeQuotaPause !== null;
    const longActive = longActiveRaw && !quotaPaused;
    // AUR-4014: episode age and activity rate are orthogonal. A long-active episode with zero
    // runs, zero assignee comments, and zero active runs in the last hour is a stall (the issue
    // went dark) -- a completely different failure from a long episode that is still producing
    // runs/comments below the churn threshold. See "stalled" below and choosePrimaryTrigger().
    const zeroRecentActivity =
      runCountLastHour === 0 && assigneeRunCommentCountLastHour === 0 && activeRunCount === 0;
    const stalled = longActive && zeroRecentActivity;
    const highChurn =
      runCountLastHour >= thresholds.highChurnHourly ||
      assigneeRunCommentCountLastHour >= thresholds.highChurnHourly ||
      runCountLastSixHours >= thresholds.highChurnSixHours ||
      assigneeRunCommentCountLastSixHours >= thresholds.highChurnSixHours;
    const trigger = choosePrimaryTrigger({ noComment, longActive, highChurn, stalled });
    if (!trigger) return null;

    const triggerReasons: string[] = [];
    if (quotaPaused && activeQuotaPause) {
      triggerReasons.push(
        `adapter quota pause active for ${sourceAgent.adapterType} until ${activeQuotaPause.scheduledRetryAt.toISOString()} (via agent ${activeQuotaPause.agentId}) -- this suppressed the long-active/stalled trigger for this episode`,
      );
    }
    if (noComment) triggerReasons.push(`${noCommentStreak} consecutive completed issue-linked runs had no run-created issue comment (${infraKilledTerminalRuns.length} infra-killed runs in the sampled window were excluded from this streak)`);
    if (trigger === "stalled_active_episode") {
      // Gated on the resolved `trigger`, not the raw `stalled` boolean: if a different trigger
      // (e.g. no_comment_streak) won precedence while `stalled` also happens to be true, we must
      // not assert "this is a dark issue, not churn" next to that trigger's own (non-stall) remedy
      // menu -- see choosePrimaryTrigger for the precedence rationale.
      triggerReasons.push(
        `stalled active episode: ${msToHuman(elapsedMs)} elapsed with zero runs, zero assignee comments, and zero active runs in the last hour -- this is a dark issue, not churn`,
      );
    } else if (longActive) {
      triggerReasons.push(`current active episode has lasted ${msToHuman(elapsedMs)}`);
    }
    if (trigger === "high_churn") {
      // Gated on the resolved `trigger`, same reasoning as the stalled/longActive block above: a
      // stale 6h churn burst can leave `highChurn` true even when `stalled` won precedence (the
      // last hour is dark), and listing churn stats as a "reason" next to a stall-shaped review
      // would contradict the "this is a dark issue, not churn" text above.
      triggerReasons.push(
        `${runCountLastHour} runs/${assigneeRunCommentCountLastHour} assignee-run comments in 1h; ${runCountLastSixHours} runs/${assigneeRunCommentCountLastSixHours} assignee-run comments in 6h (infra-killed runs already excluded from these counts)`,
      );
    }
    if (costRow.costCents === 0 && (runCountLastHour > 0 || noCommentStreak > 0)) {
      triggerReasons.push(
        `contradiction: $0 in cost events despite ${attributableTerminalRuns.length} attributable terminal run(s) sampled -- verify these runs actually did billable work before treating this as agent churn`,
      );
    }

    return {
      trigger,
      triggerReasons,
      sourceIssue,
      sourceAgent,
      noCommentStreak,
      totalRunCount: latestRuns.length,
      terminalRunCount: terminalRuns.length,
      infraKilledTerminalRunCount: infraKilledTerminalRuns.length,
      infraKilledTerminalRunBreakdown,
      attributableTerminalRunCount: attributableTerminalRuns.length,
      activeRunCount,
      runCountLastHour,
      runCountLastSixHours,
      commentCount: assigneeRunCommentCount,
      commentCountLastHour: assigneeRunCommentCountLastHour,
      commentCountLastSixHours: assigneeRunCommentCountLastSixHours,
      elapsedMs,
      zeroRecentActivity,
      quotaPaused,
      quotaPausedUntil: activeQuotaPause?.scheduledRetryAt ?? null,
      latestRuns: latestRuns.slice(0, 5),
      latestComments,
      costCents: costRow.costCents,
      usageSamples: latestRuns
        .filter((run) => run.usageJson)
        .slice(0, 3)
        .map((run) => ({ runId: run.id, usageJson: run.usageJson ?? null })),
      nextAction: latestRuns.find((run) => run.nextAction)?.nextAction ?? null,
      thresholds,
      generatedAt: now,
    };
  }

  async function resolveReviewOwnerAgentId(sourceIssue: IssueRow, sourceAgent: AgentRow) {
    const candidateIds: string[] = [];
    if (sourceAgent.reportsTo) candidateIds.push(sourceAgent.reportsTo);
    if (sourceIssue.createdByAgentId) candidateIds.push(sourceIssue.createdByAgentId);
    if (sourceIssue.projectId) {
      const project = await db
        .select({ leadAgentId: projects.leadAgentId })
        .from(projects)
        .where(and(eq(projects.companyId, sourceIssue.companyId), eq(projects.id, sourceIssue.projectId)))
        .then((rows) => rows[0] ?? null);
      if (project?.leadAgentId) candidateIds.push(project.leadAgentId);
    }
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, sourceIssue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== sourceIssue.companyId || !isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(sourceIssue.companyId, candidate.id, {
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId ?? null,
      });
      if (!budgetBlock) return candidate.id;
    }
    return null;
  }

  // AUR-4014: the churn-shaped menu ("snooze", "decompose", "the work is inefficient") is wrong
  // guidance for a stall -- nothing is churning, the issue just went dark. Give the manager
  // remedies that actually apply to each trigger instead of one generic list for all three.
  function buildManagerDecisionMenu(trigger: ProductivityReviewTrigger): string[] {
    if (trigger === "stalled_active_episode") {
      return [
        "- Wake the assignee agent to resume work, or reassign to a live agent if it cannot resume.",
        "- If a wake/monitor check is already scheduled, confirm it and let it run rather than duplicating it.",
        "- Set status to `blocked` with a named unblock owner if something external is blocking progress.",
        "- Close the issue if the work is actually complete and just needs its status updated.",
      ];
    }
    return [
      "- Close as productive if this pattern is expected.",
      "- Continue with a snooze window if the current work should keep running without repeat review spam.",
      "- Request decomposition, reroute, block with an unblock owner, or stop/cancel the source work if the work is inefficient.",
    ];
  }

  function buildReviewMarkdown(evidence: ProductivityReviewEvidence, prefix: string) {
    const latestRuns = evidence.latestRuns.length > 0
      ? evidence.latestRuns.map((run) =>
        `- ${runUiLink(run, prefix)} \`${run.status}\` liveness \`${run.livenessState ?? "unknown"}\`, created ${run.createdAt.toISOString()}${run.nextAction ? `, next action: ${truncateInline(run.nextAction, 160)}` : ""}`,
      ).join("\n")
      : "- none";
    const latestComments = evidence.latestComments.length > 0
      ? evidence.latestComments.map((comment) =>
        `- ${comment.createdAt.toISOString()}${comment.createdByRunId ? ` run \`${comment.createdByRunId}\`` : ""}: ${truncateInline(comment.body)}`,
      ).join("\n")
      : "- none";
    const usage = evidence.usageSamples.length > 0
      ? evidence.usageSamples.map((sample) => `- \`${sample.runId}\`: \`${JSON.stringify(sample.usageJson).slice(0, 500)}\``).join("\n")
      : "- no usage payloads on sampled runs";
    const infraKilledBreakdown = evidence.infraKilledTerminalRunBreakdown.length > 0
      ? evidence.infraKilledTerminalRunBreakdown.map((entry) => `\`${entry.errorCode}\`: ${entry.count}`).join(", ")
      : "none";
    return [
      "Paperclip detected an unusual productivity/progression pattern on an assigned issue.",
      "",
      "## Source",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Assigned agent: ${evidence.sourceAgent.name} (${evidence.sourceAgent.role})`,
      `- Primary trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Trigger reasons: ${evidence.triggerReasons.join("; ")}`,
      `- Generated at: ${evidence.generatedAt.toISOString()}`,
      "",
      "## Evidence",
      "",
      `- Total sampled issue-linked runs: ${evidence.totalRunCount}`,
      `- Terminal sampled runs: ${evidence.terminalRunCount} (${evidence.infraKilledTerminalRunCount} infra-killed/non-attributable, ${evidence.attributableTerminalRunCount} attributable to the agent)`,
      `- Excluded-run breakdown by errorCode: ${infraKilledBreakdown}`,
      `- Active queued/running/scheduled runs: ${evidence.activeRunCount}`,
      `- No-comment completed-run streak: ${evidence.noCommentStreak}`,
      `- Current active elapsed time: ${msToHuman(evidence.elapsedMs)}`,
      // The measurement is reported either way, but the "this is the stall axis" reading is gated
      // on the resolved trigger for the same reason triggerReasons is: zeroRecentActivity can be
      // true while a different trigger wins precedence (a no_comment_streak whose runs all landed
      // >1h ago, or a high_churn carried by its 6h window on a short/absent episode). Printing the
      // stall reading directly above that trigger's churn-shaped remedy menu hands the manager the
      // same mixed axis signal AUR-4014 exists to remove.
      `- Activity rate in the last hour: ${
        evidence.zeroRecentActivity
          ? `zero (0 runs, 0 assignee comments, 0 active runs)${evidence.trigger === "stalled_active_episode" ? " -- this is a stall axis, not a rate/churn axis" : ""}`
          : "non-zero"
      }`,
      `- Runs in rolling windows: ${evidence.runCountLastHour}/1h, ${evidence.runCountLastSixHours}/6h`,
      `- Assignee run-linked comments total/window: ${evidence.commentCount} total, ${evidence.commentCountLastHour}/1h, ${evidence.commentCountLastSixHours}/6h`,
      `- Cost events total: ${evidence.costCents} cents`,
      `- Current next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 500) : "none recorded"}`,
      "",
      "## Thresholds",
      "",
      `- No-comment streak: ${evidence.thresholds.noCommentStreakRuns} completed runs`,
      `- Long active duration: ${msToHuman(evidence.thresholds.longActiveMs)}`,
      `- High churn: ${evidence.thresholds.highChurnHourly}/1h or ${evidence.thresholds.highChurnSixHours}/6h runs/assignee-run comments`,
      `- Resolved-review snooze: ${msToHuman(evidence.thresholds.resolvedSnoozeMs)}`,
      "",
      "## Latest Runs",
      "",
      latestRuns,
      "",
      "## Latest Assignee Run Comments",
      "",
      latestComments,
      "",
      "## Usage Samples",
      "",
      usage,
      "",
      "## Manager Decision",
      "",
      ...buildManagerDecisionMenu(evidence.trigger),
    ].join("\n");
  }

  function buildRefreshComment(evidence: ProductivityReviewEvidence, prefix: string) {
    return [
      "Productivity review evidence refreshed.",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Reasons: ${evidence.triggerReasons.join("; ")}`,
      `- No-comment streak: ${evidence.noCommentStreak}`,
      `- Runs/assignee comments: ${evidence.runCountLastHour}/${evidence.commentCountLastHour} in 1h, ${evidence.runCountLastSixHours}/${evidence.commentCountLastSixHours} in 6h`,
      `- Next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 300) : "none recorded"}`,
    ].join("\n");
  }

  async function createOrUpdateReview(
    evidence: ProductivityReviewEvidence,
    opts: { prefix: string; thresholds: ProductivityReviewThresholds },
  ) {
    const existing = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
    if (existing) {
      const refreshState = await getRefreshCommentState(evidence.sourceIssue.companyId, existing.id);
      const lastRefreshOrCreationAt = refreshState.latestCreatedAt ?? existing.createdAt;
      if (
        refreshState.count >= opts.thresholds.maxRefreshComments ||
        evidence.generatedAt.getTime() - lastRefreshOrCreationAt.getTime() < opts.thresholds.refreshIntervalMs
      ) {
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }
      await addRefreshComment(existing.id, buildRefreshComment(evidence, opts.prefix), evidence.generatedAt);
      await logActivity(db, {
        companyId: evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: existing.id,
        agentId: existing.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
          noCommentStreak: evidence.noCommentStreak,
          runCountLastHour: evidence.runCountLastHour,
          commentCountLastHour: evidence.commentCountLastHour,
        },
      });
      return { kind: "updated" as const, reviewIssueId: existing.id };
    }

    const recentCreationCount = await countRecentProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
      evidence.generatedAt,
    );
    if (recentCreationCount >= opts.thresholds.maxCreationsPerWindow) {
      return { kind: "creation_capped" as const, reviewIssueId: null };
    }

    const ownerAgentId = await resolveReviewOwnerAgentId(evidence.sourceIssue, evidence.sourceAgent);
    let review: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      review = await issuesSvc.create(evidence.sourceIssue.companyId, {
        title: `Review productivity for ${evidence.sourceIssue.identifier ?? evidence.sourceIssue.title}`,
        description: buildReviewMarkdown(evidence, opts.prefix),
        status: "todo",
        priority: evidence.trigger === "long_active_duration" ? "medium" : "high",
        parentId: evidence.sourceIssue.id,
        projectId: evidence.sourceIssue.projectId,
        goalId: evidence.sourceIssue.goalId,
        billingCode: evidence.sourceIssue.billingCode,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: evidence.sourceIssue.id,
        originFingerprint: productivityReviewFingerprint(evidence.sourceIssue.id),
        requestDepth: clampIssueRequestDepth(evidence.sourceIssue.requestDepth + 1),
      });
    } catch (error) {
      const maybe = error as { code?: string; constraint?: string; message?: string };
      const uniqueConflict = maybe.code === "23505" &&
        (
          maybe.constraint === "issues_active_productivity_review_uq" ||
          typeof maybe.message === "string" && maybe.message.includes("issues_active_productivity_review_uq")
        );
      if (!uniqueConflict) throw error;
      const raced = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
      if (!raced) throw error;
      return { kind: "existing" as const, reviewIssueId: raced.id };
    }
    await db
      .update(issues)
      .set({ createdAt: evidence.generatedAt, updatedAt: evidence.generatedAt })
      .where(eq(issues.id, review.id));

    await logActivity(db, {
      companyId: evidence.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: review.id,
      agentId: ownerAgentId,
      details: {
        source: "productivity_review.reconcile",
        sourceIssueId: evidence.sourceIssue.id,
        trigger: evidence.trigger,
        noCommentStreak: evidence.noCommentStreak,
        runCountLastHour: evidence.runCountLastHour,
        commentCountLastHour: evidence.commentCountLastHour,
      },
    });

    if (ownerAgentId && deps?.enqueueWakeup) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: review.id,
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
        }),
        requestedByActorType: "system",
        requestedByActorId: "productivity_review",
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: review.id,
          taskId: review.id,
          wakeReason: "issue_assigned",
          source: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          sourceIssueId: evidence.sourceIssue.id,
          productivityReviewTrigger: evidence.trigger,
        }),
      });
    }

    return { kind: "created" as const, reviewIssueId: review.id };
  }

  // AUR-3926: distinguish a control-plane outage from per-agent churn. A single agent hammering
  // retries is ambiguous; two or more *distinct* agents dying to "Process lost" in the same
  // window is a control-plane death, categorically (see CTO forensics on AUR-3924/AUR-3926 --
  // synchronized cross-agent timestamps are the tell). When that pattern is detected, no
  // per-agent productivity review should fire for the company in this reconcile pass -- filing N
  // false accusations during an outage is worse than a missed detection.
  async function detectCompanyInfraOutage(
    companyId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ): Promise<{ outage: boolean; infraRunCount: number; totalTerminalRunCount: number; distinctInfraAgentCount: number }> {
    const windowStart = new Date(now.getTime() - thresholds.outageWindowMs);
    const rows = await db
      .select({
        total: sql<number>`count(*)::int`,
        infraCount: sql<number>`count(*) filter (where ${infraKilledRunSqlPredicate()})::int`,
        distinctInfraAgents: sql<number>`count(distinct ${heartbeatRuns.agentId}) filter (where ${infraKilledRunSqlPredicate()})::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
          sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${windowStart.toISOString()}::timestamptz`,
        ),
      );
    const row = rows[0] ?? { total: 0, infraCount: 0, distinctInfraAgents: 0 };
    const total = Number(row.total ?? 0);
    const infraCount = Number(row.infraCount ?? 0);
    const distinctInfraAgents = Number(row.distinctInfraAgents ?? 0);
    const outage =
      distinctInfraAgents >= thresholds.outageMinDistinctAgents &&
      total >= thresholds.outageMinTerminalRuns &&
      total > 0 &&
      infraCount / total >= thresholds.outageInfraShare;
    return { outage, infraRunCount: infraCount, totalTerminalRunCount: total, distinctInfraAgentCount: distinctInfraAgents };
  }

  async function reconcileProductivityReviews(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds = buildThresholds(opts?.thresholds);
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          isNull(issues.hiddenAt),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
          sql`${issues.originKind} <> ${PRODUCTIVITY_REVIEW_ORIGIN_KIND}`,
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      scanned: candidates.length,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      skipped: 0,
      failed: 0,
      suppressedForInfraOutage: 0,
      outageCompanyIds: [] as string[],
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

    const prefixCache = new Map<string, string>();
    const outageCache = new Map<string, boolean>();
    for (const candidate of candidates) {
      if (!candidate.assigneeAgentId) {
        result.skipped += 1;
        continue;
      }
      let inOutage = outageCache.get(candidate.companyId);
      if (inOutage === undefined) {
        const outageState = await detectCompanyInfraOutage(candidate.companyId, thresholds, now);
        inOutage = outageState.outage;
        outageCache.set(candidate.companyId, inOutage);
        if (inOutage) {
          result.outageCompanyIds.push(candidate.companyId);
          logger.warn(
            {
              companyId: candidate.companyId,
              infraRunCount: outageState.infraRunCount,
              totalTerminalRunCount: outageState.totalTerminalRunCount,
              distinctInfraAgentCount: outageState.distinctInfraAgentCount,
              windowMs: thresholds.outageWindowMs,
            },
            "productivity review reconciliation suppressed: infra outage detected (Process lost across multiple agents), filing one infra signal instead of per-agent reviews",
          );
          await logActivity(db, {
            companyId: candidate.companyId,
            actorType: "system",
            actorId: "system",
            action: "company.productivity_review_suppressed_for_infra_outage",
            entityType: "company",
            entityId: candidate.companyId,
            details: {
              source: "productivity_review.reconcile",
              infraRunCount: outageState.infraRunCount,
              totalTerminalRunCount: outageState.totalTerminalRunCount,
              distinctInfraAgentCount: outageState.distinctInfraAgentCount,
              windowMs: thresholds.outageWindowMs,
            },
          });
        }
      }
      if (inOutage) {
        result.suppressedForInfraOutage += 1;
        continue;
      }
      if (await isProductivityReviewDescendant(candidate)) {
        result.skipped += 1;
        continue;
      }
      if (await findRecentResolvedProductivityReview(candidate.companyId, candidate.id, thresholds, now)) {
        result.snoozed += 1;
        continue;
      }
      const sourceAgent = await getAgent(candidate.assigneeAgentId);
      if (!sourceAgent || sourceAgent.companyId !== candidate.companyId) {
        result.skipped += 1;
        continue;
      }
      const evidence = await collectEvidence(candidate, sourceAgent, thresholds, now);
      if (!evidence) {
        result.skipped += 1;
        continue;
      }
      let prefix = prefixCache.get(candidate.companyId);
      if (!prefix) {
        prefix = await getCompanyIssuePrefix(candidate.companyId);
        prefixCache.set(candidate.companyId, prefix);
      }
      try {
        const outcome = await createOrUpdateReview(evidence, { prefix, thresholds });
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "updated") result.updated += 1;
        else if (outcome.kind === "creation_capped") result.creationCapped += 1;
        else result.existing += 1;
        if (outcome.reviewIssueId) result.reviewIssueIds.push(outcome.reviewIssueId);
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(candidate.id);
        logger.warn(
          {
            err,
            companyId: candidate.companyId,
            issueId: candidate.id,
            requestDepth: candidate.requestDepth,
          },
          "productivity review reconciliation skipped malformed candidate",
        );
      }
    }

    return result;
  }

  async function isProductivityReviewContinuationHoldActive(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = input.now ?? new Date();
    const thresholds = buildThresholds(input.thresholds);
    const [sourceIssue, sourceAgent, openReview] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
        .then((rows) => rows[0] ?? null),
      getAgent(input.agentId),
      findOpenProductivityReview(input.companyId, input.issueId),
    ]);
    if (!sourceIssue || !sourceAgent || !openReview) return { held: false as const };
    if (sourceAgent.companyId !== input.companyId) return { held: false as const };
    const evidence = await collectEvidence(sourceIssue, sourceAgent, thresholds, now);
    if (!evidence || !isSoftStopTrigger(evidence.trigger)) return { held: false as const };
    return {
      held: true as const,
      reviewIssueId: openReview.id,
      reviewIdentifier: openReview.identifier,
      trigger: evidence.trigger,
      reason: evidence.triggerReasons.join("; "),
    };
  }

  async function recordContinuationHold(input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    reviewIssueId: string;
    trigger: ProductivityReviewTrigger;
    reason: string;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.productivity_review_continuation_held",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        source: "productivity_review.continuation_hold",
        reviewIssueId: input.reviewIssueId,
        trigger: input.trigger,
        reason: input.reason,
      },
    });
  }

  return {
    reconcileProductivityReviews,
    isProductivityReviewContinuationHoldActive,
    recordContinuationHold,
  };
}
