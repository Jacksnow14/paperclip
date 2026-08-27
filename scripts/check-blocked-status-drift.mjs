#!/usr/bin/env node
/**
 * check-blocked-status-drift.mjs
 *
 * Watchdog for the inverse defect of check-stalled-blocked.mjs (AUR-6248):
 * an issue that carries a live, unresolved `blockedByIssueIds` relationship
 * but whose `status` is no longer `blocked`. `issue_blockers_resolved` only
 * wakes the assignee of an issue that is currently `blocked` when its
 * blockers reach `done` — so once status drifts away from `blocked` while
 * `blockedByIssueIds` stays populated, the dependent silently loses its only
 * automatic wake path and nothing looks at it again until a human notices.
 *
 * Root incident: AUR-4130 was moved `blocked` → `backlog` on 2026-08-26 at
 * 12:02:01Z. Traced via the issue activity log to a `issue.updated` event
 * actored by the CEO agent, whose run's `contextSnapshot.issueId` was
 * AUR-5826 itself (a board-directive backlog sweep) — the CEO re-executed
 * that same directive a second time via an ad-hoc "mass PATCH loop" (69
 * issues moved to `backlog` in <30s), with no per-issue check for current
 * `blocked` status and no touch to `blockedByIssueIds` on any of them. There
 * is no committed "sweep script" to patch directly — the sweep was typed
 * live in a session, not code — and it could recur under any future sweep,
 * scheduled routine, or manual bulk action, not just this one incident's
 * specific cause. Detecting the drift signature itself (rather than the one
 * sweep that happened to cause it this time) is robust to all of those.
 *
 * Detection needs no per-issue fetch: `blockerAttention.unresolvedBlockerCount`
 * ships on the plain issue LIST response (same signal check-stalled-blocked.mjs
 * already relies on, inverted — see AUR-4105 gotcha, which is about the raw
 * `blockedBy` array being empty on list responses, not `blockerAttention`).
 *
 * Shape mirrors scripts/check-stalled-blocked.mjs (Phase A auto-resolve,
 * Phase B detect+file): an agent cannot mutate or comment on an issue it
 * neither authored nor is assigned to ("Agent cannot mutate another agent's
 * issue", server/src/routes/issues.ts:1126), so remediation is always to
 * FILE a new issue assigned to the drifted issue's own owner, recommending
 * they restore `blocked` status (safe to do without losing information,
 * since `blockedByIssueIds` already encodes the original blocked intent) or
 * explicitly clear `blockedByIssueIds` if the blocker genuinely no longer
 * applies — never to auto-mutate the target directly, which would also risk
 * a 403 depending on who owns the drifted issue vs. who runs this watchdog.
 *
 * Usage:
 *   node scripts/check-blocked-status-drift.mjs [--apply]
 *
 *   Without --apply: dry-run — prints the report, writes nothing.
 *   With --apply:    files one flag issue per still-live candidate
 *                     (idempotent — skipped if an open flag already exists)
 *                     and auto-resolves flags whose target no longer
 *                     qualifies.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3100)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Env vars optional:
 *   BLOCKED_DRIFT_MAX_FLAGS_PER_RUN  Overrides the per-run cap on individual
 *                                    flags filed (default 5).
 *
 * Exit codes:
 *   0 — clean, or all intended actions applied (a partial run where SOME
 *       mutations failed still exits 0; see Failed count in the summary)
 *   1 — dry-run with pending actions (apply to execute)
 *   2 — configuration/API error
 *   4 — every intended mutation this run failed
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Classification (exported, pure — used in tests) ─────────────────────────

/**
 * Statuses eligible for the drift check. Excludes `blocked` itself (the
 * correctly-modelled state) and the terminal statuses `done`/`cancelled`
 * (a resolved or abandoned issue's stale `blockedByIssueIds` is not this
 * watchdog's problem).
 */
export const DRIFT_CANDIDATE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review'];

/** Comma-joined for the issues-list query string. */
export const ISSUE_STATUS_FILTER = ['blocked', ...DRIFT_CANDIDATE_STATUSES].join(',');

/**
 * True when `issue` has genuinely drifted: status is one of
 * DRIFT_CANDIDATE_STATUSES (not `blocked`) while the platform's own
 * attention algorithm says a real blocker still needs attention
 * (`blockerAttention.state === 'needs_attention'`,
 * `reason === 'attention_required'`).
 *
 * `unresolvedBlockerCount > 0` alone is NOT sufficient — a live scan (AUR-6248,
 * 2026-08-26) against 22 raw `unresolvedBlockerCount > 0` candidates showed
 * three distinct buckets, only one of which is this watchdog's target:
 *   - `state: 'covered'` (9 of 22, reasons `active_dependency`/`active_child`):
 *     a healthy soft dependency the platform itself judges as fine — e.g. a
 *     `todo` issue whose blocker is actively being worked. Not drift; the
 *     status was never meant to be `blocked` in the first place.
 *   - `state: 'needs_attention', reason: 'cancelled_blocker'` (3 of 22): a
 *     dangling reference to a `cancelled` blocker. Per the skill doc,
 *     "cancelled blockers do not count as resolved — remove or replace them
 *     explicitly" — a stale-reference hygiene problem with a different fix
 *     (clear `blockedByIssueIds`), not a status that needs restoring to
 *     `blocked`.
 *   - `state: 'needs_attention', reason: 'attention_required'` (10 of 22):
 *     the actual AUR-6248 signature — a real, still-open (not done/cancelled)
 *     blocker exists but status isn't `blocked`. 18 of the 22 raw candidates
 *     (including all 10 in this bucket) carried `updatedAt` timestamps in the
 *     exact `2026-08-26T12:02:0X`–`12:03:1X` window as AUR-4130's own drift
 *     event, confirming this is the live blast radius of the same bulk sweep,
 *     not a one-off already fully remediated by closing AUR-4130 alone.
 */
export function isDriftedBlockedStatus(issue) {
  if (!DRIFT_CANDIDATE_STATUSES.includes(issue.status)) return false;
  const attention = issue.blockerAttention;
  if (!attention) return false;
  if ((attention.unresolvedBlockerCount ?? 0) <= 0) return false;
  return attention.state === 'needs_attention' && attention.reason === 'attention_required';
}

export function hoursSince(isoTimestamp, now = new Date()) {
  return (now.getTime() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

/** Matches this watchdog's own flag title. */
export const FLAG_REGEX = /blocked-status-drift:\s*(AUR-\d+)/i;

export function flagTitle(targetId, status) {
  return `blocked-status-drift: ${targetId} has a live blocker but status is \`${status}\``;
}

export function buildFlagDescription(issue, now = new Date()) {
  const id = issue.identifier ?? issue.id;
  const hrs = Math.round(hoursSince(issue.updatedAt, now));
  const attention = issue.blockerAttention ?? {};
  const sample = attention.sampleBlockerIdentifier
    ? ` (e.g. ${attention.sampleBlockerIdentifier})`
    : '';
  return [
    '## Blocked issue silently lost `blocked` status while a blocker is still live',
    '',
    `**${id}** ("${issue.title}") has status \`${issue.status}\` but ` +
      `\`blockerAttention.unresolvedBlockerCount = ${attention.unresolvedBlockerCount}\`${sample}, ` +
      `last updated ${hrs}h ago.`,
    '',
    '`issue_blockers_resolved` only wakes an assignee when the dependent issue is currently ' +
      '`blocked` — status drifting away from `blocked` while `blockedByIssueIds` stays populated ' +
      'silently breaks that auto-wake. Root incident: AUR-6248 (AUR-4130 was force-moved ' +
      '`blocked` → `backlog` by an ad-hoc bulk status sweep that never touched `blockedByIssueIds`).',
    '',
    `Please give ${id} a real disposition: restore \`status: blocked\` (safe — ` +
      '`blockedByIssueIds` already encodes the intent, nothing is lost) if the blocker is still ' +
      'genuinely outstanding, or explicitly clear `blockedByIssueIds` (PATCH with `[]`) if it no ' +
      'longer applies.',
    '',
    'exec.routing-rationale: skip',
  ].join('\n');
}

/**
 * Returns a cancel reason string if an open flag should be auto-resolved, or
 * null if it is still valid and should remain open.
 * @param {{ target: object|null, targetId: string }} opts
 */
export function resolveCancelReason({ target, targetId }) {
  if (!target || ['done', 'cancelled'].includes(target.status)) {
    return target
      ? `Auto-resolved by blocked-status-drift-watchdog: ${targetId} is ${target.status}.`
      : `Auto-resolved by blocked-status-drift-watchdog: ${targetId} not found among open issues.`;
  }
  if (target.status === 'blocked') {
    return `Auto-resolved by blocked-status-drift-watchdog: ${targetId} is \`blocked\` again — status now matches its live blocker.`;
  }
  if (!isDriftedBlockedStatus(target)) {
    return `Auto-resolved by blocked-status-drift-watchdog: ${targetId} no longer has an unresolved blocker (blockerAttention.unresolvedBlockerCount=${target.blockerAttention?.unresolvedBlockerCount ?? 0}).`;
  }
  return null;
}

// ── API helpers ───────────────────────────────────────────────────────────────

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPatch(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  return { apiGet, apiPatch, apiPost };
}

function extractStatusCode(errorMessage) {
  const match = /→\s*(\d+)/.exec(errorMessage ?? '');
  return match ? match[1] : 'unknown';
}

async function runMutation(label, fn, failures) {
  try {
    await fn();
    return true;
  } catch (err) {
    const status = extractStatusCode(err.message);
    console.error(`    FAILED (${status}): ${label} — ${err.message}`);
    failures.push({ label, status, message: err.message });
    return false;
  }
}

/**
 * The CEO routes/owns most cross-cutting board work, so it is the correct
 * default flag owner when the drifted issue has no assignee at all.
 */
export const CEO_AGENT_ID = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';

export function resolveFlagOwner(issue) {
  return issue.assigneeAgentId ?? CEO_AGENT_ID;
}

export const DEFAULT_MAX_FLAGS_PER_RUN = 5;

export function resolveMaxFlagsPerRun(env = process.env) {
  const raw = env.BLOCKED_DRIFT_MAX_FLAGS_PER_RUN;
  if (raw === undefined) return DEFAULT_MAX_FLAGS_PER_RUN;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FLAGS_PER_RUN;
}

// ── Main routine ──────────────────────────────────────────────────────────────

export async function main({ apply, apiUrl, apiKey, companyId, maxFlagsPerRun = resolveMaxFlagsPerRun() }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPatch, apiPost } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  const batch = await apiGet(`/api/companies/${companyId}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`);
  const allIssues = Array.isArray(batch) ? batch : (batch.issues ?? []);
  const issueByIdentifier = new Map();
  for (const issue of allIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue);
  }

  const candidates = allIssues.filter(isDriftedBlockedStatus);

  console.log(`── Scan: ${allIssues.length} issue(s) across [${ISSUE_STATUS_FILTER}], ${candidates.length} drifted (status != blocked, unresolvedBlockerCount > 0) ──\n`);
  candidates.forEach((issue) => {
    console.log(`    - ${issue.identifier} [${issue.status}, ${issue.priority}] assignee=${issue.assigneeAgentId ?? 'none'} unresolvedBlockerCount=${issue.blockerAttention?.unresolvedBlockerCount} updated=${Math.round(hoursSince(issue.updatedAt))}h ago`);
  });
  console.log();

  const failedMutations = [];

  // ── Phase A: auto-resolve stale flags ──────────────────────────────────────
  console.log('── Phase A: Auto-resolve stale flags ──');
  const flagIssues = allIssues.filter((issue) => FLAG_REGEX.test(issue.title ?? ''));
  const openFlagTargets = new Set();
  const toCancel = [];

  for (const flag of flagIssues) {
    const match = FLAG_REGEX.exec(flag.title);
    if (!match) continue;
    const targetId = match[1];
    const target = issueByIdentifier.get(targetId) ?? null;
    const reason = resolveCancelReason({ target, targetId });
    if (reason) {
      toCancel.push({ flag, targetId, reason });
    } else {
      openFlagTargets.add(targetId);
    }
  }

  if (toCancel.length === 0) {
    console.log('  No stale flags to resolve.\n');
  } else {
    for (const { flag, targetId, reason } of toCancel) {
      console.log(`  CANCEL ${flag.identifier ?? flag.id} → ${targetId}: ${reason}`);
      if (apply) {
        const ok = await runMutation(
          `cancel ${flag.identifier ?? flag.id} (target ${targetId})`,
          async () => {
            await apiPatch(`/api/issues/${flag.id}`, { status: 'cancelled' });
            await apiPost(`/api/issues/${flag.id}/comments`, { body: reason });
          },
          failedMutations,
        );
        if (ok) console.log('    → cancelled + commented.');
      }
    }
    console.log();
  }

  // ── Phase B: detect + file individual flags (capped) ────────────────────────
  console.log('── Phase B: Detect and file new flags ──');
  const toFileAll = candidates.filter((issue) => !openFlagTargets.has(issue.identifier));
  const skippedDedup = candidates.filter((issue) => openFlagTargets.has(issue.identifier));
  const toFile = toFileAll.slice(0, maxFlagsPerRun);
  const droppedByCap = toFileAll.slice(maxFlagsPerRun);

  if (skippedDedup.length > 0) {
    console.log(`  SKIPPED-DEDUP — open flag exists (${skippedDedup.length}):`);
    skippedDedup.forEach((issue) => console.log(`    - ${issue.identifier}`));
    console.log();
  }

  if (droppedByCap.length > 0) {
    console.log(`  CAP: max flags per run=${maxFlagsPerRun} reached — dropping ${droppedByCap.length} candidate(s) this run (will be reconsidered next run):`);
    droppedByCap.forEach((issue) => console.log(`    - ${issue.identifier ?? issue.id}`));
    console.log();
  }

  if (toFile.length === 0) {
    console.log('  No new flags to file.\n');
  } else {
    for (const issue of toFile) {
      const id = issue.identifier ?? issue.id;
      const owner = resolveFlagOwner(issue);
      const title = flagTitle(id, issue.status);
      console.log(`  FILE: "${title}" → owner ${owner}`);
      if (apply) {
        const ok = await runMutation(
          `file flag for ${id}`,
          () => apiPost(`/api/companies/${companyId}/issues`, {
            title,
            description: buildFlagDescription(issue),
            status: 'todo',
            priority: issue.priority,
            assigneeAgentId: owner,
          }),
          failedMutations,
        );
        if (ok) console.log(`    → filed (assignee ${owner}).`);
      }
    }
    console.log();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('── Summary ──');
  console.log(`  Drifted candidates: ${candidates.length}`);
  console.log(`  Auto-resolved:      ${toCancel.length}`);
  console.log(`  Filed:              ${toFile.length}`);
  console.log(`  Dropped by cap:     ${droppedByCap.length}`);
  console.log(`  Skipped-dedup:      ${skippedDedup.length}`);
  console.log(`  Failed:             ${failedMutations.length}`);
  if (failedMutations.length > 0) {
    for (const { label, status } of failedMutations) console.log(`    - ${label} → ${status}`);
    console.log('  Re-run the watchdog to retry the above (idempotent).');
  }

  const hasPendingActions = toCancel.length > 0 || toFile.length > 0;
  if (!apply && hasPendingActions) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above actions.');
    return 1;
  }

  const attemptedMutations = apply ? toCancel.length + toFile.length : 0;
  if (attemptedMutations > 0 && failedMutations.length === attemptedMutations) {
    console.log('\nERROR: every intended mutation failed this run — see Failed list above.');
    return 4;
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-blocked-status-drift.mjs [--apply]');
    console.log('  --apply  Execute changes (default: dry-run, exit 1 if actions pending)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  resolveApiBase().then((API_URL) => main({
    apply: args.apply,
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
  })).then((code) => process.exit(code)).catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
