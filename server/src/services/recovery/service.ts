import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  issueComments,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService, recoveryActionDormancyCutoff } from "../issue-recovery-actions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { issueService } from "../issues.js";
import { NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES, PROCESS_LOST_ERROR_CODE } from "../productivity-review.js";
import { findActiveAdapterQuotaPause } from "../quota-pause.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const DIRECT_BLOCKER_TERMINAL_STATUSES = new Set(["done", "cancelled"]);
// AUR-4250: how many cooldown-spaced recovery attempts an issue stays dispatchable for before
// stranded-work recovery falls back to `blocked`. Attempts are spaced by the 24h recovery-action
// dormancy window, so this is ~3 days of daily retries before the durable AUR-4168 missing-edge
// sweep takes over.
const MAX_DISPATCHABLE_STRANDED_RECOVERY_ATTEMPTS = 3;
const MISSING_BLOCKER_EDGE_REMINDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_BLOCKER_EDGE_ESCALATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Class A (terminal_only) auto-recovery flips an issue blocked -> todo. The
// status change is its own guard only while the issue stays out of `blocked`.
// If an agent re-blocks it without attaching a new first-class blocker, the
// original terminal edges still classify as terminal_only and the actuator
// would flip it back every tick. Cap auto-recovery at one per
// (issueId, blocker-set) per rolling window and downgrade to Class B after.
const CLASS_A_OSCILLATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// AUR-4996: how many dormant `stranded_assigned_issue` actions the Class B sweep may
// re-fire per run. The releasable population measured live was 223 (98% of the blocked
// backlog), so an uncapped first sweep would flood a day's worth of recovery wakes into
// one tick — this is the per-run cap AUR-4300 deliberately deferred. Deferred rows are
// counted (classBStrandedRearmDeferredCap), never silently dropped, and the next run
// picks them up.
export const CLASS_B_STRANDED_REARM_PER_RUN_CAP = 25;
const ISSUE_GRAPH_LIVENESS_RESULT_ID_ARRAY_LIMIT = 50;

function pushBoundedIssueId(ids: string[], issueId: string) {
  if (ids.length < ISSUE_GRAPH_LIVENESS_RESULT_ID_ARRAY_LIMIT) ids.push(issueId);
}

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "agentId" | "status" | "error" | "errorCode" | "contextSnapshot" | "livenessState"
> | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause = "stranded_assigned_issue" | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

type DurableBlockedIssueRow = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "projectId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "createdAt"
  | "updatedAt"
>;

type DurableBlockedIssueDirectBlockerRow = {
  blockedIssueId: string;
  blockerIssueId: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt: Date;
};

type DurableBlockedIssueDirectBlocker = DurableBlockedIssueDirectBlockerRow;

type DurableBlockedIssueClassificationKind =
  | "missing_edge"
  | "terminal_only"
  | "open_non_terminal";

type DurableBlockedEnteredAtSource = "activity_log" | "fallback_created_at";

type DurableBlockedIssueClassification = {
  issue: DurableBlockedIssueRow;
  kind: DurableBlockedIssueClassificationKind;
  directBlockers: DurableBlockedIssueDirectBlocker[];
  blockedEnteredAt: Date;
  blockedEnteredAtSource: DurableBlockedEnteredAtSource;
  staleAgeMs: number;
};

type MissingBlockerEdgeStage =
  | "none"
  | "wake_assignee"
  | "escalate_owner";

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
  if (!run) return null;

  if (readNonEmptyString(run.error) || readNonEmptyString(run.errorCode)) {
    return " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
  }
  return null;
}

function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed",
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

// AUR-5466: a terminal run carrying one of these codes died at the provider wall
// (auth/quota/transient upstream) or was killed by the control plane (process_lost) —
// before the assigned agent did any work. Filing `stranded_assigned_issue` or
// `missing_disposition` off such a run blames the assignee for an infrastructure
// outage. Reuses the productivity-review list rather than copying it: a second copy
// would drift and silently re-attribute a code the first list excused.
function isNonAttributableInfraRunFailure(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  if (
    !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  ) {
    return false;
  }
  const errorCode = readNonEmptyString(latestRun.errorCode);
  if (!errorCode) return false;
  // `process_lost` is deliberately NOT excused here even though it is in the imported
  // list. The provider-wall codes have an external recovery signal — the lane comes
  // back, the quota pause expires — so requeue-instead-of-escalate self-heals. A lost
  // process has no such signal: reapOrphanedRuns stamps `process_lost` on every
  // dead-pid run, and its bounded reap-retry ladder (PROCESS_LOST_RETRY_MAX_ATTEMPTS)
  // uses the stranded escalation as its designed fail-loud terminal. Excusing it would
  // turn a crash-looping run from a loud recovery action into silent requeue-forever
  // churn — disarming that watchdog, not removing blame. The productivity-review list
  // excuses `process_lost` from *scorecards*, where it is pure blame with no watchdog
  // role.
  if (errorCode === PROCESS_LOST_ERROR_CODE) return false;
  return (NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES as readonly string[]).includes(errorCode);
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function unwrapDatabaseConflictError(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };

  if (
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
  ) {
    return candidate;
  }

  const cause = candidate.cause;
  if (!cause || typeof cause !== "object") return candidate;

  return cause as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
}

function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
  return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  return latestRun?.status === "succeeded" &&
    (latestRun.livenessState === "advanced" ||
      latestRun.livenessState === "completed" ||
      latestRun.livenessState === "blocked" ||
      latestRun.livenessState === "needs_followup");
}

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue now keeps its existing blockers and is also blocked by the escalation issue so dependency wakeups remain explicit.",
  ].join("\n");
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  // AUR-5102: revalidate a recovery dispatch decision immediately before the
  // enqueue. reconcileStrandedAssignedIssues decides off a candidates snapshot
  // taken at sweep start; under backlog a pass runs for minutes, and the issue
  // may have been cancelled, completed, reassigned, or handed a live execution
  // path since the snapshot (and since the loop-level hasActiveExecutionPath
  // check). On 2026-08-05 stale passes enqueued 18 issue_assignment_recovery
  // wake-runs inside one minute for one issue that had been cancelled ten
  // minutes earlier. Dropping a stale dispatch here is lossless: the reconciler
  // is level-triggered, so if the issue is genuinely still stranded the next
  // sweep re-derives the dispatch from a fresh snapshot.
  async function isRecoveryDispatchStillValid(input: {
    issueId: string;
    agentId: string;
    expectedStatus: "todo" | "in_progress";
  }) {
    const issue = await db
      .select({
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) return false;
    if (issue.status !== input.expectedStatus) return false;
    if (issue.assigneeUserId) return false;
    if (issue.assigneeAgentId !== input.agentId) return false;
    // Deliberately NOT hasQueuedIssueWake here: a queued wake *request* with no
    // run behind it is a dead letter from a lost process, and recovery dispatch
    // is exactly what revives the issue past it ("still re-enqueues stranded
    // assigned todo recovery when an old queued wake exists"). A wake that is
    // actually live shows up as a queued/running/scheduled_retry run or a
    // deferred wake, which hasActiveExecutionPath covers.
    if (await hasActiveExecutionPath(issue.companyId, input.issueId)) return false;
    return true;
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed";
    retryReason: "assignment_recovery" | "issue_continuation_needed";
    source: string;
    retryOfRunId?: string | null;
  }) {
    const stillValid = await isRecoveryDispatchStillValid({
      issueId: input.issueId,
      agentId: input.agentId,
      expectedStatus: input.reason === "issue_assignment_recovery" ? "todo" : "in_progress",
    });
    if (!stillValid) return null;

    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  async function enqueueInitialAssignedTodoDispatch(issue: typeof issues.$inferSelect, agentId: string) {
    // AUR-5102: same stale-snapshot hazard as enqueueStrandedIssueRecovery —
    // the caller's readiness checks ran against a sweep-start snapshot.
    const stillValid = await isRecoveryDispatchStillValid({
      issueId: issue.id,
      agentId,
      expectedStatus: "todo",
    });
    if (!stillValid) return null;

    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }),
    });
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !isAgentInvokable(creatorAgent)) {
        skipped += 1;
        continue;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : quietUntilDecision
        ? "snoozed"
        : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
          ? "critical"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
            ? "suspicious"
            : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    if (!run.logStore || !run.logRef || !run.logBytes) return "";
    try {
      const offset = Math.max(0, run.logBytes - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
      const result = await runLogStore.read(
        { store: run.logStore as "local_file", logRef: run.logRef },
        { offset, limitBytes: ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES },
      );
      return result.content;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      return "";
    }
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), isNull(issues.hiddenAt)))
      .limit(1);
    return issue ?? null;
  }

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    if (input.sourceIssue?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceIssue.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childIssues, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, input.run.companyId),
              eq(issueRelations.relatedIssueId, input.sourceIssue.id),
              eq(issueRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childIssues,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceIssue = input.sourceIssue
      ? issueUiLink({ identifier: input.sourceIssue.identifier, id: input.sourceIssue.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childIssues = input.evidence.childIssues.length > 0
      ? input.evidence.childIssues.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source issue: ${sourceIssue}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child issues:",
      childIssues,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this issue as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stale_run_evaluation_uq" ||
        maybe.constraint_name === "issues_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stale_run_evaluation_uq")
      );
  }

  function isUniqueStrandedIssueRecoveryConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stranded_issue_recovery_uq" ||
        maybe.constraint_name === "issues_active_stranded_issue_recovery_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stranded_issue_recovery_uq")
      );
  }

  async function ensureSourceIssueBlockedByStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    const blockerIds = await existingBlockerIssueIds(input.sourceIssue.companyId, input.sourceIssue.id);
    if (blockerIds.includes(input.evaluationIssue.id)) return false;
    const nextBlockerIds = [...blockerIds, input.evaluationIssue.id];
    await issuesSvc.update(input.sourceIssue.id, {
      ...(input.sourceIssue.status === "blocked" ? {} : { status: "blocked" }),
      blockedByIssueIds: nextBlockerIds,
    });
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "This blocks the source issue on the explicit review task without cancelling the active process.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.evaluationIssue.id,
        blockerIssueIds: nextBlockerIds,
      },
    });
    return true;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await issuesSvc.update(existing.id, {
          priority: "high",
        });
        await issuesSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceIssue });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      evaluation = await issuesSvc.create(input.run.companyId, {
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationIssueId: raced.id };
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueBlockedByStaleEvaluation({
        sourceIssue,
        evaluationIssue: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }),
      });
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    const candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  async function findOpenStrandedIssueRecoveryIssue(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  async function resolveStrandedIssueRecoveryOwnerAgentId(issue: typeof issues.$inferSelect) {
    const candidateIds: string[] = [];
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  function buildStrandedIssueRecoveryDescription(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    prefix: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    sourceAssignee?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const sourceRunId = input.successfulRunHandoffEvidence?.sourceRunId;
      const sourceRunLink = sourceRunId && input.latestRun
        ? `[\`${sourceRunId}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${sourceRunId})`
        : "unknown";
      const missingDisposition = input.successfulRunHandoffEvidence?.missingDisposition ?? "clear_next_step";
      return [
        "Paperclip exhausted the bounded corrective handoff for a successful run that still has no valid issue disposition.",
        "",
        "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
        "",
        "## Safe Evidence",
        "",
        `- Source issue: ${sourceIssue}`,
        `- Source run: ${sourceRunLink}`,
        `- Corrective handoff run: ${runLink}`,
        `- Source assignee: ${agentUiLink(input.sourceAssignee ?? null, input.prefix)}`,
        `- Latest issue status: \`${input.issue.status}\``,
        `- Latest handoff run status: \`${input.latestRun?.status ?? "unknown"}\``,
        `- Normalized cause: \`${SUCCESSFUL_RUN_MISSING_STATE_REASON}\``,
        `- Missing disposition: \`${missingDisposition}\``,
        "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
        "",
        "## Required Action",
        "",
        "- Inspect the source issue and run metadata, not raw transcript excerpts.",
        "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- When the source issue has a clear owner and disposition, mark this recovery issue done.",
      ].join("\n");
    }

    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`stranded_assigned_issue\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "",
      "## Required Action",
      "",
      "- Inspect the latest run and source issue state.",
      "- Fix the runtime/adapter problem, reassign the source issue, or convert the source issue into a clear manual-review state.",
      "- When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.",
    ].join("\n");
  }

  async function ensureStrandedIssueRecoveryIssue(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) return null;

    const existing = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
    if (existing) return existing;

    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    if (!ownerAgentId) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    let recovery: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      recovery = await issuesSvc.create(input.issue.companyId, {
        title: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? `Recover missing next step ${input.issue.identifier ?? input.issue.title}`
          : `Recover stalled issue ${input.issue.identifier ?? input.issue.title}`,
        description: buildStrandedIssueRecoveryDescription({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          prefix,
          recoveryCause,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
          sourceAssignee,
        }),
        status: "todo",
        priority: input.issue.priority,
        parentId: input.issue.id,
        projectId: input.issue.projectId,
        goalId: input.issue.goalId,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        originId: input.issue.id,
        originRunId: input.latestRun?.id ?? null,
        originFingerprint: [
          STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          input.issue.companyId,
          input.issue.id,
          recoveryCause,
          input.latestRun?.id ?? "no-run",
        ].join(":"),
        billingCode: input.issue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.issue.id,
      });
    } catch (error) {
      if (!isUniqueStrandedIssueRecoveryConflict(error)) throw error;
      const raced = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
      if (!raced) throw error;
      return raced;
    }

    await deps.enqueueWakeup(ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: recovery.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: recovery.id,
        taskId: recovery.id,
        wakeReason: "issue_assigned",
        source: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
    });

    return recovery;
  }

  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
  }) {
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
    ].join(":");
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    const now = new Date();
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
      }),
      evidence: buildStrandedRecoveryActionEvidence({
        issue: input.issue,
        latestRun: input.latestRun,
        previousStatus: input.previousStatus,
        recoveryCause,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      }),
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
        },
      monitorPolicy: null,
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return action;
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    // Only the id is read; the Class B sweep re-arm path (AUR-4996) holds a
    // narrow projection of the issue row, not the full select shape.
    issue: Pick<typeof issues.$inferSelect, "id">;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }) {
    if (!input.action.ownerAgentId) return;
    await deps.enqueueWakeup(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    // AUR-5466: same backstop as escalateStrandedAssignedIssue — a recovery issue whose
    // run died at the provider wall is not evidence the recovery failed.
    if (isNonAttributableInfraRunFailure(input.latestRun)) {
      logger.info(
        {
          issueId: input.issue.id,
          latestRunId: input.latestRun?.id ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
        },
        "recovery: declining in-place recovery-issue escalation for non-attributable provider failure",
      );
      return null;
    }

    const updated = await issuesSvc.update(input.issue.id, { status: "blocked" });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    await issuesSvc.addComment(
      input.issue.id,
      buildRecoveryIssueInPlaceEscalationComment({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        prefix,
      }),
      {},
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_recovery_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        originKind: input.issue.originKind,
        originId: input.issue.originId,
      },
    });

    return updated;
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function existingUnresolvedBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    comment?: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    // AUR-5466 backstop for callers outside reconcileStrandedAssignedIssues (the
    // heartbeat promotion-blocked path and any future caller): never file blame off a
    // provider-wall failure. The reconciler's own level-triggered sweep is the revival
    // path for issues this declines to escalate.
    if (isNonAttributableInfraRunFailure(input.latestRun)) {
      logger.info(
        {
          issueId: input.issue.id,
          latestRunId: input.latestRun?.id ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
        },
        "recovery: declining stranded-issue escalation for non-attributable provider failure",
      );
      return null;
    }

    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";

    // AUR-4250: escalation cooldown.
    //
    // `reconcileStrandedAssignedIssues` has no cooldown of its own — historically the only
    // thing that stopped it re-escalating the same issue every scheduler tick was the
    // `status: "blocked"` write below dropping the issue out of the `todo`/`in_progress`
    // candidate filter. That made `blocked` load-bearing as a loop-breaker, which is why the
    // no-blocker strand could not simply be removed.
    //
    // The wake idempotency key embeds `attemptCount` (see enqueueSourceScopedStrandedRecoveryWake),
    // so every re-escalation mints a fresh key and wake-dedup can never collapse the repeats;
    // the escalation comment is gated on `attemptCount === 1`, so every repeat is silent. Each
    // repeat also refreshes `lastAttemptAt`, which keeps the AUR-4168 durable `missing_edge`
    // sweep suppressed (that sweep skips issues with a non-dormant recovery action), so the
    // issue suppresses its own backstop indefinitely.
    //
    // Gate re-escalation on the same 24h dormancy window the rest of the liveness machinery
    // uses. This is what lets the status write below stop stranding the issue.
    const existingAction = await recoveryActionsSvc.getActiveForIssue(
      input.issue.companyId,
      input.issue.id,
    );
    if (
      existingAction &&
      existingAction.kind !== "issue_graph_liveness" &&
      existingAction.lastAttemptAt &&
      new Date(existingAction.lastAttemptAt) > recoveryActionDormancyCutoff()
    ) {
      return null;
    }

    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
    });
    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);

    // AUR-4250: do not mint `blocked` with zero blocker edges.
    //
    // Per AUR-4257 a `blocked` issue with no blocker edges gets no execution at all, so writing
    // it here destroyed the very recovery path this function had just built (an invokable owner
    // plus an enqueued wake). Measured on the live fleet: 21/21 recovery-minted zero-edge blocked
    // issues had an invokable owner and an enqueued wake — nothing was actually blocked.
    //
    // When there are real unresolved blockers, `blocked` is honest — keep it. When there are none
    // but we do have an invokable recovery owner, leave the issue dispatchable and reassign it to
    // that owner; the cooldown above (not the status) is now the loop-breaker. Once attempts are
    // exhausted, fall back to `blocked`: by then the action is >24h dormant, so the AUR-4168
    // sweep is no longer suppressed and re-arms at its 7d/30d stages.
    const attemptsExhausted = recoveryAction.attemptCount > MAX_DISPATCHABLE_STRANDED_RECOVERY_ATTEMPTS;
    const keepDispatchable = blockerIds.length === 0 &&
      Boolean(recoveryAction.ownerAgentId) &&
      !attemptsExhausted;

    // AUR-5001: a `routine_execution` issue has no human review workflow and the
    // routine re-fires on its own schedule — a bare `blocked` with zero blocker
    // edges here is always wrong (AUR-4250 doctrine): there is nothing to unblock
    // it, and the umbrella just sits open forever (67 zombies in 3 days, measured).
    // This only fires once `keepDispatchable` is false (no invokable owner, or
    // attempts exhausted) AND there are no real blockers to attach — i.e. exactly
    // the zero-edge-blocked case, never the "real unresolved blocker" case above.
    if (!keepDispatchable && blockerIds.length === 0 && input.issue.originKind === "routine_execution") {
      const cancelled = await issuesSvc.update(input.issue.id, { status: "cancelled" });
      if (!cancelled) return null;
      // Dedup marker must be UNIQUE TO THIS BRANCH, not the shared
      // `Recovery action: \`<id>\`` line the ordinary escalation path also emits.
      // Attempts 1..MAX go down that path first and post that line, so keying the
      // cancellation notice on it means the notice is suppressed on essentially
      // every real issue — the cancel would land SILENTLY, which is the failure
      // mode this branch exists to avoid (retire explicitly, with a stated cause).
      // Keyed on this branch's own marker, a repeat entry still says it once.
      const cancelMarker = `routine-umbrella cancelled by recovery action \`${recoveryAction.id}\``;
      const alreadyNoticed = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, input.issue.id), eq(issueComments.authorType, "system")))
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) => (row.body ?? "").includes(cancelMarker)));
      if (!alreadyNoticed) {
        await issuesSvc.addComment(
          input.issue.id,
          [
            input.comment ?? "",
            "",
            // Carries `cancelMarker` verbatim — this line is both the human-readable
            // cause and the dedup key the re-entry check above matches on.
            `- Cancelled: ${cancelMarker}.`,
            "- This is a routine-dispatch umbrella with no live execution path and no invokable recovery owner (or recovery attempts exhausted). Cancelling instead of blocking: routine_execution issues have no dependency to unblock, and the routine re-fires on schedule — a bare `blocked` here would strand the umbrella indefinitely (AUR-5001).",
            "- Next action: none. The routine's next scheduled/manual fire will dispatch a fresh issue (or reuse this one before it terminates, per AUR-5001).",
          ].join("\n"),
          {},
          { authorType: "system" },
        );
      }
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier,
          status: "cancelled",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_stranded_assigned_issue",
          recoveryCause,
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          recoveryActionId: recoveryAction.id,
          reason: "routine_execution_zero_edge_block_avoided",
        },
      });
      return cancelled;
    }

    const nextStatus = keepDispatchable ? "todo" as const : "blocked" as const;
    const updated = await issuesSvc.update(input.issue.id, {
      status: nextStatus,
      // Only reconcile blocker edges when we are actually blocking. Passing an empty list would
      // delete every `blocks` relation, including edges to already-resolved blockers.
      ...(keepDispatchable ? {} : { blockedByIssueIds: blockerIds }),
      assigneeAgentId: recoveryAction.ownerAgentId ?? input.issue.assigneeAgentId,
    });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const recoveryOwner = recoveryAction.ownerAgentId ? await getAgent(recoveryAction.ownerAgentId) : null;
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    let notice: SuccessfulRunHandoffNotice | null = null;
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
      notice = buildSuccessfulRunHandoffExhaustedNotice({
        issue: input.issue,
        sourceRun: input.successfulRunHandoffEvidence.sourceRunId
          ? { id: input.successfulRunHandoffEvidence.sourceRunId, status: "succeeded" }
          : null,
        correctiveRun: input.latestRun ? { id: input.latestRun.id, status: input.latestRun.status } : null,
        sourceAssignee,
        recoveryIssue: null,
        recoveryActionId: recoveryAction.id,
        recoveryOwner,
        latestIssueStatus: input.issue.status,
        latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
        missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
      });
    }
    const recoveryLine = recoveryAction.ownerAgentId
      ? [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
        `- Issue status: \`${nextStatus}\`${keepDispatchable
          ? " — left dispatchable and reassigned to the recovery owner, because nothing is actually blocking it. Retries are spaced by a 24h cooldown."
          : ""}`,
        "- Next action: the recovery owner should either restore a live execution path or record the manual resolution on the source issue.",
      ].join("\n")
      : [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        "- Recovery owner: board escalation, because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
        "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
      ].join("\n");

    if (recoveryAction.attemptCount === 1) {
      const escalationCommentMarker = `Recovery action: \`${recoveryAction.id}\``;

      const hasEscalationComment = await db
        .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.authorType, "system"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) =>
          (row.body ?? "").includes(escalationCommentMarker) ||
          noticeMetadataReferencesRecoveryAction(row.metadata, recoveryAction.id),
        ));

      if (!hasEscalationComment) {
        if (notice) {
          await issuesSvc.addComment(input.issue.id, notice.body, {}, {
            authorType: "system",
            presentation: notice.presentation,
            metadata: notice.metadata,
          });
        } else {
          await issuesSvc.addComment(input.issue.id, `${input.comment ?? ""}${recoveryLine}`, {}, {
            authorType: "system",
          });
        }
      }
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "issue.successful_run_handoff_escalated"
        : "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: nextStatus,
        keptDispatchable: keepDispatchable,
        recoveryAttemptCount: recoveryAction.attemptCount,
        previousStatus: input.previousStatus,
        source: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? "recovery.reconcile_successful_run_handoff_missing_state"
          : "recovery.reconcile_stranded_assigned_issue",
        recoveryCause: input.recoveryCause ?? "stranded_assigned_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryActionId: recoveryAction.id,
        recoveryOwnerAgentId: recoveryAction.ownerAgentId,
        previousOwnerAgentId: recoveryAction.previousOwnerAgentId,
        returnOwnerAgentId: recoveryAction.returnOwnerAgentId,
        blockerIssueIds: blockerIds,
      },
    });

    await enqueueSourceScopedStrandedRecoveryWake({
      action: recoveryAction,
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
    });

    // AUR-4250: this re-assert must target `nextStatus`, not an unconditional `blocked`.
    // Re-blocking here would undo the dispatchable path chosen above.
    if (recoveryAction.ownerAgentId && recoveryAction.ownerAgentId === input.issue.assigneeAgentId) {
      const [currentIssue] = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (
        currentIssue &&
        (currentIssue.status !== nextStatus ||
          currentIssue.assigneeAgentId !== recoveryAction.ownerAgentId)
      ) {
        const reasserted = await issuesSvc.update(input.issue.id, {
          status: nextStatus,
          ...(keepDispatchable ? {} : { blockedByIssueIds: blockerIds }),
          assigneeAgentId: recoveryAction.ownerAgentId,
        });
        if (reasserted) return reasserted;
      }
    }

    return updated;
  }

  async function reconcileStrandedAssignedIssues() {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
        ),
      );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      reviewParkedSkipped: 0,
      dependencyBlockedSkipped: 0,
      // AUR-5466: failed retries whose error code is in NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES.
      // These are lane evidence, not agent evidence — requeued instead of escalated, or held
      // without requeue while the assignee's adapter is under an active quota pause.
      infraExcusedRequeued: 0,
      infraPauseHeld: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const agentId = issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== issue.companyId || !isAgentInvokable(agent)) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const latestRun = await getLatestIssueRun(issue.companyId, issue.id);
      // AUR-5466: a recovery issue whose own run died at the provider wall falls through
      // to the ordinary todo/in_progress handling below, which requeues it instead of
      // marking the recovery issue blocked-in-place off an infrastructure failure.
      if (
        isStrandedIssueRecoveryIssue(issue) &&
        isUnsuccessfulTerminalIssueRun(latestRun) &&
        !isNonAttributableInfraRunFailure(latestRun)
      ) {
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as "todo" | "in_progress",
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      // AUR-4647: every branch below this point dispatches by calling
      // deps.enqueueWakeup, which re-enters heartbeat's own
      // issue_dependencies_blocked gate and records another skipped wake if
      // the issue isn't actually ready to run. Before AUR-4647 this reconciler
      // had no memory of that outcome, so it retried the identical dispatch
      // every scheduler tick (as often as every ~15s) forever -- a storm of
      // ~11.6k/day dead wakes across two agents that also drowned out
      // GET /agents/:id/wakeup-requests' unpaginated newest-500 window.
      // Checking readiness here, fresh, each tick is edge-triggered by
      // construction: the moment a blocker resolves, the very next tick sees
      // isDependencyReady flip true and dispatches normally -- no separate
      // backoff timer or persisted cooldown state is needed.
      const dependencyReadiness = await issuesSvc.getDependencyReadiness(issue.id, db);
      if (!dependencyReadiness.isDependencyReady) {
        result.dependencyBlockedSkipped += 1;
        result.skipped += 1;
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueInitialAssignedTodoDispatch(issue, agentId);
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          if (!isNonAttributableInfraRunFailure(latestRun)) {
            const failureSummary = summarizeRunFailureForIssueComment(latestRun);
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "todo",
              latestRun,
              comment:
                "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
                `but it still has no live execution path.${failureSummary ?? ""} ` +
                "Escalating it to a recovery owner so it is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          // AUR-5466: the recovery retry died at the provider wall before the agent ran.
          // That is lane evidence, not agent evidence — do not file blame against the
          // assignee. Requeue below (the sweep is level-triggered, so this self-heals
          // once the lane recovers), unless the lane is under an active quota pause, in
          // which case requeueing would only manufacture another dead run into a lane
          // that provably cannot execute it. The pause self-expires (capped by
          // MAX_ADAPTER_QUOTA_PAUSE_MS), so a held issue is requeued on a later sweep.
          if (await findActiveAdapterQuotaPause(db, issue.companyId, agent.adapterType, new Date())) {
            result.infraPauseHeld += 1;
            result.skipped += 1;
            continue;
          }
          result.infraExcusedRequeued += 1;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !issue.checkoutRunId && !issue.executionRunId) {
        result.skipped += 1;
        continue;
      }

      if (latestRun?.errorCode === "issue_continuation_waiting_on_review") {
        result.reviewParkedSkipped += 1;
        result.skipped += 1;
        continue;
      }

      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
        if (!handoffEvidence.exhausted) {
          result.skipped += 1;
          continue;
        }

        // AUR-5466: an "exhausted" corrective handoff whose final run died at the
        // provider wall never gave the agent a chance to record a disposition — filing
        // `missing_disposition` off it blames the assignee for an outage. Fall through
        // to the continuation requeue at the bottom of this branch instead (or hold
        // under an active lane quota pause, same rule as the `todo` branch).
        if (isNonAttributableInfraRunFailure(latestRun)) {
          if (await findActiveAdapterQuotaPause(db, issue.companyId, agent.adapterType, new Date())) {
            result.infraPauseHeld += 1;
            result.skipped += 1;
            continue;
          }
          result.infraExcusedRequeued += 1;
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
            successfulRunHandoffEvidence: handoffEvidence,
          });
          if (updated) {
            result.successfulRunHandoffEscalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        const successfulRun = latestRun;

        if (!isProductiveContinuationRun(successfulRun)) {
          result.successfulContinuationObserved += 1;
          result.skipped += 1;
          continue;
        }

        if (isRepeatedProductiveContinuationRecovery(successfulRun)) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun: successfulRun,
            comment:
              "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry " +
              "made progress, but it still has no live execution path. Escalating it to a recovery owner so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
          retryOfRunId: successfulRun.id,
        });
        if (queued) {
          result.continuationRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")) {
        if (isNonAttributableInfraRunFailure(latestRun)) {
          // AUR-5466: same rule as the `todo` branch — requeue below instead of filing
          // blame. When the exhausted-handoff branch above already fell through for this
          // run, its pause check and counter increment cover this issue.
          if (!handoffEvidence) {
            if (await findActiveAdapterQuotaPause(db, issue.companyId, agent.adapterType, new Date())) {
              result.infraPauseHeld += 1;
              result.skipped += 1;
              continue;
            }
            result.infraExcusedRequeued += 1;
          }
        } else {
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            comment:
              "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
              `execution disappeared, but it still has no live execution path.${failureSummary ?? ""} ` +
              "Escalating it to a recovery owner so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId: latestRun?.id ?? issue.checkoutRunId ?? null,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    return result;
  }

  async function collectIssueGraphLivenessFindings() {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
        description: issues.description,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
    ] = await Promise.all([
      issueRowsPromise,
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            isNull(issues.hiddenAt),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            isNull(issues.hiddenAt),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
            })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
                gt(issueRecoveryActions.lastAttemptAt, recoveryActionDormancyCutoff()),
              ),
            );
      }),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (!parsed || parsed.companyId !== row.companyId) return [];
        if (parsed.state !== "blocked_by_assigned_backlog_issue") return [];
        return [
          {
            companyId: row.companyId,
            issueId: parsed.issueId,
            status: row.status,
          },
          {
            companyId: row.companyId,
            issueId: parsed.leafIssueId,
            status: row.status,
          },
        ];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    return classifyIssueGraphLiveness({
      issues: issueRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues: openRecoveryIssues.concat(recoveryActionRows),
      now: new Date(),
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof issues.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return false;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return false;
    await issuesSvc.update(sourceIssue.id, {
      blockedByIssueIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
    return true;
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  async function retireObsoleteLivenessRecoveryIssues(findings: IssueLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
    }

    return result;
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  async function loadLivenessDependencyUpdatedAtByIssue(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => finding.dependencyPath.map((entry) => entry.issueId)),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.updatedAt,
    ]));
  }

  function latestDependencyUpdatedAtForLivenessFinding(
    finding: IssueLivenessFinding,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds.map((issueId) =>
      updatedAtByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)) ?? null
    );
    if (timestamps.some((timestamp) => !timestamp)) return null;
    const [firstTimestamp, ...remainingTimestamps] = timestamps as Date[];
    return remainingTimestamps.reduce((latest, updatedAt) =>
      updatedAt > latest ? updatedAt : latest,
    firstTimestamp!);
  }

  function isLivenessFindingInsideAutoRecoveryLookback(
    finding: IssueLivenessFinding,
    cutoff: Date,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const latestUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(finding, updatedAtByIssueKey);
    return Boolean(latestUpdatedAt && latestUpdatedAt >= cutoff);
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedOutsideLookback = 0;

    for (const finding of findings) {
      const latestDependencyUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(
        finding,
        updatedAtByIssueKey,
      );
      if (!latestDependencyUpdatedAt || latestDependencyUpdatedAt < cutoff) {
        skippedOutsideLookback += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: latestDependencyUpdatedAt.toISOString(),
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: cutoff.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback,
      items,
    };
  }

  function sortDurableBlockedIssueDirectBlockers(
    blockers: DurableBlockedIssueDirectBlocker[],
  ): DurableBlockedIssueDirectBlocker[] {
    return [...blockers].sort((left, right) => {
      const leftLabel = left.identifier ?? left.title ?? left.blockerIssueId;
      const rightLabel = right.identifier ?? right.title ?? right.blockerIssueId;
      return leftLabel.localeCompare(rightLabel);
    });
  }

  function missingBlockerEdgeStageForAge(staleAgeMs: number): MissingBlockerEdgeStage {
    if (staleAgeMs >= MISSING_BLOCKER_EDGE_ESCALATION_AGE_MS) return "escalate_owner";
    if (staleAgeMs >= MISSING_BLOCKER_EDGE_REMINDER_AGE_MS) return "wake_assignee";
    return "none";
  }

  async function loadDurableBlockedEnteredAtByIssue(blockedIssues: DurableBlockedIssueRow[]) {
    type BlockedEnteredAtEntry = { at: Date; source: DurableBlockedEnteredAtSource };
    if (blockedIssues.length === 0) return new Map<string, BlockedEnteredAtEntry>();

    const blockedIssueIds = blockedIssues.map((issue) => issue.id);
    const rows = await db
      .select({
        issueId: activityLog.entityId,
        blockedEnteredAt: sql<Date>`MAX(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, blockedIssueIds),
          inArray(activityLog.action, ["issue.created", "issue.updated"]),
          // Two write shapes carry a blocked transition. Direct issue writes
          // put the new status at `details.status`; the plugin host's
          // `issues.update` logs `issue.updated` with
          // `details: { identifier, patch, _previous }`, so a plugin-driven
          // block only shows up at `details.patch.status`. `_previous.status`
          // is deliberately NOT matched — that is the status the issue left,
          // so matching it would read the wrong transition.
          sql`(${activityLog.details} ->> 'status' = 'blocked' OR ${activityLog.details} -> 'patch' ->> 'status' = 'blocked')`,
        ),
      )
      .groupBy(activityLog.entityId);

    // No activity_log row carries the blocked transition for this issue (some
    // svc.update() paths omit `status` from the details entirely). Fall back to
    // issues.createdAt: it is monotone and, unlike issues.updatedAt, immune to
    // comment recency (issues.addComment deliberately bumps updatedAt, which
    // made blocked-staleness a function of how chatty the issue was and could
    // cancel a live escalation). A createdAt-derived timestamp over-estimates
    // staleness, so it is allowed to escalate but never to cancel — see the
    // stage === "none" branch. The fallback is counted so it shows up in the
    // reconciler counters instead of silently shaping a decision.
    const blockedEnteredAtByIssueId = new Map<string, BlockedEnteredAtEntry>(
      blockedIssues.map((issue) => [
        issue.id,
        { at: issue.createdAt, source: "fallback_created_at" as const },
      ]),
    );
    for (const row of rows) {
      if (!row.blockedEnteredAt) continue;
      const blockedEnteredAt =
        row.blockedEnteredAt instanceof Date
          ? row.blockedEnteredAt
          : new Date(row.blockedEnteredAt);
      if (!Number.isNaN(blockedEnteredAt.getTime())) {
        blockedEnteredAtByIssueId.set(row.issueId, {
          at: blockedEnteredAt,
          source: "activity_log",
        });
      }
    }
    return blockedEnteredAtByIssueId;
  }

  async function collectDurableBlockedIssueClassifications(
    now: Date,
  ): Promise<DurableBlockedIssueClassification[]> {
    const blockedIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "blocked"),
          isNull(issues.hiddenAt),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      );
    if (blockedIssues.length === 0) return [];

    const blockedIssueIds = blockedIssues.map((issue) => issue.id);
    const blockedEnteredAtByIssueId = await loadDurableBlockedEnteredAtByIssue(blockedIssues);
    const explicitBlockers = await db
      .select({
        blockedIssueId: issueRelations.relatedIssueId,
        blockerIssueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, blockedIssueIds),
          isNull(issues.hiddenAt),
        ),
      );
    const childBlockers = await db
      .select({
        blockedIssueId: issues.parentId,
        blockerIssueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          inArray(issues.parentId, blockedIssueIds),
        ),
      );

    const directBlockersByIssueId = new Map<string, Map<string, DurableBlockedIssueDirectBlocker>>();
    const explicitBlockerIdsByIssueId = new Map<string, Set<string>>();
    for (const row of explicitBlockers) {
      const blockerIds = explicitBlockerIdsByIssueId.get(row.blockedIssueId) ?? new Set<string>();
      blockerIds.add(row.blockerIssueId);
      explicitBlockerIdsByIssueId.set(row.blockedIssueId, blockerIds);
    }
    for (const row of [...explicitBlockers, ...childBlockers]) {
      if (!row.blockedIssueId) continue;
      const byBlockerId = directBlockersByIssueId.get(row.blockedIssueId) ?? new Map();
      if (!byBlockerId.has(row.blockerIssueId)) {
        byBlockerId.set(row.blockerIssueId, row);
      }
      directBlockersByIssueId.set(row.blockedIssueId, byBlockerId);
    }

    return blockedIssues.map((issue) => {
      const directBlockers = sortDurableBlockedIssueDirectBlockers(
        [...(directBlockersByIssueId.get(issue.id)?.values() ?? [])],
      );
      const hasFirstClassBlockerEdge = (explicitBlockerIdsByIssueId.get(issue.id)?.size ?? 0) > 0;
      // The loader seeds an entry for every issue it is handed, so this default
      // is unreachable; it is kept only so the lookup stays total, and it
      // matches the loader's own fallback exactly rather than reporting a
      // different (updatedAt-derived) source.
      const blockedEnteredAtEntry = blockedEnteredAtByIssueId.get(issue.id)
        ?? { at: issue.createdAt, source: "fallback_created_at" as const };
      const blockedEnteredAt = blockedEnteredAtEntry.at;
      const kind: DurableBlockedIssueClassificationKind =
        directBlockers.length === 0
          ? "missing_edge"
          : !hasFirstClassBlockerEdge
            ? "missing_edge"
            : directBlockers.every((blocker) => DIRECT_BLOCKER_TERMINAL_STATUSES.has(blocker.status))
            ? "terminal_only"
            : "open_non_terminal";
      return {
        issue,
        kind,
        directBlockers,
        blockedEnteredAt,
        blockedEnteredAtSource: blockedEnteredAtEntry.source,
        staleAgeMs: Math.max(0, now.getTime() - blockedEnteredAt.getTime()),
      };
    });
  }

  async function loadActiveIssueGraphLivenessRecoveryActions(sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, typeof issueRecoveryActions.$inferSelect>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          eq(issueRecoveryActions.kind, "issue_graph_liveness"),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, typeof issueRecoveryActions.$inferSelect>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, row);
    }
    return result;
  }

  /**
   * Dormant `stranded_assigned_issue` actions on blocked issues (AUR-4996).
   *
   * `reconcileStrandedAssignedIssues` only scans `todo`/`in_progress`, so once its
   * escalation parks an issue in `blocked` the action it minted can never re-arm
   * through that loop — and `loadAnyActiveRecoveryActions` above deliberately
   * excludes dormant rows (AUR-4300), so these issues sail past the
   * classBSkippedOtherRecoveryAction guard and used to land in classBNoop
   * forever. Measured live 2026-08-06: 202 of 235 blocked-issue recovery actions
   * were dormant stranded rows, 171 of them below the 7d attention stage.
   * A `lastAttemptAt` of null has never fired at all, so it counts as dormant.
   */
  async function loadDormantStrandedRecoveryActions(sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, typeof issueRecoveryActions.$inferSelect>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(
            isNull(issueRecoveryActions.lastAttemptAt),
            lte(issueRecoveryActions.lastAttemptAt, recoveryActionDormancyCutoff()),
          ),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, typeof issueRecoveryActions.$inferSelect>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, row);
    }
    return result;
  }

  async function loadAnyActiveRecoveryActions(sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, typeof issueRecoveryActions.$inferSelect>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          gt(issueRecoveryActions.lastAttemptAt, recoveryActionDormancyCutoff()),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, typeof issueRecoveryActions.$inferSelect>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, row);
    }
    return result;
  }

  async function loadDurableMissingBlockerEscalationOwners(issuesNeedingOwners: DurableBlockedIssueRow[]) {
    const companyIds = [...new Set(issuesNeedingOwners.map((issue) => issue.companyId))];
    const projectIds = [
      ...new Set(
        issuesNeedingOwners
          .map((issue) => issue.projectId)
          .filter((projectId): projectId is string => Boolean(projectId)),
      ),
    ];
    const [projectRows, agentRows] = await Promise.all([
      projectIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; companyId: string; leadAgentId: string | null }>)
        : db
            .select({ id: projects.id, companyId: projects.companyId, leadAgentId: projects.leadAgentId })
            .from(projects)
            .where(inArray(projects.id, projectIds)),
      companyIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; companyId: string; role: string; status: string; reportsTo: string | null }>)
        : db
            .select({
              id: agents.id,
              companyId: agents.companyId,
              role: agents.role,
              status: agents.status,
              reportsTo: agents.reportsTo,
            })
            .from(agents)
            .where(inArray(agents.companyId, companyIds)),
    ]);

    const invokableAgentById = new Map(
      agentRows
        .filter((agent) => ["active", "idle", "running", "error"].includes(agent.status))
        .map((agent) => [agent.id, agent]),
    );
    const projectLeadByProjectId = new Map<string, string>();
    for (const project of projectRows) {
      if (!project.leadAgentId) continue;
      const lead = invokableAgentById.get(project.leadAgentId);
      if (!lead || lead.companyId !== project.companyId) continue;
      projectLeadByProjectId.set(project.id, project.leadAgentId);
    }

    const fallbackOwnerByCompanyId = new Map<string, string>();
    const rootsByCompanyId = new Map<string, Array<{ id: string; role: string }>>();
    for (const agent of invokableAgentById.values()) {
      if (agent.reportsTo) continue;
      const list = rootsByCompanyId.get(agent.companyId) ?? [];
      list.push({ id: agent.id, role: agent.role });
      rootsByCompanyId.set(agent.companyId, list);
    }
    for (const [companyId, roots] of rootsByCompanyId) {
      roots.sort((left, right) => {
        const leftRank = left.role === "ceo" ? 0 : 1;
        const rightRank = right.role === "ceo" ? 0 : 1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return left.id.localeCompare(right.id);
      });
      if (roots[0]) fallbackOwnerByCompanyId.set(companyId, roots[0].id);
    }

    return {
      projectLeadByProjectId,
      fallbackOwnerByCompanyId,
    };
  }

  function buildDurableMissingBlockerActionFingerprint(input: {
    issueId: string;
    stage: Exclude<MissingBlockerEdgeStage, "none">;
    ownerAgentId: string | null;
  }) {
    return `issue_graph_liveness:${input.issueId}:missing_blocker_edge:${input.stage}:${input.ownerAgentId ?? "board"}`;
  }

  /**
   * Identity of the blocker set that justified a Class A auto-recovery. A new
   * or removed blocker edge is new information and earns a fresh recovery; the
   * same edges re-observed after a re-block do not.
   */
  function buildClassABlockerSetFingerprint(blockerIssueIds: string[]) {
    return [...new Set(blockerIssueIds)].sort().join(",");
  }

  function buildClassAOscillationActionFingerprint(input: {
    issueId: string;
    blockerSetFingerprint: string;
    ownerAgentId: string | null;
  }) {
    return `issue_graph_liveness:${input.issueId}:class_a_oscillation:${input.blockerSetFingerprint}:${input.ownerAgentId ?? "board"}`;
  }

  /**
   * Prior Class A *decisions* inside the rolling window, keyed by issue: either
   * an actual auto-recovery (`issue.updated` blocked -> todo) or a capped
   * decision (`issue.recovery_class_a_capped`). Derived from `activity_log` rows
   * the Class A path already writes, so this needs no new table. Rows written
   * before the fingerprint was recorded fall back to deriving it from the logged
   * blocker summaries.
   *
   * Matching the capped marker too is what makes the window self-refreshing: a
   * persistently re-blocked issue keeps extending it and stays capped, instead
   * of ageing out of a recovery-only window and re-flipping every 7 days.
   */
  async function loadRecentClassAAutoRecoveryFingerprints(
    issueIds: string[],
    since: Date,
  ): Promise<Map<string, Set<string>>> {
    const byIssueId = new Map<string, Set<string>>();
    if (issueIds.length === 0) return byIssueId;

    const rows = await db
      .select({
        issueId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, [...new Set(issueIds)]),
          inArray(activityLog.action, ["issue.updated", "issue.recovery_class_a_capped"]),
          gte(activityLog.createdAt, since),
          sql`${activityLog.details} ->> 'source' = 'recovery.reconcile_issue_graph_liveness'`,
          sql`(
            (${activityLog.action} = 'issue.updated'
              AND ${activityLog.details} ->> 'previousStatus' = 'blocked'
              AND ${activityLog.details} ->> 'status' = 'todo')
            OR ${activityLog.action} = 'issue.recovery_class_a_capped'
          )`,
        ),
      );

    for (const row of rows) {
      if (!row.issueId) continue;
      const details = (row.details ?? {}) as Record<string, unknown>;
      const recorded = readNonEmptyString(details.classABlockerSetFingerprint);
      const fingerprint = recorded ?? buildClassABlockerSetFingerprint(
        Array.isArray(details.blockerSummaries)
          ? (details.blockerSummaries as Array<Record<string, unknown>>)
              .map((summary) => readNonEmptyString(summary?.issueId))
              .filter((issueId): issueId is string => Boolean(issueId))
          : [],
      );
      const set = byIssueId.get(row.issueId) ?? new Set<string>();
      set.add(fingerprint);
      byIssueId.set(row.issueId, set);
    }
    return byIssueId;
  }

  async function resolveDurableIssueGraphLivenessAction(input: {
    action: typeof issueRecoveryActions.$inferSelect;
    sourceIssue: DurableBlockedIssueRow;
    status: "resolved" | "cancelled";
    outcome: "restored" | "blocked" | "cancelled";
    resolutionNote: string;
    runId?: string | null;
  }) {
    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.action.companyId,
      sourceIssueId: input.action.sourceIssueId,
      actionId: input.action.id,
      status: input.status,
      outcome: input.outcome,
      resolutionNote: input.resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        identifier: input.sourceIssue.identifier,
        recoveryActionId: resolved.id,
        recoveryActionStatus: resolved.status,
        outcome: resolved.outcome,
        resolutionNote: resolved.resolutionNote,
        source: "recovery.reconcile_issue_graph_liveness",
      },
    });

    return resolved;
  }

  async function reconcileDurableBlockedIssueAttention(input: {
    now: Date;
    runId?: string | null;
  }) {
    const classifications = await collectDurableBlockedIssueClassifications(input.now);
    const sourceIssueIds = classifications.map((classification) => classification.issue.id);

    const result = {
      blockedIssuesScanned: classifications.length,
      terminalOnlyIssues: 0,
      missingEdgeIssues: 0,
      openNonTerminalIssues: 0,
      classAAutoRecovered: 0,
      classAOscillationCapped: 0,
      classBNudged: 0,
      classBEscalated: 0,
      classBNoop: 0,
      classBBoardOnly: 0,
      classBSkippedOtherRecoveryAction: 0,
      classBStrandedRearmed: 0,
      classBStrandedRearmDeferredCap: 0,
      classBStrandedResolvedBlockerGoverned: 0,
      blockedEnteredAtFallbacks: 0,
      issueGraphRecoveryActionsResolved: 0,
      actionErrors: 0,
      errorIssueIds: [] as string[],
      classAIssueIds: [] as string[],
      classBNudgedIssueIds: [] as string[],
      classBEscalatedIssueIds: [] as string[],
      classBStrandedRearmedIssueIds: [] as string[],
    };

    // These pre-loop loaders used to sit outside every try/catch. A throw here
    // (a transient DB error, say) aborted the whole reconciler while reporting
    // actionErrors: 0, and because reconcileIssueGraphLiveness sits mid-chain in
    // the periodic heartbeat it also skipped the scans that run after it. Degrade
    // instead: record one action error so the tick still logs (actionErrors is in
    // the log gate) and let the caller's chain continue.
    const prescan = await (async () => {
      try {
        const [graphLivenessActions, anyActiveActions, dormantStrandedActions] = await Promise.all([
          loadActiveIssueGraphLivenessRecoveryActions(sourceIssueIds),
          loadAnyActiveRecoveryActions(sourceIssueIds),
          loadDormantStrandedRecoveryActions(sourceIssueIds),
        ]);
        // Owner resolution is needed for every issue that can end up needing an
        // owner: 30-day escalations, capped Class A downgrades, and the
        // wake_assignee stage when the issue is assigned to a user (no agent).
        const ownerMaps = await loadDurableMissingBlockerEscalationOwners(
          classifications.map((classification) => classification.issue),
        );
        const recentClassAFingerprintsByIssueId = await loadRecentClassAAutoRecoveryFingerprints(
          classifications
            .filter((classification) => classification.kind === "terminal_only")
            .map((classification) => classification.issue.id),
          new Date(input.now.getTime() - CLASS_A_OSCILLATION_WINDOW_MS),
        );
        return {
          ok: true as const,
          graphLivenessActions,
          anyActiveActions,
          dormantStrandedActions,
          ownerMaps,
          recentClassAFingerprintsByIssueId,
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();

    if (!prescan.ok) {
      result.actionErrors += 1;
      logger.error({
        err: prescan.error,
        blockedIssuesScanned: classifications.length,
      }, "durable blocked-issue prescan failed; skipping actuation for this tick");
      return result;
    }

    const {
      graphLivenessActions,
      anyActiveActions,
      dormantStrandedActions,
      ownerMaps,
      recentClassAFingerprintsByIssueId,
    } = prescan;

    const resolveFallbackOwnerAgentId = (issue: DurableBlockedIssueRow) => (
      issue.projectId
        ? ownerMaps.projectLeadByProjectId.get(issue.projectId) ?? null
        : null
    ) ?? ownerMaps.fallbackOwnerByCompanyId.get(issue.companyId) ?? null;

    /** Upsert the issue_graph_liveness attention action and wake its owner. */
    async function upsertDurableAttentionAction(args: {
      classification: DurableBlockedIssueClassification;
      ownerAgentId: string | null;
      fingerprint: string;
      stage: string;
      nextAction: string;
      extraEvidence?: Record<string, unknown>;
    }) {
      const { classification, ownerAgentId, stage } = args;
      const action = await recoveryActionsSvc.upsertSourceScoped({
        companyId: classification.issue.companyId,
        sourceIssueId: classification.issue.id,
        kind: "issue_graph_liveness",
        ownerType: ownerAgentId ? "agent" : "board",
        ownerAgentId,
        previousOwnerAgentId: classification.issue.assigneeAgentId,
        returnOwnerAgentId: classification.issue.assigneeAgentId,
        cause: "issue_graph_liveness",
        fingerprint: args.fingerprint,
        evidence: {
          durableBlockerClassification: classification.kind,
          sourceIssueId: classification.issue.id,
          sourceIdentifier: classification.issue.identifier,
          sourceIssueStatus: classification.issue.status,
          blockedEnteredAt: classification.blockedEnteredAt.toISOString(),
          blockedEnteredAtSource: classification.blockedEnteredAtSource,
          staleAgeMs: classification.staleAgeMs,
          directBlockerCount: classification.directBlockers.length,
          stage,
          ...args.extraEvidence,
        },
        nextAction: args.nextAction,
        wakePolicy: ownerAgentId
          ? { type: "wake_owner", reason: "issue_graph_liveness", ownerAgentId, stage }
          : { type: "board_escalation", reason: "issue_graph_liveness", stage },
        monitorPolicy: null,
        maxAttempts: null,
        lastAttemptAt: input.now,
      });

      await logActivity(db, {
        companyId: classification.issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: ownerAgentId,
        runId: input.runId ?? null,
        action: "issue.recovery_action_upserted",
        entityType: "issue",
        entityId: classification.issue.id,
        details: {
          identifier: classification.issue.identifier,
          recoveryActionId: action.id,
          recoveryActionKind: action.kind,
          recoveryActionOwnerAgentId: action.ownerAgentId,
          recoveryActionAttemptCount: action.attemptCount,
          source: "recovery.reconcile_issue_graph_liveness",
          durableBlockerClassification: classification.kind,
          stage,
        },
      });

      if (ownerAgentId) {
        await deps.enqueueWakeup(ownerAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "source_scoped_recovery_action",
          idempotencyKey: `issue_graph_liveness:${action.id}:${action.attemptCount}`,
          payload: withRecoveryModelProfileHint({
            issueId: classification.issue.id,
            sourceIssueId: classification.issue.id,
            recoveryActionId: action.id,
            recoveryCause: "issue_graph_liveness",
            issueGraphLivenessStage: stage,
          }),
          requestedByActorType: "system",
          requestedByActorId: null,
          contextSnapshot: withRecoveryModelProfileHint({
            issueId: classification.issue.id,
            taskId: classification.issue.id,
            wakeReason: "source_scoped_recovery_action",
            skipIssueComment: true,
            source: "issue_recovery_action",
            recoveryActionId: action.id,
            sourceIssueId: classification.issue.id,
            recoveryCause: "issue_graph_liveness",
            issueGraphLivenessStage: stage,
          }),
        });
      }

      return action;
    }

    // AUR-4996: per-run budget for stranded re-arm wakes. See
    // CLASS_B_STRANDED_REARM_PER_RUN_CAP for why this is capped.
    let strandedRearmsThisRun = 0;

    /**
     * Re-fire a dormant `stranded_assigned_issue` action in place: bump the
     * attempt, refresh `lastAttemptAt`, and re-enqueue the recovery-owner wake
     * the stranded loop would have sent. The refreshed `lastAttemptAt` makes
     * the action non-dormant, so the next sweep noops it for 24h — the
     * dormancy window is the retry spacing, exactly as it is for the
     * `todo`-path escalation cooldown. Returns false when the action lost the
     * race to a concurrent resolve.
     */
    async function rearmDormantStrandedAction(args: {
      classification: DurableBlockedIssueClassification;
      action: typeof issueRecoveryActions.$inferSelect;
    }) {
      const { classification, action } = args;
      const rearmed = await recoveryActionsSvc.rearmActiveForIssue({
        companyId: classification.issue.companyId,
        sourceIssueId: classification.issue.id,
        actionId: action.id,
        lastAttemptAt: input.now,
      });
      if (!rearmed) return false;

      await logActivity(db, {
        companyId: classification.issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: rearmed.ownerAgentId,
        runId: input.runId ?? null,
        action: "issue.recovery_action_rearmed",
        entityType: "issue",
        entityId: classification.issue.id,
        details: {
          identifier: classification.issue.identifier,
          recoveryActionId: rearmed.id,
          recoveryActionKind: rearmed.kind,
          recoveryActionOwnerAgentId: rearmed.ownerAgentId,
          recoveryActionAttemptCount: rearmed.attemptCount,
          source: "recovery.reconcile_issue_graph_liveness",
          durableBlockerClassification: classification.kind,
          stage: "class_b_stranded_rearm",
        },
      });

      await enqueueSourceScopedStrandedRecoveryWake({
        action: rearmed,
        issue: { id: classification.issue.id },
        latestRun: null,
        recoveryCause: "stranded_assigned_issue",
      });
      return true;
    }

    for (const classification of classifications) {
      if (classification.kind === "terminal_only") result.terminalOnlyIssues += 1;
      else if (classification.kind === "missing_edge") result.missingEdgeIssues += 1;
      else result.openNonTerminalIssues += 1;

      if (classification.blockedEnteredAtSource === "fallback_created_at") {
        result.blockedEnteredAtFallbacks += 1;
      }

      const graphLivenessAction = graphLivenessActions.get(classification.issue.id) ?? null;
      const anyActiveAction = anyActiveActions.get(classification.issue.id) ?? null;

      try {
        if (classification.kind === "terminal_only") {
          const blockerSetFingerprint = buildClassABlockerSetFingerprint(
            classification.directBlockers.map((blocker) => blocker.blockerIssueId),
          );
          const alreadyAutoRecovered =
            recentClassAFingerprintsByIssueId
              .get(classification.issue.id)
              ?.has(blockerSetFingerprint) ?? false;

          if (alreadyAutoRecovered) {
            // The issue was already auto-recovered off this exact blocker set
            // inside the window and is blocked again, so the terminal edges are
            // no longer the real gate. Downgrade to Class B rather than
            // flipping it back and re-posting the same comment: a capped and
            // silent path would reintroduce the inert-detector failure this
            // line of work exists to kill.
            result.classAOscillationCapped += 1;

            // Refresh the window. Without this marker the window measured
            // "time since the last Class A *recovery*", so 7 days after the last
            // genuine recovery alreadyAutoRecovered flipped back to false and
            // Class A force-flipped the issue again — oscillation throttled to
            // weekly rather than ended. The marker makes the window measure
            // "time since the last Class A *decision*", so every capped tick
            // extends it. It is a distinct action, NOT an `issue.updated` with a
            // fabricated `status: "todo"`: no status change happened here, and
            // faking one would corrupt the blocked-transition history that
            // loadDurableBlockedEnteredAtByIssue reads.
            await logActivity(db, {
              companyId: classification.issue.companyId,
              actorType: "system",
              actorId: "system",
              agentId: null,
              runId: input.runId ?? null,
              action: "issue.recovery_class_a_capped",
              entityType: "issue",
              entityId: classification.issue.id,
              details: {
                identifier: classification.issue.identifier,
                source: "recovery.reconcile_issue_graph_liveness",
                durableBlockerClassification: classification.kind,
                stage: "class_a_oscillation_capped",
                classABlockerSetFingerprint: blockerSetFingerprint,
                classAOscillationWindowMs: CLASS_A_OSCILLATION_WINDOW_MS,
              },
            });

            if (anyActiveAction && anyActiveAction.kind !== "issue_graph_liveness") {
              result.classBSkippedOtherRecoveryAction += 1;
              continue;
            }

            const ownerAgentId = classification.issue.assigneeAgentId
              ?? resolveFallbackOwnerAgentId(classification.issue);
            const fingerprint = buildClassAOscillationActionFingerprint({
              issueId: classification.issue.id,
              blockerSetFingerprint,
              ownerAgentId,
            });
            if (graphLivenessAction?.fingerprint === fingerprint) {
              result.classBNoop += 1;
              continue;
            }
            if (!ownerAgentId) result.classBBoardOnly += 1;

            await upsertDurableAttentionAction({
              classification,
              ownerAgentId,
              fingerprint,
              stage: "class_a_oscillation_capped",
              nextAction:
                "This issue keeps being re-blocked with only terminal blocker edges. Attach a real first-class blocker or state the gate in the issue instead of leaving it blocked.",
              extraEvidence: {
                classABlockerSetFingerprint: blockerSetFingerprint,
                classAOscillationWindowMs: CLASS_A_OSCILLATION_WINDOW_MS,
              },
            });
            continue;
          }

          const updatedIssue = await issuesSvc.update(classification.issue.id, { status: "todo" });
          if (!updatedIssue) continue;

          result.classAAutoRecovered += 1;
          pushBoundedIssueId(result.classAIssueIds, classification.issue.id);

          const blockerSummaries = classification.directBlockers.map((blocker) => ({
            issueId: blocker.blockerIssueId,
            identifier: blocker.identifier,
            status: blocker.status,
          }));
          const commentBody = [
            "Recovered automatically from `blocked` to `todo`.",
            "",
            "All direct blocker edges on this issue are now terminal:",
            ...classification.directBlockers.map((blocker) =>
              `- \`${blocker.identifier ?? blocker.blockerIssueId}\` (\`${blocker.status}\`)`,
            ),
          ].join("\n");
          await issuesSvc.addComment(classification.issue.id, commentBody, {}, { authorType: "system" });

          await logActivity(db, {
            companyId: classification.issue.companyId,
            actorType: "system",
            actorId: "system",
            agentId: null,
            runId: input.runId ?? null,
            action: "issue.updated",
            entityType: "issue",
            entityId: classification.issue.id,
            details: {
              identifier: classification.issue.identifier,
              status: "todo",
              source: "recovery.reconcile_issue_graph_liveness",
              durableBlockerClassification: classification.kind,
              previousStatus: "blocked",
              blockerSummaries,
              classABlockerSetFingerprint: blockerSetFingerprint,
            },
          });

          if (classification.issue.assigneeAgentId) {
            const resolvedBlockerIssueId = classification.directBlockers[0]?.blockerIssueId ?? null;
            await deps.enqueueWakeup(classification.issue.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_blockers_resolved",
              payload: {
                issueId: classification.issue.id,
                resolvedBlockerIssueId,
                blockerIssueIds: classification.directBlockers.map((blocker) => blocker.blockerIssueId),
              },
              requestedByActorType: "system",
              requestedByActorId: null,
              contextSnapshot: {
                issueId: classification.issue.id,
                taskId: classification.issue.id,
                wakeReason: "issue_blockers_resolved",
                source: "issue.blockers_resolved",
                resolvedBlockerIssueId,
                blockerIssueIds: classification.directBlockers.map((blocker) => blocker.blockerIssueId),
              },
            });
          }

          if (graphLivenessAction) {
            const resolved = await resolveDurableIssueGraphLivenessAction({
              action: graphLivenessAction,
              sourceIssue: classification.issue,
              status: "resolved",
              outcome: "restored",
              resolutionNote: "Resolved automatically because all direct blockers are terminal.",
              runId: input.runId ?? null,
            });
            if (resolved) result.issueGraphRecoveryActionsResolved += 1;
          }
          continue;
        }

        if (classification.kind === "open_non_terminal") {
          if (graphLivenessAction) {
            const resolved = await resolveDurableIssueGraphLivenessAction({
              action: graphLivenessAction,
              sourceIssue: classification.issue,
              status: "resolved",
              outcome: "blocked",
              resolutionNote: "Resolved automatically because the source issue now has a non-terminal direct blocker edge.",
              runId: input.runId ?? null,
            });
            if (resolved) result.issueGraphRecoveryActionsResolved += 1;
          }

          // AUR-4996: a dormant stranded action on a genuinely-blocked issue is
          // dead bookkeeping — the open blocker's lifecycle governs the issue
          // now (Class A flips it back to todo when the blockers go terminal),
          // and re-waking a recovery owner who can do nothing until then would
          // be noise. Retire it; if the issue strands again after unblocking,
          // `ensureSourceScopedStrandedRecoveryAction` mints a fresh action.
          const dormantStranded = dormantStrandedActions.get(classification.issue.id);
          if (dormantStranded) {
            const resolvedStranded = await recoveryActionsSvc.resolveActiveForIssue({
              companyId: classification.issue.companyId,
              sourceIssueId: classification.issue.id,
              actionId: dormantStranded.id,
              status: "resolved",
              outcome: "blocked",
              resolutionNote:
                "Resolved automatically: the source issue is governed by an open first-class blocker, so stranded-issue recovery no longer applies.",
            });
            if (resolvedStranded) {
              result.classBStrandedResolvedBlockerGoverned += 1;
              await logActivity(db, {
                companyId: classification.issue.companyId,
                actorType: "system",
                actorId: "system",
                agentId: null,
                runId: input.runId ?? null,
                action: "issue.recovery_action_resolved",
                entityType: "issue",
                entityId: classification.issue.id,
                details: {
                  identifier: classification.issue.identifier,
                  recoveryActionId: resolvedStranded.id,
                  recoveryActionKind: resolvedStranded.kind,
                  source: "recovery.reconcile_issue_graph_liveness",
                  durableBlockerClassification: classification.kind,
                  stage: "class_b_stranded_resolved_blocker_governed",
                },
              });
            }
          }
          result.classBNoop += 1;
          continue;
        }

        const stage = missingBlockerEdgeStageForAge(classification.staleAgeMs);
        if (stage === "none") {
          // A fallback-derived blockedEnteredAt may escalate but must NEVER
          // cancel. The fallback (issues.createdAt) is only a bound on when the
          // issue entered blocked, so "entered blocked recently" is a guess —
          // and acting on that guess here would silently retire a live
          // escalation action. The asymmetry is deliberate: a false positive
          // costs one wake, a false negative disables the detector.
          if (graphLivenessAction && classification.blockedEnteredAtSource !== "activity_log") {
            result.classBNoop += 1;
            continue;
          }
          if (graphLivenessAction) {
            const resolved = await resolveDurableIssueGraphLivenessAction({
              action: graphLivenessAction,
              sourceIssue: classification.issue,
              status: "cancelled",
              outcome: "cancelled",
              resolutionNote: "Cancelled automatically because the source issue entered blocked recently and is below the stale-age threshold.",
              runId: input.runId ?? null,
            });
            if (resolved) result.issueGraphRecoveryActionsResolved += 1;
          }

          // AUR-4996: below the 7d attention stage, a missing-edge blocked
          // issue whose stranded action has gone dormant has NO other live
          // recovery path: the stranded loop cannot see blocked issues, and
          // this sweep used to noop it here until the 7d stage. Re-fire the
          // stranded wake instead, spaced by the 24h dormancy window and
          // capped per run. Board-owned actions (no ownerAgentId) are left to
          // the attention ladder — there is no one to wake.
          const dormantStranded = dormantStrandedActions.get(classification.issue.id);
          if (dormantStranded?.ownerAgentId) {
            if (strandedRearmsThisRun >= CLASS_B_STRANDED_REARM_PER_RUN_CAP) {
              result.classBStrandedRearmDeferredCap += 1;
              continue;
            }
            strandedRearmsThisRun += 1;
            if (await rearmDormantStrandedAction({ classification, action: dormantStranded })) {
              result.classBStrandedRearmed += 1;
              pushBoundedIssueId(result.classBStrandedRearmedIssueIds, classification.issue.id);
              continue;
            }
          }
          result.classBNoop += 1;
          continue;
        }

        if (anyActiveAction && anyActiveAction.kind !== "issue_graph_liveness") {
          result.classBSkippedOtherRecoveryAction += 1;
          continue;
        }

        // At the wake_assignee stage an issue assigned to a *user* has no
        // assigneeAgentId. Falling straight through to ownerType "board" woke
        // nobody, and the resulting action was indistinguishable from a nudge
        // that actually reached someone. Route to the project lead / company
        // root like the 30-day stage does, and only then fall back to board —
        // counted distinctly so it is never a silent no-op.
        const ownerAgentId = stage === "wake_assignee"
          ? classification.issue.assigneeAgentId ?? resolveFallbackOwnerAgentId(classification.issue)
          : resolveFallbackOwnerAgentId(classification.issue);
        const fingerprint = buildDurableMissingBlockerActionFingerprint({
          issueId: classification.issue.id,
          stage,
          ownerAgentId,
        });

        if (graphLivenessAction?.fingerprint === fingerprint) {
          result.classBNoop += 1;
          continue;
        }
        if (!ownerAgentId) result.classBBoardOnly += 1;

        await upsertDurableAttentionAction({
          classification,
          ownerAgentId,
          fingerprint,
          stage,
          nextAction: stage === "wake_assignee"
            ? "Attach a real first-class blocker to this issue or move it out of blocked."
            : "Review this stale blocked issue, attach a real first-class blocker, or move it out of blocked.",
        });

        if (stage === "wake_assignee") {
          result.classBNudged += 1;
          pushBoundedIssueId(result.classBNudgedIssueIds, classification.issue.id);
        } else {
          result.classBEscalated += 1;
          pushBoundedIssueId(result.classBEscalatedIssueIds, classification.issue.id);
        }
      } catch (error) {
        result.actionErrors += 1;
        result.errorIssueIds.push(classification.issue.id);
        logger.error({
          err: error,
          issueId: classification.issue.id,
          issueIdentifier: classification.issue.identifier,
          durableBlockerClassification: classification.kind,
        }, "durable blocked-issue actuation failed");
      }
    }

    return result;
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureIssueBlockedByEscalation(input: {
    issue: typeof issues.$inferSelect;
    escalationIssueId: string;
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerIssueIds(input.issue.companyId, input.issue.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationIssueId])];
    const isAlreadyBlockedByEscalation = blockerIds.includes(input.escalationIssueId);
    const isAlreadyBlocked = input.issue.status === "blocked";
    if (isAlreadyBlockedByEscalation && isAlreadyBlocked) {
      return input.issue;
    }

    const update: Partial<typeof issues.$inferInsert> & { blockedByIssueIds: string[] } = {
      blockedByIssueIds: nextBlockerIds,
    };
    if (!isAlreadyBlocked) {
      update.status = "blocked";
    }

    const updated = await issuesSvc.update(input.issue.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.blockers.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerIssueIds: nextBlockerIds,
        escalationIssueId: input.escalationIssueId,
        status: update.status ?? input.issue.status,
        previousStatus: input.issue.status,
      },
    });

    return updated;
  }

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${recoveryIssue.identifier ?? recoveryIssue.title}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw error;
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await ensureIssueBlockedByEscalation({
      issue,
      escalationIssueId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
  }) {
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = new Date();
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const result = {
      findings: 0,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      obsoleteRecoveriesRetired: 0,
      obsoleteRecoveriesActiveSkipped: 0,
      obsoleteRecoveryBlockerRelationsRemoved: 0,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: [] as string[],
      blockedIssuesScanned: 0,
      terminalOnlyIssues: 0,
      missingEdgeIssues: 0,
      openNonTerminalIssues: 0,
      classAAutoRecovered: 0,
      classAOscillationCapped: 0,
      classBNudged: 0,
      classBEscalated: 0,
      classBNoop: 0,
      classBBoardOnly: 0,
      classBSkippedOtherRecoveryAction: 0,
      classBStrandedRearmed: 0,
      classBStrandedRearmDeferredCap: 0,
      classBStrandedResolvedBlockerGoverned: 0,
      blockedEnteredAtFallbacks: 0,
      issueGraphRecoveryActionsResolved: 0,
      actionErrors: 0,
      actionErrorIssueIds: [] as string[],
      classAIssueIds: [] as string[],
      classBNudgedIssueIds: [] as string[],
      classBEscalatedIssueIds: [] as string[],
      classBStrandedRearmedIssueIds: [] as string[],
    };

    if (!autoRecoveryEnabled) {
      const findings = await collectIssueGraphLivenessFindings();
      result.findings = findings.length;
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    const durableBlockedIssueActuation = await reconcileDurableBlockedIssueAttention({
      now,
      runId: opts?.runId ?? null,
    });
    result.blockedIssuesScanned = durableBlockedIssueActuation.blockedIssuesScanned;
    result.terminalOnlyIssues = durableBlockedIssueActuation.terminalOnlyIssues;
    result.missingEdgeIssues = durableBlockedIssueActuation.missingEdgeIssues;
    result.openNonTerminalIssues = durableBlockedIssueActuation.openNonTerminalIssues;
    result.classAAutoRecovered = durableBlockedIssueActuation.classAAutoRecovered;
    result.classAOscillationCapped = durableBlockedIssueActuation.classAOscillationCapped;
    result.classBNudged = durableBlockedIssueActuation.classBNudged;
    result.classBEscalated = durableBlockedIssueActuation.classBEscalated;
    result.classBNoop = durableBlockedIssueActuation.classBNoop;
    result.classBBoardOnly = durableBlockedIssueActuation.classBBoardOnly;
    result.classBSkippedOtherRecoveryAction = durableBlockedIssueActuation.classBSkippedOtherRecoveryAction;
    result.classBStrandedRearmed = durableBlockedIssueActuation.classBStrandedRearmed;
    result.classBStrandedRearmDeferredCap = durableBlockedIssueActuation.classBStrandedRearmDeferredCap;
    result.classBStrandedResolvedBlockerGoverned = durableBlockedIssueActuation.classBStrandedResolvedBlockerGoverned;
    result.blockedEnteredAtFallbacks = durableBlockedIssueActuation.blockedEnteredAtFallbacks;
    result.issueGraphRecoveryActionsResolved = durableBlockedIssueActuation.issueGraphRecoveryActionsResolved;
    result.actionErrors = durableBlockedIssueActuation.actionErrors;
    result.actionErrorIssueIds = durableBlockedIssueActuation.errorIssueIds;
    result.classAIssueIds = durableBlockedIssueActuation.classAIssueIds;
    result.classBNudgedIssueIds = durableBlockedIssueActuation.classBNudgedIssueIds;
    result.classBEscalatedIssueIds = durableBlockedIssueActuation.classBEscalatedIssueIds;
    result.classBStrandedRearmedIssueIds = durableBlockedIssueActuation.classBStrandedRearmedIssueIds;

    const findings = await collectIssueGraphLivenessFindings();
    result.findings = findings.length;
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    result.obsoleteRecoveriesRetired = obsoleteRecoveryCleanup.retired;
    result.obsoleteRecoveriesActiveSkipped = obsoleteRecoveryCleanup.activeSkipped;
    result.obsoleteRecoveryBlockerRelationsRemoved = obsoleteRecoveryCleanup.blockerRelationsRemoved;
    result.retiredRecoveryIssueIds = obsoleteRecoveryCleanup.retiredIssueIds;
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);

    for (const finding of findings) {
      if (!isLivenessFindingInsideAutoRecoveryLookback(finding, cutoff, updatedAtByIssueKey)) {
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  /**
   * AUR-5465 backstop: the trigger and every known write path already close active
   * recovery actions synchronously when their source issue lands terminal (AUR-4299).
   * This sweep exists for the write path nobody has written yet — it finds zero rows
   * under normal operation and only earns its keep the day something new bypasses the
   * data-layer invariant.
   */
  async function reconcileOrphanedRecoveryActions() {
    return recoveryActionsSvc.reconcileOrphanedTerminalActions();
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  return {
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileIssueGraphLiveness,
    reconcileOrphanedRecoveryActions,
    readRecoveryTimerIntervalMs,
    isRecoveryDispatchStillValid,
  };
}
