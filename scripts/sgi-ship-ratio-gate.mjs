#!/usr/bin/env node
/**
 * AUR-5207 — Second admission gate: rolling 7d merged-PR ratio.
 *
 * The founder's finding on AUR-5168: 81 merged PRs into paperclip
 * (self-improvement) vs 2 into Auranode (money-making) over 7 days —
 * 97.6% self-improvement against a required 2:1 money-making:self-improvement
 * floor. AUR-5168's token-spend cap alone cannot see this: an unreviewed PR
 * sitting open costs zero ongoing tokens, so a fleet can stay "compliant" on
 * spend while shipping almost nothing that makes money. This script computes
 * the merge-ratio side out-of-band (the control-plane server has no GitHub
 * credentials) and POSTs a snapshot that server/src/services/heartbeat.ts
 * reads to shed self-improvement admission — ANDed with, never averaged
 * with, the AUR-5168 token cap.
 *
 * Repo-of-record beats self-declared workClass (anti-gaming, per the
 * founder's comment): relabeling a paperclip PR "revenue" cannot move it out
 * of the self-improvement bucket. When a merged PR's linked issue carries an
 * explicit workClass that disagrees with the repo it landed in, the repo
 * wins for the ratio and the disagreement is logged, never silently
 * resolved.
 *
 * closed-without-merge PRs (e.g. AUR-5173 clearing stale Auranode PRs) are
 * reported but excluded from the ratio entirely — not scored as shipped,
 * not scored as a shipping failure.
 *
 * Requires: `gh` CLI authenticated (uses `gh pr list` only, read-only).
 * Issue/snapshot writes need PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID.
 *
 * Usage:
 *   node scripts/sgi-ship-ratio-gate.mjs             # compute + POST snapshot
 *   node scripts/sgi-ship-ratio-gate.mjs --dry-run   # compute + print only
 */

import { execFileSync } from 'node:child_process';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

let API_URL = '';
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const TASK_ID = process.env.PAPERCLIP_TASK_ID;

export const MONEY_MAKING_REPO = 'Jacksnow14/Auranode';
export const SELF_IMPROVEMENT_REPO = 'Jacksnow14/paperclip';
export const WINDOW_DAYS = 7;
export const SHIP_RATIO_FLOOR = 2;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// ---- Pure helpers (exported for unit tests) --------------------------------

/** Pure: which money-making/self-improvement bucket a repo belongs to. */
export function repoWorkClass(repo) {
  return repo === MONEY_MAKING_REPO ? 'revenue' : 'self_improvement';
}

/** Pure: split gh's closed-PR list into merged vs closed-without-merge. */
export function partitionPrs(prs) {
  const merged = prs.filter((p) => Boolean(p.mergedAt));
  const closedWithoutMerge = prs.filter((p) => !p.mergedAt);
  return { merged, closedWithoutMerge };
}

/** Pure: pull the first AUR-NNNN token out of a PR's title (body as fallback). */
export function extractIssueIdentifier(pr) {
  const haystack = `${pr.title || ''} ${pr.body || ''}`;
  const m = /AUR-\d+/i.exec(haystack);
  return m ? m[0].toUpperCase() : null;
}

/** Pure: floor-vs-ratio, mirrors server/src/services/ship-ratio-gate.ts computeRatio. */
export function computeRatio(moneyMakingMerged, selfImprovementMerged) {
  return moneyMakingMerged / Math.max(selfImprovementMerged, 1);
}

/**
 * Pure: repo-of-record wins on disagreement (anti-gaming) — this returns the
 * logged disagreement, never a "corrected" ratio input.
 */
export function detectDisagreement({ repo, prNumber, issueIdentifier, issueWorkClass }) {
  const expected = repoWorkClass(repo);
  if (!issueWorkClass || issueWorkClass === expected) return null;
  return { prNumber, repo, repoWorkClass: expected, issueIdentifier, issueWorkClass };
}

export function renderCommentBody({ summary, disagreements }) {
  const ratioLine = `Ratio: **${summary.ratio.toFixed(2)}:1** (floor ${SHIP_RATIO_FLOOR}:1) — ${
    summary.overCap ? '⚠️ **OVER CAP — shedding self-improvement admission**' : '✅ within floor'
  }`;
  const disagreeLine = disagreements.length
    ? `\n- ⚠️ ${disagreements.length} repo/workClass disagreement(s) (repo wins): ${disagreements
        .map((d) => `${d.repo}#${d.prNumber} repo=${d.repoWorkClass} vs issue ${d.issueIdentifier}=${d.issueWorkClass}`)
        .join('; ')}`
    : '';
  return [
    '## AUR-5207 — Ship-Ratio Gate (7d merged-PR ratio)',
    '',
    `Money-making merged: **${summary.moneyMakingMerged}** (${MONEY_MAKING_REPO}) · Self-improvement merged: **${summary.selfImprovementMerged}** (${SELF_IMPROVEMENT_REPO})`,
    ratioLine,
    `Closed without merge (reported, not scored either way): money-making ${summary.moneyMakingClosedWithoutMerge}, self-improvement ${summary.selfImprovementClosedWithoutMerge}`,
    disagreeLine,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- IO ---------------------------------------------------------------------

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${API_KEY}`,
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

async function postComment(issueId, body) {
  return apiFetch(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

function ghPrList(repo, sinceDate) {
  const out = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'closed',
      '--search',
      `closed:>=${sinceDate}`,
      '--json',
      'number,title,body,mergedAt,closedAt',
      '--limit',
      '200',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

/**
 * Fetch + partition one repo's window, cross-checking each merged PR's
 * linked issue workClass against the repo-derived class. Best-effort per PR:
 * an issue lookup failure is logged and skipped, never fatal to the sweep.
 */
async function classifyRepo(repo, sinceDate, disagreements) {
  const prs = ghPrList(repo, sinceDate);
  const { merged, closedWithoutMerge } = partitionPrs(prs);

  for (const pr of merged) {
    const identifier = extractIssueIdentifier(pr);
    if (!identifier) continue;
    let issue;
    try {
      issue = await apiFetch(`/api/issues/${identifier}`);
    } catch (err) {
      console.error(`[ship-ratio-gate] could not fetch ${identifier} for ${repo}#${pr.number}: ${err.message}`);
      continue;
    }
    if (!issue || issue._notFound) continue;
    const d = detectDisagreement({
      repo,
      prNumber: pr.number,
      issueIdentifier: identifier,
      issueWorkClass: issue.workClass || null,
    });
    if (d) disagreements.push(d);
  }

  return { merged: merged.length, closedWithoutMerge: closedWithoutMerge.length };
}

async function main() {
  API_URL = await resolveApiBase();

  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const sinceDate = windowStart.toISOString().slice(0, 10);

  const disagreements = [];
  const [moneyMaking, selfImprovement] = [
    await classifyRepo(MONEY_MAKING_REPO, sinceDate, disagreements),
    await classifyRepo(SELF_IMPROVEMENT_REPO, sinceDate, disagreements),
  ];

  const ratio = computeRatio(moneyMaking.merged, selfImprovement.merged);
  const overCap = ratio < SHIP_RATIO_FLOOR;

  const summary = {
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    moneyMakingMerged: moneyMaking.merged,
    selfImprovementMerged: selfImprovement.merged,
    moneyMakingClosedWithoutMerge: moneyMaking.closedWithoutMerge,
    selfImprovementClosedWithoutMerge: selfImprovement.closedWithoutMerge,
    ratio,
    overCap,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ status: 'dry-run', ...summary, disagreements }, null, 2));
    return { dryRun: true, ...summary, disagreements };
  }

  if (!API_KEY || !COMPANY_ID) {
    console.error('FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot record snapshot.');
    process.exit(2);
  }

  const recorded = await apiFetch(`/api/companies/${COMPANY_ID}/ship-ratio-snapshot`, {
    method: 'POST',
    body: JSON.stringify({
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      moneyMakingMerged: summary.moneyMakingMerged,
      selfImprovementMerged: summary.selfImprovementMerged,
      moneyMakingClosedWithoutMerge: summary.moneyMakingClosedWithoutMerge,
      selfImprovementClosedWithoutMerge: summary.selfImprovementClosedWithoutMerge,
      disagreements,
      createdByRunId: RUN_ID || null,
    }),
  });

  if (TASK_ID) {
    await postComment(TASK_ID, renderCommentBody({ summary, disagreements }));
  }

  return { ...summary, disagreements, snapshotId: recorded && recorded.id };
}

// Only the CLI entrypoint runs main() — importing this module (e.g. from a
// test) for its pure helpers must never trigger a `gh` shell-out or network
// call as a side effect of import.
const isCliEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCliEntrypoint) {
  main()
    .then((result) => {
      console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
    })
    .catch((err) => {
      console.error('ship-ratio-gate error:', err.message);
      process.exit(1);
    });
}
