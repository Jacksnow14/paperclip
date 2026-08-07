#!/usr/bin/env node
/**
 * SGI Loop H — Experiment Watchdog (nightly 02:30 UTC, routine 556eb4c3)
 *
 * Canonical, committed runner for the experiment lifecycle defined in CTO
 * AGENTS.md § "SGI Loop H — Experiment Framework", Routine 2. Experiments live
 * as memory records (category `experiment`, auto-accepted, project-scoped);
 * conclusions as `experiment_conclusion` (same scope).
 *
 * --- Arming: gate verdict, not a board row (AUR-5354) -----------------------
 * Loop H used to send every hypothesis to the board. Two of those rows sat in
 * the queue for 8 and 24 days asking the founder to approve *prompt edits to
 * agent instructions* — not a founder decision, and the fleet already has a
 * stronger answer for it in scripts/prompt-edit-gate.mjs (bounded diff + blind
 * A/B replay). A fleet-internal experiment (routing / prompt_edit / threshold /
 * agent_assignment) now arms on an ACCEPTED gate verdict; only a genuine
 * founder decision — money, credentials, legal, irreversible — still routes to
 * the board. See scripts/sgi-loop-h-approval-route.mjs for the rule.
 *
 * State machine:
 *   proposed --gate ACCEPTED--> approved  --watchdog (1/agent ok)--> running
 *   proposed --gate REJECTED--> rejected + conclusion(gate_rejected)
 *   proposed --gate-routed, no verdict--> needs_gate (one gate-run issue filed)
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
 *   3b. PENDING-APPROVAL SWEEP (AUR-4124, doctrine step 2b) — every
 *       status:"proposed" record, invisible to every step above, is swept
 *       after activation: reconcile an already-resolved board_approval_id
 *       (approved -> approved / rejected -> rejected + conclusion), surface a
 *       missing board_approval_id as "unapproved", or age a still-pending
 *       approval and escalate once at 7d (board request_confirmation on this
 *       routine's OWN execution issue) and once more at 14d (founder
 *       Telegram), both guarded by metadata fields so a second run is a
 *       silent no-op. Never self-approves (guardrail #6) — only makes a
 *       stall loud.
 *   5. ADOPT/REJECT measured: delta>=expected -> Loop C self-edit issue,
 *      status: adopted, conclusion(adopted, loop_c_issue_id); else rejected
 *      (negative_result).
 *   6. Summary comment on the execution issue — always carries a
 *      "Pending board approval: N" line, even at zero (AUR-4124).
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

import { execFile } from 'node:child_process';

import {
  measureExperimentScoped,
  filterScorecardsByScope,
} from './sgi-loop-h-experiment-scope.mjs';
import {
  routeForExperiment,
  decideGateArming,
  decideActivationCredential,
} from './sgi-loop-h-approval-route.mjs';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

let API_URL = '';
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
async function getApproval(approvalId) {
  if (!approvalId) return null;
  const data = await apiFetch(`/api/approvals/${approvalId}`);
  if (data._notFound) return null;
  return data || null;
}
async function getApprovalStatus(approvalId) {
  const approval = await getApproval(approvalId);
  return (approval && approval.status) || null;
}
const APPROVED = new Set(['approved', 'accepted']);
const REJECTED = new Set(['rejected', 'denied']);

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
 * Pure decision for one `status: "proposed"` record's stale-approval sweep
 * (AUR-4124, doctrine step 2b). No I/O — takes the already-fetched approval
 * status/createdAt so this is unit-testable without a live API.
 *
 *   no board_approval_id                          -> unapproved
 *   approval accepted (APPROVED set)               -> reconcile_approved
 *   approval denied/rejected (REJECTED set)        -> reconcile_rejected
 *   still pending, age>=14d, no founder guard set  -> founder_alert
 *   still pending, age>=7d,  no escalate guard set -> escalate
 *   still pending, otherwise                       -> pending (silent, counted)
 */
export function decideStaleApproval(record, approvalStatus, approvalCreatedAt, todayIso) {
  const m = record.metadata || {};
  if (!m.board_approval_id) {
    return { action: 'unapproved', ageDays: null, reason: 'missing board_approval_id' };
  }
  const status = String(approvalStatus || '').toLowerCase();
  if (APPROVED.has(status)) {
    return { action: 'reconcile_approved', ageDays: null, reason: `approval ${status}` };
  }
  if (REJECTED.has(status)) {
    return { action: 'reconcile_rejected', ageDays: null, reason: `approval ${status}` };
  }
  const rawAge = Math.floor((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(approvalCreatedAt)) / 86400000);
  const ageDays = Number.isFinite(rawAge) ? Math.max(0, rawAge) : 0;
  if (ageDays >= 14 && !m.stale_founder_alerted_at) {
    return { action: 'founder_alert', ageDays, reason: `pending ${ageDays}d (>=14d threshold)` };
  }
  if (ageDays >= 7 && !m.stale_escalated_at) {
    return { action: 'escalate', ageDays, reason: `pending ${ageDays}d (>=7d threshold)` };
  }
  return { action: 'pending', ageDays, reason: `pending ${ageDays}d` };
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

/**
 * Ask the target agent to run the prompt-edit gate for a gate-routed
 * experiment (AUR-5354). This is the liveness path that replaces the board
 * row: without it a gate-routed hypothesis would park forever waiting for a
 * verdict nobody was asked to produce. Filed at most once per experiment —
 * the caller stamps `gate_issue_id` on success and never files again.
 */
async function createGateIssue(exp) {
  const m = exp.metadata;
  const id = m.id || exp.id;
  const target = m.target_agent_id || AGENT_ID;
  const description = [
    '## Run the prompt-edit gate — SGI Loop H experiment',
    '',
    `**Experiment:** \`${id}\``,
    `**Hypothesis:** ${m.hypothesis || '—'}`,
    `**Proposed change:** ${m.change || '—'}`,
    `**Change type:** ${m.change_type || '—'}`,
    `**Metric:** ${m.expected_metric || 'quality_signal'} — expected **${m.expected_delta || '+10%'}**`,
    '',
    '---',
    '',
    'This experiment is fleet-internal, so it arms on a **measured gate verdict**,',
    'not a board approval (AUR-5354). Produce the edit and let the gate judge it:',
    '',
    '1. Read your `AGENTS.md` (your agent `instructionsFilePath`).',
    '2. Write a **bounded** proposed version implementing the change above to a',
    '   scratch file — ≤60 changed lines and ≤35% of the file, or the gate rejects',
    '   it before spending a token.',
    '3. Run the gate:',
    '   ```',
    `   node scripts/prompt-edit-gate.mjs --agent-id ${target} --proposed /tmp/proposed-AGENTS.md`,
    '   ```',
    '4. Stamp the printed `diffHash` onto the experiment record so the watchdog can',
    '   find your verdict:',
    '   ```',
    `   PATCH /api/companies/{companyId}/memory/records/${exp.id}`,
    '   { "metadata": { "gate_diff_hash": "<diffHash from the gate output>" } }',
    '   ```',
    '',
    'On an **ACCEPTED** verdict the nightly watchdog arms the experiment to `running`',
    'by itself. On **REJECTED** it concludes the experiment — do not re-propose the',
    'same diff, the gate refuses repeats.',
    '',
    '**Do not file a board approval for this.** The board only decides money,',
    'credentials, legal, and irreversible changes.',
  ].join('\n');

  const payload = {
    title: `Run the prompt-edit gate — ${m.change_type || 'prompt_edit'} experiment ${id}`,
    description,
    assigneeAgentId: target,
    projectId: PROJECT_ID,
    parentId: PARENT_ISSUE_ID,
    priority: 'medium',
  };
  if (DRY_RUN) return { identifier: '(dry-run)', id: null };
  try {
    const res = await apiFetch(`/api/companies/${COMPANY_ID}/issues`, { method: 'POST', body: JSON.stringify(payload) });
    const iss = res.issue || res;
    return { identifier: iss.identifier || iss.id, id: iss.id };
  } catch (err) {
    console.error(`createGateIssue failed for ${id}:`, err.message);
    return null;
  }
}

/**
 * File the 7d escalation for a stale-pending approval as a
 * request_confirmation interaction on the routine's OWN execution issue —
 * never the CEO-owned parent issue (it 403s on any write, AUR-4124). Returns
 * true only on a genuine write (or a dry-run no-op) so the caller only
 * stamps `stale_escalated_at` on success; a failed write must retry next run.
 */
async function escalateStaleApproval(e, ageDays) {
  const m = e.metadata;
  const id = m.id || e.id;
  if (!TASK_ID) return false;
  if (DRY_RUN) return true;
  const body = `Board approval \`${m.board_approval_id}\` for experiment \`${id}\` has been pending ${ageDays}d ` +
    `with no board decision. Hypothesis: ${m.hypothesis || '—'}. Target agent: ${m.target_agent_id || '—'}. ` +
    'Please resolve (approve/reject) in the board approvals queue.';
  try {
    await apiFetch(`/api/issues/${TASK_ID}/interactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'request_confirmation',
        continuationPolicy: 'wake_assignee',
        idempotencyKey: `sgi-loop-h:stale-approval:${id}:${m.board_approval_id}`,
        payload: { version: 1, title: `Stale board approval — experiment ${id}`, prompt: body, body },
      }),
    });
    return true;
  } catch (err) {
    console.error(`escalateStaleApproval failed for ${id}:`, err.message);
    return false;
  }
}

/**
 * Founder-gated escalation for an approval stale >=14d (doctrine step 2b /
 * guardrail #8). Non-fatal by design: any failure — including the shared
 * fleet rate-limit — must never crash the routine, and a rate-limited send
 * must leave `stale_founder_alerted_at` unset so the next run retries.
 */
async function founderAlertStaleApproval(e, ageDays) {
  const m = e.metadata;
  const id = m.id || e.id;
  if (DRY_RUN) return true;
  const message = `Board approval stale ${ageDays}d — experiment ${id} (issue ${TASK_ID || '?'}). Please resolve.`;
  try {
    const result = await new Promise((resolve) => {
      execFile('/home/ievgen/bot/notify_founder.sh', [message], (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    if (result.err) {
      console.error(`founderAlertStaleApproval failed for ${id}:`, result.err.message);
      return false;
    }
    if (/blocked:\s*rate-limit/i.test(`${result.stdout}\n${result.stderr}`)) {
      console.error(`founderAlertStaleApproval rate-limited for ${id}, will retry next run`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`founderAlertStaleApproval failed for ${id}:`, err.message);
    return false;
  }
}

// ---- Main ------------------------------------------------------------------

async function main() {
  API_URL = await resolveApiBase();
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
  // Prompt-edit gate verdicts (AUR-5354) — the arming credential for every
  // fleet-internal experiment. Written org-wide by scripts/prompt-edit-gate.mjs.
  const gateVerdicts = (await fetchAllByPrefix('prompt-edit-verdict/'))
    .filter(r => fields(r).kind === 'prompt_edit_verdict');

  // Conclusions already written (dedup guard so we never double-conclude).
  const concludedIds = new Set(conclusionRecords.map(r => fields(r).experiment_id).filter(Boolean));

  const summary = { activated: [], contention: [], blocked: [], recalibrated: [], needsScope: [], measured: [], adopted: [], rejected: [], skipped: [] };
  const gate = { armed: [], rejected: [], requested: [], awaiting: [] };

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

  // 2b) ARM gate-routed experiments (AUR-5354). A fleet-internal experiment is
  // armed by an ACCEPTED prompt-edit-gate verdict, never by a board row. Runs
  // before ACTIVATE so a verdict that landed since the last fire arms AND
  // activates in the same pass.
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'proposed' && m.status !== 'needs_gate') continue;
    if (routeForExperiment(e).route !== 'gate') continue;
    const id = m.id || e.id;
    const decision = decideGateArming(e, gateVerdicts);

    if (decision.action === 'arm') {
      const next = { ...m, status: 'approved', armed_by: 'prompt_edit_gate', gate_verdict_record_id: decision.verdictRecordId, armed_at: NOW_ISO };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      gate.armed.push({ id, reason: decision.reason });
      continue;
    }

    if (decision.action === 'reject') {
      const next = { ...m, status: 'rejected', rejected_at: NOW_ISO };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      if (!concludedIds.has(id)) await writeConclusion(e, 'rejected', 'gate_rejected');
      gate.rejected.push({ id, reason: decision.reason });
      summary.rejected.push({ id, reason: 'gate_rejected' });
      continue;
    }

    if (decision.action === 'needs_gate') {
      const issue = await createGateIssue(e);
      if (issue) {
        const next = { ...m, status: 'needs_gate', gate_issue_id: issue.id || issue.identifier, gate_requested_at: NOW_ISO };
        if (!DRY_RUN) await patchRecordMetadata(e.id, next);
        e.metadata = next;
        gate.requested.push({ id, issue: issue.identifier });
      }
      continue;
    }

    // awaiting_gate — a gate run is already requested; stay parked, stay counted.
    if (m.status !== 'needs_gate') {
      const next = { ...m, status: 'needs_gate' };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
    }
    gate.awaiting.push({ id, reason: decision.reason });
  }

  // 3) ACTIVATE approved -> running (arming credential + 1-per-agent).
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'approved') continue;
    // Only a board-routed experiment needs an approval lookup; a gate-armed one
    // must not be held for a board row that will never be filed.
    const status = m.armed_by === 'prompt_edit_gate' ? null : await getApprovalStatus(m.board_approval_id);
    const credential = decideActivationCredential(e, status);
    if (!credential.ok) {
      summary.blocked.push({ id: m.id || e.id, reason: credential.reason });
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

  // 3b) PENDING-APPROVAL SWEEP (AUR-4124, doctrine step 2b) — a "proposed"
  // record is invisible to every step above; this is the liveness gate.
  const pendingApproval = {
    reconciledApproved: [], reconciledRejected: [], unapproved: [],
    escalated: [], founderAlerted: [], pending: [], details: [],
  };
  for (const e of experiments) {
    const m = e.metadata;
    if (m.status !== 'proposed') continue;
    // Gate-routed rows were handled in 2b — never age, escalate, or founder-alert
    // a board approval for a change the board should not have been asked about
    // (AUR-5354). This is what kept two prompt-edit rows in the queue for 8 and 24 days.
    if (routeForExperiment(e).route !== 'board') continue;
    const id = m.id || e.id;

    const approval = m.board_approval_id ? await getApproval(m.board_approval_id) : null;
    const decision = decideStaleApproval(e, approval && approval.status, approval && approval.createdAt, TODAY);

    if (decision.action === 'reconcile_approved') {
      const next = { ...m, status: 'approved' };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      pendingApproval.reconciledApproved.push({ id, approvalId: m.board_approval_id });
      continue;
    }

    if (decision.action === 'reconcile_rejected') {
      const next = { ...m, status: 'rejected', rejected_at: NOW_ISO };
      if (!DRY_RUN) await patchRecordMetadata(e.id, next);
      e.metadata = next;
      if (!concludedIds.has(id)) await writeConclusion(e, 'rejected', 'board_rejected');
      pendingApproval.reconciledRejected.push({ id, approvalId: m.board_approval_id });
      continue;
    }

    // Still proposed after this run — always counted toward the mandatory
    // pending-approval line, whichever of unapproved/escalate/founder_alert/pending it is.
    pendingApproval.details.push({ id, approvalId: m.board_approval_id || null, ageDays: decision.ageDays });

    if (decision.action === 'unapproved') {
      pendingApproval.unapproved.push({ id });
      continue;
    }

    if (decision.action === 'escalate' || decision.action === 'founder_alert') {
      if (!m.stale_escalated_at) {
        const ok = await escalateStaleApproval(e, decision.ageDays);
        if (ok) {
          const next = { ...e.metadata, stale_escalated_at: NOW_ISO };
          if (!DRY_RUN) await patchRecordMetadata(e.id, next);
          e.metadata = next;
          pendingApproval.escalated.push({ id, ageDays: decision.ageDays });
        }
      }
      if (decision.action === 'founder_alert') {
        const ok = await founderAlertStaleApproval(e, decision.ageDays);
        if (ok) {
          const next = { ...e.metadata, stale_founder_alerted_at: NOW_ISO };
          if (!DRY_RUN) await patchRecordMetadata(e.id, next);
          e.metadata = next;
          pendingApproval.founderAlerted.push({ id, ageDays: decision.ageDays });
        }
      }
      continue;
    }

    // decision.action === 'pending' — silent, but already counted in `details`.
    pendingApproval.pending.push({ id, ageDays: decision.ageDays });
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
    pendingApproval: pendingApproval.details.length,
    gateArmed: gate.armed.length,
    gateRejected: gate.rejected.length,
    gateRequested: gate.requested.length,
    gateAwaiting: gate.awaiting.length,
  };

  // Mandatory pending-approval line (AUR-4124) — "no stalls" must be an
  // affirmative signal, so this prints even at zero, in every branch below.
  const oldestPending = pendingApproval.details.reduce(
    (max, d) => (d.ageDays != null && (!max || d.ageDays > max.ageDays) ? d : max), null,
  );
  const pendingLine = oldestPending
    ? `Pending board approval: **${counts.pendingApproval}** proposed (oldest ${oldestPending.ageDays}d — ${oldestPending.id}/${oldestPending.approvalId || 'no-approval-id'}).`
    : `Pending board approval: **${counts.pendingApproval}**.`;

  if (TASK_ID && !DRY_RUN) {
    const lines = [];
    lines.push(`## SGI Loop H — Experiment Watchdog (${TODAY})`);
    lines.push('');
    const fmt = (arr, f) => arr.map(f).join('\n');
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
      if (summary.activated.length) lines.push('\n**Activated (→ running):**\n' + fmt(summary.activated, a => `- \`${a.id}\` (agent ${a.agent})`));
      if (summary.needsScope.length) lines.push('\n**Parked (needs_scope — AUR-3202):**\n' + fmt(summary.needsScope, a => `- \`${a.id}\` — ${a.reason}`));
      if (summary.recalibrated.length) lines.push('\n**Cap recalibrated (kept running):**\n' + fmt(summary.recalibrated, a => `- \`${a.id}\` — budget_cap_tokens ${a.oldCap || '(unset)'} → ${a.newCap} (reachable=${a.reachable}, p95=${a.p95PerTask})`));
      if (summary.measured.length) lines.push('\n**Measured:**\n' + fmt(summary.measured, a => `- \`${a.id}\` measured ${a.measured ?? '?'} vs expected ${a.expected ?? '?'} (baseline ${a.base}, period ${a.period})`));
      if (summary.adopted.length) lines.push('\n**Adopted (→ Loop C):**\n' + fmt(summary.adopted, a => `- \`${a.id}\` → ${a.loopCIssue} (${a.measured} ≥ ${a.expected})`));
      if (summary.rejected.length) lines.push('\n**Rejected:**\n' + fmt(summary.rejected, a => `- \`${a.id}\` — ${a.reason}${a.measured ? ` (${a.measured} < ${a.expected})` : ''}`));
      if (summary.contention.length) lines.push('\n**Held (1-per-agent):**\n' + fmt(summary.contention, a => `- \`${a.id}\` (agent ${a.agent} already has a running experiment)`));
      if (summary.blocked.length) lines.push('\n**Awaiting board approval:**\n' + fmt(summary.blocked, a => `- \`${a.id}\` — ${a.reason}`));
    }
    if (gate.armed.length) lines.push('\n**Armed by the prompt-edit gate (→ approved):**\n' + fmt(gate.armed, a => `- \`${a.id}\` — ${a.reason}`));
    if (gate.rejected.length) lines.push('\n**Rejected by the prompt-edit gate:**\n' + fmt(gate.rejected, a => `- \`${a.id}\` — ${a.reason}`));
    if (gate.requested.length) lines.push('\n**Gate run requested (fleet-internal — no board row filed, AUR-5354):**\n' + fmt(gate.requested, a => `- \`${a.id}\` → ${a.issue}`));
    if (gate.awaiting.length) lines.push('\n**Awaiting a gate verdict:**\n' + fmt(gate.awaiting, a => `- \`${a.id}\` — ${a.reason}`));
    lines.push('');
    lines.push(`Gate-routed (no board approval asked): **${counts.gateArmed + counts.gateRejected + counts.gateRequested + counts.gateAwaiting}**.`);
    lines.push(pendingLine);
    if (pendingApproval.unapproved.length) lines.push('\n**Unapproved (missing board_approval_id — a Drafter bug, never activated):**\n' + fmt(pendingApproval.unapproved, a => `- \`${a.id}\``));
    if (pendingApproval.escalated.length) lines.push('\n**Escalated (>=7d pending, board request_confirmation filed on this issue):**\n' + fmt(pendingApproval.escalated, a => `- \`${a.id}\` — ${a.ageDays}d`));
    if (pendingApproval.founderAlerted.length) lines.push('\n**Founder-alerted (>=14d pending, Telegram sent):**\n' + fmt(pendingApproval.founderAlerted, a => `- \`${a.id}\` — ${a.ageDays}d`));
    if (pendingApproval.reconciledApproved.length) lines.push('\n**Reconciled → approved (board had already accepted):**\n' + fmt(pendingApproval.reconciledApproved, a => `- \`${a.id}\``));
    if (pendingApproval.reconciledRejected.length) lines.push('\n**Reconciled → rejected (board had already denied):**\n' + fmt(pendingApproval.reconciledRejected, a => `- \`${a.id}\``));
    await postComment(TASK_ID, lines.join('\n'));
  }

  return { date: TODAY, dryRun: DRY_RUN, counts, summary, gate, pendingApproval };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(result => {
    console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
  }).catch(err => {
    console.error('SGI Loop H error:', err.message);
    process.exit(1);
  });
}
