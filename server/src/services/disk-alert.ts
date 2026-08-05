import type { DiskCheckResult } from "./disk-monitor.js";

// AUR-4997: identifies the disk-alert issue lineage. `originId` is a fixed
// string (there's only ever one disk to alert on per instance) so the
// partial unique index `issues_active_disk_alert_uq` can enforce "at most
// one open alert" at the DB layer — correctness that survives a restart,
// unlike the old in-memory rate limiter.
export const DISK_ALERT_ORIGIN_KIND = "disk_alert";
export const DISK_ALERT_ORIGIN_ID = "disk-usage";
export const DISK_ALERT_OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
const DISK_ALERT_UNIQUE_CONSTRAINT = "issues_active_disk_alert_uq";

export interface DiskAlertIssueRef {
  id: string;
}

// Minimal shape of `issueService(db)` this module depends on, so it can be
// unit tested against a fake without spinning up a real DB.
export interface DiskAlertIssuesPort {
  list(
    companyId: string,
    filters: { originKind: string; originId: string; status: string },
  ): Promise<DiskAlertIssueRef[]>;
  create(companyId: string, data: Record<string, unknown>): Promise<DiskAlertIssueRef>;
  addComment(issueId: string, body: string, actor: Record<string, unknown>): Promise<unknown>;
  update(issueId: string, data: Record<string, unknown>): Promise<unknown>;
}

async function findOpenDiskAlertIssue(
  issuesSvc: DiskAlertIssuesPort,
  companyId: string,
): Promise<DiskAlertIssueRef | undefined> {
  const rows = await issuesSvc.list(companyId, {
    originKind: DISK_ALERT_ORIGIN_KIND,
    originId: DISK_ALERT_ORIGIN_ID,
    status: DISK_ALERT_OPEN_STATUSES,
  });
  return rows[0];
}

function isDiskAlertUniqueConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "23505" &&
    "constraint" in err &&
    (err as { constraint?: string }).constraint === DISK_ALERT_UNIQUE_CONSTRAINT
  );
}

export type DiskAlertActOutcome =
  | { action: "created"; issueId: string }
  | { action: "commented"; issueId: string }
  | { action: "commented_after_race"; issueId: string };

export interface DiskAlertActOptions {
  companyId: string;
  result: DiskCheckResult;
  assigneeAgentId: string;
  readingBody: string;
  issuesSvc: DiskAlertIssuesPort;
}

/**
 * State-based dedup for a disk-pressure reading: comment on the existing
 * open alert if one exists, otherwise file a new one. Race-safe against a
 * concurrent check via the DB unique constraint.
 */
export async function handleDiskAlertAct(opts: DiskAlertActOptions): Promise<DiskAlertActOutcome> {
  const { companyId, result, assigneeAgentId, readingBody, issuesSvc } = opts;
  const existing = await findOpenDiskAlertIssue(issuesSvc, companyId);
  if (existing) {
    await issuesSvc.addComment(existing.id, `## Disk alert still active\n\n${readingBody}`, {});
    return { action: "commented", issueId: existing.id };
  }

  try {
    const created = await issuesSvc.create(companyId, {
      title: `[DISK ALERT] Disk usage critical: ${result.diskStats.usedPercent.toFixed(1)}%`,
      // exec.routing-rationale: skip — belt-and-braces attribution layer on
      // top of originKind !== 'manual': this is a system-filed alert, not an
      // agent routing decision, and must not be flagged by the
      // routing-rationale watchdog (isRoutingDecision()).
      description: `## Disk High-Water-Mark Alert\n\n${readingBody}\n\nexec.routing-rationale: skip`,
      status: "todo",
      priority: "critical",
      assigneeAgentId,
      originKind: DISK_ALERT_ORIGIN_KIND,
      originId: DISK_ALERT_ORIGIN_ID,
    });
    return { action: "created", issueId: created.id };
  } catch (err) {
    if (!isDiskAlertUniqueConflict(err)) throw err;
    const racedExisting = await findOpenDiskAlertIssue(issuesSvc, companyId);
    if (!racedExisting) throw err;
    await issuesSvc.addComment(racedExisting.id, `## Disk alert still active\n\n${readingBody}`, {});
    return { action: "commented_after_race", issueId: racedExisting.id };
  }
}

export type DiskAlertClearOutcome = { action: "resolved"; issueId: string } | { action: "noop" };

export interface DiskAlertClearOptions {
  companyId: string;
  recoveryBody: string;
  issuesSvc: DiskAlertIssuesPort;
}

/**
 * Auto-resolve: close the open alert (if any) once usage has dropped below
 * the clear threshold. A no-op when there's nothing open to resolve.
 */
export async function handleDiskAlertClear(opts: DiskAlertClearOptions): Promise<DiskAlertClearOutcome> {
  const { companyId, recoveryBody, issuesSvc } = opts;
  const existing = await findOpenDiskAlertIssue(issuesSvc, companyId);
  if (!existing) return { action: "noop" };
  await issuesSvc.addComment(existing.id, `## Disk alert resolved\n\n${recoveryBody}`, {});
  await issuesSvc.update(existing.id, { status: "done" });
  return { action: "resolved", issueId: existing.id };
}
