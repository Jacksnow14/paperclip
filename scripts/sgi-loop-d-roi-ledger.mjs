#!/usr/bin/env node
/**
 * SGI Loop D — Daily ROI Ledger Recompute
 *
 * Recomputes per-project return-on-investment from the company's cost-adjusted
 * scorecards and writes a canonical `roi/{projectId}/lifetime` memory record per
 * project (category `roi_ledger`, board auto-accepted). When a project's ROI band
 * crosses a threshold *edge* (newly drops to `flag` or newly climbs to
 * `profit_seeking`) versus its prior ledger, the loop raises a board-facing
 * action: a consolidated `request_board_approval` plus a summary comment on the
 * execution issue.
 *
 * --- Data reality (verified against the live store) -------------------------
 * `scorecard_adjusted` records are keyed `scorecard-adjusted/{agentId}/{taskType}/{date}`
 * and carry: issue_id (human identifier, e.g. AUR-2674), value_signal,
 * quality_signal (1..5), token_cost, score_adjusted (= value*quality/token_cost).
 * They do NOT carry project_id, so we resolve issue_id → project via the issues
 * API and aggregate by the resolved projectId. Scorecards on issues with no
 * project are tallied as "unscoped" and reported, but get no project ledger.
 *
 * --- ROI definition --------------------------------------------------------
 * Revenue is not yet wired (AUR-1734), so ROI is a normalized value-efficiency
 * score in (0,1), comparable across projects and stable against a single
 * project's swings:
 *
 *   adjustedValue_p = Σ value_signal * (quality_signal / 5)     // quality-weighted value
 *   cost_p          = Σ token_cost
 *   vpt_p           = adjustedValue_p / (cost_p / 1000)         // value per 1K tokens
 *   ref             = median(vpt across projects)               // company reference
 *   roi_p           = vpt_p / (vpt_p + ref)                     // logistic → (0,1), 0.5 = median
 *
 * When a `project_value` revenue record exists for a project, vpt_p is replaced
 * by revenue_usd / cost_usd (same formula, same bands) — i.e. the ledger becomes
 * a true revenue ROI the day revenue lands, with no threshold change.
 *
 * Bands (board thresholds, env-overridable):
 *   flag           roi < ROI_FLAG (0.25)            → board review: re-scope / reprice / pause
 *   watch          ROI_FLAG ≤ roi < 0.5
 *   healthy        0.5 ≤ roi ≤ ROI_PROFIT (0.70)
 *   profit_seeking roi > ROI_PROFIT (0.70)          → board review: scale investment
 * A board action fires only on an *edge* into flag/profit_seeking versus the
 * prior ledger band, so a standing condition is not re-raised every day.
 *
 * Usage:
 *   node scripts/sgi-loop-d-roi-ledger.mjs            # recompute + write + (edge) board action
 *   node scripts/sgi-loop-d-roi-ledger.mjs --dry-run  # print only, no writes/approval
 *   node scripts/sgi-loop-d-roi-ledger.mjs --no-approval  # write ledgers + comment, skip approval
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NO_APPROVAL = argv.includes('--no-approval');
const NOW_ISO = new Date().toISOString();
const TODAY = NOW_ISO.slice(0, 10);

const numEnv = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
};

// Board-defined band thresholds (overridable without redeploy).
const ROI_FLAG = numEnv('ROI_FLAG', 0.25);
const ROI_PROFIT = numEnv('ROI_PROFIT', 0.70);
// Below this lifetime token spend a project is too small to flag/scale on.
const ROI_MIN_TOKENS = numEnv('ROI_MIN_TOKENS', 50000);

const SCAN_LIMIT = 1000;       // memory records page
const ID_BATCH = 60;           // issue identifiers per resolution call

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

async function fetchRecords(extraQuery = '') {
  const data = await apiFetch(`/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_LIMIT}${extraQuery}`);
  if (data._notFound) return [];
  return asArray(data, 'records');
}

/** Resolve human issue identifiers → { identifier: { projectId, projectName } }. */
async function resolveIssueProjects(identifiers) {
  const out = new Map();
  for (let i = 0; i < identifiers.length; i += ID_BATCH) {
    const chunk = identifiers.slice(i, i + ID_BATCH);
    const data = await apiFetch(`/api/companies/${COMPANY_ID}/issues?identifier=${encodeURIComponent(chunk.join(','))}`);
    if (data._notFound) continue;
    for (const issue of asArray(data, 'issues')) {
      const projectName = issue.project && typeof issue.project === 'object' ? issue.project.name : null;
      out.set(issue.identifier, { projectId: issue.projectId || null, projectName });
    }
  }
  return out;
}

async function captureLedger(title, body, metadata) {
  const source = RUN_ID ? { kind: 'run', runId: RUN_ID }
    : (TASK_ID ? { kind: 'issue', issueId: TASK_ID } : { kind: 'manual_note' });
  const content = body.length > 20000 ? `${body.slice(0, 19980)}\n\n…[truncated]` : body;
  return apiFetch(`/api/companies/${COMPANY_ID}/memory/capture`, {
    method: 'POST',
    body: JSON.stringify({ title, content, metadata, source }),
  });
}

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

async function requestBoardApproval(payload, issueIds) {
  return apiFetch(`/api/companies/${COMPANY_ID}/approvals`, {
    method: 'POST',
    body: JSON.stringify({ type: 'request_board_approval', requestedByAgentId: AGENT_ID, issueIds, payload }),
  });
}

// ---- Record helpers --------------------------------------------------------

/** Merge JSON content + metadata (metadata wins) so we read fields either way. */
function fields(r) {
  let fromContent = {};
  if (typeof r.content === 'string' && r.content.trim().startsWith('{')) {
    try { fromContent = JSON.parse(r.content); } catch { /* not JSON */ }
  }
  return { ...fromContent, ...(r.metadata || {}) };
}
const cat = (r) => (r.metadata && r.metadata.category) || fields(r).category || '';
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function bandFor(roi, tokens) {
  if (tokens < ROI_MIN_TOKENS) return 'watch'; // too small to act on either way
  if (roi < ROI_FLAG) return 'flag';
  if (roi < 0.5) return 'watch';
  if (roi <= ROI_PROFIT) return 'healthy';
  return 'profit_seeking';
}

// ---- ROI computation -------------------------------------------------------

function latestRevenueByProject(all) {
  const map = new Map();
  for (const r of all) {
    const f = fields(r);
    const isRevenue = cat(r) === 'project_value' || (r.title || '').startsWith('project-value/');
    if (!isRevenue) continue;
    const pid = f.project_id || (r.title || '').split('/')[1];
    if (!pid) continue;
    const stamp = f.computed_at || r.createdAt || '';
    const prev = map.get(pid);
    if (!prev || stamp > prev.stamp) map.set(pid, { revenueUsd: num(f.revenue_usd ?? f.revenueUsd), costUsd: num(f.cost_usd ?? f.costUsd), stamp });
  }
  return map;
}

function computeRoi(all, issueProjects) {
  const revenue = latestRevenueByProject(all);
  const projects = new Map(); // projectId -> aggregate
  let unscoped = { adjustedValue: 0, tokenCost: 0, samples: 0 };

  for (const r of all) {
    if (cat(r) !== 'scorecard_adjusted') continue;
    const f = fields(r);
    const ident = f.issue_id;
    const resolved = ident ? issueProjects.get(ident) : null;
    const pid = resolved && resolved.projectId;
    const value = num(f.value_signal);
    const quality = num(f.quality_signal) || 3; // default mid-quality if missing
    const adjValue = value * (Math.min(Math.max(quality, 0), 5) / 5);
    const tok = num(f.token_cost);
    if (!pid) { unscoped.adjustedValue += adjValue; unscoped.tokenCost += tok; unscoped.samples += 1; continue; }
    let p = projects.get(pid);
    if (!p) p = projects.set(pid, { projectId: pid, projectName: resolved.projectName || null, adjustedValue: 0, tokenCost: 0, valueSignal: 0, samples: 0, agents: new Set(), issues: new Set() }).get(pid);
    p.adjustedValue += adjValue;
    p.valueSignal += value;
    p.tokenCost += tok;
    p.samples += 1;
    if (f.agent_id) p.agents.add(f.agent_id);
    if (ident) p.issues.add(ident);
  }

  // value-per-1K-tokens (or revenue ratio when revenue is wired), then a
  // median-referenced logistic so each project is judged against the company.
  const rows = [...projects.values()].map((p) => {
    const rev = revenue.get(p.projectId);
    const basis = rev ? 'revenue' : 'value_efficiency_proxy';
    let vpt;
    if (rev) {
      const costUsd = rev.costUsd > 0 ? rev.costUsd : (p.tokenCost / 1000) * numEnv('ROI_TOKEN_PRICE_USD_PER_1K', 0.015);
      vpt = costUsd > 0 ? rev.revenueUsd / costUsd : 0;
    } else {
      vpt = p.tokenCost > 0 ? p.adjustedValue / (p.tokenCost / 1000) : 0;
    }
    return { ...p, basis, vpt, revenueUsd: rev ? rev.revenueUsd : null };
  });

  const ref = median(rows.filter(r => r.tokenCost >= ROI_MIN_TOKENS).map(r => r.vpt)) || median(rows.map(r => r.vpt));
  for (const r of rows) {
    r.roi = (r.vpt + ref) > 0 ? r.vpt / (r.vpt + ref) : 0;
    r.band = bandFor(r.roi, r.tokenCost);
    r.agents = r.agents.size;
    r.issues = [...r.issues];
  }
  rows.sort((a, b) => b.roi - a.roi);
  return { rows, ref, unscoped };
}

// ---- Prior-band lookup + render -------------------------------------------

function priorLedgerBands(priorRecords) {
  const map = new Map();
  for (const r of priorRecords) {
    if (cat(r) !== 'roi_ledger') continue;
    const f = fields(r);
    const pid = f.project_id || (r.title || '').split('/')[1];
    if (!pid || /^__.*__$/.test(pid)) continue; // skip probe/sentinel ledgers
    const stamp = f.computed_at || r.createdAt || '';
    const prev = map.get(pid);
    if (!prev || stamp > prev.stamp) map.set(pid, { band: f.band || null, stamp, roi: f.roi ?? null });
  }
  return map;
}

const pct = (roi) => `${(roi * 100).toFixed(1)}%`;

function renderLedger(row, prior, ref) {
  const prev = prior ? `${prior.band} (${prior.roi === null ? '—' : pct(Number(prior.roi))})` : '— (first ledger)';
  return `# ROI Ledger — project \`${row.projectName || row.projectId}\`

_SGI Loop D · lifetime recompute ${TODAY} · basis **${row.basis}**_

- **ROI**: ${pct(row.roi)} → band **${row.band.toUpperCase()}** (prev ${prev})
- Value efficiency: ${row.vpt.toFixed(4)} ${row.basis === 'revenue' ? 'revenue$/cost$' : 'adj-value per 1K tok'} (company median ${ref.toFixed(4)})
- ${row.basis === 'revenue' ? `Revenue: $${(row.revenueUsd || 0).toFixed(2)}` : `Adjusted value: ${row.adjustedValue.toFixed(1)} (raw value-signal ${row.valueSignal})`}
- Token cost: ${row.tokenCost.toLocaleString()} tok over ${row.samples} scorecard(s), ${row.agents} agent(s)
- Bands: flag < ${ROI_FLAG} · healthy ${0.5}–${ROI_PROFIT} · profit-seeking > ${ROI_PROFIT} (min ${ROI_MIN_TOKENS.toLocaleString()} tok to act)
- Project id: \`${row.projectId}\`
`;
}

function boardActionFor(row, prior) {
  const prevBand = prior ? prior.band : null;
  if (row.band === 'flag' && prevBand !== 'flag') {
    return { kind: 'review_or_pause', severity: 'high', recommendation:
      `Project ${row.projectName || row.projectId} ROI is ${pct(row.roi)} (bottom band) on ${row.tokenCost.toLocaleString()} tok — board review: re-scope, reprice, or pause.` };
  }
  if (row.band === 'profit_seeking' && prevBand !== 'profit_seeking') {
    return { kind: 'scale_up', severity: 'info', recommendation:
      `Project ${row.projectName || row.projectId} ROI is ${pct(row.roi)} (top band) — board review: scale investment / replicate the pattern.` };
  }
  return null;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const all = await fetchRecords();
  const adjusted = all.filter(r => cat(r) === 'scorecard_adjusted');
  const identifiers = [...new Set(adjusted.map(r => fields(r).issue_id).filter(Boolean))];
  const issueProjects = await resolveIssueProjects(identifiers);

  const priorLedgers = await fetchRecords('&titlePrefix=roi/');
  const priorBands = priorLedgerBands(priorLedgers.length ? priorLedgers : all);
  // First real ledger (no prior bands): establish a baseline without firing board
  // approvals on standing conditions. Subsequent runs edge-trigger genuine changes.
  const isBaseline = priorBands.size === 0;

  const { rows, ref, unscoped } = computeRoi(all, issueProjects);

  const written = [];
  const boardActions = [];
  for (const row of rows) {
    const prior = priorBands.get(row.projectId) || null;
    // On the baseline run, record bands but do not treat first-seen as an edge.
    const action = isBaseline ? null : boardActionFor(row, prior);
    if (action) boardActions.push({ projectId: row.projectId, projectName: row.projectName, ...action, roi: row.roi, band: row.band });

    const title = `roi/${row.projectId}/lifetime`;
    const metadata = {
      category: 'roi_ledger', auto_accepted: true,
      project_id: row.projectId, project_name: row.projectName,
      computed_at: NOW_ISO, date: TODAY, generated_by: 'sgi-loop-d',
      basis: row.basis, roi: Number(row.roi.toFixed(4)), band: row.band,
      prev_band: prior ? prior.band : null,
      value_per_ktok: Number(row.vpt.toFixed(6)), company_median_vpt: Number(ref.toFixed(6)),
      adjusted_value: Number(row.adjustedValue.toFixed(3)), value_signal: row.valueSignal,
      revenue_usd: row.revenueUsd, token_cost: row.tokenCost,
      samples: row.samples, agents: row.agents, issues: row.issues.slice(0, 40),
      thresholds: { flag: ROI_FLAG, profit_seeking: ROI_PROFIT, min_tokens: ROI_MIN_TOKENS },
      board_action: action || null,
    };
    const body = renderLedger(row, prior, ref);

    if (DRY_RUN) { written.push({ title, band: row.band, roi: Number(row.roi.toFixed(4)), action: action ? action.kind : null }); continue; }
    const captured = await captureLedger(title, body, metadata);
    const rec = captured && (Array.isArray(captured.records) ? captured.records[0] : captured.record);
    written.push({ title, recordId: rec && rec.id, band: row.band, roi: Number(row.roi.toFixed(4)), action: action ? action.kind : null });
  }

  // Board-facing action: edge-triggered, consolidated.
  let approvalId = null;
  if (boardActions.length && !DRY_RUN) {
    const flags = boardActions.filter(a => a.kind === 'review_or_pause');
    const stars = boardActions.filter(a => a.kind === 'scale_up');
    if (!NO_APPROVAL) {
      const approval = await requestBoardApproval({
        title: `ROI threshold crossings — ${TODAY} (${flags.length} flag, ${stars.length} profit-seeking)`,
        summary: `SGI Loop D recomputed lifetime ROI across ${rows.length} project(s). ${boardActions.length} crossed a board-action threshold since the last ledger.\n\n` +
          boardActions.map(a => `• ${a.severity.toUpperCase()} — ${a.recommendation}`).join('\n'),
        recommendedAction: flags.length && stars.length
          ? 'Review flagged projects for re-scope/pause and approve scaling the profit-seeking ones.'
          : flags.length ? 'Review the flagged project(s) for re-scope, reprice, or pause.'
          : 'Approve scaling investment in the profit-seeking project(s).',
        risks: flags.map(a => `${a.projectName || a.projectId}: sustained low ROI burns budget if not re-scoped.`),
      }, TASK_ID ? [TASK_ID] : []);
      approvalId = approval && (approval.id || (approval.approval && approval.approval.id)) || null;
    }
    if (TASK_ID) {
      const lines = boardActions.map(a => `- **${a.severity.toUpperCase()}** · \`${a.projectName || a.projectId}\` → **${a.band}** (${pct(a.roi)}): ${a.recommendation}`).join('\n');
      await postComment(TASK_ID,
        `## SGI Loop D — ROI threshold crossings (${TODAY})\n\n${boardActions.length} project(s) crossed a board-action threshold since the last ledger:\n\n${lines}\n\n${approvalId ? `Board approval requested: \`${approvalId}\`. ` : NO_APPROVAL ? '_Approval suppressed (--no-approval)._ ' : ''}Per-project ledgers stored as \`roi/{projectId}/lifetime\` (category \`roi_ledger\`).\n\n_Edge-triggered: only newly-crossed bands are listed. ROI is a median-referenced value-efficiency score (0.5 = company median) pending revenue wiring ([AUR-1734](/AUR/issues/AUR-1734))._`);
    }
  } else if (TASK_ID && !DRY_RUN) {
    const summary = rows.length
      ? rows.slice(0, 12).map(r => `\`${(r.projectName || r.projectId).slice(0, 14)}\` ${r.band}/${pct(r.roi)}`).join(' · ')
      : '_no scorecard_adjusted records resolved to a project yet_';
    const flagged = rows.filter(r => r.band === 'flag');
    const stars = rows.filter(r => r.band === 'profit_seeking');
    const standing = (isBaseline && (flagged.length || stars.length))
      ? `\n\n**Current standing positions** (baseline — board-visible, no approval raised; future crossings will):\n` +
        [...flagged.map(r => `- 🔻 FLAG \`${r.projectName || r.projectId}\` ${pct(r.roi)} (${r.tokenCost.toLocaleString()} tok)`),
         ...stars.map(r => `- 🔺 PROFIT-SEEKING \`${r.projectName || r.projectId}\` ${pct(r.roi)}`)].join('\n')
      : '';
    await postComment(TASK_ID,
      `## SGI Loop D — ROI ledger ${isBaseline ? 'baseline' : 'recompute'} (${TODAY})\n\nRecomputed **${rows.length}** project ledger(s) from ${adjusted.length} cost-adjusted scorecard(s); **${isBaseline ? 'baseline established' : '0 new threshold crossings'}**. ${unscoped.samples} scorecard(s) on project-less issues (unscoped, ${unscoped.tokenCost.toLocaleString()} tok — ROI covers project-attributed work only).\n\n${summary}${standing}\n\n_ROI = median-referenced value-efficiency (0.5 = company median) pending revenue wiring ([AUR-1734](/AUR/issues/AUR-1734)). Bands: flag < ${ROI_FLAG}, profit-seeking > ${ROI_PROFIT}._`);
  }

  return { date: TODAY, baseline: isBaseline, projects: rows.length, scorecards: adjusted.length, unscopedSamples: unscoped.samples, boardActions: boardActions.length, approvalId, ref: Number(ref.toFixed(6)), written };
}

main().then(result => {
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
}).catch(err => {
  console.error('SGI Loop D error:', err.message);
  process.exit(1);
});
