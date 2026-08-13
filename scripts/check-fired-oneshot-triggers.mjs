#!/usr/bin/env node
/**
 * check-fired-oneshot-triggers.mjs
 *
 * Detector for AUR-5569 — cron has no year field, so every date-gated
 * "one-shot" routine (e.g. `0 8 10 8 *`, "08:00 UTC on 10 August") is
 * actually an annual recurrence. After it fires, `nextRunAt` silently rolls
 * forward twelve months and the routine stays `active`; nothing notices
 * because the scheduler is behaving exactly as configured. Live incident:
 * routines `020d0c56` and `a98d53bd` both fired 2026-08, completed
 * successfully, and were still armed to re-fire 2027 until this ticket.
 *
 * Two candidate states (CMO's corrected spec, AUR-5569 comment
 * 96ec6b96-ae32-4bb2-aecb-402448765e9e — the original spec's
 * `lastFiredAt IS NOT NULL` gate only detects damage *after* it exists):
 *
 *   fired-still-armed  — date-gated (numeric day-of-month AND numeric
 *                         month, i.e. neither field is `*`) + the trigger's
 *                         `lastFiredAt` is set + the routine is `active`.
 *                         This is the live defect: it WILL refire next year
 *                         unless disarmed. Filed at `high` priority.
 *   armed-will-recur   — date-gated + trigger has not fired yet + the
 *                         routine has no visible disarm mechanism (proxy:
 *                         description doesn't mention archived/disable/
 *                         disarm/`enabled": false` — crude, but it is
 *                         exactly what distinguished `b6bf70c9`, which has a
 *                         DISARM section, from `2090fe82`, which had none,
 *                         in the 2026-08-13 sweep). Cheap to fix now, costly
 *                         to reconstruct after the fact. Filed at `medium`.
 *
 * Per AUR-5569 ask (3): only `enabled` is read to decide trigger state.
 * `nextRunAt` is NEVER used as a liveness signal — a disabled trigger keeps
 * reporting a future `nextRunAt` (verified live on `f1a8bd16`: `enabled:
 * false` next to `nextRunAt: 2027-08-12T06:00:00.000Z`).
 *
 * Routines can only be managed by their own agent (`PATCH
 * /api/routine-triggers/{id}` and `PATCH /api/routines/{id}` both 403 for a
 * non-owner — verified AUR-5569), so this detector never mutates a routine
 * it doesn't own. It FILES one issue per owning agent listing every
 * candidate routine for that agent, assigned to that agent, so only they
 * can disarm.
 *
 * Idempotent: an existing open flag issue for an agent is extended (a
 * comment naming the newly-seen routines) rather than duplicated, and a
 * routine already named in that issue's tracked-routine-ids marker is never
 * re-added. A flag issue is auto-resolved (closed `done`, with a comment)
 * once every routine it names is no longer a live candidate (archived, or
 * its date-gated trigger disabled).
 *
 * Usage:
 *   node scripts/check-fired-oneshot-triggers.mjs            # detect + file
 *   node scripts/check-fired-oneshot-triggers.mjs --dry-run  # print only, no writes
 *
 * Env vars required: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_AGENT_ID.
 * Env var optional: PAPERCLIP_RUN_ID (attached to all mutating requests when present).
 *
 * Exit codes: 0 clean/applied, 1 dry-run with pending actions, 2 config/API error.
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

let API_URL = '';
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

const ROUTINE_LIST_LIMIT = 1000;

// ---- Pure detection logic (testable without the API) -----------------------

/**
 * True when a single cron field pins exactly ONE specific value — a bare
 * non-negative integer, nothing else. Wildcards (`*`, `*\/N`), lists
 * (`1,4,7,10`), and ranges (`1-5`) all describe a *recurring* set of values
 * within the field's period, not a single fixed point in time, so none of
 * them count as date-gating. This distinction is load-bearing: a quarterly
 * routine's month field (`1,4,7,10`) looks "non-wildcard" but is a genuine
 * recurrence, not a disguised one-shot (caught live on routine `7924834c`,
 * "Etsy v3 AI-Disclosure Schema Quarterly Recheck", cron `0 9 1 1,4,7,10 *`
 * — a naive "not `*`" test misfired on it).
 */
export function isDateGatedCronField(field) {
  return typeof field === 'string' && /^\d{1,2}$/.test(field.trim());
}

/**
 * A 5-field cron (`min hour dom month dow`) is "date-gated" — pinned to one
 * specific calendar date rather than a recurring pattern — when both the
 * day-of-month and month fields are single fixed values (see
 * `isDateGatedCronField`). A weekly cron like `0 9 * * 1` (dom=`*`), a
 * monthly cron like `0 0 1 * *` (month=`*`), and a quarterly cron like
 * `0 9 1 1,4,7,10 *` (month is a 4-value list) are all genuine recurrences,
 * not one-shots in disguise.
 */
export function isDateGatedCron(cronExpression) {
  const fields = String(cronExpression ?? '').trim().split(/\s+/);
  if (fields.length < 5) return false;
  const [, , dom, month] = fields;
  return isDateGatedCronField(dom) && isDateGatedCronField(month);
}

/**
 * Crude proxy for "this routine has a documented disarm step" (CMO's
 * proxy, AUR-5569 comment 96ec6b96): the description mentions archiving,
 * disabling, or disarming itself. False negatives (an undocumented but
 * real disarm trigger) are possible but acceptable — the cost of a
 * false-positive warning here is a routine owner reading one extra issue,
 * not a missed live defect.
 */
const DISARM_PATTERN = /\barchived\b|\bdisable[ds]?\b|\bdisarm(?:ed|s)?\b|"enabled"\s*:\s*false/i;

export function hasDisarmMechanism(description) {
  return DISARM_PATTERN.test(String(description ?? ''));
}

/**
 * Classifies one (routine, trigger) pair. Returns null when it is not a
 * candidate, else `{ severity: 'fired-still-armed'|'armed-will-recur' }`.
 */
export function classifyTrigger(routine, trigger) {
  if (routine.status !== 'active') return null;
  if (trigger.kind !== 'schedule' || trigger.enabled !== true) return null;
  if (!isDateGatedCron(trigger.cronExpression)) return null;

  if (trigger.lastFiredAt != null) {
    return { severity: 'fired-still-armed' };
  }
  if (!hasDisarmMechanism(routine.description)) {
    return { severity: 'armed-will-recur' };
  }
  return null;
}

/**
 * Scans all routines for candidate (routine, trigger) pairs.
 * @param {object[]} routines — each with `triggers: []`
 * @returns {{routine, trigger, severity}[]}
 */
export function findCandidates(routines) {
  const out = [];
  for (const routine of routines) {
    for (const trigger of routine.triggers || []) {
      const result = classifyTrigger(routine, trigger);
      if (result) out.push({ routine, trigger, severity: result.severity });
    }
  }
  return out;
}

/** Groups candidates by the owning routine's `assigneeAgentId`. Ungrouped (no owner) are returned separately. */
export function groupByOwner(candidates) {
  const byOwner = new Map();
  const unowned = [];
  for (const c of candidates) {
    const owner = c.routine.assigneeAgentId;
    if (!owner) { unowned.push(c); continue; }
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(c);
  }
  return { byOwner, unowned };
}

// ---- Flag issue content ------------------------------------------------------

export const FLAG_TITLE_PREFIX = 'Fired one-shot routine(s) still armed';
const ROUTINE_IDS_MARKER = /routine-ids-tracked:\s*([\w,-]+)/i;

export function flagTitle(ownerLabel) {
  return `${FLAG_TITLE_PREFIX} — ${ownerLabel}`;
}

/** Extracts the set of routine ids a flag issue already tracks, from its marker line. */
export function trackedRoutineIds(description) {
  const m = ROUTINE_IDS_MARKER.exec(String(description ?? ''));
  if (!m) return new Set();
  return new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

function severityLabel(severity) {
  return severity === 'fired-still-armed'
    ? 'ALREADY FIRED, still armed to refire in ~12 months'
    : 'not yet fired, will recur once it fires (no visible disarm step)';
}

function candidateLine(c) {
  const r = c.routine;
  const t = c.trigger;
  const id = r.identifier || r.id;
  return `- \`${id}\` **${r.title}** — trigger \`${t.cronExpression}\` (${t.label || t.id}) — ${severityLabel(c.severity)}` +
    (t.lastFiredAt ? `, last fired ${t.lastFiredAt}` : '');
}

export function buildFlagBody(candidates, { includeIntro = true } = {}) {
  const ids = [...new Set(candidates.map((c) => c.routine.id))];
  const lines = [];
  if (includeIntro) {
    lines.push(
      '## Date-gated "one-shot" routine(s) will recur annually unless disarmed',
      '',
      'cron has no year field, so a routine armed to fire once on a specific date ' +
        '(numeric day-of-month AND numeric month) refires every year at that date/time ' +
        'unless something disarms it. See AUR-5569 for the full incident writeup.',
      '',
      '**Only you can disarm these** — `PATCH /api/routine-triggers/{id}` and ' +
        '`PATCH /api/routines/{id}` are restricted to the routine\'s own assignee.',
      '',
    );
  }
  lines.push('### Flagged routines', '', ...candidates.map(candidateLine), '');
  lines.push(
    '### To disarm',
    '',
    '```',
    'PATCH /api/routine-triggers/{triggerId}  {"enabled": false}',
    'PATCH /api/routines/{routineId}          {"status": "archived"}',
    '```',
    '',
    'Then read back with `GET /api/companies/{companyId}/routines/{routineId}` and quote ' +
      '`enabled` per trigger plus routine `status`. **Do not quote `nextRunAt` as proof** — ' +
      'a disabled trigger keeps reporting a future `nextRunAt` (AUR-5569 ask 3).',
    '',
    `routine-ids-tracked: ${ids.join(',')}`,
  );
  return lines.join('\n');
}

export function buildAppendComment(newCandidates) {
  return [
    '## New date-gated routine(s) flagged',
    '',
    ...newCandidates.map(candidateLine),
    '',
    `routine-ids-tracked: ${[...new Set(newCandidates.map((c) => c.routine.id))].join(',')}`,
  ].join('\n');
}

/**
 * True if `flagIssue` should auto-resolve: every routine id it tracks is no
 * longer a live candidate, per the freshly-recomputed `candidateRoutineIds`
 * set (routine archived, or its date-gated trigger no longer enabled).
 */
export function shouldAutoResolve(flagIssue, candidateRoutineIds) {
  const tracked = trackedRoutineIds(flagIssue.description);
  if (tracked.size === 0) return false;
  return [...tracked].every((id) => !candidateRoutineIds.has(id));
}

// ---- API layer ---------------------------------------------------------------

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...(RUN_ID ? { 'X-Paperclip-Run-Id': RUN_ID } : {}),
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers: headers(), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

const asArray = (d, key) => (Array.isArray(d) ? d : (d && d[key]) || []);

async function fetchActiveRoutinesWithTriggers() {
  const data = await apiFetch(`/api/companies/${COMPANY_ID}/routines?limit=${ROUTINE_LIST_LIMIT}`);
  const all = asArray(data, 'routines');
  if (all.length >= ROUTINE_LIST_LIMIT) {
    console.log(`  WARNING: routine list returned exactly the ${ROUTINE_LIST_LIMIT} cap — possible truncation.`);
  }
  return all.filter((r) => r.status === 'active');
}

async function findOpenFlagIssue(ownerAgentId) {
  const data = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(FLAG_TITLE_PREFIX)}` +
      `&assigneeAgentId=${ownerAgentId}&status=backlog,todo,in_progress,in_review,blocked&limit=20`,
  );
  const rows = asArray(data, 'issues');
  return rows.find((iss) => (iss.title || '').startsWith(FLAG_TITLE_PREFIX)) ?? null;
}

async function main() {
  for (const [k, v] of Object.entries({ API_KEY, COMPANY_ID, AGENT_ID })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  API_URL = await resolveApiBase();

  const activeRoutines = await fetchActiveRoutinesWithTriggers();
  console.log(`Active routines scanned: ${activeRoutines.length}`);

  const candidates = findCandidates(activeRoutines);
  const candidateRoutineIds = new Set(candidates.map((c) => c.routine.id));
  console.log(`Candidates found: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`  ${c.severity}: ${c.routine.identifier || c.routine.id} "${c.routine.title}" (${c.routine.assigneeAgentId || 'unowned'})`);
  }

  const { byOwner, unowned } = groupByOwner(candidates);
  if (unowned.length) {
    console.log(`  WARNING: ${unowned.length} candidate(s) have no assigneeAgentId — cannot file (unowned routine): ` +
      unowned.map((c) => c.routine.identifier || c.routine.id).join(', '));
  }

  const agentsData = await apiFetch(`/api/companies/${COMPANY_ID}/agents`);
  const agentById = new Map(asArray(agentsData, 'agents').map((a) => [a.id, a]));

  const filed = [];
  const extended = [];
  const skippedNoNew = [];

  for (const [ownerId, ownerCandidates] of byOwner) {
    const ownerLabel = agentById.get(ownerId)?.name || ownerId;
    const existing = await findOpenFlagIssue(ownerId);

    if (!existing) {
      const payload = {
        title: flagTitle(ownerLabel),
        description: buildFlagBody(ownerCandidates),
        assigneeAgentId: ownerId,
        priority: ownerCandidates.some((c) => c.severity === 'fired-still-armed') ? 'high' : 'medium',
      };
      if (DRY_RUN) {
        console.log(`  [dry-run] would create for ${ownerLabel}: ${payload.title}`);
        filed.push({ ownerId, identifier: '(dry-run)' });
        continue;
      }
      const res = await apiFetch(`/api/companies/${COMPANY_ID}/issues`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const iss = res.issue || res;
      filed.push({ ownerId, identifier: iss.identifier || iss.id, id: iss.id });
      console.log(`  filed ${iss.identifier || iss.id} for ${ownerLabel}`);
      continue;
    }

    const tracked = trackedRoutineIds(existing.description);
    const newOnes = ownerCandidates.filter((c) => !tracked.has(c.routine.id));
    if (!newOnes.length) {
      skippedNoNew.push({ ownerId, identifier: existing.identifier || existing.id });
      console.log(`  skipped ${existing.identifier || existing.id} (${ownerLabel}) — no new routines beyond what's already tracked`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] would extend ${existing.identifier || existing.id} for ${ownerLabel} with ${newOnes.length} new routine(s)`);
      extended.push({ ownerId, identifier: existing.identifier || existing.id });
      continue;
    }
    await apiFetch(`/api/issues/${existing.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: buildAppendComment(newOnes) }),
    });
    extended.push({ ownerId, identifier: existing.identifier || existing.id });
    console.log(`  extended ${existing.identifier || existing.id} (${ownerLabel}) with ${newOnes.length} new routine(s)`);
  }

  // Auto-resolve: any open flag issue (from a prior run, for any owner) whose
  // tracked routines are all no longer live candidates.
  const allOpenFlagsData = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(FLAG_TITLE_PREFIX)}` +
      `&status=backlog,todo,in_progress,in_review,blocked&limit=100`,
  );
  const allOpenFlags = asArray(allOpenFlagsData, 'issues').filter((iss) => (iss.title || '').startsWith(FLAG_TITLE_PREFIX));
  const resolved = [];
  for (const flagIssue of allOpenFlags) {
    if (!shouldAutoResolve(flagIssue, candidateRoutineIds)) continue;
    if (DRY_RUN) {
      console.log(`  [dry-run] would auto-resolve ${flagIssue.identifier || flagIssue.id} — all tracked routines disarmed`);
      resolved.push(flagIssue.identifier || flagIssue.id);
      continue;
    }
    await apiFetch(`/api/issues/${flagIssue.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'done',
        comment: 'Auto-resolved by check-fired-oneshot-triggers: every routine this issue tracked is no longer an armed date-gated one-shot (archived, or trigger disabled).',
      }),
    });
    resolved.push(flagIssue.identifier || flagIssue.id);
    console.log(`  auto-resolved ${flagIssue.identifier || flagIssue.id}`);
  }

  console.log('\n=== SUMMARY JSON ===');
  console.log(JSON.stringify({
    activeRoutinesScanned: activeRoutines.length,
    candidates: candidates.map((c) => ({ routineId: c.routine.id, identifier: c.routine.identifier, severity: c.severity, owner: c.routine.assigneeAgentId })),
    filed,
    extended,
    skippedNoNew,
    resolved,
    unowned: unowned.map((c) => c.routine.identifier || c.routine.id),
  }, null, 2));

  const pending = DRY_RUN && (filed.length || extended.length || resolved.length);
  process.exitCode = pending ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 2; });
}
