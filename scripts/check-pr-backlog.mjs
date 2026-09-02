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
 *   - Self-healing after a purge (AUR-5370): a `filedSha` match alone no
 *     longer means "handled" — filing an issue is not the same as it being
 *     reviewed. Each sweep resolves the previously-filed issue's terminal
 *     state: `cancelled` or not-found re-files (a cancelled review is
 *     unreviewed work, not finished work); `done` while the PR is STILL OPEN
 *     is logged loudly as a pipeline defect and re-files; any open status
 *     skips, as before. Re-files are capped at 3 per (PR, sha) — the 4th
 *     would-be re-file escalates as a pipeline alarm instead of filing a
 *     5th issue, so a permanently-broken PR pages instead of looping forever.
 *   - Reviewer fan-out (AUR-5370): --reviewers "Name A,Name B" (or the
 *     single-name --reviewer alias) names candidate lanes. A lane is dropped
 *     if unhealthy — `status: idle` proves nothing; a quota-starved lane
 *     also reports idle — so health is read from its own recent runs
 *     (GET /api/agents/{id}/runs), not its status field. Among healthy
 *     lanes, PRs are distributed least-loaded-first by queued run count, so
 *     one lane never again absorbs the whole backlog. Fails loud (exit 2) if
 *     zero lanes are healthy — there is no reviewer to eventually pick up an
 *     unassigned issue's re-triage either, so this case still aborts rather
 *     than filing unassigned.
 *   - Credential-permission fallback (AUR-6335): a *healthy* lane was picked
 *     but the identity this script runs under structurally lacks
 *     `tasks:assign` (a shared cron credential, not this agent's own — see
 *     AUR-6054), so the assigned POST 403s. That is a permission gap, not a
 *     capacity gap: `api()` retries the same body unassigned instead of
 *     FATAL-aborting the whole run, so backlog after the first 403 still
 *     gets filed. Every other FATAL path (repo enumeration failure, zero
 *     healthy lanes, an uncaught exception) also fires a SEV2 alert via
 *     --alert-cmd, which does not touch the Paperclip API at all — so a
 *     dead fire is no longer silent even when the underlying capability
 *     that broke is the one this script itself needs to report through.
 *   - Stale-lane degrade (AUR-6430): the lane-health precheck now also drops
 *     a lane whose `lastHeartbeatAt` exceeds the same 24h threshold the
 *     create-issue endpoint enforces server-side (previously it only read
 *     run history, so it could report a >24h-idle lane "healthy" right
 *     before the server rejected it). As defense-in-depth for the remaining
 *     race — a heartbeat can still lapse between the precheck and the POST —
 *     a stale-lane 409 no longer FATAL-aborts the run either: the filing
 *     loop retries once on a different healthy lane, and only skips (leaving
 *     it to re-file next sweep) if every lane is exhausted.
 *   - Author exclusion (AUR-5370): every PR here is authored by the same
 *     GitHub machine account, so GitHub author metadata can't discriminate.
 *     The AUR-NNNN token in the PR title is looked up; that issue's
 *     assignee is excluded from the candidate set for that PR (falls back
 *     to the full set if exclusion would empty it). No token → no exclusion.
 *   - Per-run cap (AUR-5370): --max-file N (default 6) caps how many review
 *     issues one sweep files, across all repos combined, prioritizing
 *     safety/guardrail PRs and then oldest-first. Every PR the cap drops is
 *     logged — a silent truncation reads as "backlog handled" when it isn't.
 *   - PRs still open past --stale-hours (default 72) escalate via the alert
 *     command (Telegram) as ONE batched message per repo per run, rate-limited
 *     to once per 24h per PR. Escalation is an alarm about the PIPELINE
 *     (reviewer not landing work), never a request for the founder to review
 *     code — and a backlog of N stale PRs is one alarm, not N pages.
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
 *   --reviewers "Name A,Name B"   (default "Claude Code Max,Claude Code Fast")
 *   --reviewer NAME               (single-name alias for --reviewers NAME)
 *   --max-file N         (default 6 — cap on review issues filed per run)
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
const REFILE_CAP = 3;
const DEFAULT_REVIEWERS = ['Claude Code Max', 'Claude Code Fast'];
const STARVATION_PATTERN = /quota|usage limit|session limit/i;

// AUR-6430: must mirror server/src/services/agent-lane-admission.ts's
// STALE_LANE_HEARTBEAT_THRESHOLD_MS — that is the threshold the create-issue
// endpoint actually enforces (409 "Cannot assign work to a stale agent
// lane"). The run-history-based health check below (assessLaneHealth) never
// read lastHeartbeatAt, so it could report a lane "healthy" the server
// considered stale.
const STALE_LANE_HEARTBEAT_THRESHOLD_MS = 24 * HOUR_MS;

export const DEFAULT_REPOS = ['Jacksnow14/paperclip', 'Jacksnow14/Auranode'];

// AUR-6213: filed review issues must not flood the active queue (AUR-5826 —
// the board did a manual backlog/label cleanup after 10-20/week of these
// landed straight into todo/high). They file as backlog + platform label and
// drain through the weekly platform-drip routine (max 8/week) instead.
export const PLATFORM_LABEL_ID = '83062a2e-aec5-4de2-9541-02d05641c246';

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

/**
 * Pure: decide which PRs need a review issue filed, which need a fresh
 * re-file because the previously-filed issue died without the PR landing,
 * which have hit the re-file cap and escalate instead, and which are stale.
 *
 * `issueStatuses` maps filedIssueId -> Paperclip issue status string, or
 * `null` for "looked up, not found". An entry whose filedSha matches the PR
 * but has no filedIssueId (legacy state) is left alone — there is nothing
 * to verify. An id present in state but absent from issueStatuses means the
 * caller chose not to look it up (e.g. no API creds in --dry-run); that is
 * treated the same as "not found" so re-file lookups fail SAFE toward
 * re-checking, never toward silently trusting a stale filedSha forever.
 */
export function decideActions({ repo, prs, state, nowMs, staleHours, issueStatuses = {} }) {
  const file = [];
  const escalate = [];
  const refileCapped = [];
  for (const pr of prs) {
    if (pr.draft) continue;
    const sha7 = (pr.headSha ?? '').slice(0, 7);
    if (!sha7) continue;
    const key = stateKey(repo, pr.number);
    const entry = state.prs?.[key] ?? {};

    if (entry.filedSha !== sha7) {
      file.push({ number: pr.number, sha7, title: pr.title, createdAt: pr.createdAt });
    } else if (entry.filedIssueId) {
      const status = issueStatuses[entry.filedIssueId];
      let reason = null;
      if (status === 'cancelled') reason = 'cancelled';
      else if (status === undefined || status === null) reason = 'not-found';
      else if (status === 'done') reason = 'done-but-open';

      if (reason) {
        const refileCount = entry.refileCount ?? 0;
        if (refileCount < REFILE_CAP) {
          file.push({
            number: pr.number,
            sha7,
            title: pr.title,
            createdAt: pr.createdAt,
            refileReason: reason,
            refileCount: refileCount + 1,
          });
        } else {
          refileCapped.push({ number: pr.number, title: pr.title, refileCount, reason });
        }
      }
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
  return { file, escalate, refileCapped };
}

/** Pure: does this PR's title read as safety/guardrail-critical? Files before chores under the cap. */
export function isSafetyCritical(title) {
  return /safety|guardrail/i.test(title ?? '');
}

/** Pure: cap the combined (multi-repo) file list, safety/guardrail first, then oldest-first. */
export function applyFileCap(items, maxFile) {
  const sorted = [...items].sort((a, b) => {
    const pa = isSafetyCritical(a.title) ? 0 : 1;
    const pb = isSafetyCritical(b.title) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0);
  });
  return { kept: sorted.slice(0, maxFile), dropped: sorted.slice(maxFile) };
}

/** Pure: the quota-starved-run signature — failed, quota-flavored message, no tokens billed. */
export function isStarvedRun(run) {
  if (run?.status !== 'failed') return false;
  const text = String(run.error ?? '');
  if (!STARVATION_PATTERN.test(text)) return false;
  const tokens = (run.usageJson?.inputTokens ?? 0) + (run.usageJson?.outputTokens ?? 0);
  return tokens === 0;
}

/**
 * Pure: lane health from its own recent runs, never its `status` field —
 * `status: idle` is reported identically by a healthy lane and a
 * quota-starved one. Unhealthy iff the MOST RECENT run is a starved
 * failure (an older starved run the lane has since recovered from must not
 * permanently disqualify it).
 */
export function assessLaneHealth(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const queuedCount = list.filter((r) => r.status === 'queued').length;
  const mostRecent = list[0];
  const healthy = !mostRecent || !isStarvedRun(mostRecent);
  return { healthy, queuedCount };
}

/**
 * Pure: mirrors isAgentLaneStale in server/src/services/agent-lane-admission.ts
 * so the precheck actually predicts the 409 the create-issue endpoint
 * enforces (AUR-6430). A null/missing lastHeartbeatAt is NOT stale — that is
 * the legitimate signature of an agent that never heartbeats at all.
 */
export function isLaneHeartbeatStale(instance, nowMs) {
  const raw = instance?.lastHeartbeatAt;
  if (!raw) return false;
  const heartbeatMs = Date.parse(raw);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowMs - heartbeatMs > STALE_LANE_HEARTBEAT_THRESHOLD_MS;
}

/**
 * Pure: least-loaded healthy lane not already proven stale this run — the
 * fallback pool for a stale-lane 409 caught mid-filing (AUR-6430). Returns
 * null when every healthy lane has been exhausted.
 */
export function pickFallbackLane(lanes, excludeIds) {
  const pool = lanes.filter((l) => !excludeIds.has(l.id));
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => (a.queuedCount ?? 0) - (b.queuedCount ?? 0))[0];
}

/** Pure: pick the reviewer agent instance for a lane name. running > idle; never error/terminated. */
export function pickReviewer(agents, name) {
  const usable = agents.filter(
    (a) => a.name === name && !['error', 'terminated'].includes(a.status ?? ''),
  );
  usable.sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1));
  return usable[0] ?? null;
}

/** Pure: extract the AUR-NNNN token from a PR title, or null. */
export function extractAurToken(title) {
  const m = /AUR-(\d+)/.exec(title ?? '');
  return m ? `AUR-${m[1]}` : null;
}

/**
 * Pure: least-loaded-first distribution of file items across healthy
 * candidate lanes. Each candidate is `{ id, name, queuedCount }`. An item
 * may carry `excludeAgentId` (the PR's own AUR-token assignee) — skipped for
 * that item unless excluding it would empty the pool, in which case the
 * exclusion is dropped for that one item rather than leaving it unassigned.
 */
export function distributeReviewers(items, candidates) {
  const counters = candidates.map((c) => ({ ...c, load: c.queuedCount ?? 0 }));
  return items.map((item) => {
    const allowed = item.excludeAgentId
      ? counters.filter((c) => c.id !== item.excludeAgentId)
      : counters;
    const pool = allowed.length > 0 ? allowed : counters;
    pool.sort((a, b) => a.load - b.load);
    const chosen = pool[0];
    chosen.load += 1;
    return { ...item, reviewerId: chosen.id, reviewerName: chosen.name };
  });
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

/** Pure: one alarm per repo when PRs hit the re-file cap — the dispatcher stopped looping, not gave up. */
export function refileCapMessage(repo, capped) {
  const shown = capped.map((c) => `#${c.number}(${c.refileCount}x ${c.reason})`).join(' ');
  return (
    `pr-backlog[${repo}]: ${capped.length} PR(s) hit the ${REFILE_CAP}-re-file cap without a ` +
    `landing review — ${shown}. The review pipeline is repeatedly failing on these PRs; needs ` +
    `manual intervention (this is a pipeline alarm, not a code-review request).`
  );
}

/**
 * hasTrunkCiScript: whether `scripts/check-trunk-ci-red.mjs` exists in the
 * target repo's checkout (AUR-5995) — that script is Paperclip-only today;
 * stamping its command unconditionally 404s step 1 of the procedure in every
 * repo (e.g. Auranode) that doesn't have it. Callers resolve this once per
 * repo (see hasTrunkCiScript() / ghRepoHasFile()) and pass it through.
 */
export function issueBody(pr, repo, hasTrunkCiScript = true) {
  const trunkCheckStep = hasTrunkCiScript
    ? '1. Check trunk first: `node scripts/check-trunk-ci-red.mjs --dry-run`.'
    : '1. Check trunk first (repo-agnostic fallback — `scripts/check-trunk-ci-red.mjs` ' +
      `does not exist in this repo): \`gh pr checks --repo ${repo} <trunk-branch-head-sha-or-latest-PR>\`.`;
  return [
    `Filed automatically by scripts/check-pr-backlog.mjs — the PR-backlog dispatcher.`,
    '',
    `**PR:** https://github.com/${repo}/pull/${pr.number} — ${pr.title}`,
    `**Head:** \`${pr.sha7}\` (this issue covers exactly this head; a new push re-files).`,
    ...(pr.refileReason
      ? [
          '',
          `**Re-file (attempt ${pr.refileCount}/${REFILE_CAP}):** the previously-filed review issue ` +
            `for this exact head ended in \`${pr.refileReason}\` without the PR landing. A ` +
            'cancelled or missing review issue is unreviewed work, not finished work.',
        ]
      : []),
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
    trunkCheckStep,
    '   Do not merge over a red trunk — fix trunk first or park with a comment.',
    '2. Deep-review the diff against CURRENT origin/master: correctness, security,',
    '   supersession (is this already implemented on master? grep for its symbols),',
    '   test adequacy, CI status (`gh pr checks N` — distinguish PR-caused failures',
    '   from stale-base/known-flake failures by reading the failing job log).',
    '   - Flag, don\'t auto-block: if any part of the diff is not explainable by the',
    '     PR/issue title alone, comment on the PR and hold it for a human look —',
    '     specifically secrets/credential access, new or modified git remotes, or',
    '     unusual outbound network calls.',
    '   - If you record a `changes_requested` execution-review decision on the',
    '     linked AUR issue (PATCH /issues/:id), immediately run',
    '     `node scripts/enforce-execution-review-gate.mjs --issue <AUR-NNNN>` —',
    '     this converts the PR to a GitHub draft so the merge command below',
    '     hard-refuses until the decision is resolved (AUR-6150: a',
    '     changes_requested decision on its own places nothing on the PR, and',
    '     GitHub merged the still-rejected code 108s after the decision before',
    '     this gate existed).',
    '3. Verdict and act:',
    '   - **Sound** → rebase onto master if behind, re-run targeted tests +',
    '     per-package `tsc --noEmit` (server needs `--max-old-space-size=3072`;',
    '     the repo-root typecheck wrapper is memory-gated), then',
    '     `gh pr merge N --squash --delete-branch`. On a transient "not mergeable"',
    '     right after a push, wait ~30s and retry once before re-rebasing. If',
    '     merge is refused with "Pull Request is still a draft", the linked',
    '     issue is (or was) `changes_requested` — resolve the review decision',
    '     first; do not force it ready yourself.',
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
    'If you cancel this issue without landing or closing the PR, the next sweep',
    'will re-file it — cancelling is not a way to make a PR disappear.',
  ].join('\n');
}

/**
 * Pure: the create-issue request body for a filed review issue. Files as
 * `backlog` + the `platform` label (AUR-6213) so the weekly platform-drip
 * routine — not the dispatcher — controls how many enter the active queue.
 */
export function buildIssueCreatePayload(f, hasTrunkCiScript) {
  return {
    title: issueTitle(f, f.repo),
    description: issueBody(f, f.repo, hasTrunkCiScript),
    priority: 'high',
    status: 'backlog',
    labelIds: [PLATFORM_LABEL_ID],
    assigneeAgentId: f.reviewerId,
  };
}

function parseArgs(argv) {
  const args = {
    repos: [],
    reviewers: [],
    maxFile: 6,
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
    } else if (a === '--reviewers') {
      args.reviewers.push(
        ...String(argv[++i] ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      );
    } else if (a === '--reviewer') args.reviewers.push(argv[++i]);
    else if (a === '--max-file') args.maxFile = Number(argv[++i]);
    else if (a === '--stale-hours') args.staleHours = Number(argv[++i]);
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.repos.length === 0) args.repos = [...DEFAULT_REPOS];
  if (args.reviewers.length === 0) args.reviewers = [...DEFAULT_REVIEWERS];
  return args;
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

/** Does `path` exist in `repo`'s default branch? Used to decide whether the
 * stamped procedure text can reference a Paperclip-only script (AUR-5995). */
function ghRepoHasFile(repo, path) {
  try {
    execFileSync('gh', ['api', `repos/${repo}/contents/${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

const trunkCiScriptCache = new Map();
/** Memoized per repo — filing loops call this once per issue, not once per gh api round trip. */
function hasTrunkCiScript(repo) {
  if (!trunkCiScriptCache.has(repo)) {
    trunkCiScriptCache.set(repo, ghRepoHasFile(repo, 'scripts/check-trunk-ci-red.mjs'));
  }
  return trunkCiScriptCache.get(repo);
}

/**
 * Best-effort out-of-band alert for a FATAL condition. Deliberately does not
 * touch the Paperclip API — this is the path that must still work when the
 * reason we're alerting IS a broken Paperclip credential (AUR-6335: 26
 * consecutive dead fires logged to a file nobody watches, zero alerts).
 * Swallows its own failure; a broken alert must never mask the real FATAL.
 */
function alertFatal(args, message) {
  try {
    execFileSync(args.alertCmd, ['SEV2', message]);
  } catch (err) {
    console.error(`FATAL-alert via ${args.alertCmd} failed: ${err.message}`);
  }
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

/**
 * Thrown by api() for the specific 409 the create-issue endpoint returns
 * when the chosen lane's heartbeat has gone stale (AUR-6430). Typed so the
 * filing loop can fall back to a different healthy lane instead of letting
 * it propagate to the top-level handler and FATAL-abort the whole run — the
 * server-side race this covers: a heartbeat can lapse in the seconds between
 * resolveHealthyLanes()'s own read and this POST.
 */
export class StaleLaneError extends Error {
  constructor(message, agentId) {
    super(message);
    this.name = 'StaleLaneError';
    this.agentId = agentId;
  }
}

export async function api(args, method, path, body) {
  const res = await fetch(`${args.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res.json();

  // Response body is the server's stated reason (e.g. "Missing permission:
  // tasks:assign") — without it a 403/400 leaves the next responder to
  // re-derive the cause from scratch.
  const detail = await res.text().catch(() => '');

  // AUR-6335: some credentials this script runs under (a shared cron
  // service-principal key, not this agent's own) structurally lack
  // `tasks:assign`, so a POST that carries `assigneeAgentId` 403s every
  // time. Retrying the same body forever fails the same way, and letting
  // it propagate FATAL-aborts the whole run, silently dropping the rest of
  // the backlog too (AUR-6335 root cause: 26 consecutive dead fires).
  // Match the accepted company pattern (AUR-6054/check-unattributed-trigger-
  // disarms.mjs): file the issue UNASSIGNED instead of throwing. Only this
  // specific 403 is swallowed — any other status, or a 403 for a different
  // reason, still throws.
  if (method === 'POST' && res.status === 403 && body && typeof body === 'object' && 'assigneeAgentId' in body && /tasks:assign/i.test(detail)) {
    const { assigneeAgentId, ...unassignedBody } = body;
    console.log(`FILED UNASSIGNED (403 on assigneeAgentId — see AUR-6335/AUR-6054): ${detail}`);
    return api(args, method, path, unassignedBody);
  }

  // AUR-6430: the create-issue endpoint 409s when the target lane's
  // heartbeat is stale (server/src/services/agent-lane-admission.ts). This
  // is a typed, expected-to-happen condition — throw StaleLaneError instead
  // of a plain Error so the filing loop can retry on a different lane
  // instead of the whole run FATAL-aborting.
  if (method === 'POST' && res.status === 409 && body && typeof body === 'object' && 'assigneeAgentId' in body && /stale agent lane/i.test(detail)) {
    throw new StaleLaneError(`${method} ${path} → 409: ${detail}`, body.assigneeAgentId);
  }

  throw new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** Best-effort: fetch statuses for every filedIssueId that might need re-file verification. */
async function fetchIssueStatuses(args, repo, prs, state) {
  const ids = new Set();
  for (const pr of prs) {
    if (pr.draft) continue;
    const sha7 = (pr.headSha ?? '').slice(0, 7);
    if (!sha7) continue;
    const entry = state.prs?.[stateKey(repo, pr.number)];
    if (entry && entry.filedSha === sha7 && entry.filedIssueId) ids.add(entry.filedIssueId);
  }
  const statuses = {};
  for (const id of ids) {
    try {
      const issue = await api(args, 'GET', `/api/issues/${id}`);
      statuses[id] = issue.status ?? null;
    } catch {
      statuses[id] = null; // not found / unreachable — fail safe toward re-checking, per decideActions doc.
    }
  }
  return statuses;
}

/** Best-effort: resolve the AUR-token issue's assignee, to exclude the PR's own author-issue owner. */
async function resolveAuthorExclusion(args, title) {
  const token = extractAurToken(title);
  if (!token) return null;
  try {
    const issue = await api(args, 'GET', `/api/issues/${token}`);
    return issue.assigneeAgentId ?? null;
  } catch {
    return null; // no exclusion signal — do not fail the dispatch over a lookup miss.
  }
}

async function resolveHealthyLanes(args, companyId, nowMs) {
  const agents = await api(args, 'GET', `/api/companies/${companyId}/agents`);
  const list = Array.isArray(agents) ? agents : agents.agents ?? [];
  const lanes = [];
  for (const name of args.reviewers) {
    const instance = pickReviewer(list, name);
    if (!instance) {
      console.error(`lane "${name}": no usable agent instance — dropped.`);
      continue;
    }
    if (isLaneHeartbeatStale(instance, nowMs)) {
      const ageHours = Math.round((nowMs - Date.parse(instance.lastHeartbeatAt)) / HOUR_MS);
      console.error(
        `lane "${name}": STALE HEARTBEAT (idle ${ageHours}h, > ${STALE_LANE_HEARTBEAT_THRESHOLD_MS / HOUR_MS}h ` +
          'threshold the server enforces) — dropped.',
      );
      continue;
    }
    let runs = [];
    try {
      runs = await api(args, 'GET', `/api/agents/${instance.id}/runs?limit=40`);
    } catch (err) {
      console.error(`lane "${name}": could not read runs (${err.message}) — treating as unhealthy.`);
      continue;
    }
    const health = assessLaneHealth(Array.isArray(runs) ? runs : []);
    if (!health.healthy) {
      console.error(`lane "${name}": STARVED (most recent run is a quota failure) — dropped.`);
      continue;
    }
    console.log(`lane "${name}": healthy, queued=${health.queuedCount}`);
    lanes.push({ id: instance.id, name, queuedCount: health.queuedCount });
  }
  return lanes;
}

/**
 * Files one review issue, degrading gracefully instead of propagating
 * (AUR-6430): the per-item filing loop previously had no try/catch, so any
 * thrown error — including a stale-lane 409 the precheck didn't anticipate —
 * FATAL-aborted the whole run, dropping every remaining unfiled item across
 * both repos. A StaleLaneError retries once on a different healthy lane; any
 * other failure (or an exhausted fallback pool) is logged and this item is
 * skipped. Returns `{ created, candidate }` on success, or null — the caller
 * does not record state for a null result, so the PR is simply re-attempted
 * on the next sweep rather than lost.
 */
export async function fileOneItem(args, companyId, item, lanes, staleLaneIds) {
  let candidate = item;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const created = await api(
        args,
        'POST',
        `/api/companies/${companyId}/issues`,
        buildIssueCreatePayload(candidate, hasTrunkCiScript(candidate.repo)),
      );
      // 201 is not proof — read the row back before recording the dispatch.
      await api(args, 'GET', `/api/issues/${created.id}`);
      return { created, candidate };
    } catch (err) {
      if (err instanceof StaleLaneError && attempt === 0) {
        staleLaneIds.add(err.agentId);
        const fallback = pickFallbackLane(lanes, staleLaneIds);
        if (!fallback) {
          console.error(
            `SKIP: repo=${candidate.repo}#${candidate.number}@${candidate.sha7} — lane ` +
              `"${candidate.reviewerName}" went stale (409) and no other healthy lane is left; ` +
              'will re-file on the next sweep.',
          );
          return null;
        }
        console.error(
          `lane "${candidate.reviewerName}" went stale (409) mid-run — retrying ` +
            `repo=${candidate.repo}#${candidate.number} on lane "${fallback.name}" instead.`,
        );
        candidate = { ...candidate, reviewerId: fallback.id, reviewerName: fallback.name };
        continue;
      }
      console.error(
        `SKIP: repo=${candidate.repo}#${candidate.number}@${candidate.sha7} — filing failed: ` +
          `${err.message}; will re-file on the next sweep.`,
      );
      return null;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!args.dryRun && (!apiKey || !companyId)) {
    console.error('FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot dispatch.');
    alertFatal(args, 'pr-backlog-dispatch FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot dispatch.');
    process.exit(2);
  }
  const haveCreds = Boolean(apiKey && companyId);

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
      const msg = `pr-backlog-dispatch FATAL: repo=${repo} could not list open PRs: ${err.message}`;
      console.error(msg);
      alertFatal(args, msg);
      enumerationFailures += 1;
      continue;
    }
    // Re-file verification needs live issue status; skip gracefully without creds (e.g. dry-run).
    const issueStatuses = haveCreds ? await fetchIssueStatuses(args, repo, openPrs, state) : {};
    const { file, escalate, refileCapped } = decideActions({
      repo,
      prs: openPrs,
      state,
      nowMs: Date.now(),
      staleHours: args.staleHours,
      issueStatuses,
    });
    // The liveness line: printed before anything else can fail, one per repo.
    console.log(
      `repo=${repo} open=${openPrs.length} to-file=${file.length} to-escalate=${escalate.length} ` +
        `refile-capped=${refileCapped.length} (reviewers: ${args.reviewers.join(', ')})`,
    );
    for (const f of file) {
      if (f.refileReason === 'done-but-open') {
        console.error(
          `PIPELINE DEFECT: repo=${repo} #${f.number}@${f.sha7} — filed issue was done but PR is ` +
            'still open. Re-filing.',
        );
      } else if (f.refileReason) {
        console.error(
          `repo=${repo} #${f.number}@${f.sha7} — previous review issue ended ${f.refileReason}; ` +
            `re-filing (attempt ${f.refileCount}/${REFILE_CAP}).`,
        );
      }
    }
    for (const c of refileCapped) {
      console.error(
        `repo=${repo} #${c.number} — hit the ${REFILE_CAP}-re-file cap (${c.reason}); escalating ` +
          'instead of filing again.',
      );
    }
    sweeps.push({ repo, file, escalate, refileCapped });
  }

  const combinedFile = sweeps.flatMap((s) => s.file.map((f) => ({ ...f, repo: s.repo })));
  const { kept, dropped } = applyFileCap(combinedFile, args.maxFile);
  if (dropped.length > 0) {
    for (const d of dropped) {
      console.error(`CAP: dropped ${d.repo}#${d.number}@${d.sha7} this run (--max-file ${args.maxFile}).`);
    }
  }

  if (args.dryRun) {
    for (const f of kept) console.log(`DRY-RUN: would file ${issueTitle(f, f.repo)}`);
    for (const s of sweeps) {
      if (s.escalate.length > 0) {
        console.log(`DRY-RUN: would alert: ${escalationMessage(s.repo, s.escalate, args.staleHours)}`);
      }
      if (s.refileCapped.length > 0) {
        console.log(`DRY-RUN: would alert: ${refileCapMessage(s.repo, s.refileCapped)}`);
      }
    }
    if (enumerationFailures > 0) process.exit(2);
    return;
  }

  let assigned = [];
  let lanes = [];
  if (kept.length > 0) {
    lanes = await resolveHealthyLanes(args, companyId, Date.now());
    if (lanes.length === 0) {
      const msg = `pr-backlog-dispatch FATAL: zero healthy reviewer lanes among [${args.reviewers.join(', ')}] — ${kept.length} PR(s) undispatched.`;
      console.error(msg);
      alertFatal(args, msg);
      process.exit(2);
    }
    const withExclusions = [];
    for (const f of kept) {
      const excludeAgentId = await resolveAuthorExclusion(args, f.title);
      withExclusions.push({ ...f, excludeAgentId });
    }
    assigned = distributeReviewers(withExclusions, lanes);
  }

  const staleLaneIds = new Set();
  for (const f of assigned) {
    const result = await fileOneItem(args, companyId, f, lanes, staleLaneIds);
    if (!result) continue;
    const { created, candidate } = result;
    const key = stateKey(candidate.repo, candidate.number);
    state.prs[key] = {
      ...(state.prs[key] ?? {}),
      filedSha: candidate.sha7,
      filedAt: new Date().toISOString(),
      filedIssueId: created.id,
      issue: created.identifier ?? created.id,
      refileCount: candidate.refileCount ?? 0,
    };
    saveState(args.stateDir, state);
    console.log(
      `filed ${created.identifier ?? created.id} for ${candidate.repo}#${candidate.number}@${candidate.sha7} -> ${candidate.reviewerName}`,
    );
  }

  for (const s of sweeps) {
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
    if (s.refileCapped.length > 0) {
      try {
        execFileSync(args.alertCmd, ['SEV2', refileCapMessage(s.repo, s.refileCapped)]);
      } catch (err) {
        console.error(`refile-cap escalation for repo=${s.repo} failed: ${err.message}`);
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
    // parseArgs() may not have run (or may itself be the thing that threw),
    // so fall back to its own default rather than assuming `args` exists.
    alertFatal({ alertCmd: '/home/ievgen/bot/telegram-alert.sh' }, `pr-backlog-dispatch FATAL (uncaught): ${err.message}`);
    process.exit(2);
  });
}
