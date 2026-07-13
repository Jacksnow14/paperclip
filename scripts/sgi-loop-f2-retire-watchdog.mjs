#!/usr/bin/env node
/**
 * SGI Loop F-2 — Retire/Repurpose Proposal Watchdog
 *
 * Weekly watchdog identifying sustained bottom-quartile performers eligible
 * for board retire/repurpose proposals. Runs via routine c97632e4
 * (Mon 09:00 UTC, reuse_and_rewake) on exec issue AUR-1489.
 *
 * ### Gates — ALL must pass for a proposal to fire
 *
 * 1. **Min sample count ≥ 8** — single-sample agents (CFO/UX with n=1) are
 *    structurally under-represented and never flagged.
 *
 * 2. **Value-signal bias guard** — cost-adjusted score = quality × value / tokens
 *    is dominated by value_signal. CTO/CEO run mostly infra/ops which carries
 *    value_signal=1 by the scorecard convention, structurally suppressing their
 *    cost-adjusted scores even when quality_signal is 4–5. To prevent false-
 *    positive retirement of high-quality infra/ops agents, this script requires
 *    mean quality_signal < 3.5 as an ADDITIONAL gate. An agent whose average
 *    quality is ≥ 3.5 cannot be proposed for retirement on a low cost-adjusted
 *    score alone, regardless of quartile rank.
 *    Choice rationale: normalising within task_type would require knowing the
 *    task-type distribution for every agent, which adds complexity with no real
 *    benefit — the quality guard is the simpler, equally effective approach.
 *
 * 3. **Cost-adjusted bottom quartile** — mean score_adjusted at/below the Q1
 *    threshold across agents that cleared gates 1 & 2.
 *
 * 4. **Loop C self-edit gate** — only propose for an agent with an approved
 *    prompt-improvement-proposal/{agentId}/* memory record (outcome: approved).
 *    No Loop C record → skip. Correct outcome for every agent this week (no
 *    records exist), so no proposals are warranted.
 *
 * 5. **30-day cooldown** — check for any capacity-decisions/{agentId}/* record
 *    within the last 30 days; skip if present. After firing a proposal, write
 *    a capacity-decisions/{agentId}/{date} cooldown record.
 *
 * ### Scan window (AUR-3287)
 * Scorecard volume (~65 records/day) means a single 200-record page only spans
 * a few days — too narrow to establish "sustained" bottom-quartile performance.
 * The watchdog now pages through `GET /memory/records?limit=200&offset=N`
 * (AUR-2823) accumulating records until one older than the window boundary is
 * seen, then stops (bounded by MAX_PAGES as a runaway guard). Gates 1–3 (sample
 * count / quality / quartile) score only records inside WINDOW_DAYS (default
 * 28, override with `--window-days=N`). Gates 4–5 (Loop C / cooldown) look at
 * the full accumulated set, which is fetched out to
 * `max(WINDOW_DAYS, COOLDOWN_DAYS)` days so the 30-day cooldown check is never
 * starved by a shorter scoring window.
 *
 * ### Idempotency
 * Re-running in the same ISO week produces no duplicate board interactions.
 * idempotencyKey = `f2-retire-{agentId}-{isoYear}-W{isoWeek}`.
 *
 * Usage:
 *   node scripts/sgi-loop-f2-retire-watchdog.mjs                 # live run
 *   node scripts/sgi-loop-f2-retire-watchdog.mjs --dry-run       # print, do not post
 *   node scripts/sgi-loop-f2-retire-watchdog.mjs --date=2026-06-09
 *   node scripts/sgi-loop-f2-retire-watchdog.mjs --window-days=14 # override scoring window
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const dateArg = (argv.find(a => a.startsWith('--date=')) || '').split('=')[1];
const REF_DATE = dateArg ? new Date(dateArg + 'T00:00:00Z') : new Date();
const windowDaysArg = (argv.find(a => a.startsWith('--window-days=')) || '').split('=')[1];

// Scoring window in days — how far back records must fall to count toward the
// sample-count / quality / quartile gates. Default 28 (see AUR-3287).
const WINDOW_DAYS = windowDaysArg ? Number(windowDaysArg) : 28;

// Records per page and runaway guard for the offset-pagination loop.
const SCAN_PAGE_LIMIT = 200;
const MAX_PAGES = 20;

// Min scorecards per agent to qualify for quartile ranking.
const MIN_SAMPLE_COUNT = 8;

// Mean quality_signal threshold: agents at or above this are exempt from
// retirement proposals regardless of cost-adjusted score (value-signal bias).
const QUALITY_EXEMPTION_THRESHOLD = 3.5;

// Cooldown window in days.
const COOLDOWN_DAYS = 30;

// ---- Helpers ---------------------------------------------------------------

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

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function postInteraction(issueId, payload, idempotencyKey) {
  return apiFetch(`/api/issues/${issueId}/interactions`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'request_confirmation',
      continuationPolicy: 'wake_assignee',
      idempotencyKey,
      payload: {
        version: 1,
        title: payload.title,
        prompt: payload.prompt,
        body: payload.body,
      },
    }),
  });
}

async function captureRecord(title, content, metadata) {
  const source = RUN_ID
    ? { kind: 'run', runId: RUN_ID }
    : (TASK_ID ? { kind: 'issue', issueId: TASK_ID } : { kind: 'manual_note' });
  return apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST',
    body: JSON.stringify({ title, content, metadata, source }),
  });
}

// ---- Windowed pagination -----------------------------------------------

function cutoffIso(refDate, days) {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * Pages through GET /memory/records (offset pagination, AUR-2823) accumulating
 * records until one older than the fetch-window boundary is seen (or the API
 * runs out of records, or MAX_PAGES is hit). `get(path)` is injected so this
 * is testable without a live API.
 *
 * Returns:
 *   - accumulated: every record fetched, bounded by max(windowDays, cooldownDays)
 *   - windowed: the subset of `accumulated` within windowDays — used for scoring
 *   - pages / hitPageCap: pagination diagnostics
 */
async function fetchWindowedRecords(get, companyId, { refDate, windowDays, cooldownDays = COOLDOWN_DAYS, pageLimit = SCAN_PAGE_LIMIT, maxPages = MAX_PAGES } = {}) {
  const fetchWindowDays = Math.max(windowDays, cooldownDays);
  const scoreCutoffIso = cutoffIso(refDate, windowDays);
  const fetchCutoffIso = cutoffIso(refDate, fetchWindowDays);

  const accumulated = [];
  let offset = 0;
  let pages = 0;

  while (pages < maxPages) {
    const data = await get(`/api/companies/${companyId}/memory/records?limit=${pageLimit}&offset=${offset}`);
    const batch = (data && data._notFound) ? [] : (Array.isArray(data) ? data : (data.records || []));
    if (batch.length === 0) break;

    accumulated.push(...batch);
    pages++;

    const oldestInBatch = batch[batch.length - 1]?.createdAt || '';
    const reachedBoundary = oldestInBatch && oldestInBatch < fetchCutoffIso;
    const shortBatch = batch.length < pageLimit;
    if (reachedBoundary || shortBatch) break;

    offset += pageLimit;
  }

  const hitPageCap = pages >= maxPages;
  const windowed = accumulated.filter(r => (r.createdAt || '') >= scoreCutoffIso);

  return { accumulated, windowed, pages, hitPageCap, scoreCutoffIso, fetchCutoffIso };
}

// ---- ISO week helpers ------------------------------------------------------

function isoWeekYear(date) {
  // Returns { year, week } for the ISO 8601 week containing `date`.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // make Sun = 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thu
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// ---- Analysis --------------------------------------------------------------

function aggregateScores(records) {
  // Group scorecard-adjusted records by agent_id.
  const byAgent = new Map();
  for (const r of records) {
    const m = r.metadata || {};
    if (m.category !== 'scorecard_adjusted') continue;
    const id = m.agent_id;
    if (!id) continue;
    let bucket = byAgent.get(id);
    if (!bucket) {
      bucket = { agentId: id, scores: [], quality: [], taskTypes: [], oldest: '', newest: '' };
      byAgent.set(id, bucket);
    }
    const sa = Number(m.score_adjusted);
    const q = Number(m.quality_signal);
    const ts = r.createdAt || '';
    if (Number.isFinite(sa)) bucket.scores.push(sa);
    if (Number.isFinite(q)) bucket.quality.push(q);
    if (m.task_type) bucket.taskTypes.push(m.task_type);
    if (!bucket.oldest || ts < bucket.oldest) bucket.oldest = ts;
    if (!bucket.newest || ts > bucket.newest) bucket.newest = ts;
  }

  // Compute means.
  const agents = [];
  for (const [id, b] of byAgent) {
    const n = b.scores.length;
    const meanScore = n ? b.scores.reduce((s, x) => s + x, 0) / n : 0;
    const nq = b.quality.length;
    const meanQuality = nq ? b.quality.reduce((s, x) => s + x, 0) / nq : 0;
    const taskTypeDist = {};
    for (const t of b.taskTypes) taskTypeDist[t] = (taskTypeDist[t] || 0) + 1;
    agents.push({ agentId: id, n, meanScore, meanQuality, taskTypeDist, oldest: b.oldest, newest: b.newest });
  }
  return agents;
}

function quartileThreshold(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.25);
  return sorted[idx];
}

// ---- Loop C gate -----------------------------------------------------------

function hasLoopCRecord(records, agentId) {
  // Check for prompt-improvement-proposal/{agentId}/* with outcome: approved.
  return records.some(r => {
    const t = r.title || '';
    const m = r.metadata || {};
    return t.startsWith(`prompt-improvement-proposal/${agentId}/`)
      && m.outcome === 'approved';
  });
}

// ---- Cooldown gate ---------------------------------------------------------

function withinCooldown(records, agentId, refDate) {
  const cutoff = cutoffIso(refDate, COOLDOWN_DAYS);
  return records.some(r => {
    const t = r.title || '';
    if (!t.startsWith(`capacity-decisions/${agentId}/`)) return false;
    const ts = r.createdAt || '';
    return ts >= cutoff;
  });
}

// ---- Gate evaluation (pure — testable without the API) --------------------

/**
 * Runs gates 1–5 and builds the proposal/skip lists. `windowed` scores gates
 * 1–3; `accumulated` (which reaches back to at least COOLDOWN_DAYS) is used
 * for the Loop C / cooldown checks in gates 4–5.
 */
function evaluateGates(windowed, accumulated, refDate) {
  const { year: isoYear, week: isoWeek } = isoWeekYear(refDate);

  const agents = aggregateScores(windowed);
  const qualifying = agents.filter(a => a.n >= MIN_SAMPLE_COUNT);
  const lowQuality = qualifying.filter(a => a.meanQuality < QUALITY_EXEMPTION_THRESHOLD);
  const exemptedByQuality = qualifying.filter(a => a.meanQuality >= QUALITY_EXEMPTION_THRESHOLD);
  const q1 = quartileThreshold(lowQuality.map(a => a.meanScore));
  const bottomQ = lowQuality.filter(a => a.meanScore <= q1);

  const proposals = [];
  const skipped = [];

  for (const agent of bottomQ) {
    const { agentId, n, meanScore, meanQuality, taskTypeDist, oldest, newest } = agent;

    if (!hasLoopCRecord(accumulated, agentId)) {
      skipped.push({ agentId, reason: 'no Loop C self-edit on record (prompt-improvement-proposal not found)' });
      continue;
    }

    if (withinCooldown(accumulated, agentId, refDate)) {
      skipped.push({ agentId, reason: `capacity-decisions record exists within last ${COOLDOWN_DAYS} days` });
      continue;
    }

    const idempotencyKey = `f2-retire-${agentId}-${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
    proposals.push({ agentId, idempotencyKey, n, meanScore, meanQuality, taskTypeDist, oldest, newest, q1 });
  }

  return { isoYear, isoWeek, agents, qualifying, lowQuality, exemptedByQuality, q1, bottomQ, proposals, skipped };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const refDateStr = REF_DATE.toISOString().slice(0, 10);
  console.log(`SGI Loop F-2 Retire Watchdog — ref date ${refDateStr}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE'}`);
  console.log(`Scoring window: ${WINDOW_DAYS} days\n`);

  const { accumulated, windowed, pages, hitPageCap } = await fetchWindowedRecords(
    (path) => apiFetch(path),
    COMPANY_ID,
    { refDate: REF_DATE, windowDays: WINDOW_DAYS }
  );

  if (hitPageCap) {
    console.log(`[WARN] Hit MAX_PAGES cap (${MAX_PAGES}) after ${pages} page(s) while paging memory records — scan may be truncated before the full window was reached.`);
  }
  console.log(`Pagination: ${pages} page(s) fetched, ${accumulated.length} record(s) accumulated, ${windowed.length} within the ${WINDOW_DAYS}-day scoring window.`);

  const windowOldest = windowed.reduce((min, r) => {
    const ts = r.createdAt || '';
    return (!min || ts < min) ? ts : min;
  }, '');
  const windowNewest = windowed.reduce((max, r) => {
    const ts = r.createdAt || '';
    return (!max || ts > max) ? ts : max;
  }, '');
  console.log(`Scoring window: ${windowed.length} records  oldest=${windowOldest.slice(0,10)}  newest=${windowNewest.slice(0,10)}`);

  const { isoYear, isoWeek, agents, qualifying, lowQuality, exemptedByQuality, q1, bottomQ, proposals, skipped } =
    evaluateGates(windowed, accumulated, REF_DATE);

  console.log(`\nAll agents with scorecard-adjusted records (${agents.length}):`);
  for (const a of agents.sort((x, y) => y.n - x.n)) {
    console.log(`  ${a.agentId}  n=${a.n}  meanScore=${a.meanScore.toExponential(3)}  meanQuality=${a.meanQuality.toFixed(2)}`);
  }

  console.log(`\nAfter gate 1 (n ≥ ${MIN_SAMPLE_COUNT}): ${qualifying.length} agent(s) qualify`);
  for (const a of qualifying) {
    console.log(`  ${a.agentId}  n=${a.n}`);
  }

  console.log(`\nAfter gate 2 (mean quality < ${QUALITY_EXEMPTION_THRESHOLD}): ${lowQuality.length} remain, ${exemptedByQuality.length} exempted`);
  for (const a of exemptedByQuality) {
    console.log(`  EXEMPT: ${a.agentId}  meanQuality=${a.meanQuality.toFixed(2)} ≥ ${QUALITY_EXEMPTION_THRESHOLD} — high-quality infra/ops agent, skip`);
  }

  console.log(`\nQ1 threshold (among quality-gated agents): ${q1.toExponential(4)}`);
  console.log(`After gate 3 (bottom quartile): ${bottomQ.length} agent(s)`);
  for (const a of bottomQ) {
    console.log(`  ${a.agentId}  meanScore=${a.meanScore.toExponential(3)}`);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Window: ${windowOldest.slice(0, 10)} → ${windowNewest.slice(0, 10)} (${windowed.length} records scanned, ${WINDOW_DAYS}-day window)`);
  console.log(`Agents scored: ${agents.length}  Qualifying (n≥${MIN_SAMPLE_COUNT}): ${qualifying.length}  Low-quality: ${lowQuality.length}  Bottom-Q: ${bottomQ.length}`);
  console.log(`Q1 threshold: ${q1.toExponential(4)}`);
  console.log(`\nExempted by quality guard (${exemptedByQuality.length}):`);
  for (const a of exemptedByQuality) {
    console.log(`  ${a.agentId}  meanQuality=${a.meanQuality.toFixed(2)}  — VALUE-SIGNAL BIAS GUARD applied`);
  }
  console.log(`\nGated out after bottom-Q (${skipped.length}):`);
  for (const s of skipped) {
    console.log(`  ${s.agentId}: ${s.reason}`);
  }
  console.log(`\nProposals to post (${proposals.length}):`);
  for (const p of proposals) {
    console.log(`  ${p.agentId}  key=${p.idempotencyKey}`);
  }

  const proposalBodies = proposals.map(p => {
    const taskDist = Object.entries(p.taskTypeDist).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}×${c}`).join(', ');
    const interactionTitle = `Loop F-2 proposal: retire or repurpose agent ${p.agentId.slice(0, 8)}`;
    const body = [
      `## Loop F-2 Retire/Repurpose Proposal`,
      ``,
      `**Agent:** \`${p.agentId}\``,
      `**Scorecard window:** ${p.oldest.slice(0, 10)} → ${p.newest.slice(0, 10)} (n=${p.n}, ${WINDOW_DAYS}-day scan)`,
      `**Mean cost-adjusted score:** ${p.meanScore.toExponential(4)} (Q1 threshold: ${p.q1.toExponential(4)})`,
      `**Mean quality_signal:** ${p.meanQuality.toFixed(2)} (below exemption threshold ${QUALITY_EXEMPTION_THRESHOLD})`,
      `**Task-type distribution:** ${taskDist}`,
      `**Loop C self-edit:** record confirmed (prompt-improvement-proposal/${p.agentId}/*)`,
      `**Cooldown:** no capacity-decisions record within last ${COOLDOWN_DAYS} days`,
      ``,
      `### What happened`,
      `This agent ranks in the cost-adjusted bottom quartile (score ≤ Q1) among agents`,
      `with sufficient sample size (n ≥ ${MIN_SAMPLE_COUNT}) and low mean quality (< ${QUALITY_EXEMPTION_THRESHOLD})`,
      `sustained over a ${WINDOW_DAYS}-day window.`,
      `A Loop C self-edit was already attempted and approved. The 30-day cooldown has cleared.`,
      ``,
      `### Board action required`,
      `Please decide: **retire** this agent (cancel routine/issues, revoke access) or **repurpose**`,
      `(reassign to different task types where their skill set is better matched).`,
      ``,
      `Accepting this interaction will log the decision and set a 30-day cooldown.`,
      `Rejecting will skip this cycle; the agent will be re-evaluated next week.`,
    ].join('\n');
    return { ...p, interactionTitle, body };
  });

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No interactions or memory records written.');
    for (const p of proposalBodies) {
      console.log(`\n--- Proposal for ${p.agentId} ---\n${p.body}`);
    }
    return { dryRun: true, proposals: proposals.length, skipped: skipped.length, q1, exemptedByQuality: exemptedByQuality.length, windowDays: WINDOW_DAYS, recordsScanned: windowed.length, pagesFetched: pages, hitPageCap };
  }

  // Live mode: post interactions and write cooldown records.
  const posted = [];
  for (const p of proposalBodies) {
    if (!TASK_ID) {
      console.warn(`[WARN] PAPERCLIP_TASK_ID not set — skipping interaction for ${p.agentId}`);
      continue;
    }
    const result = await postInteraction(TASK_ID, {
      title: p.interactionTitle,
      prompt: `Retire or repurpose agent ${p.agentId}?`,
      body: p.body,
    }, p.idempotencyKey);
    console.log(`Posted interaction for ${p.agentId}: ${JSON.stringify(result?.id || result)}`);

    // Write 30-day cooldown record.
    await captureRecord(
      `capacity-decisions/${p.agentId}/${refDateStr}`,
      `Loop F-2 proposal posted for agent ${p.agentId} on ${refDateStr}. Q1=${p.q1.toExponential(4)}, n=${p.n}, meanScore=${p.meanScore.toExponential(4)}. Cooldown for ${COOLDOWN_DAYS} days.`,
      {
        category: 'capacity_decisions',
        agent_id: p.agentId,
        date: refDateStr,
        iso_week: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
        mean_score_adjusted: p.meanScore,
        q1_threshold: p.q1,
        n: p.n,
      }
    );
    console.log(`Wrote cooldown record capacity-decisions/${p.agentId}/${refDateStr}`);
    posted.push(p.agentId);
  }

  // Post run summary comment if we have a task ID.
  if (TASK_ID) {
    const exemptLines = exemptedByQuality.map(a =>
      `- \`${a.agentId}\` — meanQuality=${a.meanQuality.toFixed(2)} ≥ ${QUALITY_EXEMPTION_THRESHOLD} (value-signal bias guard)`
    ).join('\n') || '- _none_';
    const skipLines = skipped.map(s =>
      `- \`${s.agentId}\`: ${s.reason}`
    ).join('\n') || '- _none_';
    const proposalLines = posted.length
      ? posted.map(id => `- \`${id}\` — board interaction posted (idempotent)`).join('\n')
      : '- **None warranted** — no agent passed all gates';
    const commentBody = [
      `## SGI Loop F-2 — Retire/Repurpose Watchdog Run`,
      ``,
      `**Date:** ${refDateStr} · **ISO week:** ${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
      `**Scoring window:** ${WINDOW_DAYS} days (${windowOldest.slice(0,10)} → ${windowNewest.slice(0,10)}) · **Records scanned:** ${windowed.length} (${pages} page(s), ${accumulated.length} accumulated)`,
      `**Agents scored:** ${agents.length} total · ${qualifying.length} with n≥${MIN_SAMPLE_COUNT} · Q1 threshold: \`${q1.toExponential(4)}\``,
      ``,
      `### Exempted by value-signal bias guard (quality ≥ ${QUALITY_EXEMPTION_THRESHOLD})`,
      exemptLines,
      ``,
      `### Gated out (Loop C / cooldown)`,
      skipLines,
      ``,
      `### Proposals posted`,
      proposalLines,
    ].join('\n');
    await postComment(TASK_ID, commentBody);
  }

  return {
    date: refDateStr,
    isoWeek: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
    windowDays: WINDOW_DAYS,
    recordsScanned: windowed.length,
    recordsAccumulated: accumulated.length,
    pagesFetched: pages,
    hitPageCap,
    agentsScored: agents.length,
    qualifying: qualifying.length,
    lowQuality: lowQuality.length,
    bottomQ: bottomQ.length,
    q1Threshold: q1,
    exemptedByQuality: exemptedByQuality.length,
    skipped: skipped.length,
    proposed: posted.length,
  };
}

export {
  fetchWindowedRecords,
  aggregateScores,
  quartileThreshold,
  hasLoopCRecord,
  withinCooldown,
  isoWeekYear,
  evaluateGates,
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error('SGI Loop F-2 error:', err.message);
    process.exit(1);
  });
}
