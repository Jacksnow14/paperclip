#!/usr/bin/env node
/**
 * check-routine-workspace-binding.mjs
 *
 * Weekly watchdog closing the loop AUR-4985 opened and AUR-6167 filed against:
 * AUR-4985's enumerated cohort of routines with no `projectId` was fully bound
 * by hand, but the mechanism was a one-off script someone had to remember to
 * re-run. By the next audit (19 days later) 15 fresh routines had been created
 * with no project binding and nothing had noticed — a one-way backlog-catchup
 * pattern. This script automates the re-run and reports only the DELTA (newly
 * unbound since the last run), so closing the gap doesn't depend on anyone's
 * memory.
 *
 * --- Why not creation-time auto-defaulting (AUR-6167's other proposed option) ---
 * Evaluated and rejected. Verified against the live store (2026-08-25): of the
 * 15 currently-unbound routines, 10 carry a `parentIssueId` — and every one of
 * those parent issues is ALSO `projectId: null`. There is no reliable
 * "inherit from parent issue" signal here. This company also has no
 * "agent's primary/operational project" field to fall back to (checked:
 * agents carry no such column). Auto-defaulting would have to guess, and a
 * wrong guess (binding a routine to an unrelated project) actively makes
 * auditing *worse* than a clean, honest `null` — it hides the routine from a
 * project-scoped view while teaching nobody anything. A periodic audit that
 * surfaces drift for a human/agent judgment call is the safer fix.
 *
 * Usage:
 *   node scripts/check-routine-workspace-binding.mjs           # dry-run, print only
 *   node scripts/check-routine-workspace-binding.mjs --apply   # post digest comment + persist state
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3100)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 * Env vars used when posting (rolling-issue mode — AUR-6167 uses
 * concurrencyPolicy: reuse_and_rewake, so the routine's execution issue is
 * long-lived and PAPERCLIP_TASK_ID identifies it on every fire):
 *   PAPERCLIP_TASK_ID    Execution issue to post the digest comment on
 *                        (overridable with --issue-id for manual runs)
 *
 * Exit codes:
 *   0 — clean run (dry-run or apply, whether or not drift was found)
 *   2 — configuration/API error
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

/** Memory record title carrying the previous run's unbound-routine-id set. Org-wide
 *  (no scope.projectId) so the titlePrefix read below — also unscoped — finds it. */
export const STATE_TITLE = 'routine-binding-watchdog/last-seen';

const ACTIVE_STATUSES = new Set(['active', 'paused']);

function makeApiHelpers(apiUrl, headers) {
  async function apiGet(path) {
    const res = await fetch(`${apiUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }
  async function apiPost(path, body) {
    const res = await fetch(`${apiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }
  return { apiGet, apiPost };
}

const asArray = (d, key) => (Array.isArray(d) ? d : (d && d[key]) || []);

/** Every active/paused (non-archived) routine with no projectId. The routines list endpoint
 *  does not paginate (no limit/offset support server-side) — it always
 *  returns the full company set in one call. */
export async function fetchUnboundRoutines(apiGet, companyId) {
  const data = await apiGet(`/api/companies/${companyId}/routines`);
  const rows = asArray(data, 'routines');
  return rows.filter((r) => ACTIVE_STATUSES.has(r.status) && !r.projectId);
}

/** Diff current unbound routines against the previous run's id set. Pure. */
export function diffUnbound(current, previousIds) {
  const prev = new Set(previousIds || []);
  const currentIds = current.map((r) => r.id);
  const currentSet = new Set(currentIds);
  const fresh = current.filter((r) => !prev.has(r.id));
  const resolved = [...prev].filter((id) => !currentSet.has(id));
  return { fresh, resolved, currentIds };
}

export function buildDigestComment({ fresh, resolvedCount, totalUnbound }) {
  const lines = [
    '## Routine workspace-binding drift — weekly audit (AUR-6167)',
    '',
    `Active/paused unbound routines: ${totalUnbound}. New since last run: ${fresh.length}. ` +
      `Resolved since last run: ${resolvedCount}.`,
    '',
  ];
  if (fresh.length === 0) {
    lines.push('No new drift this week.');
  } else {
    lines.push('### New unbound routines');
    for (const r of fresh) {
      lines.push(
        `- \`${r.id}\` **${r.title}** — assignee \`${r.assigneeAgentId ?? '(none)'}\`, ` +
          `parentIssueId \`${r.parentIssueId ?? '(none)'}\`, created ${r.createdAt}`,
      );
    }
    lines.push(
      '',
      'Triage each: bind it with `PATCH /api/routines/{id}` `{ "projectId": "..." }` if it should be ' +
        'project-scoped, or reply noting why it is intentionally unscoped (narrow one-shot/checkpoint ' +
        'routine with no repo-checkout hazard, per AUR-6167’s own risk framing) so it is not re-flagged ' +
        'as a mystery next week.',
    );
  }
  lines.push('', '_Rolling issue — this comment does not close the issue; the next weekly fire reuses it._');
  return lines.join('\n');
}

export async function main({ apply, apiUrl, apiKey, companyId, issueId }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const { apiGet, apiPost } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  const current = await fetchUnboundRoutines(apiGet, companyId);

  const stateRes = await apiGet(
    `/api/companies/${companyId}/memory/records?titlePrefix=${encodeURIComponent(STATE_TITLE)}&limit=1`,
  );
  const stateRows = asArray(stateRes, 'records');
  const previousIds = stateRows[0]?.metadata?.unbound_routine_ids ?? [];

  const { fresh, resolved, currentIds } = diffUnbound(current, previousIds);

  console.log(`Active/paused unbound routines: ${current.length}`);
  console.log(`New since last run: ${fresh.length}`);
  console.log(`Resolved since last run: ${resolved.length}`);
  for (const r of fresh) console.log(`  NEW: ${r.id} | ${r.title}`);

  if (!apply) {
    console.log('\n[DRY-RUN] Pass --apply to post the digest comment and persist state.');
    return 0;
  }

  if (issueId) {
    const body = buildDigestComment({ fresh, resolvedCount: resolved.length, totalUnbound: current.length });
    await apiPost(`/api/issues/${issueId}/comments`, { body });
  } else {
    console.warn(
      'WARNING: no issue id available (set PAPERCLIP_TASK_ID or pass --issue-id) — skipped posting the digest comment.',
    );
  }

  const nowIso = new Date().toISOString();
  await apiPost(`/api/companies/${companyId}/memory/capture`, {
    title: STATE_TITLE,
    upsert: true,
    content: `Unbound-routine watchdog state as of ${nowIso}: ${currentIds.length} active/paused unbound routine(s), ${fresh.length} new, ${resolved.length} resolved this run.`,
    metadata: {
      category: 'synthesis',
      unbound_routine_ids: currentIds,
      fresh_count: fresh.length,
      resolved_count: resolved.length,
      computed_at: nowIso,
    },
    source: issueId ? { kind: 'issue', issueId } : { kind: 'manual_note' },
  });

  return 0;
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'issue-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-routine-workspace-binding.mjs [--apply] [--issue-id <id>]');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
  const ISSUE_ID = args['issue-id'] || process.env.PAPERCLIP_TASK_ID || null;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  resolveApiBase()
    .then((API_URL) =>
      main({
        apply: args.apply,
        apiUrl: API_URL,
        apiKey: API_KEY,
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
      }),
    )
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FATAL:', err.message);
      process.exit(2);
    });
}
