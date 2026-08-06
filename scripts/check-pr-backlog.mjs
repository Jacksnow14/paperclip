#!/usr/bin/env node
/**
 * PR-backlog dispatcher (AUR-4990 class: improvements must never strand).
 *
 * The failure mode this guards: 74 open PRs accumulated between May and
 * August 2026 because nothing routed them to a reviewer — merged only when a
 * human manually drove the backlog (2026-08-05). Detection alone exists
 * (#191 merge-debt alarm pages when CLEAN PRs pile up); this script closes
 * the loop by DISPATCHING the work: for every open PR it files exactly one
 * Paperclip issue per (repo, PR, head sha), assigned to the strongest
 * available code-review agent, whose assignment wake triggers a run that
 * reviews, corrects, and lands (or closes) the PR.
 *
 * Dispatch semantics:
 *   - Sweeps EVERY repo in the --repo list (default: the control plane AND
 *     the product repo — AUR-5111: sweeping only paperclip left 20 Auranode
 *     PRs invisible). State keys on (repo, PR number); bare-number rows from
 *     the pre-AUR-5111 format are migrated on load.
 *   - One issue per repo#PR@sha7. A new push to the PR re-arms dispatch for
 *     the new sha; the state file remembers the last filed sha per (repo, PR).
 *   - Draft PRs are skipped (author explicitly opted out of review).
 *   - PRs still open past --stale-hours (default 72) escalate via the alert
 *     command (Telegram) as ONE batched message per repo per run, rate-limited
 *     to once per 24h per PR. Escalation is an alarm about the PIPELINE
 *     (reviewer not landing work), never a request for the founder to review
 *     code — and a backlog of N stale PRs is one alarm, not N pages.
 *   - Reviewer resolution: --reviewer name (default "Claude Code Max"),
 *     matched against /agents by exact name; instances in error/terminated
 *     status are ignored; prefer running > idle. Fail LOUD (exit 2) if no
 *     usable instance — a dispatcher that silently files unassigned issues
 *     reads as "backlog handled" while nothing executes.
 *   - Liveness contract (AUR-5111): every sweep prints one summary line per
 *     repo (`repo=... open=N to-file=M ...`) BEFORE doing anything else with
 *     the result, and a repo whose PRs cannot be enumerated logs FATAL and
 *     forces exit 2 after the remaining repos are swept. An empty journal
 *     from a timer run is therefore itself the alarm.
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
 *   --repo owner/name[,owner/name...]   (repeatable; default sweeps
 *                                        Jacksnow14/paperclip AND Jacksnow14/Auranode)
 *   --reviewer NAME      (default "Claude Code Max")
 *   --stale-hours H      (default 72)
 *   --state-dir DIR      (default $HOME/.paperclip/pr-review-dispatch)
 *   --alert-cmd PATH     (default /home/ievgen/bot/telegram-alert.sh)
 *   --api-base URL       (default http://127.0.0.1:3100)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HOUR_MS = 60 * 60 * 1000;
const ESCALATION_INTERVAL_MS = 24 * HOUR_MS;

export const DEFAULT_REPOS = ['Jacksnow14/paperclip', 'Jacksnow14/Auranode'];

// Every state row written before (repo, pr) keying came from a sweep of the
// then-hardcoded single default repo.
const LEGACY_STATE_REPO = 'Jacksnow14/paperclip';

export function stateKey(repo, number) {
  return `${repo}#${number}`;
}

/** Pure: rekey legacy bare-PR-number state rows under the repo that filed them. */
export function migrateState(state) {
  const prs = {};
  for (const [key, entry] of Object.entries(state?.prs ?? {})) {
    prs[/^\d+$/.test(key) ? stateKey(LEGACY_STATE_REPO, key) : key] = entry;
  }
  return { version: 2, prs };
}

/** Pure: decide which PRs need a review issue filed and which escalate. */
export function decideActions({ repo, prs, state, nowMs, staleHours }) {
  const file = [];
  const escalate = [];
  for (const pr of prs) {
    if (pr.draft) continue;
    const sha7 = (pr.headSha ?? '').slice(0, 7);
    if (!sha7) continue;
    const entry = state.prs?.[stateKey(repo, pr.number)] ?? {};
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

export function issueTitle(pr, repo) {
  const short = repo.includes('/') ? repo.split('/')[1] : repo;
  return `pr-review/${short}#${pr.number}@${pr.sha7}: review, correct and land`;
}

/** Pure: one batched pipeline alarm per repo per run — a stale backlog is one page, not N. */
export function escalationMessage(repo, escalate, staleHours) {
  const sorted = [...escalate].sort((a, b) => b.ageHours - a.ageHours);
  const shown = sorted
    .slice(0, 8)
    .map((e) => `#${e.number}(${e.ageHours}h)`)
    .join(' ');
  const more = sorted.length > 8 ? ` (+${sorted.length - 8} more)` : '';
  return (
    `pr-backlog[${repo}]: ${sorted.length} PR(s) open >${staleHours}h without landing — ` +
    `oldest ${sorted[0].ageHours}h: ${shown}${more}. Review pipeline is not keeping up ` +
    `(this is a pipeline alarm, not a code-review request).`
  );
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
    repos: [],
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
    else if (a === '--repo') {
      args.repos.push(
        ...String(argv[++i] ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      );
    } else if (a === '--reviewer') args.reviewer = argv[++i];
    else if (a === '--stale-hours') args.staleHours = Number(argv[++i]);
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.repos.length === 0) args.repos = [...DEFAULT_REPOS];
  return args;
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function loadState(stateDir) {
  const f = join(stateDir, 'state.json');
  if (!existsSync(f)) return migrateState({ prs: {} });
  try {
    return migrateState(JSON.parse(readFileSync(f, 'utf8')));
  } catch {
    return migrateState({ prs: {} });
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

  const state = loadState(args.stateDir);
  const sweeps = [];
  let enumerationFailures = 0;
  for (const repo of args.repos) {
    let openPrs;
    try {
      openPrs = ghJson(`repos/${repo}/pulls?state=open&per_page=100`).map((p) => ({
        number: p.number,
        title: p.title,
        draft: Boolean(p.draft),
        headSha: p.head?.sha ?? '',
        createdAt: p.created_at,
      }));
    } catch (err) {
      // Loud, but per-repo: one dead repo must not hide the other's backlog.
      console.error(`FATAL: repo=${repo} could not list open PRs: ${err.message}`);
      enumerationFailures += 1;
      continue;
    }
    const { file, escalate } = decideActions({
      repo,
      prs: openPrs,
      state,
      nowMs: Date.now(),
      staleHours: args.staleHours,
    });
    // The liveness line: printed before anything else can fail, one per repo.
    console.log(
      `repo=${repo} open=${openPrs.length} to-file=${file.length} to-escalate=${escalate.length} (reviewer: ${args.reviewer})`,
    );
    sweeps.push({ repo, file, escalate });
  }

  if (args.dryRun) {
    for (const s of sweeps) {
      for (const f of s.file) console.log(`DRY-RUN: would file ${issueTitle(f, s.repo)}`);
      if (s.escalate.length > 0) {
        console.log(`DRY-RUN: would alert: ${escalationMessage(s.repo, s.escalate, args.staleHours)}`);
      }
    }
    if (enumerationFailures > 0) process.exit(2);
    return;
  }

  const totalToFile = sweeps.reduce((n, s) => n + s.file.length, 0);
  let reviewer = null;
  if (totalToFile > 0) {
    const agents = await api(args, 'GET', `/api/companies/${companyId}/agents`);
    reviewer = pickReviewer(Array.isArray(agents) ? agents : agents.agents ?? [], args.reviewer);
    if (!reviewer) {
      console.error(`FATAL: no usable instance of reviewer agent "${args.reviewer}".`);
      process.exit(2);
    }
  }

  for (const s of sweeps) {
    for (const f of s.file) {
      const created = await api(args, 'POST', `/api/companies/${companyId}/issues`, {
        title: issueTitle(f, s.repo),
        description: issueBody(f, s.repo),
        priority: 'high',
        assigneeAgentId: reviewer.id,
      });
      // 201 is not proof — read the row back before recording the dispatch.
      await api(args, 'GET', `/api/issues/${created.id}`);
      const key = stateKey(s.repo, f.number);
      state.prs[key] = {
        ...(state.prs[key] ?? {}),
        filedSha: f.sha7,
        filedAt: new Date().toISOString(),
        issue: created.identifier ?? created.id,
      };
      saveState(args.stateDir, state);
      console.log(`filed ${created.identifier ?? created.id} for ${s.repo}#${f.number}@${f.sha7}`);
    }

    if (s.escalate.length > 0) {
      try {
        execFileSync(args.alertCmd, ['SEV2', escalationMessage(s.repo, s.escalate, args.staleHours)]);
        const escalatedAt = new Date().toISOString();
        for (const e of s.escalate) {
          const key = stateKey(s.repo, e.number);
          state.prs[key] = { ...(state.prs[key] ?? {}), escalatedAt };
        }
        saveState(args.stateDir, state);
      } catch (err) {
        console.error(`escalation for repo=${s.repo} failed: ${err.message}`);
      }
    }
  }

  if (enumerationFailures > 0) process.exit(2);
}

// AUR-5111: the timer invokes this through /opt/paperclip/app/current (a
// symlink), where import.meta.url resolves to the RELEASE realpath while
// process.argv[1] keeps the symlinked spelling — a string comparison can never
// match, so main() silently never ran while systemd logged Result=success.
// Compare realpaths on both sides.
let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly =
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  });
}
