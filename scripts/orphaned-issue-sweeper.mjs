#!/usr/bin/env node
/**
 * Orphaned-Issue Sweeper (AUR-2059)
 *
 * Daily safety net for the orphaned-issue failure mode (AUR-1567): subtasks get
 * created without an assigneeAgentId while no agent looks for unassigned work, so
 * they sit in todo/in_progress forever and silently stall their parent trees.
 *
 * This script:
 *   1. Lists actionable issues: GET /issues?status=todo,in_progress
 *   2. Finds orphans — no assigneeAgentId AND no assigneeUserId
 *   3. Routes each orphan to the correct owner, in priority order:
 *        a. Ownership continuity — the assignee of the nearest assigned ancestor
 *           (parent, grandparent, ...). Keeps a subtask with the agent already
 *           running the tree. This is the strongest signal and is tried first.
 *        b. Content routing — keyword match on title/description/labels:
 *             engineering -> Claude Code Fast vs Max, performance-aware tiebreak
 *                            (recent scorecard-adjusted quality_signal); fallback CTO
 *             research    -> Predictor
 *             design      -> UX Designer
 *             marketing   -> CMO
 *        c. Creator fallback — the creatorAgentId, if the content is unclear.
 *
 * Consolidates the duplicate "Daily Orphaned-Issue Sweeper" (AUR-1969,
 * scripts/orphan-issue-sweeper.mjs) per AUR-2935: this is the single surviving
 * sweeper — it keeps ancestor ownership-continuity (highest-signal route) AND
 * folds in AUR-1969's performance-aware Fast-vs-Max engineer tiebreaking.
 *   4. PATCHes the assignee, comments that the sweeper auto-routed it, and for
 *      high/critical orphans captures a routing/{id} rationale record.
 *   5. Prints a summary. Zero orphans => one-line all-clear.
 *
 * Safety: dry-run by default. Pass --apply to actually assign/comment/capture.
 *
 * Usage:
 *   node scripts/orphaned-issue-sweeper.mjs            # dry-run, print what it WOULD do
 *   node scripts/orphaned-issue-sweeper.mjs --apply    # execute routing
 *   node scripts/orphaned-issue-sweeper.mjs --apply --json
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const SWEEPER_ISSUE = 'AUR-2059';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');

if (!API_URL || !API_KEY || !COMPANY_ID) {
  console.error('Missing PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID in env.');
  process.exit(2);
}

function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...(RUN_ID ? { 'X-Paperclip-Run-Id': RUN_ID } : {}),
    ...extra,
  };
}

async function api(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers: headers(), ...opts });
  if (res.status === 404) return { _notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ---- Role resolution -------------------------------------------------------

async function buildRoster() {
  const data = await api(`/api/companies/${COMPANY_ID}/agents`);
  const list = Array.isArray(data) ? data : (data.agents || []);
  const byId = new Map();
  const byRole = new Map();   // role -> [agents]
  const byName = new Map();   // lower-name -> agent
  for (const a of list) {
    byId.set(a.id, a);
    byName.set((a.name || '').toLowerCase(), a);
    const role = (a.role || '').toLowerCase();
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(a);
  }
  const pickName = (n) => byName.get(n.toLowerCase()) || null;
  return {
    byId,
    engineer: pickName('Claude Code Fast') || (byRole.get('engineer') || [])[0] || pickName('CTO'),
    engineerMax: pickName('Claude Code Max') || null,
    cto: pickName('CTO') || (byRole.get('cto') || [])[0],
    researcher: pickName('Predictor') || (byRole.get('researcher') || [])[0],
    designer: pickName('UX Designer') || (byRole.get('designer') || [])[0],
    cmo: pickName('CMO') || (byRole.get('cmo') || [])[0],
    ceo: (byRole.get('ceo') || [])[0],
  };
}

// ---- Content classification ------------------------------------------------

const BUCKETS = [
  // 'snapshot' is deliberately NOT a research keyword — it appears just as often
  // in commit/cron/infra wrap-up tasks. Genuine research is caught by the market
  // terms below. Engineering verbs (commit/cron/deploy) are matched in their bucket.
  { key: 'research',    re: /\b(research|forecast|predict|market depth|liquidity|odds|backtest|analy[sz]e|dataset|scrap(e|ing)|study|investigat)/i },
  { key: 'design',      re: /\b(design|ux|ui|figma|wireframe|mockup|usability|design[- ]system|visual|layout|prototype)/i },
  { key: 'marketing',   re: /\b(market(ing)?|content|social|tweet|blog|seo|growth|devrel|campaign|outreach|copy(writing)?|newsletter|launch post)/i },
  { key: 'engineering', re: /\b(bug|fix|implement|refactor|endpoint|api|deploy|migration|test|build|server|script|infra|database|commit|cron|routine|backend|frontend|typecheck|lint|patch|code)/i },
];

function classify(issue) {
  const hay = `${issue.title || ''} ${issue.description || ''} ${(issue.labels || []).map(l => l.name || l).join(' ')}`;
  for (const b of BUCKETS) if (b.re.test(hay)) return b.key;
  return null;
}

// Performance-aware tiebreak between Claude Code Fast and Max for engineering
// work, using recent scorecard-adjusted quality_signal (folded in from AUR-1969).
// Higher recent quality wins; ties and missing data favour Fast. Falls back to
// Fast (or CTO) when Max is unavailable.
function chooseEngineer(roster, perfMap) {
  const fast = roster.engineer;     // Claude Code Fast (or engineer/CTO fallback)
  const max = roster.engineerMax;   // Claude Code Max, if present in roster
  if (!fast && !max) return roster.cto && { agent: roster.cto, reason: 'engineering content — no engineer in roster, CTO fallback' };
  if (!max) return fast && { agent: fast, reason: 'engineering content' };
  if (!fast) return { agent: max, reason: 'engineering content' };
  const fastQ = perfMap.get(fast.id) ?? 3;
  const maxQ = perfMap.get(max.id) ?? 3;
  const chosen = fastQ >= maxQ ? fast : max;
  return {
    agent: chosen,
    reason: `engineering content — perf-aware pick (recent quality: fast=${fastQ.toFixed(2)}, max=${maxQ.toFixed(2)})`,
  };
}

function ownerForBucket(bucket, roster, perfMap) {
  switch (bucket) {
    case 'research':    return roster.researcher && { agent: roster.researcher, reason: 'research content' };
    case 'design':      return roster.designer && { agent: roster.designer, reason: 'design content' };
    case 'marketing':   return roster.cmo && { agent: roster.cmo, reason: 'marketing content' };
    case 'engineering': return chooseEngineer(roster, perfMap);
    default: return null;
  }
}

// Recent quality (avg scorecard-adjusted quality_signal, last 10) per engineer,
// used by chooseEngineer. Non-fatal on any error — the tiebreak just defaults to Fast.
async function loadEngineerQuality(roster) {
  const map = new Map();
  for (const a of [roster.engineer, roster.engineerMax]) {
    if (!a) continue;
    try {
      const prefix = `scorecard-adjusted/${a.id}/`;
      const data = await api(`/api/companies/${COMPANY_ID}/memory/records?titlePrefix=${encodeURIComponent(prefix)}&limit=10`);
      const items = (Array.isArray(data) ? data : (data.records || []))
        .filter(r => typeof r.title === 'string' && r.title.startsWith(prefix));
      if (!items.length) continue;
      const avg = items.reduce((s, r) => s + (r.metadata?.quality_signal ?? 3), 0) / items.length;
      map.set(a.id, avg);
    } catch { /* non-fatal */ }
  }
  return map;
}

// Walk up the parent chain to the nearest ancestor that has an agent assignee.
async function nearestAssignedAncestor(issue, cache) {
  let cur = issue;
  for (let hops = 0; hops < 8 && cur && cur.parentId; hops++) {
    let parent = cache.get(cur.parentId);
    if (!parent) {
      parent = await api(`/api/issues/${cur.parentId}`);
      if (parent && parent._notFound) parent = null;
      if (parent) cache.set(cur.parentId, parent);
    }
    if (!parent) break;
    if (parent.assigneeAgentId) return parent;
    cur = parent;
  }
  return null;
}

async function resolveOwner(issue, roster, ancestorCache, perfMap) {
  // a. Ownership continuity
  const anc = await nearestAssignedAncestor(issue, ancestorCache);
  if (anc && anc.assigneeAgentId && roster.byId.has(anc.assigneeAgentId)) {
    return {
      agent: roster.byId.get(anc.assigneeAgentId),
      reason: `ownership continuity — ${anc.identifier} (assigned ancestor) owned by this agent`,
      basis: 'ancestor',
    };
  }
  // b. Content routing (engineering bucket uses perf-aware Fast-vs-Max tiebreak)
  const bucket = classify(issue);
  const byContent = ownerForBucket(bucket, roster, perfMap);
  if (byContent) return { agent: byContent.agent, reason: byContent.reason, basis: 'content', bucket };
  // c. Creator fallback
  if (issue.creatorAgentId && roster.byId.has(issue.creatorAgentId)) {
    return { agent: roster.byId.get(issue.creatorAgentId), reason: 'unclear content — fell back to issue creator', basis: 'creator' };
  }
  // d. Last resort: CEO triages
  if (roster.ceo) return { agent: roster.ceo, reason: 'no signal — escalated to CEO for manual triage', basis: 'ceo' };
  return null;
}

// ---- Actions ---------------------------------------------------------------

async function assign(issue, agentId) {
  if (!APPLY) return;
  await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ assigneeAgentId: agentId }) });
}

async function comment(issue, owner) {
  if (!APPLY) return;
  const body = `🧹 **Auto-routed by the orphaned-issue sweeper (${SWEEPER_ISSUE}).** ` +
    `This issue had no assigneeAgentId or assigneeUserId. Routed to **${owner.agent.name}** by ${owner.reason}. ` +
    `If this owner is wrong, reassign — the sweeper only fires on fully-unassigned issues.`;
  await api(`/api/issues/${issue.id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

async function captureRationale(issue, owner) {
  if (!APPLY) return;
  const isHot = ['high', 'critical', 'urgent'].includes((issue.priority || '').toLowerCase());
  if (!isHot) return;
  const rec = {
    title: `routing/${issue.identifier}`,
    content: `Sweeper auto-routed orphan ${issue.identifier} to ${owner.agent.name}: ${owner.reason}.`,
    metadata: {
      category: 'routing_rationale',
      issue_id: issue.identifier,
      chosen_agent: owner.agent.id,
      rationale: `Orphan (no assignee). Routed to ${owner.agent.name} via ${owner.basis}: ${owner.reason}.`,
      routing_basis: owner.basis,
      data_available: owner.basis === 'ancestor' || owner.basis === 'creator' ? true : false,
      swept_by: SWEEPER_ISSUE,
    },
    source: { kind: 'issue', issueId: SWEEPER_ISSUE },
  };
  await api(`/api/companies/${COMPANY_ID}/memory/capture`, { method: 'POST', body: JSON.stringify(rec) });
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const issues = await api(`/api/companies/${COMPANY_ID}/issues?status=todo,in_progress`);
  const list = Array.isArray(issues) ? issues : (issues.issues || []);
  const orphans = list.filter(i => !i.assigneeAgentId && !i.assigneeUserId);

  if (orphans.length === 0) {
    const msg = `✅ Orphaned-issue sweeper: all clear — 0 unassigned actionable issues across ${list.length} todo/in_progress.`;
    if (JSON_OUT) console.log(JSON.stringify({ orphans: 0, total: list.length, routed: [] }));
    else console.log(msg);
    return;
  }

  const roster = await buildRoster();
  const perfMap = await loadEngineerQuality(roster);
  const ancestorCache = new Map();
  const routed = [];

  for (const o of orphans) {
    const owner = await resolveOwner(o, roster, ancestorCache, perfMap);
    if (!owner) {
      routed.push({ issue: o.identifier, status: 'UNROUTABLE', priority: o.priority });
      continue;
    }
    await assign(o, owner.agent.id);
    await comment(o, owner);
    await captureRationale(o, owner);
    routed.push({
      issue: o.identifier, title: o.title, priority: o.priority,
      owner: owner.agent.name, ownerId: owner.agent.id, basis: owner.basis, reason: owner.reason,
    });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ orphans: orphans.length, total: list.length, applied: APPLY, routed }, null, 2));
  } else {
    console.log(`${APPLY ? '🧹 Routed' : '🔎 [dry-run] would route'} ${orphans.length} orphan(s) of ${list.length} actionable issues:`);
    for (const r of routed) {
      console.log(`  ${r.issue} [${r.priority}] -> ${r.owner || r.status} (${r.basis || 'n/a'}: ${r.reason || ''})`);
    }
    if (!APPLY) console.log('\nRe-run with --apply to execute.');
  }
}

main().catch(e => { console.error('Sweeper failed:', e.message); process.exit(1); });
