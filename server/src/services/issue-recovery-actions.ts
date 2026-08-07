import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;

/**
 * A recovery action's wake is fired exactly once (source.ts:1942) and is never
 * re-armed by any sweeper (no `listOpen`, no attempt-count-driven retry). Once
 * that single wake is lost, an `active`/`escalated` row sits forever and
 * suppresses every liveness sweep that treats it as a waiting path
 * (issue-graph-liveness.ts, blockerAttention, Class B durable-blocker sweep).
 *
 * 24h matches the existing `DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS`
 * convention for this same liveness domain: long enough to absorb a wake landing
 * in a temporarily quota-exhausted lane (which recovers same-day), short enough
 * that a genuinely lost wake stops blinding recovery within one day instead of
 * the weeks observed live (AUR-4300: 7-58 day dormant rows still suppressing).
 */
export const RECOVERY_ACTION_DORMANCY_HOURS = 24;

export function recoveryActionDormancyCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - RECOVERY_ACTION_DORMANCY_HOURS * 60 * 60 * 1000);
}

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

export type ResolveIssueRecoveryActionsForTerminalIssuesInput = {
  companyId: string;
  sourceIssueIds: string[];
  issueStatus: string;
  resolutionNote?: string | null;
};

type TerminalRecoveryResolution = {
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
};

/**
 * How an active recovery action is disposed of when its source issue reaches a terminal status.
 *
 * A recovery action only ever tracks "this issue is stranded and needs to get moving again".
 * Once the source issue is `done`/`cancelled` the tracking object has no remaining purpose, so
 * it must be closed out rather than left active — otherwise `activeRecoveryAction` decays into a
 * mostly-false signal and any consumer keyed off it is swamped by noise (AUR-4299).
 *
 * Returns `null` for every non-terminal status, which is what makes this safe to call
 * unconditionally from the generic issue update path.
 */
export function terminalIssueRecoveryResolution(issueStatus: string): TerminalRecoveryResolution | null {
  if (issueStatus === "done") return { status: "resolved", outcome: "restored" };
  if (issueStatus === "cancelled") return { status: "cancelled", outcome: "cancelled" };
  return null;
}

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? existing.evidence,
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: existing.attemptCount + 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
          outcome: null,
          resolutionNote: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? null,
          returnOwnerAgentId: input.returnOwnerAgentId ?? null,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? {},
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  /**
   * Re-fire an existing active/escalated action: bump `attemptCount` and refresh
   * `lastAttemptAt` without touching kind, owner, cause, fingerprint, or evidence.
   *
   * This exists for sweepers that retry a *dormant* action (AUR-4996): a mirror
   * `upsertSourceScoped` call is the wrong tool there because the upsert nulls
   * every field the caller does not reconstruct (`recoveryIssueId`, `wakePolicy`,
   * ...), so a retry would silently rewrite the action it meant to repeat.
   * Returns null when the action is no longer active (resolved/cancelled race).
   */
  async function rearmActiveForIssue(input: {
    companyId: string;
    sourceIssueId: string;
    actionId: string;
    lastAttemptAt?: Date;
  }): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const [updated] = await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: sql`${issueRecoveryActions.attemptCount} + 1`,
        lastAttemptAt: input.lastAttemptAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
          eq(issueRecoveryActions.id, input.actionId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .returning();
    return updated ? toReadModel(updated) : null;
  }

  /**
   * Close out every active recovery action whose source issue just reached a terminal status.
   *
   * Idempotent: the status predicate means a second call matches zero rows. Callers pass the
   * *issue* status (not a recovery-action status) and get a no-op for non-terminal values, so
   * this can be wired into generic update paths without the caller re-deriving the mapping.
   */
  async function resolveActiveForTerminalIssues(
    input: ResolveIssueRecoveryActionsForTerminalIssuesInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction[]> {
    const resolution = terminalIssueRecoveryResolution(input.issueStatus);
    if (!resolution) return [];
    const sourceIssueIds = [...new Set(input.sourceIssueIds)];
    if (sourceIssueIds.length === 0) return [];

    const now = new Date();
    const updated = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: resolution.status,
        outcome: resolution.outcome,
        resolutionNote:
          input.resolutionNote ?? `Source issue reached terminal status ${input.issueStatus}.`,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          inArray(issueRecoveryActions.sourceIssueId, sourceIssueIds),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .returning();

    return updated.map(toReadModel);
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    rearmActiveForIssue,
    resolveActiveForIssue,
    resolveActiveForTerminalIssues,
    upsertSourceScoped,
  };
}
