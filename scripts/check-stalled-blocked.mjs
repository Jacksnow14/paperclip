#!/usr/bin/env node
/**
 * check-stalled-blocked.mjs
 *
 * Watchdog for `blocked` issues that have no unresolved blocker at all
 * (AUR-4105). Root incident: AUR-3916 — the only pre-deploy mitigation for a
 * live CRITICAL bug — sat `blocked` for 13 hours with zero blockers after
 * being auto-blocked by lost-run recovery (`escalateStrandedAssignedIssue` /
 * `escalateStrandedRecoveryIssueInPlace` in
 * server/src/services/recovery/service.ts, which set `status: "blocked"`
 * without ever adding the recovery action to `blockedByIssueIds`). Nothing
 * looked at it again until a human happened to read the chain manually.
 *
 * The control plane already computes the answer: `blockerAttention.state ===
 * "needs_attention"` with `unresolvedBlockerCount === 0` on the issue LIST
 * response (no per-issue fetch required — see AUR-4105 gotcha, which is about
 * `blockedBy`, not `blockerAttention`; both ship on the plain list endpoint).
 * This watchdog is the first consumer of that signal.
 *
 * Two distinct classes (do not collapse them — see AUR-3937):
 *   - stalled      — auto-blocked by lost-run recovery, or blocked with no
 *                     stated reason. Drift. Needs a real disposition.
 *   - human-gated   — genuinely waiting on the founder or an external party.
 *                     Legitimately parked; the long-term fix is a first-class
 *                     founder-gate blocker or interaction, not a bare
 *                     `blocked`. Flagged as mis-modelled, not re-paged — but
 *                     only when it actually IS bare: a human-gated candidate
 *                     that already carries a pending issue-thread interaction
 *                     (GET /api/issues/:id/interactions) is correctly
 *                     modelled already and is reported under a separate
 *                     AWAITING-HUMAN bucket instead of filed (AUR-4275 — the
 *                     detector previously asserted "nothing attached"
 *                     without ever checking, and filed false mis-modelled
 *                     flags against AUR-1879 and AUR-2162, which both had a
 *                     pending interaction).
 *
 * Shape mirrors scripts/check-routing-rationale.mjs (Phase A auto-resolve,
 * Phase B detect+file), for the same reason that script uses it: an agent
 * cannot comment on or mutate an issue it neither authored nor is assigned
 * to ("Agent cannot mutate another agent's issue", server/src/routes/
 * issues.ts:1126) — you must FILE a new issue assigned to the target's
 * owner rather than commenting on the target directly.
 *
 * Usage:
 *   node scripts/check-stalled-blocked.mjs [--apply]
 *
 *   Without --apply: dry-run — prints the graded report, writes nothing.
 *   With --apply:    files one flag issue per still-uncovered candidate
 *                     (idempotent — skipped if an open flag already exists)
 *                     and auto-resolves flags whose target no longer
 *                     qualifies.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3100)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
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
 * Opt-out token an issue author can set to explicitly declare a `blocked`
 * issue as human-gated, bypassing the keyword heuristic below.
 */
export const HUMAN_GATED_TOKEN = 'exec.blocked-reason: human-gated';

/**
 * Heuristic signal that a `blocked`-with-no-blocker issue is genuinely
 * waiting on the founder or an external party rather than drifted state.
 * Matches the concrete examples cited in AUR-4105 (AUR-3945 identity docs,
 * AUR-2162 recovery codes, AUR-1879 payment rail, [alex@]/[board@] inbox
 * items, "Founder gate: ..." titles). Heuristic, not authoritative — the
 * long-term fix is a first-class founder-gate blocker/interaction, which is
 * why this classification is surfaced as "mis-modelled", not silently acted
 * on.
 */
export const HUMAN_GATED_PATTERN =
  /founder gate|\[alex@|\[board@|recovery codes?|identity docs?|payment rail|\b2fa\b|two-factor|waiting on (?:the )?founder|manual (?:approval|action)(?: is)? (?:required|needed)/i;

/**
 * True when a `blocked` issue has no unresolved blocker at all — the
 * "needs_attention with unresolvedBlockerCount === 0" branch computed
 * server-side in listIssueBlockerAttentionMap (topLevelEdges.length === 0).
 * Distinct from `needs_attention` with `unresolvedBlockerCount > 0`, which
 * means real blockers exist but one of them itself needs attention — a
 * different problem, out of scope here (verified against AUR-4032: 1 real
 * covered blocker → state "covered", never flagged).
 */
export function hasNoBlocker(issue) {
  const attention = issue.blockerAttention;
  if (!attention) return false;
  return attention.state === 'needs_attention' && attention.unresolvedBlockerCount === 0;
}

/**
 * Grades a no-blocker `blocked` issue as 'stalled' or 'human-gated'.
 * @param {{ title?: string, description?: string }} issue
 * @returns {'stalled'|'human-gated'}
 */
export function gradeBlockedIssue(issue) {
  const text = `${issue.title ?? ''}\n${issue.description ?? ''}`;
  if (text.includes(HUMAN_GATED_TOKEN)) return 'human-gated';
  if (HUMAN_GATED_PATTERN.test(text)) return 'human-gated';
  return 'stalled';
}

export function hoursSince(isoTimestamp, now = new Date()) {
  return (now.getTime() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

/**
 * True when a GET /api/issues/:id/interactions response includes at least
 * one pending interaction — i.e. the target already has a first-class
 * human-gate mechanism attached, so it is not "a bare `blocked` status with
 * nothing attached" (AUR-4275: AUR-1879 and AUR-2162 were both filed as
 * mis-modelled while carrying a pending interaction).
 * @param {unknown} interactionsResponse
 */
export function hasPendingInteractionInList(interactionsResponse) {
  const list = Array.isArray(interactionsResponse)
    ? interactionsResponse
    : (interactionsResponse?.items ?? []);
  return list.some((i) => i.status === 'pending');
}

/** Matches both flag title formats produced in the wild. */
export const FLAG_REGEX = /stalled-blocked(?:-mismodelled)?:\s*(AUR-\d+)/i;

export function flagTitle(targetId, grade) {
  return grade === 'human-gated'
    ? `stalled-blocked-mismodelled: ${targetId} blocked with no blocker (human-gated)`
    : `stalled-blocked: ${targetId} blocked with no blocker`;
}

export function buildFlagDescription(issue, grade) {
  const id = issue.identifier ?? issue.id;
  const hrs = Math.round(hoursSince(issue.updatedAt));
  if (grade === 'human-gated') {
    return [
      `## Blocked issue reads as human-gated, but is mis-modelled`,
      '',
      `**${id}** ("${issue.title}") is \`blocked\` with **no unresolved blocker** ` +
        `(\`blockerAttention.state = needs_attention\`, \`unresolvedBlockerCount = 0\`), last updated ${hrs}h ago, ` +
        `and reads as genuinely waiting on the founder or an external party.`,
      '',
      'Per AUR-4105, the durable fix for issues like this is a first-class founder-gate blocker or an ' +
        'interaction, not a bare `blocked` status with nothing attached. No urgent action needed on the ' +
        'underlying wait itself — consider filing the modelling fix (attach a blocker/interaction) when convenient.',
      '',
      'exec.routing-rationale: skip',
    ].join('\n');
  }
  return [
    `## Blocked issue has no unresolved blocker — needs a real disposition`,
    '',
    `**${id}** ("${issue.title}") is \`blocked\` with **no unresolved blocker** ` +
      `(\`blockerAttention.state = needs_attention\`, \`unresolvedBlockerCount = 0\`), last updated ${hrs}h ago.`,
    '',
    'That combination almost always means the block was set by lost-run recovery or another process with ' +
      'nothing actually attached to unblock it — see AUR-4105.',
    '',
    `Please give ${id} a real disposition: attach a first-class blocker, re-arm to \`todo\`, convert to ` +
      '`in_review` with an interaction, or cancel if it is dead.',
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
      ? `Auto-resolved by stalled-blocked-watchdog: ${targetId} is ${target.status}.`
      : `Auto-resolved by stalled-blocked-watchdog: ${targetId} not found among open issues.`;
  }
  if (target.status !== 'blocked') {
    return `Auto-resolved by stalled-blocked-watchdog: ${targetId} is no longer \`blocked\` (now \`${target.status}\`).`;
  }
  if (!hasNoBlocker(target)) {
    return `Auto-resolved by stalled-blocked-watchdog: ${targetId} now has a real blocker attached (blockerAttention.state=${target.blockerAttention?.state}).`;
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

  async function hasPendingInteraction(issueId) {
    return hasPendingInteractionInList(await apiGet(`/api/issues/${issueId}/interactions`));
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

  return { apiGet, apiPatch, apiPost, hasPendingInteraction };
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
 * default flag owner when the target issue has no assignee at all (never
 * leave a flag orphaned — AUR-1817/AUR-1818 class of bug).
 */
export const CEO_AGENT_ID = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';

export function resolveFlagOwner(issue) {
  return issue.assigneeAgentId ?? CEO_AGENT_ID;
}

// ── Main routine ──────────────────────────────────────────────────────────────

export const ISSUE_STATUS_FILTER = 'backlog,todo,in_progress,in_review,blocked';

export async function main({ apply, apiUrl, apiKey, companyId }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPatch, apiPost, hasPendingInteraction } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  const [blockedBatch, allBatch] = await Promise.all([
    apiGet(`/api/companies/${companyId}/issues?status=blocked&limit=500`),
    apiGet(`/api/companies/${companyId}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`),
  ]);
  const blockedIssues = Array.isArray(blockedBatch) ? blockedBatch : (blockedBatch.issues ?? []);
  const allIssues = Array.isArray(allBatch) ? allBatch : (allBatch.issues ?? []);
  const issueByIdentifier = new Map();
  for (const issue of allIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue);
  }
  // Blocked issues are always a subset of the filter above, but a blocked
  // issue fetched via the dedicated status=blocked query is authoritative
  // for its own blockerAttention regardless of pagination on the pooled query.
  for (const issue of blockedIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue);
  }

  const candidates = blockedIssues.filter(hasNoBlocker);
  const graded = candidates.map((issue) => ({ issue, grade: gradeBlockedIssue(issue) }));

  // A human-gated candidate that already carries a pending first-class
  // interaction is NOT mis-modelled — the "nothing attached" premise in
  // buildFlagDescription's human-gated branch would be false for it. Check
  // before filing, not after (AUR-4275): filing first and disproving later
  // costs a full heartbeat per target and mis-teaches the reader.
  for (const g of graded) {
    g.pendingInteraction = g.grade === 'human-gated'
      ? await hasPendingInteraction(g.issue.id)
      : false;
  }

  const awaitingHuman = graded.filter((g) => g.grade === 'human-gated' && g.pendingInteraction);

  console.log(`── Scan: ${blockedIssues.length} blocked issue(s), ${candidates.length} with no unresolved blocker ──\n`);
  console.log(`  STALLED (${graded.filter((g) => g.grade === 'stalled').length}):`);
  graded.filter((g) => g.grade === 'stalled').forEach(({ issue }) => {
    console.log(`    - ${issue.identifier} [${issue.priority}] assignee=${issue.assigneeAgentId ?? 'none'} updated=${Math.round(hoursSince(issue.updatedAt))}h ago`);
  });
  console.log(`\n  HUMAN-GATED (${graded.filter((g) => g.grade === 'human-gated').length}):`);
  graded.filter((g) => g.grade === 'human-gated').forEach(({ issue, pendingInteraction }) => {
    console.log(`    - ${issue.identifier} [${issue.priority}] assignee=${issue.assigneeAgentId ?? 'none'} updated=${Math.round(hoursSince(issue.updatedAt))}h ago${pendingInteraction ? ' (pending interaction)' : ''}`);
  });
  console.log(`\n  AWAITING-HUMAN (correctly modelled, ${awaitingHuman.length}):`);
  awaitingHuman.forEach(({ issue }) => {
    console.log(`    - ${issue.identifier} [${issue.priority}] already has a pending interaction — not filing.`);
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

  // ── Phase B: detect + file ───────────────────────────────────────────────────
  console.log('── Phase B: Detect and file new flags ──');
  const toFile = graded.filter(({ issue, pendingInteraction }) => !openFlagTargets.has(issue.identifier) && !pendingInteraction);
  const skippedDedup = graded.filter(({ issue, pendingInteraction }) => openFlagTargets.has(issue.identifier) && !pendingInteraction);

  if (skippedDedup.length > 0) {
    console.log(`  SKIPPED-DEDUP — open flag exists (${skippedDedup.length}):`);
    skippedDedup.forEach(({ issue }) => console.log(`    - ${issue.identifier}`));
    console.log();
  }

  if (toFile.length === 0) {
    console.log('  No new flags to file.\n');
  } else {
    for (const { issue, grade } of toFile) {
      const id = issue.identifier ?? issue.id;
      const owner = resolveFlagOwner(issue);
      const title = flagTitle(id, grade);
      console.log(`  FILE (${grade}): "${title}" → owner ${owner}`);
      if (apply) {
        const ok = await runMutation(
          `file flag for ${id}`,
          () => apiPost(`/api/companies/${companyId}/issues`, {
            title,
            description: buildFlagDescription(issue, grade),
            status: 'todo',
            priority: grade === 'human-gated' ? 'low' : issue.priority,
            assigneeAgentId: owner,
          }),
          failedMutations,
        );
        if (ok) console.log(`    → filed (assignee ${owner}).`);
      }
    }
    console.log();
  }

  console.log('── Summary ──');
  console.log(`  Candidates:      ${candidates.length} (stalled=${graded.filter((g) => g.grade === 'stalled').length}, human-gated=${graded.filter((g) => g.grade === 'human-gated').length})`);
  console.log(`  Awaiting-human:  ${awaitingHuman.length} (correctly modelled, not filed)`);
  console.log(`  Resolved:        ${toCancel.length}`);
  console.log(`  Filed:           ${toFile.length}`);
  console.log(`  Skipped-dedup:   ${skippedDedup.length}`);
  console.log(`  Failed:          ${failedMutations.length}`);
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
    console.log('Usage: node scripts/check-stalled-blocked.mjs [--apply]');
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
