#!/usr/bin/env node
/**
 * check-routing-rationale.mjs
 *
 * Self-cleaning, deterministic watchdog for the routing-rationale convention
 * (AGENTS.md §12). Runs as a scheduled routine every 30 minutes with --apply.
 *
 * Lifecycle:
 *   Phase A — Auto-resolve stale flags (always runs, ignores window):
 *     Cancel open flag issues whose target is done/cancelled, already has a
 *     routing/{id} memory record, or is now exempt. Posts a one-line reason.
 *
 *   Phase B — Detect + file (within --window-minutes):
 *     Flag high/critical assigned manual issues updated in the window that are
 *     still missing routing/{id} records, deduplicating against Phase A's
 *     remaining open flags.
 *
 * Usage:
 *   node scripts/check-routing-rationale.mjs [--window-minutes N] [--apply]
 *
 *   Without --apply: dry-run — prints full plan, writes nothing.
 *   With --apply:    executes cancellations and files new flags (idempotent).
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exemption rules (no flag filed; existing open flags auto-resolved):
 *   1. Issue description contains token `exec.routing-rationale: skip`
 *   2. Issue title matches /content slot/i
 *
 * Exit codes:
 *   0 — clean (nothing to do, or all actions applied)
 *   1 — dry-run with pending actions (apply to execute)
 *   2 — configuration/API error
 */

import { parseArgs } from 'node:util';

// ── Exported core utilities (used in tests) ──────────────────────────────────

/** Matches both flag title formats produced in the wild. */
export const FLAG_REGEX = /routing-rationale[- ]gap:\s*(AUR-\d+)/i;

/**
 * The issues LIST endpoint truncates `description` to this many chars
 * (server: ISSUE_LIST_DESCRIPTION_MAX_CHARS in services/issues.ts). The
 * `exec.routing-rationale: skip` exemption token can sit past this boundary,
 * so a list-fetched description at or above this length may be truncated and
 * must be re-fetched in full before evaluating exemption.
 */
export const LIST_DESC_TRUNCATION = 1200;

/** A list-fetched description this long may be truncated — fetch the full issue. */
export function mayBeTruncated(description) {
  return (description ?? '').length >= LIST_DESC_TRUNCATION;
}

/**
 * Returns true if an issue is exempt from the routing-rationale convention.
 * Exempt issues are never flagged and any existing open flags are auto-resolved.
 */
export function isExempt(issue) {
  if (issue.description && issue.description.includes('exec.routing-rationale: skip')) return true;
  if (/content slot/i.test(issue.title ?? '')) return true;
  // Recurring daily-brief publication tasks (e.g. "Post 2026-05-29 daily AI brief
  // to AUR-27") are content publication, not technical-routing decisions, so a
  // routing/{id} rationale is meaningless. They recur daily and would otherwise be
  // flagged-then-auto-resolved every day — a known false-positive class (AUR-1550).
  if (/daily\b.*\bbrief/i.test(issue.title ?? '')) return true;
  return false;
}

/**
 * Returns a cancel reason string if the flag should be resolved, or null if
 * the flag is still valid and should remain open.
 *
 * @param {{ target: object|null, hasRecord: boolean }} opts
 */
export function resolveCancelReason({ target, targetId, hasRecord }) {
  if (!target || ['done', 'cancelled'].includes(target.status)) {
    return target
      ? `Auto-resolved by routing-rationale-watchdog: ${targetId} is ${target.status} — routing rationale moot.`
      : `Auto-resolved by routing-rationale-watchdog: ${targetId} not found among open issues — routing rationale moot.`;
  }
  if (isExempt(target)) {
    return `Auto-resolved by routing-rationale-watchdog: ${targetId} is exempt from routing rationale (exec.routing-rationale: skip or content-slot pattern).`;
  }
  if (hasRecord) {
    return `Auto-resolved by routing-rationale-watchdog: routing/${targetId} record now exists.`;
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

// ── Main routine ──────────────────────────────────────────────────────────────

/**
 * Status filter for the working-issue fetch. MUST include `backlog`: flags
 * filed by Phase B (and any other issue) default to `backlog` status server-side
 * (services/issues.ts: `status: values.status ?? "backlog"`). If `backlog` is
 * omitted here, Phase A never sees stale backlog flags (they never auto-resolve)
 * and Phase B never counts them as open (it files duplicates). See AUR-1581.
 */
export const ISSUE_STATUS_FILTER = 'backlog,todo,in_progress,in_review,blocked';

export async function main({ windowMinutes, apply, apiUrl, apiKey, companyId }) {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPatch, apiPost } = makeApiHelpers(apiUrl, headers);

  // The issues LIST endpoint truncates descriptions, which can hide the
  // exemption token. Re-fetch the full issue (cached) only when the
  // list-fetched description is long enough to possibly be truncated.
  const fullDescCache = new Map();
  async function withFullDescription(issue) {
    if (!mayBeTruncated(issue.description)) return issue;
    const key = issue.id ?? issue.identifier;
    if (!fullDescCache.has(key)) {
      const full = await apiGet(`/api/issues/${key}`);
      fullDescCache.set(key, full?.description ?? issue.description ?? '');
    }
    return { ...issue, description: fullDescCache.get(key) };
  }

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  // Fetch all open issues once — used by both phases
  const issuesBatch = await apiGet(
    `/api/companies/${companyId}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`
  );
  const rawIssues = Array.isArray(issuesBatch) ? issuesBatch : (issuesBatch.issues ?? []);

  // Build lookup by identifier
  const issueByIdentifier = new Map();
  for (const issue of rawIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue);
  }

  // ── Phase A: Auto-resolve stale flags ──────────────────────────────────────
  console.log('── Phase A: Auto-resolve stale flags ──');

  const flagIssues = rawIssues.filter(issue => FLAG_REGEX.test(issue.title ?? ''));
  const openFlagTargets = new Set(); // target identifiers with still-valid open flags

  const toCancel = [];

  for (const flag of flagIssues) {
    const match = FLAG_REGEX.exec(flag.title);
    if (!match) continue;
    const targetId = match[1];
    const rawTarget = issueByIdentifier.get(targetId) ?? null;
    const target = rawTarget ? await withFullDescription(rawTarget) : null;

    // Check routing record only when target is open and non-exempt
    let hasRecord = false;
    if (target && !['done', 'cancelled'].includes(target.status) && !isExempt(target)) {
      const records = await apiGet(
        `/api/companies/${companyId}/memory/records?titlePrefix=routing/${targetId}&limit=1`
      );
      hasRecord = Array.isArray(records)
        ? records.length > 0
        : (records?.records?.length ?? 0) > 0;
    }

    const cancelReason = resolveCancelReason({ target, targetId, hasRecord });

    if (cancelReason) {
      toCancel.push({ flag, targetId, reason: cancelReason });
    } else {
      openFlagTargets.add(targetId);
    }
  }

  if (toCancel.length === 0) {
    console.log('  No stale flags to resolve.\n');
  } else {
    for (const { flag, targetId, reason } of toCancel) {
      const flagId = flag.id ?? flag.identifier;
      console.log(`  CANCEL ${flag.identifier ?? flagId} → ${targetId}: ${reason}`);
      if (apply) {
        await apiPatch(`/api/issues/${flagId}`, { status: 'cancelled' });
        await apiPost(`/api/issues/${flagId}/comments`, { body: reason });
        console.log(`    → cancelled + commented.`);
      }
    }
    console.log();
  }

  if (openFlagTargets.size > 0) {
    console.log(`  Keeping ${openFlagTargets.size} flag(s) still valid: ${[...openFlagTargets].join(', ')}\n`);
  }

  // ── Phase B: Detect + file ─────────────────────────────────────────────────
  console.log('── Phase B: Detect and file new flags ──');

  // Pool of issues subject to §12, then hydrate full descriptions so the
  // exemption token is not missed due to list-endpoint truncation.
  const pool = await Promise.all(
    rawIssues
      .filter(issue =>
        ['high', 'critical'].includes(issue.priority) &&
        issue.assigneeAgentId &&
        (!issue.originKind || issue.originKind === 'manual'))
      .map(withFullDescription)
  );

  const exemptIssues = pool.filter(isExempt);

  const seen = new Set();
  const candidates = pool.filter(issue => {
    if (isExempt(issue)) return false;
    const key = issue.id ?? issue.identifier;
    if (seen.has(key)) return false;
    seen.add(key);
    const updated = issue.updatedAt ?? issue.assignedAt;
    if (!updated) return true;
    return new Date(updated) >= new Date(windowStart);
  });

  if (exemptIssues.length > 0) {
    console.log(`  EXEMPT (${exemptIssues.length}):`);
    for (const issue of exemptIssues) {
      console.log(`    - ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
    console.log();
  }

  if (candidates.length === 0) {
    console.log(`  No high/critical assigned manual issues updated in the last ${windowMinutes} minutes.\n`);
  }

  const toFile = [];
  const skippedDedup = [];
  const skippedHasRecord = [];

  await Promise.all(candidates.map(async (issue) => {
    const id = issue.identifier ?? issue.id;

    // Dedup: an open flag for this target already exists (Phase A kept it)
    if (openFlagTargets.has(id)) {
      skippedDedup.push(issue);
      return;
    }

    const records = await apiGet(
      `/api/companies/${companyId}/memory/records?titlePrefix=routing/${id}&limit=1`
    );
    const hasRecord = Array.isArray(records)
      ? records.length > 0
      : (records?.records?.length ?? 0) > 0;

    if (hasRecord) {
      skippedHasRecord.push(issue);
    } else {
      toFile.push(issue);
    }
  }));

  if (skippedDedup.length > 0) {
    console.log(`  SKIPPED-DEDUP — open flag exists (${skippedDedup.length}):`);
    for (const issue of skippedDedup) {
      console.log(`    - ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
    console.log();
  }

  if (skippedHasRecord.length > 0) {
    console.log(`  HAS RECORD — routing rationale present (${skippedHasRecord.length}):`);
    for (const issue of skippedHasRecord) {
      console.log(`    - ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
    console.log();
  }

  if (toFile.length === 0) {
    console.log('  No new flags to file.\n');
  } else {
    for (const issue of toFile) {
      const id = issue.identifier ?? issue.id;
      const assignee = issue.assigneeAgentId ?? 'unknown';
      const title = `routing-rationale gap: ${id} missing routing/${id} record`;
      const description = [
        `## Routing rationale gap detected`,
        ``,
        `Issue **${id}** ("${issue.title}") is \`${issue.priority}\` priority, assigned to agent \`${assignee}\`, but is missing a \`routing/${id}\` rationale record in Paperclip Memory.`,
        ``,
        `The manager that assigned this issue must capture a routing rationale record per AGENTS.md §12.`,
        ``,
        `**Required record key:** \`routing/${id}\``,
        ``,
        `exec.preflight: skip`,
      ].join('\n');
      console.log(`  FILE: "${title}"`);
      if (apply) {
        // File in `todo`, not the server default `backlog`: these flags are
        // actionable (a manager must add the routing record) and should be
        // visible in the working set by default. The filter above also covers
        // `backlog` defensively so pre-existing/manually-moved flags still
        // auto-resolve and dedup. See AUR-1581.
        await apiPost(`/api/companies/${companyId}/issues`, { title, description, status: 'todo' });
        console.log(`    → filed.`);
      }
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('── Summary ──');
  console.log(`  Resolved:      ${toCancel.length}`);
  console.log(`  Filed:         ${toFile.length}`);
  console.log(`  Skipped-dedup: ${skippedDedup.length}`);
  console.log(`  Exempt:        ${exemptIssues.length}`);

  const hasPendingActions = toCancel.length > 0 || toFile.length > 0;
  if (!apply && hasPendingActions) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above actions.');
    return 1;
  }
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Run only when invoked directly (not imported by tests)
const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      'window-minutes': { type: 'string', default: '60' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-routing-rationale.mjs [--window-minutes N] [--apply]');
    console.log('  --window-minutes N  Only check issues updated in last N minutes (default: 60)');
    console.log('  --apply             Execute changes (default: dry-run, exit 1 if actions pending)');
    process.exit(0);
  }

  const API_URL = process.env.PAPERCLIP_API_URL;
  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_URL || !API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  main({
    windowMinutes: parseInt(args['window-minutes'], 10),
    apply: args.apply,
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
  }).then(code => process.exit(code)).catch(err => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
