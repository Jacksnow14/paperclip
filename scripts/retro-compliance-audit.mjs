#!/usr/bin/env node
/**
 * retro-compliance-audit.mjs — Daily retrospective compliance audit (AUR-2694, AUR-2851).
 *
 * Scans issues closed (completedAt) with status=done in the last N hours, checks each for:
 *   1. A `## Retrospective` heading in its comments.
 *   2. A `performance_scorecard` memory record referencing the issue.
 *   3. A `scorecard_adjusted` memory record referencing the issue.
 *
 * SCOPE POLICY (AUR-2851):
 *   - Only `done` issues are in scope. `cancelled` issues are EXCLUDED — they represent
 *     abandoned work; neither a retro comment nor scorecard captures are expected.
 *   - Content-pipeline / automation closures remain exempt via isExempt().
 *
 * Dry-run by default; pass --apply to capture memory records. The digest comment
 * and run-issue summary are posted by the caller (CTO) using this script's JSON plan.
 *
 * Output: prints a human plan, then a final line `PLAN_JSON=<json>` for the caller.
 */
import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

const CONTENT_BOTS = new Set([
  'c1ddb8af-53ce-437e-b473-1f437c97739b', // Content Manager
  'a7adf6b0-d9e5-4553-a164-02fd2bdd09e1', // Script Writer
  '8db80b88-312e-4729-92ec-ea842e5d1ad7', // Video Editor
]);
const CTO = '371a1b08-0286-4a12-a516-f587f42df5eb';

/**
 * Retrospective heading detector — matches the literal `## Retrospective` heading.
 *
 * MISFILED-RETRO HARDENING (AUR-3203): a bare `## Retrospective` string is not enough.
 * A retro authored for a *different* issue (e.g. `## Retrospective — AUR-3164 …` sitting
 * on AUR-1876's thread) must NOT read as compliant. So when a heading carries an issue
 * identifier (`## Retrospective — AUR-XXX`), it only counts if that identifier matches the
 * audited issue. Headings with no identifier still count (backward-compatible with retros
 * that omit the id), as do all headings when the audited issue has no identifier.
 */
export function hasRetro(comments, issue) {
  const wantId = (issue?.identifier ?? '').toUpperCase();
  const headingRe = /(^|\n)[ \t]*##[ \t]*Retrospective\b([^\n]*)/gi;
  return comments.some(c => {
    const text = c.body ?? c.content ?? '';
    headingRe.lastIndex = 0;
    let m;
    while ((m = headingRe.exec(text)) !== null) {
      const idInHeading = (m[2] || '').match(/\b([A-Za-z]{2,}-\d+)\b/);
      // No identifier on the heading (or no audited identifier to compare) → accept.
      if (!idInHeading || !wantId) return true;
      // Identifier present → only compliant when it names the audited issue.
      if (idInHeading[1].toUpperCase() === wantId) return true;
      // Otherwise it's a misfiled retro for another issue; keep scanning this comment.
    }
    return false;
  });
}

/** AUR-2694 exemption: content-pipeline / automation closures never emit retros. */
export function isExempt(issue) {
  if (CONTENT_BOTS.has(issue.assigneeAgentId)) return { exempt: true, reason: 'content-bot assignee' };
  const title = issue.title ?? '';
  const desc = issue.description ?? '';
  if (/content slot/i.test(title)) return { exempt: true, reason: 'title:content slot' };
  if (/^\s*write script\b/i.test(title) && /workflow signal/i.test(desc)) return { exempt: true, reason: 'title:write script + workflow signal' };
  if (/^\s*render & upload\b/i.test(title) && /video editor render task/i.test(desc)) return { exempt: true, reason: 'title:render & upload + video editor render task' };
  if (/daily\b.*\bbrief/i.test(title)) return { exempt: true, reason: 'title:daily brief' };
  if (issue.originKind && issue.originKind !== 'manual') return { exempt: true, reason: `originKind:${issue.originKind}` };
  return { exempt: false, reason: null };
}

/**
 * Checks if memory records include a `performance_scorecard` for this issue.
 * Matches on metadata.issue_id (UUID or identifier string) or metadata.issue_identifier.
 * Production records often store the identifier (e.g. "AUR-2817") in issue_id rather than the UUID.
 */
export function hasPerformanceScorecard(memRecords, issue) {
  return memRecords.some(r =>
    r.metadata?.category === 'performance_scorecard' &&
    (r.metadata?.issue_id === issue.id || r.metadata?.issue_id === issue.identifier || r.metadata?.issue_identifier === issue.identifier)
  );
}

/**
 * Checks if memory records include a `scorecard_adjusted` record for this issue.
 * Matches on metadata.issue_id (UUID or identifier string) or metadata.issue_identifier.
 * Production records often store the identifier (e.g. "AUR-2817") in issue_id rather than the UUID.
 */
export function hasScorecardAdjusted(memRecords, issue) {
  return memRecords.some(r =>
    r.metadata?.category === 'scorecard_adjusted' &&
    (r.metadata?.issue_id === issue.id || r.metadata?.issue_id === issue.identifier || r.metadata?.issue_identifier === issue.identifier)
  );
}

/**
 * Fetches memory records org-wide AND per project (for any project-scoped issues),
 * returning a deduplicated merged array.  This ensures project-scoped scorecards
 * (invisible to the org-wide endpoint) are not silently missed.
 * Exported for unit testing.
 */
export async function fetchMergedMemRecords(get, companyId, issues) {
  const orgRaw = await get(`/api/companies/${companyId}/memory/records?limit=500`);
  const orgRecords = asArray(orgRaw, 'records');

  const projectIds = [...new Set(issues.map(i => i.projectId).filter(Boolean))];
  const projSets = await Promise.all(
    projectIds.map(async pid => {
      try {
        const r = await get(`/api/companies/${companyId}/memory/records?projectId=${encodeURIComponent(pid)}&limit=500`);
        return asArray(r, 'records');
      } catch { return []; }
    })
  );

  const seen = new Set(orgRecords.map(r => r.id).filter(Boolean));
  const merged = [...orgRecords];
  for (const set of projSets) {
    for (const r of set) {
      if (r.id && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    }
  }
  return merged;
}

function makeApi(API_URL, headers) {
  async function get(path) {
    const r = await fetch(`${API_URL}${path}`, { headers });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${r.statusText}`);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${r.statusText} :: ${await r.text().catch(() => '')}`);
    return r.json();
  }
  return { get, post };
}

const asArray = (j, key) => Array.isArray(j) ? j : (j?.[key] ?? Object.values(j).filter(v => typeof v === 'object'));

export async function main({ hours, apply, apiUrl, apiKey, companyId, runIssueId }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const { get, post } = makeApi(apiUrl, headers);
  const since = Date.now() - hours * 3600 * 1000;

  // Agent roster → manager map
  const agentsRaw = await get(`/api/companies/${companyId}/agents`);
  const agents = asArray(agentsRaw, 'agents');
  const agentById = new Map(agents.map(a => [a.id, a]));
  const nameOf = id => agentById.get(id)?.name ?? id;
  const managerOf = id => agentById.get(id)?.reportsTo ?? null;

  // SCOPE: only `done` issues; `cancelled` is excluded (see module header for policy).
  const issuesRaw = await get(`/api/companies/${companyId}/issues?status=done&limit=500`);
  const issues = asArray(issuesRaw, 'issues');
  const closedRecent = issues.filter(i => {
    const t = i.completedAt;
    return t && new Date(t).getTime() >= since && i.id !== runIssueId;
  });

  // Fetch memory records for scorecard presence checks.
  // Merges org-wide + per-project results so project-scoped scorecards (invisible
  // to the org-wide endpoint) are not falsely flagged as missing (AUR-2858 fix).
  let memRecords = [];
  try {
    memRecords = await fetchMergedMemRecords(get, companyId, closedRecent);
  } catch (e) {
    console.warn(`[warn] Could not fetch memory records for scorecard checks: ${e.message}`);
  }

  const compliant = [];   // retro + both scorecards present
  const exempt = [];
  const retroGaps = [];   // missing `## Retrospective` comment
  const scorecardGaps = []; // has retro, missing performance or scorecard-adjusted record

  for (const issue of closedRecent) {
    const ex = isExempt(issue);
    if (ex.exempt) { exempt.push({ issue, reason: ex.reason }); continue; }

    let comments = [];
    try { comments = asArray(await get(`/api/issues/${issue.id}/comments`), 'comments'); }
    catch { comments = []; }

    const retroOk = hasRetro(comments, issue);
    const perfOk = hasPerformanceScorecard(memRecords, issue);
    const adjOk = hasScorecardAdjusted(memRecords, issue);
    const scorecardOk = perfOk && adjOk;

    if (retroOk && scorecardOk) {
      compliant.push(issue);
    } else {
      if (!retroOk) retroGaps.push(issue);
      // Report scorecard gap even when retro is also missing (distinct fix needed).
      if (!scorecardOk) scorecardGaps.push({ issue, missingPerf: !perfOk, missingAdj: !adjOk });
    }
  }

  // Resolve manager-to-notify for each gap.
  function toGapEntry(issue) {
    const owner = issue.assigneeAgentId ?? null;
    let mgr = owner ? managerOf(owner) : null;
    let mgrSource = 'reportsTo';
    if (!mgr) {
      if (owner) { mgr = owner; mgrSource = 'owner (no manager)'; }
      else { mgr = CTO; mgrSource = 'fallback:CTO (unassigned)'; }
    }
    return {
      identifier: issue.identifier, id: issue.id, title: issue.title,
      assigneeAgentId: owner, assigneeName: owner ? nameOf(owner) : null,
      managerId: mgr, managerName: nameOf(mgr), managerSource: mgrSource,
      ownedByAudit: owner === CTO, closedAt: issue.completedAt,
    };
  }

  const retroGapPlan = retroGaps.map(i => toGapEntry(i));
  const scorecardGapPlan = scorecardGaps.map(({ issue, missingPerf, missingAdj }) => ({
    ...toGapEntry(issue), missingPerf, missingAdj,
  }));

  // Plan output
  console.log(`\n=== Retro Compliance Audit (window ${hours}h, since ${new Date(since).toISOString()}) ===`);
  console.log(`Scope: done-only (cancelled excluded per AUR-2851 policy)`);
  console.log(`Scanned: ${closedRecent.length} | Fully Compliant: ${compliant.length} | Exempt: ${exempt.length} | Retro Gaps: ${retroGaps.length} | Scorecard Gaps: ${scorecardGaps.length}\n`);

  console.log('-- EXEMPT --');
  exempt.forEach(e => console.log(`  ${e.issue.identifier}  [${e.reason}]  ${e.issue.title.slice(0, 70)}`));

  console.log('\n-- FULLY COMPLIANT (retro + scorecards) --');
  compliant.forEach(i => console.log(`  ${i.identifier}  ${i.title.slice(0, 70)}`));

  console.log('\n-- RETRO GAPS (missing ## Retrospective comment) --');
  retroGapPlan.forEach(m => console.log(`  ${m.identifier}  assignee=${m.assigneeName}  notify→${m.managerName} (${m.managerSource})  ${m.title.slice(0, 60)}`));

  console.log('\n-- SCORECARD GAPS (missing performance or scorecard-adjusted memory record) --');
  scorecardGapPlan.forEach(m => {
    const missing = [m.missingPerf && 'performance_scorecard', m.missingAdj && 'scorecard_adjusted'].filter(Boolean).join(', ');
    console.log(`  ${m.identifier}  assignee=${m.assigneeName}  notify→${m.managerName} (${m.managerSource})  missing=[${missing}]  ${m.title.slice(0, 50)}`);
  });

  // Capture gap records
  if (apply) {
    console.log('\n-- CAPTURING retro gap records --');
    for (const m of retroGapPlan) {
      const body = {
        title: `retrospective-compliance/missing/${m.identifier}`,
        content: `Closed issue ${m.identifier} ("${m.title}") has no '## Retrospective' comment. Assignee ${m.assigneeName ?? 'unassigned'}; manager notified: ${m.managerName}.`,
        metadata: {
          category: 'retrospective_compliance_gap',
          gap_type: 'missing_retro',
          issue_identifier: m.identifier, issue_id: m.id, title: m.title,
          assignee_agent_id: m.assigneeAgentId, manager_agent_id: m.managerId,
          manager_source: m.managerSource, closed_at: m.closedAt,
          audited_at: new Date().toISOString(),
        },
        source: { kind: 'issue', issueId: runIssueId },
      };
      try { await post(`/api/companies/${companyId}/memory/capture`, body); console.log(`  captured ${body.title}`); }
      catch (e) { console.log(`  FAILED ${body.title}: ${e.message}`); }
    }

    console.log('\n-- CAPTURING scorecard gap records --');
    for (const m of scorecardGapPlan) {
      const missing = [m.missingPerf && 'performance_scorecard', m.missingAdj && 'scorecard_adjusted'].filter(Boolean).join(', ');
      const body = {
        title: `retrospective-compliance/scorecard-missing/${m.identifier}`,
        content: `Closed issue ${m.identifier} ("${m.title}") is missing scorecard captures: [${missing}]. Assignee ${m.assigneeName ?? 'unassigned'}; manager notified: ${m.managerName}.`,
        metadata: {
          category: 'retrospective_compliance_gap',
          gap_type: 'missing_scorecard',
          missing_records: [m.missingPerf && 'performance_scorecard', m.missingAdj && 'scorecard_adjusted'].filter(Boolean),
          issue_identifier: m.identifier, issue_id: m.id, title: m.title,
          assignee_agent_id: m.assigneeAgentId, manager_agent_id: m.managerId,
          manager_source: m.managerSource, closed_at: m.closedAt,
          audited_at: new Date().toISOString(),
        },
        source: { kind: 'issue', issueId: runIssueId },
      };
      try { await post(`/api/companies/${companyId}/memory/capture`, body); console.log(`  captured ${body.title}`); }
      catch (e) { console.log(`  FAILED ${body.title}: ${e.message}`); }
    }
  }

  const plan = {
    window_hours: hours, scanned: closedRecent.length,
    scope_policy: 'done-only; cancelled excluded (AUR-2851)',
    compliant: compliant.map(i => i.identifier),
    exempt: exempt.map(e => ({ id: e.issue.identifier, reason: e.reason })),
    retro_gaps: retroGapPlan,
    scorecard_gaps: scorecardGapPlan,
  };
  console.log(`\nPLAN_JSON=${JSON.stringify(plan)}`);
  return plan;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      hours: { type: 'string', default: '24' },
      apply: { type: 'boolean', default: false },
      'run-issue-id': { type: 'string' },
    },
  });
  resolveApiBase().then(apiUrl => main({
    hours: parseInt(args.hours, 10), apply: args.apply,
    apiUrl, apiKey: process.env.PAPERCLIP_API_KEY,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    runIssueId: args['run-issue-id'] ?? 'bf68742f-63a2-4849-b931-9b179c50fcb5',
  })).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
