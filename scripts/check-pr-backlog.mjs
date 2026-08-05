#!/usr/bin/env node
/**
 * PR-backlog dispatcher (AUR-4990 class: improvements must never strand).
 *
 * The failure mode this guards: 74 open PRs accumulated between May and
 * August 2026 because nothing routed them to a reviewer — merged only when a
 * human manually drove the backlog (2026-08-05). Detection alone exists
 * (#191 merge-debt alarm pages when CLEAN PRs pile up); this script closes
 * the loop by DISPATCHING the work: for every open PR it files exactly one
 * Paperclip issue per (PR, head sha), assigned to the strongest available
 * code-review agent, whose assignment wake triggers a run that reviews,
 * corrects, and lands (or closes) the PR.
 *
 * Dispatch semantics:
 *   - One issue per PR@sha7. A new push to the PR re-arms dispatch for the
 *     new sha; the state file remembers the last filed sha per PR.
 *   - Draft PRs are skipped (author explicitly opted out of review).
 *   - PRs still open past --stale-hours (default 72) escalate via the alert
 *     command (Telegram), rate-limited to once per 24h per PR. Escalation is
 *     an alarm about the PIPELINE (reviewer not landing work), never a
 *     request for the founder to review code.
 *   - Reviewer resolution: --reviewer name (default "Claude Code Max"),
 *     matched against /agents by exact name; instances in error/terminated
 *     status are ignored; prefer running > idle. Fail LOUD (exit 2) if no
 *     usable instance — a dispatcher that silently files unassigned issues
 *     reads as "backlog handled" while nothing executes.
 *
 * Exit codes: 0 = swept (possibly nothing to do) · 2 = could not measure or
 * could not dispatch (transport/API/agent-resolution failure). Loud and
 * distinct: an unreachable dispatcher must never read as an empty backlog.
 *
 * Requires: `gh` CLI authenticated (uses `gh api` only). Issue filing needs
 * PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID in the environment.
 *
 * Usage:
 *   node scripts/check-pr-backlog.mjs                # sweep and dispatch
 *   node scripts/check-pr-backlog.mjs --dry-run      # sweep, print, file nothing
 *   --repo owner/name    (default Jacksnow14/paperclip)
 *   --reviewer NAME      (default "Claude Code Max")
 *   --stale-hours H      (default 72)
 *   --state-dir DIR      (default $HOME/.paperclip/pr-review-dispatch)
 *   --alert-cmd PATH     (default /home/ievgen/bot/telegram-alert.sh)
 *   --api-base URL       (default http://127.0.0.1:3100)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const HOUR_MS = 60 * 60 * 1000;
const ESCALATION_INTERVAL_MS = 24 * HOUR_MS;

/** Pure: decide which PRs need a review issue filed and which escalate. */
export function decideActions({ prs, state, nowMs, staleHours }) {
  const file = [];
  const escalate = [];
  for (const pr of prs) {
    if (pr.draft) continue;
    const sha7 = (pr.headSha ?? '').slice(0, 7);
    if (!sha7) continue;
    const entry = state.prs?.[String(pr.number)] ?? {};
    if (entry.filedSha !== sha7) {
      file.push({ number: pr.number, sha7, title: pr.title });
    }
    const ageMs = nowMs - Date.parse(pr.createdAt ?? '');
    const lastEsc = entry.escalatedAt ? Date.parse(entry.escalatedAt) : 0;
    if (
      Number.isFinite(ageMs) &&
      ageMs > staleHours * HOUR_MS &&
      nowMs - lastEsc > ESCALATION_INTERVAL_MS
    ) {
      escalate.push({ number: pr.number, ageHours: Math.floor(ageMs / HOUR_MS), title: pr.title });
    }
  }
  return { file, escalate };
}

/** Pure: pick the reviewer agent instance. running > idle; never error/terminated. */
export function pickReviewer(agents, name) {
  const usable = agents.filter(
    (a) => a.name === name && !['error', 'terminated'].includes(a.status ?? ''),
  );
  usable.sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1));
  return usable[0] ?? null;
}

export function issueTitle(pr) {
  return `pr-review/PR-${pr.number}@${pr.sha7}: review, correct and land`;
}

export function issueBody(pr, repo) {
  return [
    `Filed automatically by scripts/check-pr-backlog.mjs — the PR-backlog dispatcher.`,
    '',
    `**PR:** https://github.com/${repo}/pull/${pr.number} — ${pr.title}`,
    `**Head:** \`${pr.sha7}\` (this issue covers exactly this head; a new push re-files).`,
    '',
    '## Your mandate',
    '',
    'You hold FINAL review authority for this PR. The founder does not read or',
    'review code — never ask the founder to review, approve, or look at a diff;',
    'never mark this issue blocked on founder input for a code decision. Escalate',
    'to the founder ONLY for money, credentials, or irreversible product/data',
    'decisions — never for code quality questions.',
    '',
    '## Procedure (single PR — never batch)',
    '',
    '1. Check trunk first: `node scripts/check-trunk-ci-red.mjs --dry-run`.',
    '   Do not merge over a red trunk — fix trunk first or park with a comment.',
    '2. Deep-review the diff against CURRENT origin/master: correctness, security,',
    '   supersession (is this already implemented on master? grep for its symbols),',
    '   test adequacy, CI status (`gh pr checks N` — distinguish PR-caused failures',
    '   from stale-base/known-flake failures by reading the failing job log).',
    '3. Verdict and act:',
    '   - **Sound** → rebase onto master if behind, re-run targeted tests +',
    '     per-package `tsc --noEmit` (server needs `--max-old-space-size=3072`;',
    '     the repo-root typecheck wrapper is memory-gated), then',
    '     `gh pr merge N --squash --delete-branch`. On a transient "not mergeable"',
    '     right after a push, wait ~30s and retry once before re-rebasing.',
    '   - **Fixable defects** → fix them yourself on the PR branch (work in a',
    '     dedicated worktree, NEVER the shared /home/ievgen/paperclip clone),',
    '     force-push, then merge as above.',
    '   - **Superseded/wrong** → comment on the PR with concrete evidence',
    '     (master commit/symbol), close it, and disposition its linked issue.',
    '4. Close the loop: transition the AUR issue referenced in the PR title/body',
    '   to done (or cancelled if the PR was closed as superseded).',
    '5. Migrations: if the PR adds a migration, renumber to the next free slot on',
    '   current master and keep `_journal.json` idx order (`pnpm check:migrations`',
    '   in packages/db validates).',
    '',
    'When the work is finished this issue must be done and the PR must be either',
    'merged or closed — an open PR with a done review issue is a pipeline defect.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    repo: 'Jacksnow14/paperclip',
    reviewer: 'Claude Code Max',
    staleHours: 72,
    stateDir: join(process.env.HOME ?? '/home/ievgen', '.paperclip', 'pr-review-dispatch'),
    alertCmd: '/home/ievgen/bot/telegram-alert.sh',
    apiBase: 'http://127.0.0.1:3100',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--reviewer') args.reviewer = argv[++i];
    else if (a === '--stale-hours') args.staleHours = Number(argv[++i]);
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function loadState(stateDir) {
  const f = join(stateDir, 'state.json');
  if (!existsSync(f)) return { prs: {} };
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return { prs: {} };
  }
}

function saveState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

async function api(args, method, path, body) {
  const res = await fetch(`${args.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!args.dryRun && (!apiKey || !companyId)) {
    console.error('FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot dispatch.');
    process.exit(2);
  }

  let openPrs;
  try {
    openPrs = ghJson(`repos/${args.repo}/pulls?state=open&per_page=100`).map((p) => ({
      number: p.number,
      title: p.title,
      draft: Boolean(p.draft),
      headSha: p.head?.sha ?? '',
      createdAt: p.created_at,
    }));
  } catch (err) {
    console.error(`FATAL: could not list open PRs: ${err.message}`);
    process.exit(2);
  }

  const state = loadState(args.stateDir);
  const { file, escalate } = decideActions({
    prs: openPrs,
    state,
    nowMs: Date.now(),
    staleHours: args.staleHours,
  });

  console.log(
    `open=${openPrs.length} to-file=${file.length} to-escalate=${escalate.length} (reviewer: ${args.reviewer})`,
  );

  if (args.dryRun) {
    for (const f of file) console.log(`DRY-RUN: would file ${issueTitle(f)}`);
    for (const e of escalate) {
      console.log(`DRY-RUN: would escalate PR #${e.number} (open ${e.ageHours}h)`);
    }
    return;
  }
  if (file.length === 0 && escalate.length === 0) return;

  let reviewer = null;
  if (file.length > 0) {
    const agents = await api(args, 'GET', `/api/companies/${companyId}/agents`);
    reviewer = pickReviewer(Array.isArray(agents) ? agents : agents.agents ?? [], args.reviewer);
    if (!reviewer) {
      console.error(`FATAL: no usable instance of reviewer agent "${args.reviewer}".`);
      process.exit(2);
    }
  }

  for (const f of file) {
    const created = await api(args, 'POST', `/api/companies/${companyId}/issues`, {
      title: issueTitle(f),
      description: issueBody(f, args.repo),
      priority: 'high',
      assigneeAgentId: reviewer.id,
    });
    // 201 is not proof — read the row back before recording the dispatch.
    await api(args, 'GET', `/api/issues/${created.id}`);
    state.prs[String(f.number)] = {
      ...(state.prs[String(f.number)] ?? {}),
      filedSha: f.sha7,
      filedAt: new Date().toISOString(),
      issue: created.identifier ?? created.id,
    };
    saveState(args.stateDir, state);
    console.log(`filed ${created.identifier ?? created.id} for PR #${f.number}@${f.sha7}`);
  }

  for (const e of escalate) {
    try {
      execFileSync(args.alertCmd, [
        'SEV2',
        `pr-backlog: PR #${e.number} open ${e.ageHours}h without landing — ${e.title}. ` +
          `Review pipeline is not keeping up (this is a pipeline alarm, not a code-review request).`,
      ]);
      state.prs[String(e.number)] = {
        ...(state.prs[String(e.number)] ?? {}),
        escalatedAt: new Date().toISOString(),
      };
      saveState(args.stateDir, state);
    } catch (err) {
      console.error(`escalation for PR #${e.number} failed: ${err.message}`);
    }
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  });
}
