/**
 * Close-time scorecard auto-capture (AUR-4224).
 *
 * AUR-4151's daily retro-compliance audit found 33 of 101 `done` closures (~33%) missing
 * BOTH `performance_scorecard` and `scorecard_adjusted` memory records, always together —
 * the signature of a step skipped wholesale, not a partial failure. Root cause: agents
 * authored these captures from prose instructions using field names that don't match the
 * API's actual required metadata (`quality_signal`/`token_cost`/`task_type`, not `quality`),
 * so `POST /memory/capture` correctly 422s (see `checkScorecardMetadataViolations` in
 * routes/memory.ts), and the caller never checked the response status — a silent failure.
 *
 * Rather than trust every agent to hand-author a well-formed payload at close time, the
 * server builds and writes both records itself when an issue transitions to `done`, using
 * only data it already knows (issue id/identifier, assignee, token spend from `cost_events`).
 * `task_type` has no canonical source on the `issues` table today, so it's inferred with a
 * best-effort keyword heuristic and `quality_signal`/`value_signal` fall back to a documented
 * neutral default — every such record is flagged `metadata.auto_generated: true` so it stays
 * distinguishable (and overridable: an agent's own later `upsert: true` capture with the same
 * title still wins) from a real judgment call.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { memoryService as memoryServiceFactory } from "./memory.js";

const DEFAULT_QUALITY_SIGNAL = 3;
const DEFAULT_TASK_TYPE = "feature";

const TASK_TYPE_PATTERNS: Array<{ taskType: string; pattern: RegExp }> = [
  { taskType: "bug", pattern: /\b(fix(es|ed)?|bug|regression|hotfix|broken)\b/i },
  { taskType: "infra", pattern: /\b(infra|deploy(ment)?|ci\/?cd|watchdog|pipeline|systemd|provision)\b/i },
  { taskType: "research", pattern: /\b(research|investigat\w*|audit|diagnos\w*|root cause)\b/i },
  { taskType: "design", pattern: /\b(design|mockup|wireframe|ux\b)\b/i },
  { taskType: "marketing", pattern: /\b(marketing|campaign|content|seo|copywriting)\b/i },
  { taskType: "ops", pattern: /\b(runbook|incident|on-?call|ops\b)\b/i },
];

/**
 * Best-effort task_type guess from the issue's title/description. There is no canonical
 * taxonomy field on `issues` today, so this is a label, not a guarantee — every record it
 * populates is flagged `auto_generated: true` so downstream quartile math can exclude it.
 */
export function inferTaskType(issue: { title?: string | null; description?: string | null }): string {
  const haystack = `${issue.title ?? ""} ${issue.description ?? ""}`;
  for (const { taskType, pattern } of TASK_TYPE_PATTERNS) {
    if (pattern.test(haystack)) return taskType;
  }
  return DEFAULT_TASK_TYPE;
}

export interface CloseTimeScorecardIssue {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  assigneeAgentId: string;
  projectId?: string | null;
}

/**
 * Sums token usage recorded against this issue in `cost_events` — the server-known analog
 * of `token_cost` (AUR-4224 point 4 in the issue's candidate list: don't make agents
 * self-report a number the server already has).
 */
export async function sumIssueTokenCost(db: Db, companyId: string, issueId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}), 0)`,
    })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), eq(costEvents.issueId, issueId)));
  return Number(rows[0]?.total ?? 0);
}

/**
 * Pure builder for the two capture payloads — kept separate from the DB/memory-service calls
 * so the title/metadata shape can be unit tested without a database.
 *
 * Titles append the issue identifier after the date (`performance/{agent}/{taskType}/{date}/{issue}`)
 * instead of stopping at the date like a human-authored day-bucket scorecard would. Router
 * reads still match via `titlePrefix=performance/{agent}/{taskType}/` (see routes/memory.ts),
 * but a bare `.../{date}` bucket would silently collapse every issue an agent closes on the
 * same day into one upserted record — the audit matches per-issue on `metadata.issue_id`, so
 * a collapsed bucket would still show as "missing" for every issue but the last one closed.
 */
export function buildCloseTimeScorecardCaptures(issue: CloseTimeScorecardIssue, tokenCost: number, closedAt: Date) {
  const day = closedAt.toISOString().slice(0, 10);
  const issueRef = issue.identifier ?? issue.id;
  const taskType = inferTaskType(issue);
  const safeTokenCost = Math.max(Math.round(tokenCost), 0);
  const qualitySignal = DEFAULT_QUALITY_SIGNAL;
  const valueSignal = DEFAULT_QUALITY_SIGNAL;
  // AUR-5410: token_cost:0 means "we never measured cost", not "this cost
  // nothing" — the previous `Math.max(safeTokenCost, 1)` clamp turned an
  // absent measurement into score_adjusted: 9.0, the best possible score in
  // the registry, so routing was decided by which candidate happened to have
  // an unmeasured close. A row with no measured cost gets no score at all:
  // score_adjusted is omitted (not null — `Number(null) === 0`, which would
  // silently drag a reader's average toward zero instead of being skipped)
  // and both records are flagged so readers can exclude them explicitly.
  const hasMeasuredCost = safeTokenCost > 0;
  const scoreAdjusted = hasMeasuredCost ? (qualitySignal * valueSignal) / safeTokenCost : undefined;
  const owner = { type: "agent" as const, id: issue.assigneeAgentId };
  const source = { kind: "issue" as const, issueId: issue.id };
  const unmeasuredFlags = hasMeasuredCost
    ? {}
    : { metrics_lost: true, exclude_from_aggregates: true };

  const performanceScorecard = {
    title: `performance/${issue.assigneeAgentId}/${taskType}/${day}/${issueRef}`,
    content: `Closed ${issueRef}; auto-captured at close time (AUR-4224 — no agent-authored scorecard within this close).`,
    metadata: {
      category: "performance_scorecard",
      issue_id: issueRef,
      agent_id: issue.assigneeAgentId,
      task_type: taskType,
      outcome: "success",
      token_cost: safeTokenCost,
      quality_signal: qualitySignal,
      value_signal: valueSignal,
      auto_generated: true,
      ...unmeasuredFlags,
      ...(issue.projectId ? { project_id: issue.projectId } : {}),
    },
    source,
    owner,
    upsert: true,
  };

  const scorecardAdjusted = {
    title: `scorecard-adjusted/${issue.assigneeAgentId}/${taskType}/${day}/${issueRef}`,
    content: hasMeasuredCost
      ? `Adjusted score ${(scoreAdjusted as number).toFixed(4)} (auto-captured at close time, AUR-4224).`
      : `No cost measurement available at close time (cost_events empty for this issue) — score suppressed, not fabricated (AUR-5410).`,
    metadata: {
      category: "scorecard_adjusted",
      issue_id: issueRef,
      agent_id: issue.assigneeAgentId,
      task_type: taskType,
      ...(hasMeasuredCost ? { score_adjusted: scoreAdjusted } : {}),
      quality_signal: qualitySignal,
      value_signal: valueSignal,
      token_cost: safeTokenCost,
      auto_generated: true,
      ...unmeasuredFlags,
      ...(issue.projectId ? { project_id: issue.projectId } : {}),
    },
    source,
    owner,
    upsert: true,
  };

  return { performanceScorecard, scorecardAdjusted };
}

/**
 * Writes both auto-generated records for a just-closed issue. Never throws — a scorecard
 * capture failure must not block or fail the issue close it's attached to; failures are
 * logged loudly instead (a silent catch here would just reproduce the bug this exists to fix).
 */
export async function captureCloseTimeScorecard(
  db: Db,
  memory: ReturnType<typeof memoryServiceFactory>,
  companyId: string,
  issue: CloseTimeScorecardIssue,
  closedAt: Date = new Date(),
): Promise<void> {
  try {
    const tokenCost = await sumIssueTokenCost(db, companyId, issue.id);
    const { performanceScorecard, scorecardAdjusted } = buildCloseTimeScorecardCaptures(issue, tokenCost, closedAt);
    const actor = { actorType: "system" as const, actorId: "system", agentId: issue.assigneeAgentId, userId: null, runId: null };
    await memory.capture(companyId, performanceScorecard, actor, "hook", "issue_close_scorecard_capture");
    await memory.capture(companyId, scorecardAdjusted, actor, "hook", "issue_close_scorecard_capture");
  } catch (err) {
    logger.error({ err, issueId: issue.id }, "AUR-4224: failed to auto-capture close-time performance scorecard");
  }
}
