#!/usr/bin/env node
/**
 * SGI Loop D — Daily ROI ledger recompute
 *
 * Methodology (per board direction, AUR-1723):
 *
 *   Two SEPARATE signals — do not conflate them:
 *
 *   1. EXECUTION-EFFICIENCY signal (internal only).
 *        efficiency = completion_rate × priority_weight / friction_penalty
 *      Measures how cleanly work flows through the board. It is NOT money and
 *      must never drive a board-facing action on its own. Stored to memory as
 *      `efficiency/{projectId}/lifetime` for internal trend-watching, and later
 *      compared against real financials when those are wired up.
 *
 *   2. FINANCIAL ROI = revenue / agent_token_cost  ("agent token cost to revenue").
 *      - agent_token_cost: REAL, available now from /costs/by-project (token
 *        usage per project). Where per-event dollar cost isn't recorded (BYOK,
 *        costCents=0) we estimate USD from token counts at the configured rates.
 *      - revenue: comes from the CFO, periodically. NOT wired up yet. Read from
 *        memory `project-value/{projectId}` (metadata.revenue_usd) once the CFO
 *        populates it.
 *      ROI is computed and can raise board actions ONLY for projects that have a
 *      revenue figure. Projects without revenue are reported "ROI pending" — the
 *      token cost is shown (it's ready), but no ROI is invented.
 *
 *   Why this shape: an earlier version computed "ROI" from execution smoothness,
 *   which is uncorrelated (inversely, for trading) with money. It flagged a
 *   money-losing taker bot as positive and the high-value Voice pilot as
 *   negative. Efficiency is kept, but demoted to an internal signal; real ROI
 *   waits for real revenue.
 *
 * Financial ROI thresholds (revenue / cost ratio, on real revenue only):
 *   roi < 1.0  → revenue below agent token cost → flag for board review
 *   roi > 2.0  → >2x revenue over cost → profit-seeking trigger
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

const ROI_LOSS_THRESHOLD = 1.0;   // revenue < cost
const ROI_PROFIT_THRESHOLD = 2.0; // revenue > 2x cost
const MIN_ISSUES_FOR_SIGNAL = 3;  // skip efficiency for projects with too few issues

const PRIORITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };

// Token → USD estimation (used only when costCents is 0, i.e. BYOK). Blended
// rates per million tokens; override via env. Defaults are Claude-Opus-ish and
// deliberately conservative — these drive an *estimated* cost, flagged as such.
const RATE_INPUT_PER_MTOK = Number(process.env.SGI_RATE_INPUT_PER_MTOK || 3.0);
const RATE_CACHED_PER_MTOK = Number(process.env.SGI_RATE_CACHED_PER_MTOK || 0.3);
const RATE_OUTPUT_PER_MTOK = Number(process.env.SGI_RATE_OUTPUT_PER_MTOK || 15.0);

function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'X-Paperclip-Run-Id': RUN_ID,
    ...extra,
  };
}

async function apiFetch(path, opts = {}) {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, { headers: headers(), ...opts });
  if (res.status === 404) return { _notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchAllIssuesByStatus(statuses) {
  const issues = [];
  for (const status of statuses) {
    const data = await apiFetch(
      `/api/companies/${COMPANY_ID}/issues?status=${status}&limit=200`
    );
    const batch = Array.isArray(data) ? data : (data.issues || data.data || []);
    issues.push(...batch);
  }
  return issues;
}

async function fetchProjects() {
  const data = await apiFetch(`/api/companies/${COMPANY_ID}/projects`);
  return Array.isArray(data) ? data : (data.projects || []);
}

/** Real agent token cost per project. Returns Map<projectId,{costUsd,estimated,tokens}>. */
async function fetchTokenCostByProject() {
  const data = await apiFetch(`/api/companies/${COMPANY_ID}/costs/by-project`);
  const map = new Map();
  if (data._notFound) return map;
  const rows = Array.isArray(data) ? data : (data.rows || []);
  for (const r of rows) {
    if (!r.projectId) continue;
    const input = r.inputTokens || 0;
    const cached = r.cachedInputTokens || 0;
    const output = r.outputTokens || 0;
    const cents = r.costCents || 0;
    const estimated = cents <= 0;
    const costUsd = estimated
      ? (input * RATE_INPUT_PER_MTOK + cached * RATE_CACHED_PER_MTOK + output * RATE_OUTPUT_PER_MTOK) / 1_000_000
      : cents / 100;
    map.set(r.projectId, { costUsd, estimated, input, cached, output });
  }
  return map;
}

/**
 * Per-project revenue from the CFO. Read from memory `project-value/{projectId}`
 * (metadata.revenue_usd). NOT wired up yet — returns empty until the CFO
 * populates it. Returns Map<projectId,{revenueUsd,period,source}>.
 */
async function fetchRevenueSignals() {
  const data = await apiFetch(
    `/api/companies/${COMPANY_ID}/memory/records?titlePrefix=${encodeURIComponent('project-value/')}&limit=200`
  );
  const map = new Map();
  if (data._notFound) return map;
  const records = Array.isArray(data) ? data : (data.records || []);
  for (const r of records) {
    const m = r.metadata || {};
    const pid = m.project_id || r.scope?.projectId;
    const revenueUsd = m.revenue_usd;
    if (!pid || typeof revenueUsd !== 'number') continue;
    const stamp = m.computed_at || r.createdAt || '';
    const prev = map.get(pid);
    if (!prev || stamp > prev._stamp) {
      map.set(pid, { revenueUsd, period: m.period || null, source: m.source || r.title, _stamp: stamp });
    }
  }
  return map;
}

/** Write the internal efficiency signal. Best-effort. */
async function captureEfficiency(row) {
  const payload = {
    title: `efficiency/${row.projectId}/lifetime`,
    content: `EXECUTION EFFICIENCY (internal, not ROI): ${row.efficiency.toFixed(3)} | done=${row.done} cancelled=${row.cancelled} blocked=${row.blocked} completion=${(row.completionRate * 100).toFixed(0)}% | token_cost≈$${row.costUsd.toFixed(2)}${row.costEstimated ? ' (est)' : ''} | computed=${new Date().toISOString().slice(0, 10)}`,
    metadata: {
      category: 'efficiency_signal',
      internal_only: true,
      project_id: row.projectId,
      efficiency: row.efficiency,
      completion_rate: row.completionRate,
      done_count: row.done,
      cancelled_count: row.cancelled,
      blocked_count: row.blocked,
      token_cost_usd: row.costUsd,
      token_cost_estimated: row.costEstimated,
      computed_at: new Date().toISOString(),
    },
    source: { kind: 'issue', issueId: TASK_ID },
    scope: { projectId: row.projectId },
  };
  const result = await apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  return result._notFound ? null : result;
}

/** Write the financial ROI ledger (only when revenue is known). Best-effort. */
async function captureRoi(row) {
  const payload = {
    title: `roi/${row.projectId}/lifetime`,
    content: `ROI (revenue/agent_token_cost): ${row.roi.toFixed(3)} | revenue=$${row.revenueUsd} token_cost≈$${row.costUsd.toFixed(2)}${row.costEstimated ? ' (est)' : ''} | efficiency=${row.efficiency.toFixed(3)} | computed=${new Date().toISOString().slice(0, 10)}`,
    metadata: {
      category: 'roi_ledger',
      project_id: row.projectId,
      roi: row.roi,
      revenue_usd: row.revenueUsd,
      revenue_period: row.revenuePeriod,
      revenue_source: row.revenueSource,
      token_cost_usd: row.costUsd,
      token_cost_estimated: row.costEstimated,
      efficiency: row.efficiency,
      computed_at: new Date().toISOString(),
    },
    source: { kind: 'issue', issueId: TASK_ID },
    scope: { projectId: row.projectId },
  };
  const result = await apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  return result._notFound ? null : result;
}

function buildRows(doneIssues, otherIssues, projects, tokenCosts, revenueSignals) {
  const byProject = new Map();
  for (const p of projects) {
    byProject.set(p.id, { projectId: p.id, name: p.name, done: 0, cancelled: 0, blocked: 0, prioritySum: 0 });
  }
  for (const issue of doneIssues) {
    const b = byProject.get(issue.projectId);
    if (!b) continue;
    b.done++;
    b.prioritySum += PRIORITY_WEIGHT[issue.priority] || 2;
  }
  for (const issue of otherIssues) {
    const b = byProject.get(issue.projectId);
    if (!b) continue;
    if (issue.status === 'cancelled') b.cancelled++;
    else if (issue.status === 'blocked') b.blocked++;
  }

  const rows = [];
  for (const [pid, b] of byProject) {
    const total = b.done + b.cancelled + b.blocked;
    if (total < MIN_ISSUES_FOR_SIGNAL) continue;

    const completionRate = b.done / total;
    const priorityWeight = b.done > 0 ? b.prioritySum / b.done / 4 : 0;
    const frictionPenalty = 1 + (b.blocked / Math.max(b.done, 1)) * 0.5;
    const efficiency = (completionRate * priorityWeight) / frictionPenalty;

    const cost = tokenCosts.get(pid) || { costUsd: 0, estimated: true };
    const rev = revenueSignals.get(pid);
    const hasRevenue = !!rev && cost.costUsd > 0;
    const roi = hasRevenue ? rev.revenueUsd / cost.costUsd : null;

    rows.push({
      projectId: pid, name: b.name,
      done: b.done, cancelled: b.cancelled, blocked: b.blocked,
      completionRate, efficiency,
      costUsd: cost.costUsd, costEstimated: cost.estimated,
      hasRevenue, revenueUsd: rev?.revenueUsd ?? null, revenuePeriod: rev?.period ?? null, revenueSource: rev?.source ?? null, roi,
    });
  }
  return rows;
}

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

async function createApproval(title, summary, recommendedAction, risks, issueIds) {
  return apiFetch(`/api/companies/${COMPANY_ID}/approvals`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'request_board_approval',
      requestedByAgentId: AGENT_ID,
      issueIds,
      payload: { title, summary, recommendedAction, risks },
    }),
  });
}

async function main() {
  const [projects, doneIssues, otherIssues, tokenCosts, revenueSignals] = await Promise.all([
    fetchProjects(),
    fetchAllIssuesByStatus(['done']),
    fetchAllIssuesByStatus(['cancelled', 'blocked', 'in_progress', 'todo']),
    fetchTokenCostByProject(),
    fetchRevenueSignals(),
  ]);

  const rows = buildRows(doneIssues, otherIssues, projects, tokenCosts, revenueSignals);

  const withRoi = rows.filter(r => r.hasRevenue).sort((a, b) => b.roi - a.roi);
  const losing = withRoi.filter(r => r.roi < ROI_LOSS_THRESHOLD);
  const profitable = withRoi.filter(r => r.roi > ROI_PROFIT_THRESHOLD);

  // Memory writes: efficiency for every project (internal); ROI where revenue exists.
  let effWrites = 0, roiWrites = 0;
  for (const r of rows) {
    if ((await captureEfficiency(r)) !== null) effWrites++;
    if (r.hasRevenue && (await captureRoi(r)) !== null) roiWrites++;
  }

  const effTable = rows
    .slice().sort((a, b) => b.efficiency - a.efficiency)
    .map(r => `| ${r.name} | ${r.efficiency.toFixed(3)} | done=${r.done} cancelled=${r.cancelled} blocked=${r.blocked} | $${r.costUsd.toFixed(2)}${r.costEstimated ? ' est' : ''} |`)
    .join('\n');

  const roiTable = withRoi.length
    ? withRoi.map(r => {
        const flag = r.roi < ROI_LOSS_THRESHOLD ? '🔴' : r.roi > ROI_PROFIT_THRESHOLD ? '🟢' : '🟡';
        return `| ${flag} | ${r.name} | ${r.roi.toFixed(2)}× | $${r.revenueUsd} | $${r.costUsd.toFixed(2)}${r.costEstimated ? ' est' : ''} |`;
      }).join('\n')
    : '| ⏳ | _(no project has CFO revenue yet — ROI pending)_ | — | — | — |';
  const roiIntro = withRoi.length
    ? `> Agent token cost is **real** (from \`/costs/by-project\`${rows.some(r => r.costEstimated) ? ', USD estimated from token counts since per-event cost is BYOK/unrecorded' : ''}). Revenue now comes from CFO memory records \`project-value/{projectId}\`; ${withRoi.length} project(s) have numeric revenue signals in this run, so financial ROI is no longer pending for them.`
    : `> Agent token cost is **real** (from \`/costs/by-project\`${rows.some(r => r.costEstimated) ? ', USD estimated from token counts since per-event cost is BYOK/unrecorded' : ''}). **Revenue comes from the CFO and is not wired up yet**, so ROI is *pending* for every project below. The cost side is ready — the moment the CFO supplies \`revenue_usd\` per project (memory \`project-value/{projectId}\`), ROI computes and flags the right projects.`;

  const commentBody = `## SGI Loop D — Daily ledger

Two separate signals, per board direction:

### 1. Execution efficiency — INTERNAL signal only (NOT ROI)
> How cleanly work flows through the board (completion / friction). Does **not** measure money; never triggers a board action. Tracked internally to compare against financials later. Stored to memory \`efficiency/{projectId}/lifetime\` (${effWrites}/${rows.length} written).

| Project | Efficiency | Throughput | Agent token cost |
|---------|-----------|------------|------------------|
${effTable}

### 2. Financial ROI = revenue ÷ agent token cost
${roiIntro}

| | Project | ROI | Revenue | Agent token cost |
|---|---------|-----|---------|------------------|
${roiTable}

**Thresholds (on real revenue only):** 🔴 ROI < 1.0× (revenue below cost) · 🟢 ROI > 2.0× · 🟡 between.

${withRoi.length === 0 ? '_No board action raised — there is no revenue data to compute real ROI yet._' : `Ledger: roi_ledger written for ${roiWrites}/${withRoi.length} projects.`}`;

  if (TASK_ID) await postComment(TASK_ID, commentBody);
  else console.log(commentBody);

  // Board approvals ONLY from real financial ROI crossings.
  if (losing.length > 0 || profitable.length > 0) {
    const summary = [
      losing.length ? `Revenue below agent token cost (ROI < 1.0×): ${losing.map(r => `${r.name} (${r.roi.toFixed(2)}×)`).join(', ')}.` : '',
      profitable.length ? `Strong return (ROI > 2.0×): ${profitable.map(r => `${r.name} (${r.roi.toFixed(2)}×)`).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    const risks = [];
    if (losing.length) risks.push(`${losing.length} project(s) earning less than they cost in agent tokens`);
    if (profitable.length) risks.push('Capacity increase requires budget headroom');
    const recommendedAction = [
      losing.length ? `Review / pause / redirect: ${losing.map(r => r.name).join(', ')}.` : '',
      profitable.length ? `Authorize more capacity for: ${profitable.map(r => r.name).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    const approval = await createApproval('SGI Loop D: financial ROI alert', summary, recommendedAction, risks, TASK_ID ? [TASK_ID] : []);
    if (approval && !approval._notFound && TASK_ID) {
      const approvalId = approval.id || approval.approvalId;
      await postComment(TASK_ID, `Board approval requested for ROI threshold actions: [/AUR/approvals/${approvalId}](/AUR/approvals/${approvalId})`);
    }
  }

  return { rows, withRoi, losing, profitable, effWrites, roiWrites };
}

main().then(result => {
  console.log(JSON.stringify({
    status: 'ok',
    projects: result.rows.length,
    withRevenue: result.withRoi.length,
    flaggedLosing: result.losing.length,
    flaggedProfitable: result.profitable.length,
    efficiencyWritten: result.effWrites,
    roiWritten: result.roiWrites,
  }, null, 2));
}).catch(err => {
  console.error('SGI Loop D error:', err.message);
  process.exit(1);
});
