#!/usr/bin/env node
/**
 * SGI Loop C — Scorecard Streak Detection (Prompt Self-Edit detector)
 *
 * Fetches all `performance_scorecard` memory records, canonicalizes each
 * record's raw `metadata.agent_id` (or title-derived) key to a live agent
 * UUID (AUR-3856 — some agents write non-canonical ids like a bare UUID
 * prefix or a name, which used to split one agent's records across
 * multiple buckets), groups the canonicalized records by
 * {agent_id}/{task_type}, and evaluates each bucket against four
 * independent detectors (AUR-3850 — replaces the original strict-3-sample
 * monotone test, which fired once in 1,574 scorecards):
 *
 *   A — baseline-delta regression: mean(last 5) <= mean(prior 20) - 0.5
 *   B — non-strict decline (small buckets, 3 <= n < 10): last 3 records
 *       non-increasing oldest→newest AND total drop >= 1 AND min(quality)
 *       below the absolute floor AND at least one record required rework
 *   C — sustained low absolute quality: mean(last 5) <= 2.5
 *   D — rework streak (relaxed): >= 3 of the last 5 have rework_required
 *
 * AUR-4233 — the *trend* detectors (A and B) order records by work time (the
 * scorecard's own `performance/{agent}/{type}/{YYYY-MM-DD}` date, or an
 * explicit metadata date), never by `createdAt`. For backfilled scorecards
 * `createdAt` is the insertion timestamp, so a `createdAt` "trend" is an
 * artifact of backfill write order — all three self-edit issues filed by the
 * 2026-07-26T06:49 run were false positives of exactly that shape (AUR-4217's
 * three records were written 54ms apart with their title dates in the
 * opposite order to `createdAt`). Where a work order cannot be established —
 * no parseable date, or a same-day tie inside a backfill burst — the trend
 * detectors fail closed to `no_trigger`: a detector that cannot tell which
 * record is newer must not report a direction. The level-based detectors
 * (C, D) and the staleness guard are not trend detectors, so they use a
 * best-effort work-time-then-createdAt ordering instead of failing closed.
 *
 * Detector B additionally requires an absolute-quality floor breach and a
 * rework signal (AUR-4233). Quality 4 with `rework_required: false` is good
 * work, and a no-rework streak is not a regression; without those gates B
 * duplicated Detector C at a noise-level threshold and inverted its purpose.
 *
 * A staleness guard (skip if most-recent record > 30 days old) runs first
 * so relaxed rules can't resurrect dead/retired-agent buckets. Because all
 * four detectors are more sensitive than the old strict test, flood control
 * adds a 30-day per-{agent_id}/{task_type} cooldown (on top of the existing
 * one-open-issue-per-agent dedup) and caps creation at 3 issues per run,
 * highest-severity first — anything dropped by the cap is logged, never
 * silently truncated.
 *
 * For each triggered, non-deduped, non-cooldown, in-cap bucket, files a
 * "Prompt self-edit required — {agent_id} / {task_type}" issue assigned back
 * to the offending agent (Loop C § 13 protocol — unchanged by this script).
 *
 * titlePrefix= is ignored server-side, so records are filtered client-side.
 *
 * Usage:
 *   node scripts/sgi-loop-c-streak-detection.mjs            # detect + create issues
 *   node scripts/sgi-loop-c-streak-detection.mjs --dry-run  # print only, no writes
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

let API_URL = '';
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// Loop C parent issue (AUR-1395) and the SGI project.
const PARENT_IDENTIFIER = process.env.LOOP_C_PARENT || 'AUR-1395';
const PROJECT_ID = process.env.LOOP_C_PROJECT_ID || '593af91d-6e65-47fe-9db2-cd39469548f8';

const SCAN_LIMIT = 1000;

// ---- Detector tuning (AUR-3850) --------------------------------------------

const STALENESS_DAYS = 30;
const COOLDOWN_DAYS = 30;
const RECENT_N = 5;
const BASELINE_N = 20;
const BASELINE_MIN = 5;
const DETECTOR_A_DELTA = 0.5;
const DETECTOR_B_MAX_BUCKET = 10; // small-bucket detector applies while n < 10
const DETECTOR_C_THRESHOLD = 2.5;
const DETECTOR_D_MIN_REWORK = 3; // of the last RECENT_N
const CREATE_CAP = 3;

// AUR-6215: mirrors check-pr-backlog.mjs's PLATFORM_LABEL_ID (AUR-6213) — not
// imported because that export may not have landed on master yet. Self-edit
// issues are never critical, so they must file as backlog + platform, not
// flood the active `todo` queue.
export const PLATFORM_LABEL_ID = '83062a2e-aec5-4de2-9541-02d05641c246';

// ---- Detector B false-positive gates (AUR-4233) ----------------------------

// Absolute-quality floor: a window whose worst record is still >= this is good
// work, not a regression, whatever its slope. Genuinely low quality is
// Detector C's job, so B must not duplicate it at a noise-level threshold.
const DETECTOR_B_QUALITY_FLOOR = 4;

// Records whose createdAt values all fall inside this span were written by one
// backfill burst, so createdAt carries no work-order information at all.
const BACKFILL_CLUSTER_MS = 5 * 60 * 1000;

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...(RUN_ID ? { 'X-Paperclip-Run-Id': RUN_ID } : {}),
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers: headers(), ...opts });
  if (res.status === 404) return { _notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

const asArray = (d, key) => (Array.isArray(d) ? d : (d && d[key]) || []);

async function fetchAllRecords() {
  // Paginate via offset until a short page is returned, deduping by record id
  // (offset paging can repeat a row if records are inserted mid-scan).
  // NOTE: this deployment's memory API caps `limit` at 1000, IGNORES `offset`,
  // and returns records newest-first with no cursor. Offset paging therefore
  // yields the SAME newest page every time — the old `page.length < SCAN_LIMIT`
  // break condition never fires once the corpus exceeds 1000, causing an
  // infinite loop. We instead stop as soon as a page adds ZERO new records
  // (dedup by id). This is correct for Loop C: records are newest-first and we
  // only ever need the 3 most-recent scorecards per bucket, all of which live
  // in the newest page. It also still terminates correctly if a future API
  // build starts honoring `offset`. Tracked as an infra gap (see retro/memory).
  const byId = new Map();
  let offset = 0;
  let guard = 0;
  for (;;) {
    const data = await apiFetch(
      `/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_LIMIT}&offset=${offset}`,
    );
    if (data._notFound) break;
    const page = asArray(data, 'records');
    let added = 0;
    for (const r of page) {
      const id = r.id ?? r._id ?? `${r.title}|${r.createdAt || r.created_at || ''}`;
      if (!byId.has(id)) { byId.set(id, r); added += 1; }
    }
    // Stop on a short page (offset honored, corpus exhausted) OR when a full
    // page contributed nothing new (offset ignored → same newest page again).
    if (page.length < SCAN_LIMIT) break;
    if (added === 0) break;
    offset += SCAN_LIMIT;
    if (++guard > 100) break; // hard backstop against any runaway
  }
  return [...byId.values()];
}

function parseTitle(title) {
  // performance/{agent_id}/{task_type}/{date}
  const parts = (title || '').split('/');
  if (parts.length >= 4 && parts[0] === 'performance') {
    return { agent_id: parts[1], task_type: parts[2] };
  }
  return { agent_id: null, task_type: null };
}

// ---- Agent-key canonicalization (AUR-3856) ---------------------------------

// Malformed keys observed live are always an 8-hex-char UUID-segment prefix
// (e.g. '371a1b08', 'e8f947d2'). Anything shorter risks an accidental match
// against an unrelated agent, so prefix-matching only kicks in at this length;
// shorter strings (e.g. 'cto', 'ceo') fall through to the name-match step.
const MIN_HEX_PREFIX_LEN = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leadingHexRun(key) {
  const m = /^[0-9a-f]+/i.exec(String(key).trim());
  return m ? m[0].toLowerCase() : '';
}

/**
 * Resolves a raw `agent_id` bucket key to a canonical agent UUID.
 * `liveAgents` items: { id: string, name: string }.
 *
 * Resolution order: exact UUID *format* match wins outright (an agent that
 * has since been deleted still wrote a well-formed id — that's a
 * skippedNoAgent case downstream, not a hygiene problem); else a
 * case-insensitive UNIQUE prefix match against live agents (after stripping
 * non-hex trailing junk, e.g. '371a1b08 (CTO)' -> '371a1b08'); else a
 * case-insensitive match against agent name; else unresolved. A prefix
 * matching 2+ live agents is never merged.
 *
 * Returns { resolved: string|null, method: 'exact'|'prefix'|'name'|'ambiguous-prefix'|'unresolved' }.
 */
export function canonicalizeAgentKey(rawKey, liveAgents) {
  const key = String(rawKey ?? '').trim();
  if (!key) return { resolved: null, method: 'unresolved' };
  const keyLower = key.toLowerCase();

  if (UUID_RE.test(key)) return { resolved: keyLower, method: 'exact' };

  const hexPrefix = leadingHexRun(key);
  if (hexPrefix.length >= MIN_HEX_PREFIX_LEN) {
    const matches = liveAgents.filter((a) => a.id.toLowerCase().startsWith(hexPrefix));
    if (matches.length === 1) return { resolved: matches[0].id, method: 'prefix' };
    if (matches.length > 1) return { resolved: null, method: 'ambiguous-prefix' };
  }

  const byName = liveAgents.find((a) => (a.name || '').toLowerCase() === keyLower);
  if (byName) return { resolved: byName.id, method: 'name' };

  return { resolved: null, method: 'unresolved' };
}

// ---- Pure detector logic (testable without the API) ------------------------

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Age in days of an ISO timestamp relative to refDate. Invalid → Infinity (treated as stale). */
function ageDays(refDate, iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (refDate.getTime() - t) / (1000 * 60 * 60 * 24);
}

// ---- Work-time ordering (AUR-4233) -----------------------------------------

// `performance/{agent_id}/{task_type}/{YYYY-MM-DD}` — the trailing path segment
// is the date the work was actually scored, which is what a trend is over.
// Agents routinely append a disambiguating suffix when they score twice in one
// day ('2026-07-26-b', '2026-06-03-AUR-793', '2026-06-22b'), so only the date
// *prefix* of the final segment is required. Since one unparseable record
// fails its whole bucket closed, an over-strict parser silently blacks out
// healthy buckets — 21 such records took out 10 of 38 buckets before this.
const TITLE_WORK_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Epoch ms of a scorecard's *work* date — an explicit metadata date if the
 * record carries one, else the title's trailing YYYY-MM-DD. Null when neither
 * is present or parseable; callers decide whether that is fatal.
 */
function workDateMs(rec) {
  const explicit = rec.work_date ?? rec.date ?? null;
  let src = typeof explicit === 'string' ? explicit.slice(0, 10) : null;
  if (!src) {
    const segments = String(rec.title || '').split('/');
    const m = TITLE_WORK_DATE_RE.exec(segments[segments.length - 1] || '');
    src = m ? m[1] : null;
  }
  if (!src || !/^\d{4}-\d{2}-\d{2}$/.test(src)) return null;
  const t = Date.parse(`${src}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function createdAtMs(rec) {
  const t = new Date(rec.createdAt).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Best-effort newest-first time for the *level*-based consumers (staleness
 * guard, detectors C and D). Work date when known, insertion time otherwise.
 * These are not trend detectors, so an imperfect ordering degrades which five
 * records get averaged — it cannot invent a direction — and failing them
 * closed would take Loop C's genuine-badness detectors offline.
 */
function effectiveTimeMs(rec) {
  const wd = workDateMs(rec);
  return wd !== null ? wd : (createdAtMs(rec) ?? -Infinity);
}

/**
 * Newest-first ordering for the *trend* detectors, or a refusal.
 *
 * Returns `{ ordered: rec[], ambiguousAt: Set<number> }` where `ambiguousAt`
 * holds each index i whose order relative to i-1 could not be established, or
 * `{ ordered: null, reason }` when no record-level work time exists at all.
 * A caller must treat an ambiguous index that straddles a boundary it depends
 * on as fail-closed — see `evaluateBucket`.
 */
export function orderByWorkTime(recs) {
  const items = recs.map((r) => ({ rec: r, wd: workDateMs(r), ca: createdAtMs(r) }));
  if (items.some((it) => it.wd === null)) {
    return { ordered: null, reason: 'missing_work_date' };
  }

  // When every createdAt lands inside one short burst the records were
  // backfilled together, so createdAt cannot break a same-day tie.
  const cas = items.map((it) => it.ca).filter((v) => v !== null);
  const backfillClustered =
    cas.length === items.length &&
    cas.length >= 2 &&
    Math.max(...cas) - Math.min(...cas) < BACKFILL_CLUSTER_MS;

  const sorted = items.slice().sort((a, b) => {
    if (b.wd !== a.wd) return b.wd - a.wd;
    return backfillClustered ? 0 : (b.ca ?? 0) - (a.ca ?? 0);
  });

  const ambiguousAt = new Set();
  if (backfillClustered) {
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].wd === sorted[i - 1].wd) ambiguousAt.add(i);
    }
  }
  return { ordered: sorted.map((it) => it.rec), ambiguousAt, reason: null };
}

/**
 * Evaluate one {agent_id, task_type} bucket's records against detectors A–D.
 * `recs` items: { quality_signal: number|null, rework_required: boolean, createdAt: string }.
 * Returns { skip: 'too_few_records'|'stale'|'no_trigger' } or
 * { triggers: [{ detector, severity, desc }], severity, mostRecentAgeDays }.
 */
function evaluateBucket(recs, refDate) {
  // Level-based ordering: work date where known, insertion time otherwise.
  // Used by the staleness guard and detectors C/D (see effectiveTimeMs).
  const sorted = recs.slice().sort((a, b) => effectiveTimeMs(b) - effectiveTimeMs(a));
  if (sorted.length < 3) return { skip: 'too_few_records' };

  const mostRecentTime = effectiveTimeMs(sorted[0]);
  const mostRecentAgeDays = Number.isFinite(mostRecentTime)
    ? (refDate.getTime() - mostRecentTime) / (1000 * 60 * 60 * 24)
    : Infinity;
  if (mostRecentAgeDays > STALENESS_DAYS) return { skip: 'stale' };

  // Trend-safe ordering for detectors A and B. `null` ordered => refuse both
  // (AUR-4233): without a work order there is no direction to report.
  const trend = orderByWorkTime(recs);
  const trendOrdered = trend.ordered;
  const ambiguousAt = trend.ambiguousAt || new Set();
  const unorderable = [];
  if (!trendOrdered) unorderable.push(trend.reason);

  const triggers = [];
  const recent = sorted.slice(0, RECENT_N);
  const qRecent = recent.map((r) => r.quality_signal).filter((v) => typeof v === 'number');

  // Detector A — baseline-delta regression, over the *work*-ordered records.
  // Only a tie straddling the recent/baseline boundary can move a record
  // between the two groups; ties inside a group leave both means unchanged.
  const aOrdered = trendOrdered && !ambiguousAt.has(RECENT_N) ? trendOrdered : null;
  if (trendOrdered && !aOrdered) unorderable.push('ambiguous_recent_baseline_boundary');
  const aRecent = aOrdered ? aOrdered.slice(0, RECENT_N) : [];
  const baseline = aOrdered ? aOrdered.slice(RECENT_N, RECENT_N + BASELINE_N) : [];
  const qARecent = aRecent.map((r) => r.quality_signal).filter((v) => typeof v === 'number');
  const qBaseline = baseline.map((r) => r.quality_signal).filter((v) => typeof v === 'number');
  if (aRecent.length >= RECENT_N && baseline.length >= BASELINE_MIN && qARecent.length && qBaseline.length) {
    const meanRecent = mean(qARecent);
    const meanBaseline = mean(qBaseline);
    const delta = meanBaseline - meanRecent;
    if (delta >= DETECTOR_A_DELTA) {
      triggers.push({
        detector: 'A',
        severity: delta,
        desc: `baseline-delta regression — recent${qARecent.length} mean ${meanRecent.toFixed(2)} vs prior${qBaseline.length} mean ${meanBaseline.toFixed(2)} (Δ=${delta.toFixed(2)})`,
      });
    }
  }

  // Detector B — non-strict decline, small buckets only (3 <= n < 10).
  // Needs a trustworthy work order across the 3-record window *and* across the
  // window boundary (index 3 decides which records are even in the window).
  const bWindowAmbiguous = [1, 2, 3].some((i) => ambiguousAt.has(i));
  if (trendOrdered && bWindowAmbiguous) unorderable.push('ambiguous_detector_b_window');
  const bOrdered = trendOrdered && !bWindowAmbiguous ? trendOrdered : null;
  if (bOrdered && bOrdered.length >= 3 && bOrdered.length < DETECTOR_B_MAX_BUCKET) {
    const [n1, n2, n3] = bOrdered; // n1 = most recent, n3 = oldest of the 3
    const window = [n1, n2, n3];
    if (window.every((r) => typeof r.quality_signal === 'number')) {
      const nonIncreasing = n3.quality_signal >= n2.quality_signal && n2.quality_signal >= n1.quality_signal;
      const drop = n3.quality_signal - n1.quality_signal;
      // AUR-4233 gates: good-but-slightly-lower work is not a regression.
      const minQuality = Math.min(...window.map((r) => r.quality_signal));
      const belowFloor = minQuality < DETECTOR_B_QUALITY_FLOOR;
      const anyRework = window.some((r) => r.rework_required === true);
      if (nonIncreasing && drop >= 1 && belowFloor && anyRework) {
        triggers.push({
          detector: 'B',
          severity: drop,
          desc: `non-strict decline (oldest→newest by work date): ${n3.quality_signal}→${n2.quality_signal}→${n1.quality_signal}, min quality ${minQuality} (<${DETECTOR_B_QUALITY_FLOOR}) with rework`,
        });
      }
    }
  }

  // Detector C — sustained low absolute quality.
  if (recent.length >= RECENT_N && qRecent.length) {
    const meanRecent = mean(qRecent);
    if (meanRecent <= DETECTOR_C_THRESHOLD) {
      triggers.push({
        detector: 'C',
        severity: DETECTOR_C_THRESHOLD - meanRecent,
        desc: `sustained low quality — recent${qRecent.length} mean ${meanRecent.toFixed(2)} (≤${DETECTOR_C_THRESHOLD})`,
      });
    }
  }

  // Detector D — rework streak (relaxed: 3 of last 5, was 3 of 3).
  if (recent.length >= RECENT_N) {
    const reworkCount = recent.filter((r) => r.rework_required === true).length;
    if (reworkCount >= DETECTOR_D_MIN_REWORK) {
      triggers.push({
        detector: 'D',
        severity: reworkCount / RECENT_N,
        desc: `rework streak — ${reworkCount}/${RECENT_N} most-recent runs required rework`,
      });
    }
  }

  // Never silent: a trend detector that refused to run says so, so a bucket
  // going dark reads as a refusal rather than as a clean bill of health.
  const unorderableReasons = [...new Set(unorderable)];

  if (!triggers.length) return { skip: 'no_trigger', unorderable: unorderableReasons };

  return {
    triggers,
    severity: Math.max(...triggers.map((t) => t.severity)),
    mostRecentAgeDays,
    unorderable: unorderableReasons,
  };
}

/** True if any open issue title mentions "self-edit required" and the agent id (existing per-agent dedup, unchanged). */
function hasOpenSelfEditIssue(openIssues, agentId) {
  return openIssues.some((iss) => {
    const title = iss.title || '';
    return title.includes('self-edit required') && title.includes(agentId);
  });
}

/**
 * 30-day per-{agent_id}/{task_type} cooldown: true if a self-edit attempt was
 * already made recently, via either a prompt-improvement-proposal memory
 * record (agent-wide — the self-edit protocol edits the whole prompt file)
 * or a closed self-edit issue naming this exact agent/task_type pair.
 */
function withinCooldown(records, closedIssues, agentId, taskType, refDate) {
  const cutoffDays = COOLDOWN_DAYS;
  const recentProposal = records.some((r) => {
    const title = r.title || '';
    if (!title.startsWith(`prompt-improvement-proposal/${agentId}/`)) return false;
    return ageDays(refDate, r.createdAt || r.created_at || '') <= cutoffDays;
  });
  if (recentProposal) return true;

  return closedIssues.some((iss) => {
    const title = iss.title || '';
    if (!title.includes('self-edit required') || !title.includes(agentId) || !title.includes(taskType)) return false;
    return ageDays(refDate, iss.updatedAt || iss.updated_at || '') <= cutoffDays;
  });
}

/** Sort eligible buckets by severity desc, take the top `cap`, log the rest as dropped. */
function selectForCreation(eligible, cap) {
  const sorted = eligible.slice().sort((a, b) => b.severity - a.severity);
  return { selected: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

/**
 * AUR-6215: self-edit issues are self-improvement work and never critical,
 * so they must file as backlog + platform label (routed through the weekly
 * platform-backlog drip) rather than flooding the active `todo` queue.
 */
export function buildSelfEditIssuePayload({ title, description, assigneeAgentId, projectId, parentId }) {
  return {
    title,
    description,
    assigneeAgentId,
    projectId,
    priority: 'high',
    status: 'backlog',
    labelIds: [PLATFORM_LABEL_ID],
    ...(parentId ? { parentId } : {}),
  };
}

async function main() {
  for (const [k, v] of Object.entries({ API_KEY, COMPANY_ID, AGENT_ID })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  API_URL = await resolveApiBase();

  const now = new Date();
  const records = await fetchAllRecords();
  const scorecards = records.filter((r) => {
    const m = r.metadata || {};
    if (m.category !== 'performance_scorecard') return false;
    if (m.outcome === 'blocked' || m.outcome === 'failed') return false;
    return (r.title || '').startsWith('performance/');
  });

  // Verification: paginated fetch should see the full corpus, not a capped 200.
  console.log(`Records fetched (deduped): ${records.length}, performance scorecards: ${scorecards.length}`);

  // Resolve which agents still exist (needed up front to canonicalize bucket keys).
  const agentsData = await apiFetch(`/api/companies/${COMPANY_ID}/agents`);
  const allAgents = asArray(agentsData, 'agents').map((a) => ({ id: a.id, name: a.name || '' }));
  const liveAgents = new Set(allAgents.map((a) => a.id));

  // Group into {agent_id}/{task_type} buckets, canonicalizing each record's
  // raw agent key to a live agent UUID first (AUR-3856) so non-canonical
  // ids (uuid prefix, name, decorated prefix) don't split one agent's
  // records into multiple buckets.
  const malformedAgentKeys = {};
  const unresolvedAgentKeys = {};
  const buckets = new Map();
  for (const r of scorecards) {
    const m = r.metadata || {};
    const fromTitle = parseTitle(r.title);
    const rawAgentKey = m.agent_id || fromTitle.agent_id;
    const task_type = m.task_type || fromTitle.task_type;
    if (!rawAgentKey || !task_type) continue;

    const canon = canonicalizeAgentKey(rawAgentKey, allAgents);
    const agent_id = canon.resolved || rawAgentKey;
    if (canon.method !== 'exact') {
      malformedAgentKeys[rawAgentKey] = (malformedAgentKeys[rawAgentKey] || 0) + 1;
    }
    if (!canon.resolved) {
      unresolvedAgentKeys[rawAgentKey] = (unresolvedAgentKeys[rawAgentKey] || 0) + 1;
    }

    const key = `${agent_id}/${task_type}`;
    if (!buckets.has(key)) buckets.set(key, { agent_id, task_type, recs: [] });
    buckets.get(key).recs.push({
      title: r.title,
      // Work date (AUR-4233): prefer an explicit metadata date, else the
      // title's trailing YYYY-MM-DD. Never createdAt — that is insertion time.
      work_date: m.work_date || m.date || m.completed_at || null,
      quality_signal: typeof m.quality_signal === 'number' ? m.quality_signal : null,
      rework_required: m.rework_required === true,
      createdAt: r.createdAt || r.created_at || '',
    });
  }
  if (Object.keys(malformedAgentKeys).length) {
    console.log(`  malformed agent keys: ${JSON.stringify(malformedAgentKeys)}`);
  }
  if (Object.keys(unresolvedAgentKeys).length) {
    console.log(`  unresolved agent keys (left ungrouped): ${JSON.stringify(unresolvedAgentKeys)}`);
  }

  const triggered = [];
  const skippedTooFew = [];
  const skippedStale = [];
  const skippedNoAgent = [];
  let evaluated = 0;

  const unorderableBuckets = {};

  for (const [key, b] of buckets) {
    const result = evaluateBucket(b.recs, now);
    if (result.skip === 'too_few_records') { skippedTooFew.push(key); continue; }
    evaluated += 1;
    if (result.skip === 'stale') { skippedStale.push(key); continue; }
    for (const reason of result.unorderable || []) {
      unorderableBuckets[reason] = (unorderableBuckets[reason] || 0) + 1;
    }
    if (result.skip === 'no_trigger') continue;

    if (!liveAgents.has(b.agent_id)) {
      skippedNoAgent.push(key);
      continue;
    }

    const patternDesc = result.triggers.map((t) => `[${t.detector}] ${t.desc}`).join('; ');
    triggered.push({ key, agent_id: b.agent_id, task_type: b.task_type, recs: b.recs, triggers: result.triggers, severity: result.severity, patternDesc });
  }

  console.log(`Buckets total: ${buckets.size}, evaluated (≥3 recs): ${evaluated}, triggered: ${triggered.length}`);
  for (const t of triggered) console.log(`  TRIGGER ${t.key} (severity=${t.severity.toFixed(2)}) — ${t.patternDesc}`);
  if (skippedStale.length) console.log(`  skipped (stale, >${STALENESS_DAYS}d): ${skippedStale.join(', ')}`);
  if (Object.keys(unorderableBuckets).length) {
    console.log(`  trend detectors refused (no trustworthy work order): ${JSON.stringify(unorderableBuckets)}`);
  }
  if (skippedNoAgent.length) console.log(`  skipped (agent gone): ${skippedNoAgent.join(', ')}`);

  // Existing open-issue dedup + new closed-issue cooldown lookups.
  const selfEditData = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?limit=200&q=${encodeURIComponent('self-edit required')}`,
  );
  const selfEditIssues = asArray(selfEditData, 'issues');
  const openIssues = selfEditIssues.filter((iss) => !['done', 'cancelled'].includes(iss.status));
  const closedIssues = selfEditIssues.filter((iss) => ['done', 'cancelled'].includes(iss.status));

  // Resolve parent issue UUID.
  const parentData = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?identifier=${encodeURIComponent(PARENT_IDENTIFIER)}`,
  );
  const parentIssue = asArray(parentData, 'issues')[0];
  const parentId = parentIssue ? parentIssue.id : null;

  const skippedExisting = [];
  const skippedCooldown = [];
  const eligible = [];

  for (const t of triggered) {
    if (hasOpenSelfEditIssue(openIssues, t.agent_id)) {
      skippedExisting.push(t.key);
      continue;
    }
    if (withinCooldown(records, closedIssues, t.agent_id, t.task_type, now)) {
      skippedCooldown.push(t.key);
      continue;
    }
    eligible.push(t);
  }

  const { selected, dropped } = selectForCreation(eligible, CREATE_CAP);
  if (dropped.length) {
    console.log(`  cap (${CREATE_CAP}/run) dropped ${dropped.length}: ${dropped.map((t) => `${t.key} (severity=${t.severity.toFixed(2)})`).join(', ')}`);
  }

  const created = [];

  for (const t of selected) {
    const recList = t.recs
      .slice()
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
      .slice(0, RECENT_N)
      .map((r, i) => `${i + 1}. \`${r.title}\` — quality=${r.quality_signal ?? 'n/a'}, rework=${r.rework_required}, ${r.createdAt}`)
      .join('\n');

    const description = [
      '## Self-Edit Triggered',
      '',
      `**Agent:** ${t.agent_id}`,
      `**Task type:** ${t.task_type}`,
      `**Pattern detected:** ${t.patternDesc}`,
      '',
      '### Scorecard streak (most recent, up to 5):',
      recList,
      '',
      '---',
      '',
      '## What you must do in this heartbeat',
      '',
      'See **Section 13 of root `AGENTS.md`** for the complete self-edit protocol.',
      '',
      'TLDR:',
      '1. Read your `AGENTS.md` (your `instructions-path` file)',
      `2. Identify the section governing \`${t.task_type}\` work`,
      '3. Write the FULL proposed file (a BOUNDED edit — small add/delete/replace,',
      '   never a rewrite) to a temp path, then run the validation gate:',
      '   `node scripts/prompt-edit-gate.mjs --agent-name "<your name>" --proposed <tmpfile>`',
      '   The gate replays your recent completed tasks under both prompt versions and',
      '   only ACCEPTS an edit that beats the current prompt. If REJECTED: do NOT',
      '   re-submit the same diff (the gate remembers) — refine or stand down.',
      `4. On ACCEPTED only: POST a \`prompt-improvement-proposal/${t.agent_id}/{YYYY-MM-DD}\``,
      '   memory record including the gate verdict JSON (diffHash, wins/losses/ties)',
      '5. POST a `request_board_approval` linking this issue, with payload `title`,',
      '   `valueAtStake`, and `costOfInaction` all non-empty strings (or the POST 422s — AUR-5353)',
      '6. Set this issue `in_review`, assigned to CEO',
      '',
      '**Safety boundary:** propose edits to YOUR file ONLY.',
      '**Approval boundary (CEO):** refuse any proposal without an ACCEPTED',
      'prompt-edit-gate verdict — plausible-sounding prose is not evidence.',
    ].join('\n');

    const payload = buildSelfEditIssuePayload({
      title: `Prompt self-edit required — ${t.agent_id} / ${t.task_type}`,
      description,
      assigneeAgentId: t.agent_id,
      projectId: PROJECT_ID,
      parentId,
    });

    if (DRY_RUN) {
      console.log(`  [dry-run] would create: ${payload.title}`);
      created.push({ ...t, identifier: '(dry-run)' });
      continue;
    }

    const res = await apiFetch(`/api/companies/${COMPANY_ID}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const iss = res.issue || res;
    created.push({ ...t, identifier: iss.identifier || iss.id, id: iss.id });
    console.log(`  created ${iss.identifier || iss.id}: ${payload.title}`);
  }

  // Emit a machine-readable summary for the calling heartbeat.
  console.log('\n=== SUMMARY JSON ===');
  console.log(JSON.stringify({
    evaluated,
    bucketsTotal: buckets.size,
    triggered: triggered.map((t) => ({ key: t.key, severity: t.severity, pattern: t.patternDesc })),
    created: created.map((c) => ({ key: c.key, identifier: c.identifier })),
    skippedExisting,
    skippedCooldown,
    skippedCap: dropped.map((t) => t.key),
    skippedStale,
    skippedNoAgent,
    parentResolved: !!parentId,
    malformedAgentKeys,
    unresolvedAgentKeys,
    unorderableBuckets,
  }, null, 2));
}

export {
  mean,
  ageDays,
  workDateMs,
  evaluateBucket,
  hasOpenSelfEditIssue,
  withinCooldown,
  selectForCreation,
  parseTitle,
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
