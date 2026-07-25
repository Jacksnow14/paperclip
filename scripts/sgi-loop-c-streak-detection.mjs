#!/usr/bin/env node
/**
 * SGI Loop C — Scorecard Streak Detection (Prompt Self-Edit detector)
 *
 * Fetches all `performance_scorecard` memory records, groups them by
 * {agent_id}/{task_type}, and evaluates each bucket against four
 * independent detectors (AUR-3850 — replaces the original strict-3-sample
 * monotone test, which fired once in 1,574 scorecards):
 *
 *   A — baseline-delta regression: mean(last 5) <= mean(prior 20) - 0.5
 *   B — non-strict decline (small buckets, 3 <= n < 10): last 3 records
 *       non-increasing oldest→newest AND total drop >= 1
 *   C — sustained low absolute quality: mean(last 5) <= 2.5
 *   D — rework streak (relaxed): >= 3 of the last 5 have rework_required
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
  const byId = new Map();
  let offset = 0;
  for (;;) {
    const data = await apiFetch(
      `/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_LIMIT}&offset=${offset}`,
    );
    if (data._notFound) break;
    const page = asArray(data, 'records');
    for (const r of page) {
      const id = r.id ?? r._id ?? `${r.title}|${r.createdAt || r.created_at || ''}`;
      if (!byId.has(id)) byId.set(id, r);
    }
    if (page.length < SCAN_LIMIT) break;
    offset += SCAN_LIMIT;
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

/**
 * Evaluate one {agent_id, task_type} bucket's records against detectors A–D.
 * `recs` items: { quality_signal: number|null, rework_required: boolean, createdAt: string }.
 * Returns { skip: 'too_few_records'|'stale'|'no_trigger' } or
 * { triggers: [{ detector, severity, desc }], severity, mostRecentAgeDays }.
 */
function evaluateBucket(recs, refDate) {
  const sorted = recs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (sorted.length < 3) return { skip: 'too_few_records' };

  const mostRecentAgeDays = ageDays(refDate, sorted[0].createdAt);
  if (mostRecentAgeDays > STALENESS_DAYS) return { skip: 'stale' };

  const triggers = [];
  const recent = sorted.slice(0, RECENT_N);
  const qRecent = recent.map((r) => r.quality_signal).filter((v) => typeof v === 'number');

  // Detector A — baseline-delta regression.
  const baseline = sorted.slice(RECENT_N, RECENT_N + BASELINE_N);
  const qBaseline = baseline.map((r) => r.quality_signal).filter((v) => typeof v === 'number');
  if (recent.length >= RECENT_N && baseline.length >= BASELINE_MIN && qRecent.length && qBaseline.length) {
    const meanRecent = mean(qRecent);
    const meanBaseline = mean(qBaseline);
    const delta = meanBaseline - meanRecent;
    if (delta >= DETECTOR_A_DELTA) {
      triggers.push({
        detector: 'A',
        severity: delta,
        desc: `baseline-delta regression — recent${qRecent.length} mean ${meanRecent.toFixed(2)} vs prior${qBaseline.length} mean ${meanBaseline.toFixed(2)} (Δ=${delta.toFixed(2)})`,
      });
    }
  }

  // Detector B — non-strict decline, small buckets only (3 <= n < 10).
  if (sorted.length >= 3 && sorted.length < DETECTOR_B_MAX_BUCKET) {
    const [n1, n2, n3] = sorted; // n1 = most recent, n3 = oldest of the 3
    if ([n1, n2, n3].every((r) => typeof r.quality_signal === 'number')) {
      const nonIncreasing = n3.quality_signal >= n2.quality_signal && n2.quality_signal >= n1.quality_signal;
      const drop = n3.quality_signal - n1.quality_signal;
      if (nonIncreasing && drop >= 1) {
        triggers.push({
          detector: 'B',
          severity: drop,
          desc: `non-strict decline (oldest→newest): ${n3.quality_signal}→${n2.quality_signal}→${n1.quality_signal}`,
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

  if (!triggers.length) return { skip: 'no_trigger' };

  return { triggers, severity: Math.max(...triggers.map((t) => t.severity)), mostRecentAgeDays };
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

  // Group into {agent_id}/{task_type} buckets.
  const buckets = new Map();
  for (const r of scorecards) {
    const m = r.metadata || {};
    const fromTitle = parseTitle(r.title);
    const agent_id = m.agent_id || fromTitle.agent_id;
    const task_type = m.task_type || fromTitle.task_type;
    if (!agent_id || !task_type) continue;
    const key = `${agent_id}/${task_type}`;
    if (!buckets.has(key)) buckets.set(key, { agent_id, task_type, recs: [] });
    buckets.get(key).recs.push({
      title: r.title,
      quality_signal: typeof m.quality_signal === 'number' ? m.quality_signal : null,
      rework_required: m.rework_required === true,
      createdAt: r.createdAt || r.created_at || '',
    });
  }

  // Resolve which agents still exist.
  const agentsData = await apiFetch(`/api/companies/${COMPANY_ID}/agents`);
  const liveAgents = new Set(asArray(agentsData, 'agents').map((a) => a.id));

  const triggered = [];
  const skippedTooFew = [];
  const skippedStale = [];
  const skippedNoAgent = [];
  let evaluated = 0;

  for (const [key, b] of buckets) {
    const result = evaluateBucket(b.recs, now);
    if (result.skip === 'too_few_records') { skippedTooFew.push(key); continue; }
    evaluated += 1;
    if (result.skip === 'stale') { skippedStale.push(key); continue; }
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
      `3. POST a \`prompt-improvement-proposal/${t.agent_id}/{YYYY-MM-DD}\` memory record`,
      '4. POST a `request_board_approval` linking this issue',
      '5. Set this issue `in_review`, assigned to CEO',
      '',
      '**Safety boundary:** propose edits to YOUR file ONLY.',
    ].join('\n');

    const payload = {
      title: `Prompt self-edit required — ${t.agent_id} / ${t.task_type}`,
      description,
      assigneeAgentId: t.agent_id,
      projectId: PROJECT_ID,
      priority: 'high',
      ...(parentId ? { parentId } : {}),
    };

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
  }, null, 2));
}

export {
  mean,
  ageDays,
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
