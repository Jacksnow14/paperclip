#!/usr/bin/env node
/**
 * SGI Loop H — Experiment Watchdog (nightly 02:30 UTC, routine 556eb4c3)
 *
 * Canonical, committed runner for the experiment lifecycle defined in CTO
 * AGENTS.md § "SGI Loop H — Experiment Framework", Routine 2. Experiments live
 * as memory records (category `experiment`, auto-accepted, project-scoped);
 * conclusions as `experiment_conclusion` (same scope).
 *
 * State machine:
 *   proposed --board approves--> approved --watchdog (1/agent ok)--> running
 *   running --no isolation key (AUR-3202)-----------------------> needs_scope (blocked; never adopted/rejected)
 *   running --cap mis-set (budget_cap < horizon×p95) ------------> recalibrate to ceil(reachable×1.5), stay running
 *   running --horizon_tasks reached (in-scope only)--------------> measured --delta>=expected--> adopted (Loop C issue)
 *                                                                              --delta<expected--> rejected
 *   running --budget_cap exceeded (post cap-sanity, horizon not yet reached)-> rejected
 *
 * Per fire:
 *   1. Fetch `experiment/` records project-scoped (projectId=593af91d-6e65-…),
 *      keep category=="experiment".
 *   2. ACTIVATE approved->running: requires an accepted board_approval_id and
 *      enforces 1 running experiment per target_agent_id (else leaves
 *      approved, notes contention).
 *   3. SELF-MODIFICATION GUARDRAIL: change_type=="experiment_framework" ->
 *      rejected + conclusion(rejection_reason="self_modification_blocked").
 *      No self-experiment.
 *   4. MEASURE running (gate order, AUR-3202/AUR-2471):
 *      (0) Scope gate FIRST — validateExperimentScope via the canonical
 *          scripts/sgi-loop-h-experiment-scope.mjs helper. No isolation key
 *          (task_type/target_routine/scope_selector) -> status: needs_scope,
 *          skip every gate below, never compute measured_delta.
 *      (a) Cap-sanity guard — if budget_cap_tokens is unset or below the
 *          reachable-horizon cost (horizon × p95_per_task_cost), recalibrate
 *          to ceil(reachable × 1.5) and keep status=running (never reject on
 *          a mis-set cap).
 *      (b) Horizon-first — tasks_measured (in-scope only) >= horizon_tasks ->
 *          measured (+ measured_delta vs isolation-scoped baseline). Wins
 *          over the budget ceiling.
 *      (c) Runaway ceiling — only if horizon not yet reached: tokens_spent
 *          (in-scope only) >= budget_cap_tokens -> rejected (budget_exceeded).
 *   5. ADOPT/REJECT measured: delta>=expected -> Loop C self-edit issue,
 *      status: adopted, conclusion(adopted, loop_c_issue_id); else rejected
 *      (negative_result).
 *   6. Summary comment on the execution issue.
 *
 * Scope isolation logic (validateExperimentScope / measureExperimentScoped /
 * filterScorecardsByScope) is imported from scripts/sgi-loop-h-experiment-scope.mjs
 * — NOT reimplemented here, so both the Watchdog and any other caller share one
 * source of truth for attributable measurement (AUR-3202).
 *
 * Usage:
 *   node scripts/sgi-loop-h-experiment-watchdog.mjs            # advance + write
 *   node scripts/sgi-loop-h-experiment-watchdog.mjs --dry-run  # print only, no writes
 */

import {
  measureExperimentScoped,
  filterScorecardsByScope,
} from './sgi-loop-h-experiment-scope.mjs';

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NOW_ISO = new Date().toISOString();
const TODAY = NOW_ISO.slice(0, 10);

// Auranode SGI project — see CTO AGENTS.md § "SGI Loop H — Experiment Framework".
const PROJECT_ID = '593af91d-6e65-47fe-9db2-cd39469548f8';
const PARENT_ISSUE_ID = 'fc908e3a-51de-49b8-a910-f17a9d9adb53';
const SCAN_LIMIT = 200;
const DEFAULT_P95_PER_TASK_COST = 55000;
const RUNAWAY_SAFETY_FACTOR = 1.5;

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
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Page through every record under a title prefix (server-side filter, AUR-2900 fix verified live). */
async function fetchAllByPrefix(titlePrefix, extraQuery = '') {
  const out = [];
  for (let offset = 0; ; offset += SCAN_LIMIT) {
    const data = await apiFetch(
      `/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_LIMIT}&offset=${offset}&titlePrefix=${encodeURIComponent(titlePrefix)}${extraQuery}`,
    );
    if (data._notFound) break;
    const page = asArray(data, 'records');
    out.push(...page);
    if (page.length < SCAN_LIMIT) break;
    if (offset > 20000) break; // hard safety stop
  }
  return out;
}

/** Merge JSON content + metadata (metadata wins) so we read fields either way. */
export function fields(r) {
  let fromContent = {};
  if (typeof r.content === 'string' && r.content.trim().startsWith('{')) {
    try { fromContent = JSON.parse(r.content); } catch { /* not JSON */ }
  }
  return { ...fromContent, ...(r.metadata || {}) };
}
const cat = (r) => (r.metadata && r.metadata.category) || fields(r).category || '';

async function captureRecord(title, content, metadata) {
  const source = RUN_ID ? { kind: 'run', runId: RUN_ID }
    : (TASK_ID ? { kind: 'issue', issueId: TASK_ID } : { kind: 'manual_note' });
  return apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST',
    body: JSON.stringify({ title, content, metadata, scope: { projectId: PROJECT_ID }, source }),
  });
}

/** PATCH an experiment record's metadata (owning agent + allowlisted category). */
async function patchRecordMetadata(recordId, metadata) {
  return apiFetch(`/api/companies/${COMPANY_ID}/memory/records/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ metadata }),
  });
}

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

/** GET /approvals/:id — NOT /companies/:companyId/approvals/:id (that route doesn't exist). */
async function getApprovalStatus(approvalId) {
  if (!approvalId) return null;
  const data = await apiFetch(`/api/approvals/${approvalId}`);
  if (data._notFound) return null;
  return data && data.status || null;
}
const APPROVED = new Set(['approved', 'accepted']);

/** Parse "+12%" / "-5%" / "0.1" into a comparable numeric delta (percent units). */
export function parseDelta(v) {
  if (v == null) return null;
  const s = String(v).trim().replace('%', '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a target agent's raw scorecard records (performance_scorecard +
 * scorecard_adjusted) into baseline (before run_start_date) and period
 * (on/after run_start_date). Returns RAW records — isolation-scope filtering
 * happens downstream via the canonical scope helper, not here.
 */
export function scorecardsForAgent(allScorecards, agentId, runStartDate) {
  const period = [];
  const baseline = [];
  for (const r of allScorecards) {
    const f = fields(r);
    if (agentId && f.agent_id !== agentId) continue;
    const when = (r.createdAt || f.computed_at || '').slice(0, 10);
    if (!when) continue;
    (when >= runStartDate ? period : baseline).push(r);
  }
  return { period, baseline };
}

/** Average of the expected_metric over a set of flattened scorecard field objects. */
export function metricValue(metric, cards) {
  if (!cards.length) return null;
  if (metric === 'rework_rate') {
    const reworked = cards.filter(c => c.rework_required === true || c.rework_required === 'true').length;
    return reworked / cards.length; // lower is better
  }
  if (metric === 'token_efficiency') {
    const v = cards.reduce((s, c) => s + num(c.value_signal || c.quality_signal), 0);
    const t = cards.reduce((s, c) => s + num(c.token_cost), 0);
    return t > 0 ? v / (t / 1000) : null;
  }
  if (metric === 'routing_accuracy') {
    const ok = cards.filter(c => c.rework_required !== true && num(c.quality_signal) >= 4).length;
    return ok / cards.length;
  }
  // default: quality_signal (1..5), higher is better
  const q = cards.map(c => num(c.quality_signal)).filter(n => n > 0);
  return q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
}

/** Percent change from baseline → period, sign-oriented so "better" is positive. */
export function measuredDeltaPct(metric, baselineCards, periodCards) {
  const b = metricValue(metric, baselineCards);
  const p = metricValue(metric, periodCards);
  if (b == null || p == null) return { pct: null, base: b, period: p, note: 'insufficient data' };
  const lowerIsBetter = metric === 'rework_rate';
  let pct;
  if (b === 0) {
    pct = p === 0 ? 0 : (lowerIsBetter ? -100 : 100);
  } else {
    pct = ((p - b) / Math.abs(b)) * 100;
    if (lowerIsBetter) pct = -pct;
  }
  return { pct: Number(pct.toFixed(2)), base: Number(b.toFixed(4)), period: Number(p.toFixed(4)), note: null };
}

export function decideAdopt(measuredDeltaStr, expectedDeltaStr) {
  const measured = parseDelta(measuredDeltaStr);
  const expected = parseDelta(expectedDeltaStr);
  return measured != null && expected != null && measured >= expected;
}

/**
 * Pure MEASURE-step decision for one `running` experiment. No I/O — takes the
 * raw scorecard records already split into period/baseline (see
 * `scorecardsForAgent`) and returns the gate outcome. This is the unit the
 * gate-order tests exercise directly.
 *
 * Gate order (AUR-3202 scope gate FIRST, then AUR-2471 cap-sanity → horizon → budget):
 *   0) scope gate      -> { action: 'needs_scope', reason }
 *   a) cap-sanity       -> recalibration attached to whichever action follows
 *   b) horizon-first    -> { action: 'measured', ... }               (wins over budget)
 *   c) runaway ceiling  -> { action: 'rejected_budget', ... }         (only if horizon not reached)
 *   else                -> { action: 'accruing', ... }
 */
export function measureExperiment(record, periodScorecards, baselineScorecards) {
  const m = record.metadata || {};

  // (0) Scope gate — FIRST. An unattributable experiment is never measured,
  // adopted, or rejected — it is parked, full stop.
  const scoped = measureExperimentScoped(record, periodScorecards);
  if (scoped.status === 'needs_scope') {
    return { action: 'needs_scope', reason: scoped.reason, recalibration: null };
  }

  const horizon = num(m.horizon_tasks) || 20;
  const p95PerTask = num(m.p95_per_task_cost) || DEFAULT_P95_PER_TASK_COST;
  const reachable = horizon * p95PerTask;
  let budgetCap = num(m.budget_cap_tokens);
  let recalibration = null;

  // (a) Cap-sanity guard — run first. Never reject on a mis-set cap; recalibrate
  // and keep the experiment running so it can reach its horizon (AUR-2471).
  if (budgetCap === 0 || budgetCap < reachable) {
    const newCap = Math.ceil(reachable * RUNAWAY_SAFETY_FACTOR);
    recalibration = { oldCap: budgetCap, newCap, reachable, p95PerTask };
    budgetCap = newCap;
  }

  const tasksMeasured = scoped.tasksMeasured;
  const tokensSpent = scoped.tokensSpent;

  // (b) Horizon check — wins over budget, regardless of token spend.
  if (tasksMeasured >= horizon) {
    const baselineScoped = filterScorecardsByScope(baselineScorecards, record);
    const periodFields = scoped.scopedScorecards.map(fields);
    const baselineFields = baselineScoped.map(fields);
    const delta = measuredDeltaPct(m.expected_metric || 'quality_signal', baselineFields, periodFields);
    return {
      action: 'measured', recalibration, isolation: scoped.isolation,
      tasksMeasured, tokensSpent, delta,
    };
  }

  // (c) Runaway ceiling — only reached if the horizon has NOT been reached; the
  // cap is guaranteed >= reachable by (a), so this only fires for genuine runaways.
  if (tokensSpent >= budgetCap) {
    return { action: 'rejected_budget', recalibration, isolation: scoped.isolation, tasksMeasured, tokensSpent, budgetCap };
  }

  return { action: 'accruing', recalibration, isolation: scoped.isolation, tasksMeasured, tokensSpent, horizon, budgetCap };
}

async function writeConclusion(exp, status, rejectionReason, extra = {}) {
  const m = exp.metadata;
  const id = m.id || exp.id;
  const content = status === 'adopted'
    ? `Experiment ${id} adopted: ${m.hypothesis || ''} (measured ${m.measured_delta ?? '?'} vs expected ${m.expected_delta ?? '?'}).`
    : `Experiment ${id} rejected (${rejectionReason}): ${m.hypothesis || ''}.`;
  const metadata = {
    category: 'experiment_conclusion', auto_accepted: true,
    experiment_id: id, status,
    hypothesis: m.hypothesis || null, change: m.change || null,
    change_type: m.change_type || null,
    measured_delta: m.measured_delta ?? extra.measured_delta ?? null,
    expected_delta: m.expected_delta ?? null,
    target_agent_id: m.target_agent_id || null,
    loop_c_issue_id: extra.loop_c_issue_id || null,
    rejection_reason: rejectionReason || null,
    concluded_at: NOW_ISO, generated_by: 'sgi-loop-h',
  };
  if (DRY_RUN) return { title: `experiment-conclusions/${id}`, dryRun: true };
  return captureRecord(`experiment-conclusions/${id}`, content, metadata);
}

/** Create a Loop C self-edit issue carrying the adopted prompt change. */
async function createLoopCIssue(exp) {
  const m = exp.metadata;
  const id = m.id || exp.id;
  const target = m.target_agent_id || AGENT_ID;
  const description = [
    '## Prompt self-edit — adopted SGI Loop H experiment',
    '',
    `**Experiment:** \`${id}\``,
    `**Hypothesis:** ${m.hypothesis || '—'}`,
    `**Adopted change:** ${m.change || '—'}`,
    `**Change type:** ${m.change_type || '—'}`,
    `**Metric:** ${m.expected_metric || '—'} — measured **${m.measured_delta ?? '?'}** vs expected **${m.expected_delta ?? '?'}**`,
    '',
    '---',
    '',
    'This experiment met its expected delta over its horizon. Carry the change into',
    'your `AGENTS.md` through the standard Loop C prompt-improvement flow:',
    '',
    '1. Read your `AGENTS.md` (your `instructions-path` file).',
    `2. Identify the section governing the experiment's change (\`${m.change_type || 'prompt_edit'}\`).`,
    `3. POST a \`prompt-improvement-proposal/${target}/{YYYY-MM-DD}\` memory record citing experiment \`${id}\`.`,
    '4. POST a `request_board_approval` linking this issue.',
    '5. Set this issue `in_review`, assigned to CEO.',
    '',
    '**Safety boundary:** propose edits to YOUR file ONLY. The board approves the actual change.',
  ].join('\n');

  const payload = {
    title: `Prompt self-edit required — ${target} / experiment ${id}`,
    description,
    assigneeAgentId: target,
    projectId: PROJECT_ID,
    parentId: PARENT_ISSUE_ID,
    priority: 'high',
  };
  if (DRY_RUN) return { identifier: '(dry-run)', id: null };
  const res = await apiFetch(`/api/companies/${COMPANY_ID}/issues`, { method: 'POST', body: JSON.stringify(payload) });
  const iss = res.issue || res;
  return { identifier: iss.identifier || iss.id, id: iss.id };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  // 1) Fetch experiments PROJECT-SCOPED (AUR-3266 requirement #1) — an
  // org-wide query sees 0 experiments (they're captured scope:{projectId}).
  const experiments = (await fetchAllByPrefix('experiment/', `&projectId=${PROJECT_ID}`))
    .filter(r => cat(r) === 'experiment');
  const conclusionRecords = (await fetchAllByPrefix('experiment-conclusions/', `&projectId=${PROJECT_ID}`))
    .filter(r => cat(r) === 'experiment_conclusion');
  // Scorecards are agent-scoped, not project-scoped — fetch org-wide.
  const perfScorecards = await fetchAllByPrefix('performance/');
  const adjScorecards = await fetchAllByPrefix('scorecard-adjusted/');
  const allScorecards = [...perfScorecards, ...adjScorecards];

  // Conclusions already written (dedup guard so we never double-conclude).
  const concludedIds = new Set(conclusionRecords.map(r => fields(r).experiment_id).filter(Boolean));

  const summary = { activated: [], contention: [], blocked: [], recalibrated: [], needsScope: [], measured: [], adopted: [], rejected: [], skipped: [] };

  // Normalize a working metadata object onto each experiment for convenience.
  for (const e of experiments) e.metadata = { ...(e.metadata || {}), ...fields(e) };

  // Running set per target agent (for 1-per-agent enforcement). Seed with what's
  // already running so a fresh activation respects the cap.
  const runningByAgent = new Map();
  for (const e of experiments) {
    if (e.metadata.status === 'running' && e.metadata.target_agent_id) {
      runningByAgent.set(e.metadata.target_agent_id, (runningByAgent.get(e.metadata.target_agent_id) || 0) + 1);
    }
  }

  // 2) SELF-MODIFICATION GUARDRAIL — never let the framework experiment on itself.
  for (const e of experiments) {
    const m = e.metadata;
    if (m.change_type === 'experiment_framework' && m.status !== 'rejected') {
      if (!DRY_RUN) await patchRecordMetadata(e.id, { ...m, status: 'rejected', rejected_at: NOW_ISO });
      if (!concludedIds.has(m.id || e.id)) await writeConclusion(e, 'rejected', 'self_modification_blocked');
      m.status = 'rejected';
      summary.rejected.push({ id: m.id || e.id, reason: 'self_modification_blocked' });
    }
  }

  // 3) ACTIVATE approved -> running (accepted approval + 1-per-agent).
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'approved') continue;
    const status = await getApprovalStatus(m.board_approval_id);
    if (!m.board_approval_id || !APPROVED.has(String(status || '').toLowerCase())) {
      summary.blocked.push({ id: m.id || e.id, reason: `approval ${status || 'missing'}` });
      continue;
    }
    const agent = m.target_agent_id || '(unassigned)';
    if (m.target_agent_id && (runningByAgent.get(m.target_agent_id) || 0) >= 1) {
      summary.contention.push({ id: m.id || e.id, agent });
      continue;
    }
    const next = { ...m, status: 'running', run_start_date: TODAY, tasks_measured: 0, tokens_spent: 0, activated_at: NOW_ISO };
    if (!DRY_RUN) await patchRecordMetadata(e.id, next);
    e.metadata = next;
    if (m.target_agent_id) runningByAgent.set(m.target_agent_id, (runningByAgent.get(m.target_agent_id) || 0) + 1);
    summary.activated.push({ id: m.id || e.id, agent });
  }

  // 4) MEASURE running experiments — scope gate FIRST, then cap-sanity → horizon → budget.
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'running') continue;

    const { period, baseline } = scorecardsForAgent(allScorecards, m.target_agent_id, m.run_start_date || TODAY);
    const result = measureExperiment(e, period, baseline);

    if (result.action === 'needs_scope') {
      const next = { ...m, status: 'needs_scope', needs_scope_reason: result.reason, needs_scope_at: NOW_ISO };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      summary.needsScope.push({ id: m.id || e.id, reason: result.reason });
      continue;
    }

    if (result.recalibration) {
      summary.recalibrated.push({ id: m.id || e.id, ...result.recalibration });
    }

    if (result.action === 'measured') {
      const d = result.delta;
      const measuredStr = d.pct == null ? null : `${d.pct >= 0 ? '+' : ''}${d.pct}%`;
      const next = {
        ...m,
        status: 'measured',
        tasks_measured: result.tasksMeasured, tokens_spent: result.tokensSpent,
        measured_delta: measuredStr, measured_at: NOW_ISO,
        ...(result.recalibration ? { budget_cap_tokens: result.recalibration.newCap, p95_per_task_cost: result.recalibration.p95PerTask } : {}),
      };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      summary.measured.push({ id: m.id || e.id, measured: measuredStr, expected: m.expected_delta, base: d.base, period: d.period });
      continue;
    }

    if (result.action === 'rejected_budget') {
      const next = {
        ...m, status: 'rejected',
        tasks_measured: result.tasksMeasured, tokens_spent: result.tokensSpent, rejected_at: NOW_ISO,
        ...(result.recalibration ? { budget_cap_tokens: result.recalibration.newCap, p95_per_task_cost: result.recalibration.p95PerTask } : {}),
      };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      if (!concludedIds.has(m.id || e.id)) await writeConclusion(e, 'rejected', 'budget_exceeded');
      summary.rejected.push({ id: m.id || e.id, reason: 'budget_exceeded', tokensSpent: result.tokensSpent, budgetCap: result.budgetCap });
      continue;
    }

    // Still accruing — persist progress counters (+ any recalibration) only.
    const next = {
      ...m,
      tasks_measured: result.tasksMeasured, tokens_spent: result.tokensSpent,
      ...(result.recalibration ? { budget_cap_tokens: result.recalibration.newCap, p95_per_task_cost: result.recalibration.p95PerTask } : {}),
    };
    if (!DRY_RUN) await patchRecordMetadata(e.id, next);
    e.metadata = next;
    summary.skipped.push({ id: m.id || e.id, reason: `accruing ${result.tasksMeasured}/${result.horizon} tasks` });
  }

  // 5) ADOPT / REJECT measured experiments.
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'measured') continue;
    if (decideAdopt(m.measured_delta, m.expected_delta)) {
      const issue = await createLoopCIssue(e);
      const next = { ...m, status: 'adopted', adopted_at: NOW_ISO, loop_c_issue_id: issue.id || issue.identifier };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      if (!concludedIds.has(m.id || e.id)) await writeConclusion(e, 'adopted', null, { loop_c_issue_id: issue.id || issue.identifier });
      summary.adopted.push({ id: m.id || e.id, loopCIssue: issue.identifier, measured: m.measured_delta, expected: m.expected_delta });
    } else {
      const next = { ...m, status: 'rejected', rejected_at: NOW_ISO };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      if (!concludedIds.has(m.id || e.id)) await writeConclusion(e, 'rejected', 'negative_result');
      summary.rejected.push({ id: m.id || e.id, reason: 'negative_result', measured: m.measured_delta, expected: m.expected_delta });
    }
  }

  // 6) Summary comment on the execution issue.
  const counts = {
    total: experiments.length,
    activated: summary.activated.length,
    contention: summary.contention.length,
    blocked: summary.blocked.length,
    recalibrated: summary.recalibrated.length,
    needsScope: summary.needsScope.length,
    measured: summary.measured.length,
    adopted: summary.adopted.length,
    rejected: summary.rejected.length,
  };

  if (TASK_ID && !DRY_RUN) {
    const lines = [];
    lines.push(`## SGI Loop H — Experiment Watchdog (${TODAY})`);
    lines.push('');
    if (!experiments.length) {
      lines.push('**No experiment records in the pipeline** (project-scoped query) — nothing to activate, measure, or conclude. Steady-state no-op.');
      lines.push('');
      lines.push('_The Hypothesis Drafter (Routine 1) seeds `experiment/{id}` records from weekly synthesis signal; until it drafts and the board approves one, the watchdog has no work._');
    } else {
      lines.push(`Processed **${counts.total}** experiment(s): ` +
        `**${counts.activated}** activated, **${counts.measured}** measured, **${counts.adopted}** adopted, **${counts.rejected}** rejected` +
        (counts.needsScope ? `, **${counts.needsScope}** parked needs_scope` : '') +
        (counts.contention ? `, **${counts.contention}** held (1-per-agent contention)` : '') +
        (counts.blocked ? `, **${counts.blocked}** awaiting board approval` : '') + '.');
      const fmt = (arr, f) => arr.map(f).join('\n');
      if (summary.activated.length) lines.push('\n**Activated (→ running):**\n' + fmt(summary.activated, a => `- \`${a.id}\` (agent ${a.agent})`));
      if (summary.needsScope.length) lines.push('\n**Parked (needs_scope — AUR-3202):**\n' + fmt(summary.needsScope, a => `- \`${a.id}\` — ${a.reason}`));
      if (summary.recalibrated.length) lines.push('\n**Cap recalibrated (kept running):**\n' + fmt(summary.recalibrated, a => `- \`${a.id}\` — budget_cap_tokens ${a.oldCap || '(unset)'} → ${a.newCap} (reachable=${a.reachable}, p95=${a.p95PerTask})`));
      if (summary.measured.length) lines.push('\n**Measured:**\n' + fmt(summary.measured, a => `- \`${a.id}\` measured ${a.measured ?? '?'} vs expected ${a.expected ?? '?'} (baseline ${a.base}, period ${a.period})`));
      if (summary.adopted.length) lines.push('\n**Adopted (→ Loop C):**\n' + fmt(summary.adopted, a => `- \`${a.id}\` → ${a.loopCIssue} (${a.measured} ≥ ${a.expected})`));
      if (summary.rejected.length) lines.push('\n**Rejected:**\n' + fmt(summary.rejected, a => `- \`${a.id}\` — ${a.reason}${a.measured ? ` (${a.measured} < ${a.expected})` : ''}`));
      if (summary.contention.length) lines.push('\n**Held (1-per-agent):**\n' + fmt(summary.contention, a => `- \`${a.id}\` (agent ${a.agent} already has a running experiment)`));
      if (summary.blocked.length) lines.push('\n**Awaiting board approval:**\n' + fmt(summary.blocked, a => `- \`${a.id}\` — ${a.reason}`));
    }
    await postComment(TASK_ID, lines.join('\n'));
  }

  return { date: TODAY, dryRun: DRY_RUN, counts, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(result => {
    console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
  }).catch(err => {
    console.error('SGI Loop H error:', err.message);
    process.exit(1);
  });
}
