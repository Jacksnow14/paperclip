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
 * AUR-5780 adds a second, independent check alongside this one:
 * `classifyBornDisabledRoutine` / `runBornDisabledCheck` (own dedup issue,
 * `BORN_DISABLED_FLAG_TITLE`) catches the general case the revision-mismatch
 * check above cannot: a routine with `status: 'active'`, never triggered
 * (`lastTriggeredAt: null`), every trigger disabled, and the earliest signal
 * (a schedule trigger's `nextRunAt`, or the routine's `createdAt` if none)
 * frozen more than `--staleness-ms` (default 24h) in the past. This covers a
 * trigger disabled from the moment the routine was created — no revision
 * mismatch ever exists for that shape, so it slipped past the check above
 * entirely (root case: routine 725124f5 / AUR-5668, silent 3 days).
 *
 * Usage:
 *   node scripts/check-unattributed-trigger-disarms.mjs [--apply] [--tolerance-ms 5000] [--staleness-ms 86400000]
 *
 *   Without --apply: dry-run — prints the plan, writes nothing.
 *   With --apply:    files/updates/closes both dedup issues.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3100)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Env vars optional:
 *   TRIGGER_DISARM_WATCHDOG_OWNER_AGENT_ID  Overrides the assignee for the
 *                                           filed issue(s). Defaults to the CTO.
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD  Override the
 *                                           embedded-Postgres connection
 *                                           (defaults match the local
 *                                           control-plane instance).
 *
 * Exit codes:
 *   0 — ran to completion (including "found and reported unattributed
 *       disarms / operationally-invisible routines" — that is success for
 *       this script, not a failure)
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

// ── Born-disabled routine detection (AUR-5780) ──────────────────────────────
//
// The revision-mismatch check above only catches a trigger flipping to
// enabled=false *after* it existed — a matching routine_revisions row (or
// its absence) is the tell. A trigger that is born disabled — created with
// enabled=false from the start, e.g. a routine-creation bug/oversight, or an
// out-of-policy title that the routine-allowlist enforcer disarms on its
// very first sweep — never flips, so there is no mismatch to catch. It
// slips through invisibly. AUR-5780's root case (routine 725124f5, AUR-5668
// daily delivery check) sat silent for three days this way.
//
// Detection is independent of *why* the routine never fires — attribution
// doesn't matter, only the operationally-invisible shape does:
//   status: 'active', lastTriggeredAt: null, every trigger disabled, and the
//   earliest signal (a schedule trigger's nextRunAt, or the routine's own
//   createdAt if no schedule trigger ever computed one) frozen more than
//   `stalenessMs` in the past.
//
// A routine intentionally kept out of the routine-trigger layer (e.g. this
// watchdog's own routine 1b991602, disarmed by founder policy in
// routine-allowlist.json because that layer is revenue-work-only) should be
// moved to `status: 'paused'` once its real execution path (host cron) is
// confirmed — that removes it from this detector's `status = 'active'`
// filter without requiring the detector itself to special-case "policy" vs
// "bug". Both are the same invisible failure until a human/agent looks.

/** Default staleness floor: one full day past the earliest signal. */
export const DEFAULT_STALENESS_MS = 24 * 60 * 60 * 1000;

/** Stable dedup title for this second check — its own rolling issue, not folded into FLAG_TITLE's. */
export const BORN_DISABLED_FLAG_TITLE =
  'Watchdog: operationally-invisible routine(s) detected (active, never fired, all triggers disabled)';

/**
 * Classifies one routine candidate for the born-disabled/operationally-invisible shape.
 *
 * @param {{ status: string, lastTriggeredAt: string|Date|null, createdAt: string|Date, triggers: Array<{ kind: string, enabled: boolean, nextRunAt?: string|Date|null }> }} routine
 * @param {Date} now
 * @param {number} stalenessMs
 * @returns {{ flagged: boolean, staleMs: number|null, hasScheduleNextRunAt: boolean }}
 */
export function classifyBornDisabledRoutine(routine, now = new Date(), stalenessMs = DEFAULT_STALENESS_MS) {
  if (routine.status !== 'active') return { flagged: false, staleMs: null, hasScheduleNextRunAt: false };
  if (routine.lastTriggeredAt != null) return { flagged: false, staleMs: null, hasScheduleNextRunAt: false };

  const triggers = routine.triggers ?? [];
  if (triggers.length === 0) return { flagged: false, staleMs: null, hasScheduleNextRunAt: false };
  if (triggers.some((t) => t.enabled)) return { flagged: false, staleMs: null, hasScheduleNextRunAt: false };

  const scheduleNextRunAtsMs = triggers
    .filter((t) => t.kind === 'schedule' && t.nextRunAt != null)
    .map((t) => new Date(t.nextRunAt).getTime());
  const hasScheduleNextRunAt = scheduleNextRunAtsMs.length > 0;
  const earliestSignalMs = hasScheduleNextRunAt ? Math.min(...scheduleNextRunAtsMs) : new Date(routine.createdAt).getTime();
  const staleMs = now.getTime() - earliestSignalMs;

  return { flagged: staleMs > stalenessMs, staleMs, hasScheduleNextRunAt };
}

/** One human-readable line per born-disabled finding. */
export function formatBornDisabledFinding(routine, classification) {
  const routineLabel = routine.title ? `"${routine.title}"` : routine.routineId;
  const triggerDesc = (routine.triggers ?? [])
    .map((t) => `${t.label ?? t.id ?? t.kind}(kind=${t.kind}, nextRunAt=${t.nextRunAt ? new Date(t.nextRunAt).toISOString() : 'null'})`)
    .join(', ');
  const staleDesc = classification.hasScheduleNextRunAt
    ? `earliest nextRunAt is ${Math.round(classification.staleMs / (60 * 60 * 1000))}h in the past`
    : `no trigger ever computed a nextRunAt — routine createdAt is ${Math.round(classification.staleMs / (60 * 60 * 1000))}h in the past`;
  return (
    `routine ${routine.routineId} ${routineLabel}: status=active, lastTriggeredAt=null, ` +
    `all ${(routine.triggers ?? []).length} trigger(s) disabled [${triggerDesc}], ${staleDesc}.`
  );
}

/** Builds the dedup issue body listing every current born-disabled finding. */
export function buildBornDisabledIssueBody(findings, now = new Date()) {
  const lines = [
    `## Operationally-invisible routine(s) — active, never fired, every trigger disabled`,
    '',
    `As of ${now.toISOString()}, ${findings.length} routine(s) report \`status: "active"\` but have never fired ` +
      '(`lastTriggeredAt` is null) with every trigger disabled and the earliest signal frozen stale in the past. ' +
      'This covers a trigger born disabled at routine-creation time and one disarmed after birth (out-of-band ' +
      'write, or founder routine-allowlist policy) — the same operationally-invisible failure mode either way ' +
      '(AUR-5780, sibling to the unattributed-disarm check above; root case: routine 725124f5 / AUR-5668 sat ' +
      'silent for 3 days before a human caught it downstream).',
    '',
  ];
  for (const { routine, classification } of findings) {
    lines.push(`- ${formatBornDisabledFinding(routine, classification)}`);
  }
  lines.push(
    '',
    'This is detection only — nothing here re-enables a trigger or changes routine status. Investigate why the ' +
      'routine never fired: if it is legitimately out of the routine-trigger layer (e.g. off-policy per ' +
      '`routine-allowlist.json` and now executed via host cron instead), move it to `status: "paused"` and ' +
      'document why so it drops out of this scan; otherwise fix the trigger and confirm it actually fires once.',
    '',
    'This issue is rewritten in place every watchdog run and auto-closes once the list empties.',
    '',
    'exec.routing-rationale: skip',
  );
  return lines.join('\n');
}

/**
 * Fetches every candidate routine for the company: status active, never
 * triggered, alongside all of its triggers (any kind — a routine with an
 * enabled non-schedule trigger, e.g. webhook, is not flagged by
 * classifyBornDisabledRoutine since that trigger keeps it reachable).
 */
export async function queryBornDisabledCandidateRoutines(sql, companyId) {
  const rows = await sql`
    select
      r.id as routine_id,
      r.title,
      r.status,
      r.last_triggered_at,
      r.created_at as routine_created_at,
      rt.id as trigger_id,
      rt.kind,
      rt.label,
      rt.enabled,
      rt.next_run_at
    from routines r
    join routine_triggers rt on rt.routine_id = r.id
    where r.company_id = ${companyId}
      and r.status = 'active'
      and r.last_triggered_at is null
    order by r.id, rt.created_at asc
  `;
  const byRoutine = new Map();
  for (const row of rows) {
    if (!byRoutine.has(row.routine_id)) {
      byRoutine.set(row.routine_id, {
        routineId: row.routine_id,
        title: row.title,
        status: row.status,
        lastTriggeredAt: row.last_triggered_at,
        createdAt: row.routine_created_at,
        triggers: [],
      });
    }
    byRoutine.get(row.routine_id).triggers.push({
      id: row.trigger_id,
      kind: row.kind,
      label: row.label,
      enabled: row.enabled,
      nextRunAt: row.next_run_at,
    });
  }
  return [...byRoutine.values()];
}

/** Finds the born-disabled dedup issue by exact title match. */
export async function findBornDisabledFlagIssue({ companyId, apiGet }) {
  const results = await apiGet(
    `/api/companies/${companyId}/issues?q=${encodeURIComponent(BORN_DISABLED_FLAG_TITLE)}&status=${FLAG_SEARCH_STATUSES}&limit=20`,
  );
  const rows = Array.isArray(results) ? results : (results?.issues ?? []);
  return rows.find((issue) => issue.title === BORN_DISABLED_FLAG_TITLE) ?? null;
}

/**
 * Runs the born-disabled/operationally-invisible check and syncs its own
 * rolling dedup issue, mirroring main()'s find-or-create-and-rewrite-in-place
 * lifecycle exactly but for a distinct finding class and title.
 */
export async function runBornDisabledCheck({
  apply,
  apiUrl,
  apiKey,
  companyId,
  stalenessMs = DEFAULT_STALENESS_MS,
  ownerAgentId = DEFAULT_OWNER_AGENT_ID,
  now = new Date(),
  fetchCandidateRoutines,
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPatch, apiPost } = makeApiHelpers(apiUrl, headers);

  let ownDb = null;
  const fetchRoutines =
    fetchCandidateRoutines ??
    (async () => {
      ownDb = connectDb();
      return queryBornDisabledCandidateRoutines(ownDb, companyId);
    });

  let routines;
  try {
    routines = await fetchRoutines();
  } finally {
    if (ownDb) await ownDb.end();
  }

  const findings = [];
  for (const routine of routines) {
    const classification = classifyBornDisabledRoutine(routine, now, stalenessMs);
    if (classification.flagged) findings.push({ routine, classification });
  }

  console.log(`Active never-fired routines scanned: ${routines.length}. Operationally invisible: ${findings.length}.`);
  for (const f of findings) console.log(`  ${formatBornDisabledFinding(f.routine, f.classification)}`);

  const existing = await findBornDisabledFlagIssue({ companyId, apiGet });

  if (findings.length === 0) {
    if (existing && !['done', 'cancelled'].includes(existing.status)) {
      console.log(`CLOSE ${existing.identifier ?? existing.id} — no outstanding operationally-invisible routines.`);
      if (apply) {
        await apiPatch(`/api/issues/${existing.id}`, { status: 'done' });
        await apiPost(`/api/issues/${existing.id}/comments`, {
          body: `Auto-closed by check-unattributed-trigger-disarms (born-disabled check): 0 operationally-invisible routines found as of ${now.toISOString()}.`,
        });
        console.log('  → closed.');
      }
    } else {
      console.log('No outstanding operationally-invisible routines; nothing to sync.');
    }
    return 0;
  }

  const body = buildBornDisabledIssueBody(findings, now);

  if (existing && !['done', 'cancelled'].includes(existing.status)) {
    console.log(`UPDATE ${existing.identifier ?? existing.id} (${findings.length} outstanding).`);
    if (apply) {
      await apiPatch(`/api/issues/${existing.id}`, { description: body });
      await apiPost(`/api/issues/${existing.id}/comments`, {
        body: `Re-scanned ${now.toISOString()}: ${findings.length} operationally-invisible routine(s) still present.`,
      });
      console.log('  → updated.');
    }
    return 0;
  }

  console.log(`FILE "${BORN_DISABLED_FLAG_TITLE}" (${findings.length} outstanding) → owner ${ownerAgentId}.`);
  if (apply) {
    await apiPost(`/api/companies/${companyId}/issues`, {
      title: BORN_DISABLED_FLAG_TITLE,
      description: body,
      status: 'todo',
      priority: 'medium',
      assigneeAgentId: ownerAgentId,
    });
    console.log('  → filed.');
  }
  return 0;
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
      'staleness-ms': { type: 'string' },
    },
  });

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  resolveApiBase()
    .then(async (API_URL) => {
      const ownerAgentId = process.env.TRIGGER_DISARM_WATCHDOG_OWNER_AGENT_ID ?? DEFAULT_OWNER_AGENT_ID;
      // Each check owns its own dedup-issue lifecycle and is independent of
      // the other — a failure in one (e.g. a permission error while filing)
      // must not prevent the other from running. Run both, always; report
      // the worse of the two exit codes.
      const [unattributedResult, bornDisabledResult] = await Promise.allSettled([
        main({
          apply: values.apply,
          apiUrl: API_URL,
          apiKey: API_KEY,
          companyId: COMPANY_ID,
          toleranceMs: values['tolerance-ms'] ? Number(values['tolerance-ms']) : DEFAULT_TOLERANCE_MS,
          ownerAgentId,
        }),
        runBornDisabledCheck({
          apply: values.apply,
          apiUrl: API_URL,
          apiKey: API_KEY,
          companyId: COMPANY_ID,
          stalenessMs: values['staleness-ms'] ? Number(values['staleness-ms']) : DEFAULT_STALENESS_MS,
          ownerAgentId,
        }),
      ]);
      if (unattributedResult.status === 'rejected') console.error('unattributed-disarm check FAILED:', unattributedResult.reason);
      if (bornDisabledResult.status === 'rejected') console.error('born-disabled check FAILED:', bornDisabledResult.reason);
      const codes = [
        unattributedResult.status === 'fulfilled' ? unattributedResult.value : 2,
        bornDisabledResult.status === 'fulfilled' ? bornDisabledResult.value : 2,
      ];
      return Math.max(...codes.map((c) => c ?? 0));
    })
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('FATAL:', err);
      process.exit(2);
    });
}
