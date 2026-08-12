#!/usr/bin/env node
/**
 * check-delivery-claims.mjs
 *
 * Watchdog for unverifiable delivery claims on routine-executed issues
 * (AUR-4613, generalizing AUR-4551). Root incident: AUR-4482 — CMO run
 * 91c51306 posted a 95-character handoff note ("Daily AI opportunity brief
 * posted. ...") and moved the issue to in_review. No brief existed: one
 * comment, zero documents, zero attachments. The CEO burned a full heartbeat
 * re-running the research leg (the real brief was 24,005 chars).
 *
 * Same class as AUR-3930 (Telegram `sent` on HTTP 401), AUR-4136 (memory
 * capture `succeeded` for an unreadable row), AUR-4184 (artifact
 * provenance): the success signal is not the same object as the outcome. A
 * handoff note is a success signal; the artifact is the outcome.
 *
 * Detection rule (deliberately precise — near-zero false positives):
 *   Flag an issue where ALL of:
 *     (a) originKind === "routine_execution"
 *     (b) status is in_review or done
 *     (c) the LONGEST comment authored by the executing assignee on the
 *         issue is < 2000 chars
 *     (d) the issue has zero documents and zero attachments
 *   scoped to a lookback window (default 7 days).
 *
 * Blindness guard (mandatory — AUR-4234 class): a wrong field name or wrong
 * id returns HTTP 200 + [], which reads identically to "no violations".
 * Every invocation therefore re-runs two REAL fixtures through the full
 * classification path before any scan result is reported:
 *   - AUR-4482 (as of 2026-07-29) MUST classify as a violation
 *     (assignee 1685f8cf, longest own comment 12863274 = 95 chars).
 *   - AUR-4361 (07-28) MUST classify as clean (same routine, same agent,
 *     one day apart — comment ab661f20 = 11,093 chars).
 * If either control misbehaves, or the windowed list scan comes back empty /
 * missing a filtered field, the script prints `DETECTOR BLIND` and exits 3
 * WITHOUT printing a violations count. A check that can never clear is as
 * broken as one that never fires — both controls are exercised every run.
 *
 * Shape mirrors scripts/check-stalled-blocked.mjs (Phase A auto-resolve,
 * Phase B detect+file) for the same reason: an agent cannot comment on an
 * issue it neither authored nor is assigned to, so violations are surfaced
 * by FILING a flag issue (assigned to the CEO, naming the offending issue
 * and agent) rather than commenting on the target.
 *
 * Usage:
 *   node scripts/check-delivery-claims.mjs [--apply] [--lookback-days N]
 *
 *   Without --apply: dry-run — prints the report, writes nothing.
 *   With --apply:    files one flag issue per still-unflagged violation
 *                     (idempotent) and auto-resolves flags whose target no
 *                     longer violates.
 *
 * Env vars required:
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *   (PAPERCLIP_API_URL resolved via scripts/lib/paperclip-api-base.mjs)
 *
 * Exit codes:
 *   0 — controls passed, scan clean or all intended actions applied
 *   1 — dry-run with pending actions (violations found; apply to file)
 *   2 — configuration/API error
 *   3 — DETECTOR BLIND: a control fixture did not come back with the
 *       expected verdict, or the scan query shape is invalid
 *   4 — every intended mutation this run failed
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Classification (exported, pure — used in tests) ─────────────────────────

export const MIN_COMMENT_CHARS = 2000;
export const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Real fixtures exercised on EVERY invocation (see header). `mustFlag: true`
 * is the positive control (proves the detector can fire); `mustFlag: false`
 * is the negative control (proves it can clear). Both verdicts are computed
 * through the exact same classify() path the scan uses.
 */
export const CONTROLS = [
  { identifier: 'AUR-4482', mustFlag: true, note: 'CMO 95-char handoff, no brief (comment 12863274)' },
  { identifier: 'AUR-4361', mustFlag: false, note: 'same routine/agent, real 11,093-char brief (comment ab661f20)' },
];

export const FLAGGABLE_STATUSES = ['in_review', 'done'];

/**
 * Length of the longest comment body authored by the executing assignee.
 * Comments by OTHER agents do not count: on AUR-4482 the CEO's later
 * 24,005-char re-run comment sits on the same thread, and counting it would
 * have hidden the violation.
 */
export function longestOwnCommentLength(comments, assigneeAgentId) {
  let longest = 0;
  for (const c of comments ?? []) {
    if (c.authorAgentId !== assigneeAgentId) continue;
    const len = (c.body ?? '').length;
    if (len > longest) longest = len;
  }
  return longest;
}

/**
 * Rule gates (a) + (b): routine-executed and claiming completion. Issues
 * with no assignee cannot violate (there is no "executing assignee" whose
 * comments to measure).
 */
export function isCandidate(issue) {
  return (
    issue.originKind === 'routine_execution' &&
    FLAGGABLE_STATUSES.includes(issue.status) &&
    Boolean(issue.assigneeAgentId)
  );
}

/**
 * Full rule (a)–(d) over a fetched bundle. Pure — the caller fetches.
 * @param {{ issue: object, comments: object[], documents: unknown[], attachments: unknown[], minChars?: number }} bundle
 */
export function classify({ issue, comments, documents, attachments, minChars = MIN_COMMENT_CHARS }) {
  const longestOwn = longestOwnCommentLength(comments, issue.assigneeAgentId);
  const documentCount = (documents ?? []).length;
  const attachmentCount = (attachments ?? []).length;
  const violation =
    isCandidate(issue) &&
    longestOwn < minChars &&
    documentCount === 0 &&
    attachmentCount === 0;
  return { violation, longestOwn, documentCount, attachmentCount };
}

/**
 * Verdict for one control fixture: null when it behaved, otherwise a
 * human-readable blindness reason. Distinguishes "fixture unfetchable"
 * (query/id rot) from "rule regressed" (classification flipped) — both are
 * blindness, but the fix differs.
 */
export function controlVerdict(control, issue, classification) {
  if (!issue || !issue.id) {
    return `control ${control.identifier} did not come back from the API (wrong id or broken query)`;
  }
  if (classification.violation !== control.mustFlag) {
    return (
      `control ${control.identifier} classified ${classification.violation ? 'VIOLATION' : 'clean'}, ` +
      `expected ${control.mustFlag ? 'VIOLATION' : 'clean'} ` +
      `(longestOwn=${classification.longestOwn}, docs=${classification.documentCount}, ` +
      `attachments=${classification.attachmentCount}) — ${control.note}`
    );
  }
  return null;
}

/**
 * Fields the scan filters on. The issues LIST endpoint omits some fields
 * entirely (e.g. `blockedBy` — AUR-4105), so filtering on an absent field
 * silently matches nothing. Validate each is present as a key on at least
 * one row before trusting the scan; an empty window is equally untrustable
 * (134 active routines fire daily — a genuinely empty 7-day window does not
 * happen on a live company).
 * @returns {string|null} blindness reason, or null when the shape is valid
 */
export const SCAN_FIELDS = ['id', 'identifier', 'originKind', 'status', 'assigneeAgentId', 'updatedAt'];

export function validateListShape(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'windowed issue list came back empty — on a company with active daily routines that is a broken query, not a clean board';
  }
  for (const field of SCAN_FIELDS) {
    if (!rows.some((row) => row != null && field in row)) {
      return `field "${field}" is absent from every row of the issue list response — the endpoint does not return it, so filtering on it silently matches nothing`;
    }
  }
  return null;
}

export function withinLookback(issue, lookbackDays, now = new Date()) {
  const stamp = issue.lastActivityAt ?? issue.updatedAt;
  if (!stamp) return false;
  return now.getTime() - new Date(stamp).getTime() <= lookbackDays * 24 * 60 * 60 * 1000;
}

/** Run id to report per violation, best-effort across the fields the API sets. */
export function violationRunId(issue) {
  return issue.completedByRunId ?? issue.executionRunId ?? issue.originRunId ?? 'unknown';
}

// ── Flag issue plumbing ───────────────────────────────────────────────────────

export const FLAG_REGEX = /delivery-claim violation:\s*(AUR-\d+)/i;

export function flagTitle(targetIdentifier) {
  return `delivery-claim violation: ${targetIdentifier} closed with no verifiable deliverable`;
}

export function buildFlagDescription(issue, classification) {
  const id = issue.identifier ?? issue.id;
  return [
    `## Routine execution claimed delivery with no verifiable artifact`,
    '',
    `**${id}** ("${issue.title}") is \`${issue.status}\` with \`originKind: routine_execution\`, ` +
      `assignee \`${issue.assigneeAgentId}\`, run \`${violationRunId(issue)}\` — and the longest comment the ` +
      `assignee posted on it is **${classification.longestOwn} chars** (< ${MIN_COMMENT_CHARS}), with ` +
      `**zero documents and zero attachments**.`,
    '',
    'That is the AUR-4482 signature: a handoff note asserting a deliverable that does not exist anywhere ' +
      'a reader can find it (see AUR-4613; same class as AUR-3930, AUR-4136, AUR-4184 — the success signal ' +
      'is not the outcome).',
    '',
    `Please have the assignee either link the real artifact (document, attachment, or a substantive comment ` +
      `re-read back per doctrine/deliverable-verification.md) or re-run the work. Detected by ` +
      `scripts/check-delivery-claims.mjs.`,
    '',
    'exec.routing-rationale: skip',
  ].join('\n');
}

/**
 * Cancel reason for an open flag whose target no longer violates, or null
 * while the flag is still valid.
 */
export function resolveCancelReason({ target, targetIdentifier, classification }) {
  if (!target) {
    return `Auto-resolved by delivery-claims watchdog: ${targetIdentifier} not found.`;
  }
  if (target.status === 'cancelled') {
    return `Auto-resolved by delivery-claims watchdog: ${targetIdentifier} is cancelled.`;
  }
  if (classification && !classification.violation) {
    return (
      `Auto-resolved by delivery-claims watchdog: ${targetIdentifier} no longer violates ` +
      `(longest own comment now ${classification.longestOwn} chars, ` +
      `${classification.documentCount} document(s), ${classification.attachmentCount} attachment(s)).`
    );
  }
  return null;
}

/** CEO routes cross-cutting board work; flags are filed to the CEO by spec. */
export const CEO_AGENT_ID = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';

/**
 * Anti-flood cap on Phase B filing per run (house pattern from
 * check-routing-rationale.mjs: cap and LOG the drops — a silent cap reads as
 * "covered everything"). First live dry-run (2026-08-12) found 14 violations
 * in a 7-day window; filing all at once buries the CEO and teaches the board
 * the watchdog is noise. Overflow is re-detected and filed on later runs as
 * earlier flags resolve (the scan is idempotent).
 */
export const FLAG_FILE_CAP = 5;

// ── API helpers ───────────────────────────────────────────────────────────────

const MAX_PAGES = 50;

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPatch(path, body) {
    const res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Paginate limit/offset until a short page. Guard against endpoints that
   * ignore `offset` (would loop forever repeating page one) by breaking when
   * a page's first id repeats.
   */
  async function apiGetAll(pathWithQueryPrefix, pageSize = 500) {
    const all = [];
    const seenFirstIds = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await apiGet(`${pathWithQueryPrefix}limit=${pageSize}&offset=${page * pageSize}`);
      const rows = Array.isArray(batch) ? batch : (batch?.issues ?? batch?.items ?? []);
      if (rows.length > 0) {
        const firstId = rows[0]?.id;
        if (firstId && seenFirstIds.has(firstId)) break;
        if (firstId) seenFirstIds.add(firstId);
      }
      all.push(...rows);
      if (rows.length < pageSize) return all;
    }
    console.error(`WARNING: pagination cap hit for ${pathWithQueryPrefix} — population may be undercounted.`);
    return all;
  }

  /** Everything classify() needs for one issue. `issue` may be an identifier or a full object. */
  async function fetchBundle(issueOrIdentifier) {
    const issue =
      typeof issueOrIdentifier === 'string'
        ? await apiGet(`/api/issues/${issueOrIdentifier}`)
        : issueOrIdentifier;
    const [comments, documents, attachments] = await Promise.all([
      apiGetAll(`/api/issues/${issue.id}/comments?`, 200),
      apiGet(`/api/issues/${issue.id}/documents`),
      apiGet(`/api/issues/${issue.id}/attachments`),
    ]);
    return { issue, comments, documents, attachments };
  }

  return { apiGet, apiPost, apiPatch, apiGetAll, fetchBundle };
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

// ── Main routine ──────────────────────────────────────────────────────────────

export async function main({ apply, lookbackDays, apiUrl, apiKey, companyId }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPost, apiPatch, apiGetAll, fetchBundle } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  // ── Blindness controls: run BEFORE any scan result is reported ─────────────
  console.log('── Controls (run every invocation — a clean zero from a blind query is worse than a crash) ──');
  for (const control of CONTROLS) {
    let verdict;
    try {
      const bundle = await fetchBundle(control.identifier);
      verdict = controlVerdict(control, bundle.issue, classify(bundle));
    } catch (err) {
      verdict = `control ${control.identifier} fetch failed: ${err.message}`;
    }
    if (verdict) {
      console.error(`\nDETECTOR BLIND: ${verdict}`);
      console.error('Refusing to report a violations count from an unvalidated query. Fix the detector first.');
      return 3;
    }
    console.log(`  OK: ${control.identifier} → ${control.mustFlag ? 'flagged' : 'clean'} as expected (${control.note})`);
  }

  // ── Windowed scan ──────────────────────────────────────────────────────────
  const statusParam = FLAGGABLE_STATUSES.join(',');
  const listed = await apiGetAll(`/api/companies/${companyId}/issues?status=${statusParam}&`);
  const shapeProblem = validateListShape(listed);
  if (shapeProblem) {
    console.error(`\nDETECTOR BLIND: ${shapeProblem}`);
    return 3;
  }

  const now = new Date();
  const candidates = listed.filter((issue) => isCandidate(issue) && withinLookback(issue, lookbackDays, now));
  console.log(`\n── Scan: ${listed.length} ${statusParam} issue(s), ${candidates.length} routine-executed within ${lookbackDays}d ──\n`);

  const violations = [];
  for (const issue of candidates) {
    const bundle = await fetchBundle(issue);
    const classification = classify(bundle);
    if (classification.violation) violations.push({ issue, classification });
  }

  if (violations.length === 0) {
    console.log('  No violations.');
  } else {
    console.log(`  VIOLATIONS (${violations.length}):`);
    for (const { issue, classification } of violations) {
      console.log(
        `    - ${issue.identifier} [${issue.status}] assignee=${issue.assigneeAgentId} ` +
          `longestOwnComment=${classification.longestOwn} chars, ` +
          `docs=${classification.documentCount}, attachments=${classification.attachmentCount}, ` +
          `run=${violationRunId(issue)}`
      );
    }
  }
  console.log();

  const failedMutations = [];

  // ── Phase A: auto-resolve stale flags ──────────────────────────────────────
  console.log('── Phase A: Auto-resolve stale flags ──');
  const openFlags = (
    await apiGetAll(`/api/companies/${companyId}/issues?status=backlog,todo,in_progress,in_review,blocked&`)
  ).filter((issue) => FLAG_REGEX.test(issue.title ?? ''));

  const openFlagTargets = new Set();
  const toCancel = [];
  for (const flag of openFlags) {
    const targetIdentifier = FLAG_REGEX.exec(flag.title)[1];
    let target = null;
    let classification = null;
    try {
      const bundle = await fetchBundle(targetIdentifier);
      target = bundle.issue;
      classification = classify(bundle);
    } catch {
      // target unfetchable → resolveCancelReason handles target === null
    }
    const reason = resolveCancelReason({ target, targetIdentifier, classification });
    if (reason) {
      toCancel.push({ flag, targetIdentifier, reason });
    } else {
      openFlagTargets.add(targetIdentifier);
    }
  }

  if (toCancel.length === 0) {
    console.log('  No stale flags to resolve.\n');
  } else {
    for (const { flag, targetIdentifier, reason } of toCancel) {
      console.log(`  CANCEL ${flag.identifier ?? flag.id} → ${targetIdentifier}: ${reason}`);
      if (apply) {
        const ok = await runMutation(
          `cancel ${flag.identifier ?? flag.id} (target ${targetIdentifier})`,
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

  // ── Phase B: file new flags ────────────────────────────────────────────────
  console.log('── Phase B: File new flags (assigned to CEO, naming issue + agent) ──');
  const unflagged = violations.filter(({ issue }) => !openFlagTargets.has(issue.identifier));
  const skippedDedup = violations.length - unflagged.length;
  if (skippedDedup > 0) console.log(`  SKIPPED-DEDUP — open flag exists (${skippedDedup}).`);

  const toFile = unflagged.slice(0, FLAG_FILE_CAP);
  const droppedByCap = unflagged.slice(FLAG_FILE_CAP);
  if (droppedByCap.length > 0) {
    console.log(`  CAPPED — filing ${FLAG_FILE_CAP}/${unflagged.length} this run; deferred to later runs:`);
    droppedByCap.forEach(({ issue }) => console.log(`    - ${issue.identifier}`));
  }

  if (toFile.length === 0) {
    console.log('  No new flags to file.\n');
  } else {
    for (const { issue, classification } of toFile) {
      const title = flagTitle(issue.identifier);
      console.log(`  FILE: "${title}" → CEO`);
      if (apply) {
        const ok = await runMutation(
          `file flag for ${issue.identifier}`,
          () =>
            apiPost(`/api/companies/${companyId}/issues`, {
              title,
              description: buildFlagDescription(issue, classification),
              status: 'todo',
              priority: 'high',
              assigneeAgentId: CEO_AGENT_ID,
            }),
          failedMutations,
        );
        if (ok) console.log('    → filed.');
      }
    }
    console.log();
  }

  console.log('── Summary ──');
  console.log(`  Controls:      2/2 passed`);
  console.log(`  Candidates:    ${candidates.length}`);
  console.log(`  Violations:    ${violations.length}`);
  console.log(`  Resolved:      ${toCancel.length}`);
  console.log(`  Filed:         ${toFile.length}${droppedByCap.length > 0 ? ` (capped; ${droppedByCap.length} deferred)` : ''}`);
  console.log(`  Skipped-dedup: ${skippedDedup}`);
  console.log(`  Failed:        ${failedMutations.length}`);
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
      'lookback-days': { type: 'string', default: String(DEFAULT_LOOKBACK_DAYS) },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-delivery-claims.mjs [--apply] [--lookback-days N]');
    console.log('  --apply          Execute changes (default: dry-run, exit 1 if actions pending)');
    console.log('  --lookback-days  Scan window in days (default: 7)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
  const lookbackDays = Number(args['lookback-days']);

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    console.error('ERROR: --lookback-days must be a positive number.');
    process.exit(2);
  }

  resolveApiBase()
    .then((API_URL) =>
      main({ apply: args.apply, lookbackDays, apiUrl: API_URL, apiKey: API_KEY, companyId: COMPANY_ID })
    )
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FATAL:', err.message);
      process.exit(2);
    });
}
