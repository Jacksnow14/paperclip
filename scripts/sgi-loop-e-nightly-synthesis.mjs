#!/usr/bin/env node
/**
 * SGI Loop E — Nightly Cross-Project Synthesis
 *
 * Reads the day's self-improvement signals and distills them into a single
 * cross-project `synthesis/{YYYY-MM-DD}` memory record so the board can see the
 * forest, not the trees. Inputs (all from the company memory store):
 *
 *   - retrospectives        category=retrospective       (aspect: what_worked | patterns | tool_gaps)
 *   - tool-gaps             category=tool_gap            (frequency, capability_needed, workaround, cost)
 *   - performance scorecards category=performance_scorecard (outcome, quality_signal, rework_required, token_cost)
 *   - cost-adjusted scorecards category=scorecard_adjusted (Loop D: value_signal, token_cost, score_adjusted)
 *   - efficiency signals    category=efficiency_signal    (Loop D: efficiency, token_cost_usd, completion_rate)
 *
 * Output: one memory record titled `synthesis/{YYYY-MM-DD}`,
 *   metadata.category = "synthesis"  (board-defined auto-accepted category)
 * containing four sections:
 *   1. Recurring failure modes      — friction/quality signals seen 2+ times or flagged recurring
 *   2. Consistently strong patterns — what_worked / clean successes worth reinforcing
 *   3. Emergent cost outliers       — projects/work burning tokens out of proportion to value
 *   4. Delta vs. previous day       — how today's picture moved against the last synthesis
 *
 * The record is idempotent per day: capture is insert-only, so a re-run writes a
 * fresh `synthesis/{date}` record and then revokes our own earlier copies of the
 * same title, leaving exactly one live canonical synthesis per UTC day.
 *
 * Usage:
 *   node scripts/sgi-loop-e-nightly-synthesis.mjs            # synthesize "today" (UTC)
 *   node scripts/sgi-loop-e-nightly-synthesis.mjs --date=2026-06-02
 *   node scripts/sgi-loop-e-nightly-synthesis.mjs --dry-run  # print, do not capture/comment
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

let API_URL = '';
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const dateArg = (argv.find(a => a.startsWith('--date=')) || '').split('=')[1];
const TARGET_DATE = dateArg || new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// Records are scanned most-recent-first via ?limit&offset pagination. Daily
// signal volume outgrew a single page long ago (~750 records/day as of
// 2026-07-25, so one 200-record page covered only the last ~6h of a UTC day and
// never reached the prior day's synthesis for the delta). We now page until we
// have walked past the target day and found the previous synthesis, bounded by
// SCAN_MAX_PAGES so a runaway stream can't hang the nightly run.
const SCAN_PAGE_SIZE = 200;
const SCAN_MAX_PAGES = 30;

// A failure theme is "recurring" if it shows up at least this many times today,
// independent of any single record self-declaring frequency=recurring.
const RECURRING_THRESHOLD = 2;

function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...(RUN_ID ? { 'X-Paperclip-Run-Id': RUN_ID } : {}),
    ...extra,
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

async function fetchRecordPage(offset) {
  const data = await apiFetch(
    `/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_PAGE_SIZE}&offset=${offset}`
  );
  if (data._notFound) return [];
  return Array.isArray(data) ? data : (data.records || []);
}

/**
 * Page most-recent-first until the whole target UTC day is covered and the
 * previous synthesis (delta basis) is in hand. Offsets shift while the table
 * grows under us, so dedupe by record id.
 */
async function fetchRecords() {
  const byId = new Map();
  let pages = 0;
  let truncated = false;
  for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
    const page = await fetchRecordPage(offset);
    pages++;
    for (const r of page) byId.set(r.id || `${r.title}:${r.createdAt}`, r);
    const records = [...byId.values()];
    const walkedPastDay = records.some(r => dayOf(r) < TARGET_DATE);
    const hasPrevSynthesis = records.some(r => cat(r) === 'synthesis' && dayOf(r) < TARGET_DATE);
    if (page.length < SCAN_PAGE_SIZE) break;            // reached the oldest record
    if (walkedPastDay && hasPrevSynthesis) break;        // day fully covered + delta basis found
    if (pages >= SCAN_MAX_PAGES) { truncated = true; break; }
  }
  const records = [...byId.values()];
  if (truncated) {
    console.error(
      `[loop-e] WARNING: scan hit the ${SCAN_MAX_PAGES}-page cap (${records.length} records); ` +
      `signals for ${TARGET_DATE} may be incomplete and the delta may fall back to baseline.`
    );
  }
  return { records, pages, truncated };
}

async function captureSynthesis(title, body, metadata) {
  // Memory capture schema (packages/shared/src/validators/memory.ts, .strict()):
  //   { title?, content: string(1..20000), metadata?, source: { kind, ... } }
  // Old payload shape ({ body, kind:'synthesis', agentId, runId }) is now rejected.
  // Bind the record to this automated run when we have a run id, else to the
  // execution issue; either way scope defaults to {} so it stays org-wide /
  // project-agnostic, which is what cross-project synthesis wants.
  const source = RUN_ID
    ? { kind: 'run', runId: RUN_ID }
    : (TASK_ID ? { kind: 'issue', issueId: TASK_ID } : { kind: 'manual_note' });
  const content = body.length > 20000 ? `${body.slice(0, 19980)}\n\n…[truncated]` : body;
  return apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST',
    body: JSON.stringify({ title, content, metadata, source }),
  });
}

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// AUR-5168 AC4: surface the same rolling 7-day self-improvement-vs-revenue
// share the AC3 admission gate reads, so the board sees it without a
// separate dashboard. Best-effort — a fetch failure omits the line rather
// than failing the whole nightly synthesis.
async function fetchWorkClassBudget() {
  try {
    const budget = await apiFetch(`/api/companies/${COMPANY_ID}/work-class-budget`);
    return budget && !budget._notFound ? budget : null;
  } catch (err) {
    console.error(`[loop-e] could not fetch work-class-budget: ${err.message}`);
    return null;
  }
}

function workClassBudgetLine(budget) {
  if (!budget) return null;
  const totalTokens = budget.revenueTokens + budget.selfImprovementTokens;
  const pct = (budget.selfImprovementShare * 100).toFixed(1);
  const capPct = (budget.capShare * 100).toFixed(0);
  return `self-improvement 7d: ${pct}% of ${totalTokens.toLocaleString()} tok (cap ${capPct}%)${budget.overCap ? ' ⚠️ over cap' : ''}`;
}

const cat = (r) => (r.metadata && r.metadata.category) || '';
const dayOf = (r) => (r.createdAt || '').slice(0, 10);

// /memory/capture silently drops category `retrospective`, so agents capture
// retro lessons as category `lesson` under a `retrospective/<AUR-xxxx>/...`
// title. Matching on category alone counted 0 retros every night.
const isRetro = (r) =>
  cat(r) === 'retrospective' ||
  (cat(r) === 'lesson' && String(r.title || '').startsWith('retrospective/'));
const idLabel = (r) => (r.metadata && (r.metadata.issue_id || r.metadata.project_id || r.metadata.agent_id)) || '';

/** Normalize a free-text capability/theme into a short grouping key. */
function themeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')
    .trim();
}

// ---- Section builders ------------------------------------------------------

/** 1. Recurring failure modes — clustered friction + quality misses. */
function recurringFailureModes(today) {
  const themes = new Map(); // key -> { label, count, recurringFlagged, costs:[], examples:Set, kinds:Set }
  const bump = (rawLabel, { recurring = false, cost, example, kind } = {}) => {
    const key = themeKey(rawLabel) || 'unspecified';
    let t = themes.get(key);
    if (!t) { t = { label: rawLabel || '(unspecified)', count: 0, recurringFlagged: false, costs: [], examples: new Set(), kinds: new Set() }; themes.set(key, t); }
    t.count++;
    if (recurring) t.recurringFlagged = true;
    if (cost) t.costs.push(cost);
    if (example) t.examples.add(example);
    if (kind) t.kinds.add(kind);
  };

  for (const r of today) {
    const m = r.metadata || {};
    if (cat(r) === 'tool_gap') {
      bump(m.capability_needed || r.title, {
        recurring: m.frequency === 'recurring',
        cost: m.estimated_cost_of_workaround,
        example: m.issue_id || r.title,
        kind: 'tool_gap',
      });
    } else if (cat(r) === 'performance_scorecard') {
      const quality = Number(m.quality_signal);
      if (m.rework_required === true || m.outcome === 'failure' || (Number.isFinite(quality) && quality <= 2)) {
        const reason = m.rework_required ? 'rework required' : m.outcome === 'failure' ? 'task failed' : 'low quality signal';
        bump(`${m.task_type || 'task'}: ${reason}`, { example: m.issue_id, kind: 'scorecard' });
      }
    } else if (isRetro(r) && m.aspect === 'tool_gaps') {
      bump(`retro tool-gap: ${m.issue_id || r.title}`, { example: m.issue_id, kind: 'retro' });
    }
  }

  return [...themes.values()]
    .filter(t => t.recurringFlagged || t.count >= RECURRING_THRESHOLD)
    .sort((a, b) => b.count - a.count)
    .map(t => ({
      label: t.label,
      count: t.count,
      recurring: t.recurringFlagged,
      examples: [...t.examples].slice(0, 5),
      costs: t.costs.slice(0, 5),
      kinds: [...t.kinds],
    }));
}

/** 2. Consistently strong patterns — what_worked + clean successes. */
function strongPatterns(today) {
  const worked = today.filter(r => isRetro(r) && (r.metadata.aspect === 'what_worked' || r.metadata.aspect === 'patterns'));
  const cleanWins = today.filter(r => {
    const m = r.metadata || {};
    return cat(r) === 'performance_scorecard'
      && m.outcome === 'success'
      && m.rework_required !== true
      && Number(m.quality_signal) >= 4;
  });

  // Reinforce by agent/task_type combos that show repeated clean wins.
  const byCombo = new Map();
  for (const r of cleanWins) {
    const m = r.metadata;
    const key = `${m.task_type || 'task'}`;
    let c = byCombo.get(key); if (!c) { c = { task: key, wins: 0, agents: new Set(), issues: new Set() }; byCombo.set(key, c); }
    c.wins++; if (m.agent_id) c.agents.add(m.agent_id); if (m.issue_id) c.issues.add(m.issue_id);
  }

  return {
    workedAspects: worked.map(r => ({ aspect: r.metadata.aspect, ref: r.metadata.issue_id || r.title })),
    cleanWinCount: cleanWins.length,
    repeatedStrengths: [...byCombo.values()]
      .filter(c => c.wins >= RECURRING_THRESHOLD)
      .sort((a, b) => b.wins - a.wins)
      .map(c => ({ task: c.task, wins: c.wins, agents: [...c.agents].length, issues: [...c.issues].slice(0, 10), issuesTotal: c.issues.size })),
  };
}

/** 3. Emergent cost outliers — token spend out of proportion to value/throughput. */
function costOutliers(today, allRecords) {
  // Latest efficiency signal per project (these are lifetime, refreshed by Loop D;
  // use the freshest regardless of day so an outlier isn't missed on a quiet day).
  const latestEff = new Map();
  for (const r of allRecords.filter(x => cat(x) === 'efficiency_signal')) {
    const m = r.metadata || {};
    const pid = m.project_id; if (!pid) continue;
    const stamp = m.computed_at || r.createdAt || '';
    const prev = latestEff.get(pid);
    if (!prev || stamp > prev._stamp) {
      latestEff.set(pid, { projectId: pid, costUsd: Number(m.token_cost_usd) || 0, efficiency: Number(m.efficiency) || 0, completion: Number(m.completion_rate) || 0, blocked: Number(m.blocked_count) || 0, _stamp: stamp });
    }
  }
  const effRows = [...latestEff.values()];
  const totalCost = effRows.reduce((s, r) => s + r.costUsd, 0);
  const meanCost = effRows.length ? totalCost / effRows.length : 0;
  // A project is a cost outlier if it spends well above the mean while delivering
  // little (low efficiency / nothing completed).
  const projectOutliers = effRows
    .filter(r => r.costUsd > 0 && r.costUsd >= Math.max(meanCost * 1.5, 1) && (r.efficiency < 0.15 || r.completion < 0.25))
    .sort((a, b) => b.costUsd - a.costUsd)
    .map(r => ({ projectId: r.projectId, costUsd: r.costUsd, efficiency: r.efficiency, completion: r.completion, blocked: r.blocked }));

  // Today's cost-adjusted scorecards with the worst value-per-token (Loop D).
  const adj = today.filter(r => cat(r) === 'scorecard_adjusted')
    .map(r => ({ ref: r.metadata.issue_id || r.title, agent: r.metadata.agent_id, task: r.metadata.task_type, tokenCost: Number(r.metadata.token_cost) || 0, value: Number(r.metadata.value_signal) || 0, scoreAdjusted: Number(r.metadata.score_adjusted) || 0 }))
    .sort((a, b) => a.scoreAdjusted - b.scoreAdjusted);
  const worstAdjusted = adj.slice(0, 3);

  return { projectOutliers, worstAdjusted, totalCostUsd: totalCost, meanCostUsd: meanCost, projectsTracked: effRows.length };
}

/** 4. Delta vs. the previous synthesis record. */
function findPreviousSynthesis(allRecords) {
  return allRecords
    .filter(r => cat(r) === 'synthesis' && dayOf(r) < TARGET_DATE)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0] || null;
}

function delta(metrics, prev) {
  if (!prev || !prev.metadata || !prev.metadata.metrics) {
    return { hasPrev: false, prevDate: prev ? dayOf(prev) : null, lines: ['No prior synthesis on record — this is the baseline.'] };
  }
  const p = prev.metadata.metrics;
  const arrow = (now, was) => now > was ? `▲ +${now - was}` : now < was ? `▼ ${now - was}` : '▬ 0';
  const lines = [
    `Recurring failure modes: ${metrics.failureModes} (prev ${p.failureModes ?? '–'}) ${arrow(metrics.failureModes, p.failureModes ?? 0)}`,
    `Strong patterns: ${metrics.strongPatterns} (prev ${p.strongPatterns ?? '–'}) ${arrow(metrics.strongPatterns, p.strongPatterns ?? 0)}`,
    `Cost outlier projects: ${metrics.costOutliers} (prev ${p.costOutliers ?? '–'}) ${arrow(metrics.costOutliers, p.costOutliers ?? 0)}`,
    `Tool-gaps logged: ${metrics.toolGaps} (prev ${p.toolGaps ?? '–'}) ${arrow(metrics.toolGaps, p.toolGaps ?? 0)}`,
  ];
  // A synthesis written before the paginated scan landed only saw one
  // 200-record window of its day, so its counts under-sample. Flag it instead
  // of letting the board read a coverage change as a real regression.
  const prevInputs = prev.metadata.inputs || {};
  if (!prevInputs.pagesScanned) {
    lines.push(
      '_Caveat: the prior synthesis predates the full-day paginated scan (it saw a single 200-record window), ' +
      'so these deltas mostly reflect scan coverage, not a real change in fleet behaviour._'
    );
  }
  return { hasPrev: true, prevDate: dayOf(prev), lines };
}

// ---- Render ----------------------------------------------------------------

function renderBody(s) {
  const { date, failures, patterns, cost, deltaInfo, counts, wcbLine } = s;
  // Section 1 is capped so a high-signal day can't push the record past the
  // 20k-char capture limit and silently amputate sections 3 and 4. The omitted
  // tail is reported, never dropped in silence.
  const FAIL_RENDER_CAP = 15;
  const shownFailures = failures.slice(0, FAIL_RENDER_CAP);
  const omittedFailures = failures.length - shownFailures.length;
  const fail = failures.length
    ? shownFailures.map(f => `- **${f.label}** — seen ${f.count}×${f.recurring ? ' _(flagged recurring)_' : ''}${f.examples.length ? ` · e.g. ${f.examples.join(', ')}` : ''}${f.costs.length ? ` · workaround cost: ${f.costs.join('; ')}` : ''}`).join('\n')
      + (omittedFailures > 0 ? `\n- _…and ${omittedFailures} more theme(s) below the top ${FAIL_RENDER_CAP} by occurrence (see metadata.failure_modes for the full list)._` : '')
    : '- _None crossed the recurrence threshold today._';

  const strong = [
    patterns.workedAspects.length ? patterns.workedAspects.map(w => `- ${w.aspect} → ${w.ref}`).join('\n') : null,
    patterns.repeatedStrengths.length ? patterns.repeatedStrengths.map(r => `- **${r.task}**: ${r.wins} clean wins across ${r.agents} agent(s) (${r.issues.join(', ')}${r.issuesTotal > r.issues.length ? `, +${r.issuesTotal - r.issues.length} more` : ''})`).join('\n') : null,
    !patterns.workedAspects.length && !patterns.repeatedStrengths.length ? '- _No repeated strong pattern surfaced today._' : null,
  ].filter(Boolean).join('\n');

  const outliers = cost.projectOutliers.length
    ? cost.projectOutliers.map(o => `- project \`${o.projectId}\` — $${o.costUsd.toFixed(2)} token spend, efficiency ${o.efficiency.toFixed(2)}, completion ${(o.completion * 100).toFixed(0)}%${o.blocked ? `, ${o.blocked} blocked` : ''}`).join('\n')
    : '- _No project breached the cost-vs-throughput outlier bar._';
  const worstAdj = cost.worstAdjusted.length
    ? '\n\n  Lowest value-per-token today (cost-adjusted scorecards):\n' + cost.worstAdjusted.map(a => `  - ${a.ref} (${a.task}) — score ${a.scoreAdjusted.toFixed(4)}, ${a.tokenCost} tok, value ${a.value}`).join('\n')
    : '';

  return `# Cross-Project Synthesis — ${date}

_SGI Loop E · distilled from ${counts.inputs} signal record(s) dated ${date} (${counts.retros} retro, ${counts.toolGaps} tool-gap, ${counts.scorecards} scorecard, ${counts.adjusted} cost-adjusted, ${counts.efficiency} efficiency); scanned ${counts.pagesScanned ?? '?'} page(s) of memory${counts.scanTruncated ? ' — **scan hit the page cap, coverage incomplete**' : ''}.${counts.inputs === 0 ? ' No fresh signals today — sections reflect standing state only.' : ''}_
${wcbLine ? `\n_${wcbLine}_\n` : ''}
## 1. Recurring failure modes
${fail}

## 2. Consistently strong patterns
${strong}

## 3. Emergent cost outliers
${outliers}${worstAdj}

_Tracked ${cost.projectsTracked} project(s); mean token spend $${cost.meanCostUsd.toFixed(2)}._

## 4. Delta vs. previous day${deltaInfo.prevDate ? ` (${deltaInfo.prevDate})` : ''}
${deltaInfo.lines.map(l => `- ${l}`).join('\n')}
`;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  API_URL = await resolveApiBase();
  const scan = await fetchRecords();
  const all = scan.records;
  const today = all.filter(r => dayOf(r) === TARGET_DATE && cat(r) !== 'synthesis');

  const failures = recurringFailureModes(today);
  const patterns = strongPatterns(today);
  const cost = costOutliers(today, all);
  const prev = findPreviousSynthesis(all);
  const workClassBudget = await fetchWorkClassBudget();
  const wcbLine = workClassBudgetLine(workClassBudget);

  const counts = {
    retros: today.filter(r => isRetro(r)).length,
    toolGaps: today.filter(r => cat(r) === 'tool_gap').length,
    scorecards: today.filter(r => cat(r) === 'performance_scorecard').length,
    adjusted: today.filter(r => cat(r) === 'scorecard_adjusted').length,
    efficiency: today.filter(r => cat(r) === 'efficiency_signal').length,
  };
  counts.inputs = counts.retros + counts.toolGaps + counts.scorecards + counts.adjusted + counts.efficiency;
  counts.scanned = today.length;
  counts.pagesScanned = scan.pages;
  counts.scanTruncated = scan.truncated;

  const metrics = {
    failureModes: failures.length,
    strongPatterns: patterns.workedAspects.length + patterns.repeatedStrengths.length,
    costOutliers: cost.projectOutliers.length,
    toolGaps: counts.toolGaps,
  };
  const deltaInfo = delta(metrics, prev);

  const body = renderBody({ date: TARGET_DATE, failures, patterns, cost, deltaInfo, counts, wcbLine });

  const title = `synthesis/${TARGET_DATE}`;
  const metadata = {
    category: 'synthesis',
    auto_accepted: true,
    date: TARGET_DATE,
    generated_by: 'sgi-loop-e',
    generated_at: new Date().toISOString(),
    metrics,
    inputs: counts,
    failure_modes: failures.slice(0, 60).map(f => ({ label: f.label, count: f.count, recurring: f.recurring })),
    cost_outliers: cost.projectOutliers,
    prev_synthesis_date: deltaInfo.prevDate || null,
    // AUR-5168 AC4: the same 7d work-class split the admission gate reads.
    work_class_budget: workClassBudget,
  };

  if (DRY_RUN) {
    console.log(`--- DRY RUN: ${title} ---\n`);
    console.log(body);
    console.log('\n--- metadata ---\n' + JSON.stringify(metadata, null, 2));
    return { dryRun: true, title, metrics };
  }

  const captured = await captureSynthesis(title, body, metadata);
  const recordId = captured && captured.record && captured.record.id;

  // Capture is insert-only, so a re-run (backfill, retry after a failed
  // heartbeat) would leave two live records for the same day and the board
  // would not know which one is canonical. `synthesis` is agent-mutable
  // (AUR-3072), so retire our own earlier copies of this exact title.
  const superseded = [];
  for (const r of all) {
    if (r.title !== title || !r.id || r.id === recordId || cat(r) !== 'synthesis') continue;
    try {
      await apiFetch(`/api/companies/${COMPANY_ID}/memory/records/${r.id}/revoke-own`, {
        method: 'POST',
        body: JSON.stringify({ reason: `superseded by a later ${title} synthesis run` }),
      });
      superseded.push(r.id);
    } catch (err) {
      console.error(`[loop-e] could not revoke superseded ${r.id}: ${err.message}`);
    }
  }

  if (TASK_ID) {
    const link = recordId ? ` (memory record \`${recordId}\`)` : '';
    await postComment(TASK_ID, `## SGI Loop E — Nightly Cross-Project Synthesis\n\nWrote \`${title}\`${link}, category \`synthesis\` (auto-accepted).\n\n- Recurring failure modes: **${metrics.failureModes}**\n- Strong patterns: **${metrics.strongPatterns}**\n- Cost outlier projects: **${metrics.costOutliers}**\n- Inputs synthesized: ${counts.inputs} (${counts.retros} retro · ${counts.toolGaps} tool-gap · ${counts.scorecards} scorecard · ${counts.adjusted} cost-adjusted)${wcbLine ? `\n- ${wcbLine}` : ''}\n- Delta basis: ${deltaInfo.prevDate ? `prior synthesis ${deltaInfo.prevDate}` : 'baseline (no prior synthesis)'}\n\n<details><summary>Synthesis record</summary>\n\n${body}\n</details>`);
  }

  return { title, recordId, supersededRecordIds: superseded, metrics, counts };
}

main().then(result => {
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
}).catch(err => {
  console.error('SGI Loop E error:', err.message);
  process.exit(1);
});
