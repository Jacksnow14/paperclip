#!/usr/bin/env node
/**
 * check-unattributed-trigger-disarms.mjs (AUR-5745, child of AUR-5744)
 *
 * Root incident (AUR-5744): the systemd --user timer
 * `paperclip-routine-allowlist.timer` runs
 * `/home/ievgen/.paperclip/bin/enforce-routine-allowlist.mjs` every 15
 * minutes and used to disarm off-policy schedule triggers with a raw
 * `UPDATE routine_triggers SET enabled = false, updated_at = now()`. That
 * raw SQL never wrote a `routine_revisions` row or an `activity_log` entry
 * and left `updated_by_agent_id` stale, so the disarm looked unattributed —
 * only a human noticing a stale `updated_by_agent_id` ever caught it. The
 * enforcer script has since been fixed to write both (actor
 * `actor_type='system'/actor_id='routine-allowlist-enforcer'`).
 *
 * This watchdog is the remaining ask: catch the NEXT time some writer
 * (present or future) disarms a schedule trigger without leaving that same
 * audit trail, instead of relying on a human noticing again.
 *
 * Detection logic, per trigger where `kind = 'schedule'` and
 * `enabled = false`:
 *   1. Find the most recent `routine_revisions` row for its `routine_id`
 *      (`order by revision_number desc limit 1`).
 *   2. Flag as unattributed if `routine_triggers.updated_at` is more than
 *      `--tolerance-ms` (default 5000) after the latest revision's
 *      `created_at` — or if no revision exists at all. A legitimate disarm
 *      via `PATCH /api/routine-triggers/:id` always appends a revision in
 *      the same transaction (`appendRoutineRevision()` / `updateTrigger()`
 *      in server/src/services/routines.ts), so `updated_at` and the new
 *      revision's `created_at` land within the same transaction — well
 *      under the tolerance.
 *   3. Report (but do not additionally gate on) whether the trigger also
 *      carries no actor identity at all (`updated_by_agent_id IS NULL AND
 *      updated_by_user_id IS NULL`) — the strongest tell when there is no
 *      revision to compare against, surfaced in the finding for context.
 *
 * Detection only — this script never mutates `routine_triggers` or
 * `routine_revisions`, matching the rest of the check-*.mjs family
 * (see check-routing-rationale.mjs, check-stalled-blocked.mjs for the same
 * find-or-create-and-rewrite-in-place shape this borrows).
 *
 * Output: find-or-create a single dedup issue titled `FLAG_TITLE`, rewritten
 * in place every run with the current findings, and auto-closed once the
 * list empties — never one issue per gap.
 *
 * Usage:
 *   node scripts/check-unattributed-trigger-disarms.mjs [--apply] [--tolerance-ms 5000]
 *
 *   Without --apply: dry-run — prints the plan, writes nothing.
 *   With --apply:    files/updates/closes the dedup issue.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3100)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Env vars optional:
 *   TRIGGER_DISARM_WATCHDOG_OWNER_AGENT_ID  Overrides the assignee for the
 *                                           filed issue. Defaults to the CTO.
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD  Override the
 *                                           embedded-Postgres connection
 *                                           (defaults match the local
 *                                           control-plane instance).
 *
 * Exit codes:
 *   0 — ran to completion (including "found and reported unattributed
 *       disarms" — that is success for this script, not a failure)
 *   2 — configuration/API error
 */

import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// `postgres` is loaded lazily inside connectDb() below, not at module scope —
// the scripts-test CI job runs `node --test scripts/` with no `pnpm install`
// step (see .github/workflows/ci.yml), so a top-level `require('postgres')`
// breaks module import for every test in this file even when a mock
// fetchCandidateRows is supplied and connectDb() is never called.

// ── Pure logic (exported, used in tests) ────────────────────────────────────

/** Default tolerance for "the revision landed in the same transaction". */
export const DEFAULT_TOLERANCE_MS = 5000;

/** Owner for a filed watchdog issue when the caller doesn't override it. */
export const DEFAULT_OWNER_AGENT_ID = '371a1b08-0286-4a12-a516-f587f42df5eb'; // CTO

/** Stable dedup title — find-or-create, rewritten in place, never one-per-gap. */
export const FLAG_TITLE = 'Watchdog: unattributed schedule-trigger disarm(s) detected';

/** Statuses searched (and treated as "still open") when looking up the dedup issue. */
export const FLAG_SEARCH_STATUSES = 'backlog,todo,in_progress,in_review,blocked';

/**
 * Classifies one disabled schedule-trigger candidate row.
 *
 * @param {{ triggerUpdatedAt: string|Date, updatedByAgentId?: string|null, updatedByUserId?: string|null, revisionCreatedAt?: string|Date|null }} row
 * @param {number} toleranceMs
 * @returns {{ unattributed: boolean, hasRevision: boolean, gapMs: number|null, noActorIdentity: boolean }}
 */
export function classifyRow(row, toleranceMs = DEFAULT_TOLERANCE_MS) {
  const hasRevision = row.revisionCreatedAt != null;
  const triggerUpdatedAtMs = new Date(row.triggerUpdatedAt).getTime();
  const gapMs = hasRevision ? triggerUpdatedAtMs - new Date(row.revisionCreatedAt).getTime() : null;
  const noActorIdentity = !row.updatedByAgentId && !row.updatedByUserId;
  const unattributed = !hasRevision || gapMs > toleranceMs;
  return { unattributed, hasRevision, gapMs, noActorIdentity };
}

/** One human-readable line per finding, used in both console output and the issue body. */
export function formatFinding(row, classification) {
  const routineLabel = row.routineTitle ? `"${row.routineTitle}"` : row.routineId;
  const gapDesc = classification.hasRevision
    ? `${Math.round(classification.gapMs / 1000)}s after the latest revision (routine_revisions#${row.revisionNumber ?? '?'}, created_at=${new Date(row.revisionCreatedAt).toISOString()})`
    : 'no routine_revisions row exists for this routine at all';
  const identityDesc = classification.noActorIdentity
    ? 'updated_by_agent_id and updated_by_user_id are BOTH null'
    : `updated_by_agent_id=${row.updatedByAgentId ?? 'null'}, updated_by_user_id=${row.updatedByUserId ?? 'null'}`;
  return (
    `trigger ${row.triggerId} (routine ${row.routineId} ${routineLabel}, label=${row.label ?? 'null'}): ` +
    `disabled at ${new Date(row.triggerUpdatedAt).toISOString()}, ${gapDesc}. ${identityDesc}.`
  );
}

/** Builds the dedup issue body listing every current finding. */
export function buildIssueBody(findings, now = new Date()) {
  const lines = [
    `## Unattributed schedule-trigger disarm(s)`,
    '',
    `As of ${now.toISOString()}, ${findings.length} disabled schedule trigger(s) were disabled more recently ` +
      'than the latest `routine_revisions` row for their routine was written (or have no revision at all) — ' +
      'meaning whatever flipped `enabled = false` did not append a revision covering the change, the same ' +
      'audit-trail gap root-caused on AUR-5744.',
    '',
  ];
  for (const { row, classification } of findings) {
    lines.push(`- ${formatFinding(row, classification)}`);
  }
  lines.push(
    '',
    'This is detection only — nothing here re-enables a trigger or writes a revision. Investigate the writer ' +
      '(most recent `activity_log` rows for the trigger, or the process that touched it) and either fix it to ' +
      'append a revision the way `PATCH /api/routine-triggers/:id` does, or confirm the disarm was legitimate ' +
      'and record it properly.',
    '',
    'This issue is rewritten in place every watchdog run and auto-closes once the list empties.',
    '',
    'exec.routing-rationale: skip',
  );
  return lines.join('\n');
}

// ── DB access ────────────────────────────────────────────────────────────────

/**
 * Fetches every disabled schedule trigger for the company alongside its
 * latest routine_revisions row (left-joined, so a routine with zero
 * revisions still comes back with revisionCreatedAt: null rather than being
 * dropped).
 */
export async function queryCandidateRows(sql, companyId) {
  const rows = await sql`
    select
      rt.id as trigger_id,
      rt.routine_id,
      rt.label,
      rt.updated_at as trigger_updated_at,
      rt.updated_by_agent_id,
      rt.updated_by_user_id,
      r.title as routine_title,
      rev.revision_number,
      rev.created_at as revision_created_at
    from routine_triggers rt
    join routines r on r.id = rt.routine_id
    left join lateral (
      select revision_number, created_at
      from routine_revisions
      where routine_id = rt.routine_id
      order by revision_number desc
      limit 1
    ) rev on true
    where rt.kind = 'schedule' and rt.enabled = false and rt.company_id = ${companyId}
    order by rt.updated_at desc
  `;
  return rows.map((r) => ({
    triggerId: r.trigger_id,
    routineId: r.routine_id,
    label: r.label,
    triggerUpdatedAt: r.trigger_updated_at,
    updatedByAgentId: r.updated_by_agent_id,
    updatedByUserId: r.updated_by_user_id,
    routineTitle: r.routine_title,
    revisionNumber: r.revision_number,
    revisionCreatedAt: r.revision_created_at,
  }));
}

function connectDb() {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const postgres = require('postgres');
  return postgres({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 54329),
    db: process.env.PGDATABASE ?? 'paperclip',
    user: process.env.PGUSER ?? 'paperclip',
    pass: process.env.PGPASSWORD ?? 'paperclip',
    max: 1,
  });
}

// ── API access ───────────────────────────────────────────────────────────────

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

/** Finds the dedup issue by exact title match (search is a loose ILIKE contains — assert exact client-side). */
export async function findFlagIssue({ companyId, apiGet }) {
  const results = await apiGet(
    `/api/companies/${companyId}/issues?q=${encodeURIComponent(FLAG_TITLE)}&status=${FLAG_SEARCH_STATUSES}&limit=20`,
  );
  const rows = Array.isArray(results) ? results : (results?.issues ?? []);
  return rows.find((issue) => issue.title === FLAG_TITLE) ?? null;
}

// ── Main routine ─────────────────────────────────────────────────────────────

export async function main({
  apply,
  apiUrl,
  apiKey,
  companyId,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  ownerAgentId = DEFAULT_OWNER_AGENT_ID,
  now = new Date(),
  fetchCandidateRows,
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPatch, apiPost } = makeApiHelpers(apiUrl, headers);

  let ownDb = null;
  const fetchRows =
    fetchCandidateRows ??
    (async () => {
      ownDb = connectDb();
      return queryCandidateRows(ownDb, companyId);
    });

  let rows;
  try {
    rows = await fetchRows();
  } finally {
    if (ownDb) await ownDb.end();
  }

  const findings = [];
  for (const row of rows) {
    const classification = classifyRow(row, toleranceMs);
    if (classification.unattributed) findings.push({ row, classification });
  }

  console.log(`Disabled schedule triggers scanned: ${rows.length}. Unattributed: ${findings.length}.`);
  for (const f of findings) console.log(`  ${formatFinding(f.row, f.classification)}`);

  const existing = await findFlagIssue({ companyId, apiGet });

  if (findings.length === 0) {
    if (existing && !['done', 'cancelled'].includes(existing.status)) {
      console.log(`CLOSE ${existing.identifier ?? existing.id} — no outstanding unattributed disarms.`);
      if (apply) {
        await apiPatch(`/api/issues/${existing.id}`, { status: 'done' });
        await apiPost(`/api/issues/${existing.id}/comments`, {
          body: `Auto-closed by check-unattributed-trigger-disarms: 0 unattributed schedule-trigger disarms found as of ${now.toISOString()}.`,
        });
        console.log('  → closed.');
      }
    } else {
      console.log('No outstanding unattributed disarms; nothing to sync.');
    }
    return 0;
  }

  const body = buildIssueBody(findings, now);

  if (existing && !['done', 'cancelled'].includes(existing.status)) {
    console.log(`UPDATE ${existing.identifier ?? existing.id} (${findings.length} outstanding).`);
    if (apply) {
      await apiPatch(`/api/issues/${existing.id}`, { description: body });
      await apiPost(`/api/issues/${existing.id}/comments`, {
        body: `Re-scanned ${now.toISOString()}: ${findings.length} unattributed disarm(s) still present.`,
      });
      console.log('  → updated.');
    }
    return 0;
  }

  console.log(`FILE "${FLAG_TITLE}" (${findings.length} outstanding) → owner ${ownerAgentId}.`);
  if (apply) {
    await apiPost(`/api/companies/${companyId}/issues`, {
      title: FLAG_TITLE,
      description: body,
      status: 'todo',
      priority: 'medium',
      assigneeAgentId: ownerAgentId,
    });
    console.log('  → filed.');
  }
  return 0;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);
if (isMain) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'tolerance-ms': { type: 'string' },
    },
  });

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  resolveApiBase()
    .then((API_URL) =>
      main({
        apply: values.apply,
        apiUrl: API_URL,
        apiKey: API_KEY,
        companyId: COMPANY_ID,
        toleranceMs: values['tolerance-ms'] ? Number(values['tolerance-ms']) : DEFAULT_TOLERANCE_MS,
        ownerAgentId: process.env.TRIGGER_DISARM_WATCHDOG_OWNER_AGENT_ID ?? DEFAULT_OWNER_AGENT_ID,
      }),
    )
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('FATAL:', err);
      process.exit(2);
    });
}
