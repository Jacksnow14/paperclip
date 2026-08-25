#!/usr/bin/env node
/**
 * Execution-review merge gate (AUR-6150).
 *
 * The failure mode this closes: on AUR-6145, a `changes_requested`
 * execution-review decision was recorded on an issue at T+0, and the linked
 * PR — carrying the exact unfixed code the review had just rejected — merged
 * to master 108 seconds later. The Paperclip execution-review decision
 * (`executionState.status` on the issue) and the GitHub merge gate are
 * completely decoupled: `changes_requested` places nothing on the PR, so
 * GitHub sees an unreviewed-by-GitHub's-own-primitive, CI-green, mergeable
 * PR and merges it. `request_changes` isn't available as the enforcement
 * primitive either — every PR in this fleet is authored by the same GitHub
 * account (Jacksnow14), and GitHub refuses `request_changes` on your own PR.
 *
 * The fix: the moment an issue's execution review is `changes_requested`,
 * convert its linked PR (matched by the `AUR-NNNN` token in the PR title —
 * the same convention scripts/check-pr-backlog.mjs uses) to a GitHub DRAFT.
 * GitHub's own merge path (the merge button and `gh pr merge`) refuses to
 * merge a draft PR — this is enforcement in the real merge path, not an
 * advisory instruction a reviewer can forget. When the review resolves away
 * from `changes_requested`, the PR is marked ready again — but ONLY a PR
 * this gate itself drafted (tracked in the state file): never touch a PR's
 * draft status for any other reason, since a human/agent may have drafted it
 * intentionally for something unrelated.
 *
 * No new infrastructure: uses the same `gh` CLI (pre-authenticated) every
 * other GitHub interaction in this fleet already uses. Conversion is done
 * via the GraphQL `convertPullRequestToDraft` / `markPullRequestReadyForReview`
 * mutations because the `gh` CLI version deployed in this fleet (2.4.0) predates
 * `gh pr ready --undo`, and the REST API has no draft-toggle endpoint.
 *
 * Two modes:
 *   --issue <AUR-NNNN>   Single-issue mode: gate (or release) exactly the PR
 *                        linked to this one issue. Call this immediately
 *                        after recording a changes_requested (or resolving)
 *                        decision — this is the zero-latency path.
 *   --sweep              Scan every open PR across --repo (default: both
 *                        fleet repos), resolve each PR's linked issue via its
 *                        AUR-NNNN title token, and apply the gate. This is
 *                        the backstop for any decision recorded through a
 *                        path that didn't call --issue directly — run this
 *                        on a tight cron interval (host cron, matching
 *                        scripts/check-pr-backlog.mjs's deployment pattern).
 *
 * Exit codes: 0 = gate applied/checked cleanly (including no-op) · 2 = could
 * not measure or could not enforce (repo enumeration failure, or a draft/
 * undraft mutation failed) — loud and distinct, because a silently-failed
 * gate is the exact hazard this script exists to close.
 *
 * Requires: `gh` CLI authenticated (`gh api` / `gh api graphql` only). Issue
 * status lookups need PAPERCLIP_API_KEY in the environment (PAPERCLIP_COMPANY_ID
 * is not required — GET /api/issues/:id is not company-scoped).
 *
 * Usage:
 *   node scripts/enforce-execution-review-gate.mjs --issue AUR-6150
 *   node scripts/enforce-execution-review-gate.mjs --sweep
 *   node scripts/enforce-execution-review-gate.mjs --sweep --dry-run
 *   --repo owner/name[,owner/name...]  (repeatable; default sweeps
 *                                       Jacksnow14/paperclip AND Jacksnow14/Auranode)
 *   --state-dir DIR   (default $HOME/.paperclip/execution-review-gate)
 *   --alert-cmd PATH  (default /home/ievgen/bot/telegram-alert.sh)
 *   --api-base URL    (default http://127.0.0.1:3100)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const DEFAULT_REPOS = ['Jacksnow14/paperclip', 'Jacksnow14/Auranode'];
export const GATED_STATUS = 'changes_requested';

/** Pure: extract the AUR-NNNN token from a PR title, or null. Same convention as check-pr-backlog.mjs. */
export function extractAurToken(title) {
  const m = /AUR-(\d+)/i.exec(title ?? '');
  return m ? `AUR-${m[1]}` : null;
}

/** Pure: normalize any AUR id spelling ("AUR-6150", "aur6150", "6150") to the canonical "AUR-6150" form. */
export function normalizeIssueId(id) {
  const m = /(?:AUR-?)?(\d+)/i.exec(String(id ?? ''));
  return m ? `AUR-${m[1]}` : null;
}

export function stateKey(repo, number) {
  return `${repo}#${number}`;
}

/** Pure: among open PRs, find every one whose title carries this issue's AUR token. */
export function matchPrsForIssue(prs, issueId) {
  const wanted = normalizeIssueId(issueId);
  if (!wanted) return [];
  return prs.filter((pr) => extractAurToken(pr.title) === wanted);
}

/** Pure: title-token reuse across PRs should be rare, but must never throw — pick the newest. */
export function pickPr(prs) {
  if (prs.length === 0) return null;
  return [...prs].sort(
    (a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0),
  )[0];
}

/**
 * Pure: decide the gate action for one (issue status, PR draft state, prior
 * guard state) triple.
 *   - changes_requested + not-draft -> draft (close the merge path)
 *   - changes_requested + draft     -> noop (already gated)
 *   - resolved + draft, gated by us -> undraft (release our own block)
 *   - resolved + not draft          -> noop (nothing to release)
 *   - resolved + draft, NOT by us   -> noop (never touch a draft we didn't set)
 */
export function decideGateAction({ issueStatus, prDraft, draftedByGate }) {
  if (issueStatus === GATED_STATUS) {
    return prDraft
      ? { action: 'noop', reason: 'already-draft' }
      : { action: 'draft', reason: 'changes_requested' };
  }
  if (prDraft && draftedByGate) {
    return { action: 'undraft', reason: 'resolved' };
  }
  return { action: 'noop', reason: prDraft ? 'draft-not-ours' : 'ready' };
}

function parseArgs(argv) {
  const args = {
    mode: null,
    issueId: null,
    repos: [],
    stateDir: join(process.env.HOME ?? '/home/ievgen', '.paperclip', 'execution-review-gate'),
    alertCmd: '/home/ievgen/bot/telegram-alert.sh',
    apiBase: 'http://127.0.0.1:3100',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--sweep') args.mode = 'sweep';
    else if (a === '--issue') {
      args.mode = 'issue';
      args.issueId = argv[++i];
    } else if (a === '--repo') {
      args.repos.push(
        ...String(argv[++i] ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      );
    } else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.repos.length === 0) args.repos = [...DEFAULT_REPOS];
  if (!args.mode) throw new Error('one of --issue <AUR-NNNN> or --sweep is required');
  if (args.mode === 'issue' && !args.issueId) throw new Error('--issue requires an id');
  return args;
}

function ghJson(apiArgs) {
  const out = execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function listOpenPrs(repo) {
  return ghJson([`repos/${repo}/pulls?state=open&per_page=100`]).map((p) => ({
    number: p.number,
    title: p.title,
    draft: Boolean(p.draft),
    headSha: p.head?.sha ?? '',
    createdAt: p.created_at,
  }));
}

function getPrNodeId(repo, number) {
  return ghJson([`repos/${repo}/pulls/${number}`]).node_id;
}

const MUTATION_FIELD = {
  draft: 'convertPullRequestToDraft',
  undraft: 'markPullRequestReadyForReview',
};

/** Real GitHub call: flip a PR's draft state via the GraphQL mutations `gh pr ready --undo`
 * would use on a newer gh CLI. `action` is 'draft' or 'undraft'. */
function applyDraftMutation(repo, number, action) {
  const nodeId = getPrNodeId(repo, number);
  const field = MUTATION_FIELD[action];
  const query = `mutation($id: ID!) { ${field}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`;
  const out = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `query=${query}`, '-F', `id=${nodeId}`],
    { encoding: 'utf8' },
  );
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

export async function api(args, method, path) {
  const res = await fetch(`${args.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

/** Best-effort: null means "no execution-review state" (never found, or no executionState set),
 * which is always a noop for this gate — an issue with no execution review has nothing to enforce. */
async function getIssueExecutionStatus(args, issueId) {
  try {
    const issue = await api(args, 'GET', `/api/issues/${issueId}`);
    return issue?.executionState?.status ?? null;
  } catch (err) {
    console.error(`could not read execution state for ${issueId}: ${err.message}`);
    return null;
  }
}

/** Apply one decided action for one (repo, pr, issueId) — returns {ok, action, error?}. */
function execute(args, repo, prNumber, issueId, decision, state) {
  const key = stateKey(repo, prNumber);
  if (decision.action === 'noop') return { ok: true, action: 'noop', reason: decision.reason };
  if (args.dryRun) {
    console.log(`DRY-RUN: would ${decision.action} ${key} (issue ${issueId}, reason: ${decision.reason})`);
    return { ok: true, action: decision.action, reason: decision.reason };
  }
  try {
    applyDraftMutation(repo, prNumber, decision.action);
    state.prs[key] = {
      ...(state.prs[key] ?? {}),
      draftedByGate: decision.action === 'draft',
      issueId,
      updatedAt: new Date().toISOString(),
    };
    console.log(`${decision.action === 'draft' ? 'DRAFTED' : 'RELEASED'} ${key} (issue ${issueId}, reason: ${decision.reason})`);
    return { ok: true, action: decision.action, reason: decision.reason };
  } catch (err) {
    console.error(`GATE FAILED to ${decision.action} ${key} (issue ${issueId}): ${err.message}`);
    return { ok: false, action: decision.action, reason: decision.reason, error: err.message };
  }
}

async function runIssueMode(args) {
  const state = loadState(args.stateDir);
  const issueId = normalizeIssueId(args.issueId) ?? args.issueId;
  const status = await getIssueExecutionStatus(args, issueId);
  const failures = [];
  let touched = 0;
  for (const repo of args.repos) {
    let prs;
    try {
      prs = listOpenPrs(repo);
    } catch (err) {
      console.error(`FATAL: repo=${repo} could not list open PRs: ${err.message}`);
      failures.push({ repo, error: err.message });
      continue;
    }
    const pr = pickPr(matchPrsForIssue(prs, issueId));
    if (!pr) continue;
    touched += 1;
    const key = stateKey(repo, pr.number);
    const decision = decideGateAction({
      issueStatus: status,
      prDraft: pr.draft,
      draftedByGate: Boolean(state.prs[key]?.draftedByGate),
    });
    const result = execute(args, repo, pr.number, issueId, decision, state);
    if (!result.ok) failures.push({ repo, number: pr.number, error: result.error });
  }
  saveState(args.stateDir, state);
  if (touched === 0) {
    console.log(`no open PR found for ${issueId} across [${args.repos.join(', ')}] — nothing to gate.`);
  }
  return failures;
}

async function runSweepMode(args) {
  const state = loadState(args.stateDir);
  const failures = [];
  let enumerationFailures = 0;
  for (const repo of args.repos) {
    let prs;
    try {
      prs = listOpenPrs(repo);
    } catch (err) {
      console.error(`FATAL: repo=${repo} could not list open PRs: ${err.message}`);
      enumerationFailures += 1;
      continue;
    }
    let gated = 0;
    let released = 0;
    for (const pr of prs) {
      const issueId = extractAurToken(pr.title);
      if (!issueId) continue;
      const status = await getIssueExecutionStatus(args, issueId);
      const key = stateKey(repo, pr.number);
      const decision = decideGateAction({
        issueStatus: status,
        prDraft: pr.draft,
        draftedByGate: Boolean(state.prs[key]?.draftedByGate),
      });
      const result = execute(args, repo, pr.number, issueId, decision, state);
      if (!result.ok) failures.push({ repo, number: pr.number, error: result.error });
      else if (result.action === 'draft') gated += 1;
      else if (result.action === 'undraft') released += 1;
    }
    // Liveness line, printed per repo before anything else can fail this sweep.
    console.log(`repo=${repo} open=${prs.length} gated=${gated} released=${released}`);
  }
  saveState(args.stateDir, state);
  if (enumerationFailures > 0) failures.push({ error: `${enumerationFailures} repo(s) could not be enumerated` });
  return failures;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.dryRun && !process.env.PAPERCLIP_API_KEY) {
    console.error('FATAL: PAPERCLIP_API_KEY not set — cannot read execution review state.');
    process.exit(2);
  }
  const failures = args.mode === 'issue' ? await runIssueMode(args) : await runSweepMode(args);
  if (failures.length > 0) {
    const msg =
      `execution-review-gate: ${failures.length} enforcement failure(s) — a rejected PR may be ` +
      `mergeable right now. ${failures.map((f) => f.error).join('; ')}`;
    console.error(`FATAL: ${msg}`);
    try {
      execFileSync(args.alertCmd, ['SEV2', msg]);
    } catch (err) {
      console.error(`alert failed: ${err.message}`);
    }
    process.exit(2);
  }
}

// Mirrors check-pr-backlog.mjs's realpath guard (AUR-5111): the deployed
// wrapper invokes this via a symlinked release path, where a bare argv[1]
// string comparison against import.meta.url would never match.
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
