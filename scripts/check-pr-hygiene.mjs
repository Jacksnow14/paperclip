#!/usr/bin/env node
/**
 * PR-hygiene detectors (AUR-5513, direct follow-up to AUR-5465).
 *
 * The failure mode this guards: AUR-5097 shipped PR #242 — the same
 * `AFTER UPDATE OF status` recovery-action trigger AUR-5465 later re-derived
 * from scratch. PR #242 sat open, unmerged, while its issue was cancelled in
 * the 2026-08-06 bulk-cancel window. Nothing said a word; the fix was
 * silently re-derived a week later as PR #264, and PR #242 was only closed
 * by hand because a reviewer happened to cross-check the open-PR list. A
 * cancelled/done issue with a still-open PR is a signal, not a cleanup
 * target — this script never touches the PR itself, only reports.
 *
 * Two independent checks, run in one sweep because both are cheap read-only
 * PR-hygiene scans over the same open-PR list:
 *
 *   A. Terminal-issue-with-open-PR: an open PR whose TITLE names an
 *      `AUR-NNNN` issue (this repo's `type(AUR-NNNN): ...` convention) that
 *      has since gone `cancelled` or `done`. Title-only, not body — a live
 *      sweep during development showed body-scanning pulls in ~10x incidental
 *      mentions (prior-art references, changelogs) that are not the issue
 *      the PR is actually for. Action:
 *      comment on the PR naming the terminal issue (both statuses — a done
 *      issue with an unmerged PR is a weaker signal but still worth a note),
 *      and additionally file a `high`-priority Paperclip issue for the CTO
 *      when the status is `cancelled` (the stronger signal: a done issue's
 *      PR is usually just lagging cleanup, a cancelled issue's PR may be the
 *      only surviving copy of correct work — the exact AUR-5097 shape).
 *      NEVER auto-closes the PR.
 *
 *   B. Duplicate migration `idx`: two open PRs (or an open PR and current
 *      master) independently claiming the same `idx` slot in
 *      packages/db/src/migrations/meta/_journal.json. Git conflicts on the
 *      journal file at merge time, but only if the resolver knows the fix is
 *      "renumber one side" — dropping a side compiles and passes CI, silently
 *      wrong. Action: comment on each colliding PR, file one `high`-priority
 *      Paperclip issue naming every colliding source.
 *
 * Both checks are idempotent per-target via a small state file: a given
 * (repo, PR, ref, status) or (repo, idx, source-set) only re-acts after a
 * 24h cooldown, so a standing collision does not re-page every sweep.
 *
 * Exit codes: 0 = swept · 2 = could not enumerate PRs for at least one repo.
 * A dead repo must never read as "no PRs to check."
 *
 * Requires: `gh` CLI authenticated. Issue filing/PR comments (non-dry-run)
 * need PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID in the environment.
 *
 * Usage:
 *   node scripts/check-pr-hygiene.mjs                  # sweep and act
 *   node scripts/check-pr-hygiene.mjs --dry-run        # sweep, print, act nothing
 *   --repo owner/name[,owner/name...]   (default: same repos as check-pr-backlog.mjs)
 *   --skip-terminal-check   (run only check B)
 *   --skip-migration-check  (run only check A)
 *   --state-dir DIR         (default $HOME/.paperclip/pr-hygiene)
 *   --api-base URL          (default http://127.0.0.1:3100)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { DEFAULT_REPOS } from './check-pr-backlog.mjs';

const HOUR_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 24 * HOUR_MS;
const MIGRATIONS_JOURNAL_PATH = 'packages/db/src/migrations/meta/_journal.json';
const CTO_AGENT_ID = '371a1b08-0286-4a12-a516-f587f42df5eb';
const TERMINAL_STATUSES = new Set(['cancelled', 'done']);

// ---------------------------------------------------------------------------
// Check A: terminal-issue-with-open-PR — pure decision logic
// ---------------------------------------------------------------------------

/**
 * Pure: unique AUR-NNNN references in PR TITLE ONLY, order of first
 * appearance. Deliberately title-only, not body: this repo's convention is a
 * leading `type(AUR-NNNN): ...` naming exactly the issue the PR addresses,
 * while PR bodies routinely mention unrelated issues as context/prior-art
 * (e.g. "follow-up to AUR-5465", changelogs listing sibling work). Scanning
 * the body against a live sweep of this repo's open PRs produced ~10x the
 * matches of title-only scanning, almost all incidental — the kind of noise
 * that turns one real alarm into N pages and trains the CTO to ignore this
 * detector. Title-only trades a small amount of recall (a PR that references
 * its issue only in the body) for precision that keeps the signal loud.
 */
export function extractIssueRefs(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? '').matchAll(/\bAUR-\d+\b/gi)) {
    const ref = m[0].toUpperCase();
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Pure: decide what to do about one (repo, PR, referenced issue) tuple given
 * the issue's current status. Returns null when nothing is owed — status is
 * not terminal, or both applicable actions already happened and are still
 * inside cooldown.
 */
export function decideTerminalIssueAction({ repo, pr, ref, status, state, nowMs }) {
  if (!TERMINAL_STATUSES.has(status)) return null;
  const key = `${repo}#${pr.number}:${ref}:${status}`;
  const entry = state.actions?.[key];
  const commentedAt = entry?.commentedAt ? Date.parse(entry.commentedAt) : 0;
  const needsComment = !entry?.commentedAt || nowMs - commentedAt > COOLDOWN_MS;
  const needsIssue = status === 'cancelled' && !entry?.filedIssue;
  if (!needsComment && !needsIssue) return null;
  return { key, needsComment, needsIssue, status };
}

/** Pure: PR comment body for check A. */
export function terminalPrCommentBody({ ref, status }) {
  const statusLine =
    status === 'cancelled'
      ? `**${ref} was cancelled** while this PR is still open. Per AUR-5097 (the ` +
        `incident this check exists to prevent): cancelling an issue does not mean ` +
        `the code is wrong — verify against current master before assuming this PR ` +
        `should be closed.`
      : `**${ref} is done** while this PR is still open — likely lagging cleanup, but ` +
        `confirm the PR is actually superseded/merged-in-spirit before closing it.`;
  return [
    `Automated PR-hygiene check (scripts/check-pr-hygiene.mjs, AUR-5513).`,
    '',
    statusLine,
    '',
    'This is a signal, not a directive to close — do not auto-close. Review the diff ' +
      'against current master: if it is superseded, close with evidence and say so on ' +
      `${ref}; if it is still correct and unmerged, land it.`,
  ].join('\n');
}

/** Pure: Paperclip issue title/body for the `cancelled` case (CTO escalation). */
export function terminalIssueTitle({ repo, pr, ref }) {
  const short = repo.includes('/') ? repo.split('/')[1] : repo;
  return `pr-hygiene/${short}#${pr.number}: ${ref} cancelled with PR still open`;
}

export function terminalIssueBody({ repo, pr, ref }) {
  return [
    `Filed automatically by scripts/check-pr-hygiene.mjs (AUR-5513 check A).`,
    '',
    `**PR:** https://github.com/${repo}/pull/${pr.number} — ${pr.title}`,
    `**Referenced issue:** ${ref}, now \`cancelled\`.`,
    '',
    `${ref} was cancelled while this PR is still open and unmerged. Per AUR-5097: a ` +
      'cancelled issue does not mean the code is wrong — the exact incident this check ' +
      'exists to prevent was a correct PR silently orphaned by its issue dying.',
    '',
    '**Do not auto-close the PR.** Review the diff against current master:',
    '- Superseded/already landed another way → close the PR with evidence, comment why.',
    '- Still correct and needed → land it (rebase, verify CI, merge), then re-open or ' +
      `reference the outcome from ${ref}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Check B: duplicate migration idx — pure decision logic
// ---------------------------------------------------------------------------

/**
 * Pure: find idx collisions among migration journals proposed by open PRs,
 * plus collisions against the journal already on master.
 *
 * `masterEntries`: [{idx, tag}] — the journal currently on the target branch.
 * `prJournals`: [{repo, number, entries: [{idx, tag}]}] — only PRs whose diff
 *   touches the journal file need to be included by the caller.
 *
 * An entry is a "claim" only if it is not already present on master with the
 * identical tag (i.e. it's new work the PR is proposing). A claim collides
 * when two+ sources claim the same idx, or one source claims an idx master
 * already uses for a different tag (the PR is stale relative to master).
 */
export function findMigrationIdxCollisions({ masterEntries, prJournals }) {
  const masterIdx = new Map(masterEntries.map((e) => [e.idx, e.tag]));
  const claims = new Map();
  for (const { repo, number, entries } of prJournals) {
    for (const e of entries) {
      if (masterIdx.has(e.idx) && masterIdx.get(e.idx) === e.tag) continue;
      const list = claims.get(e.idx) ?? [];
      list.push({ source: `${repo}#${number}`, tag: e.tag });
      claims.set(e.idx, list);
    }
  }
  const collisions = [];
  for (const [idx, list] of claims) {
    const onMaster = masterIdx.has(idx);
    if (list.length > 1 || onMaster) {
      collisions.push({ idx, onMaster, masterTag: masterIdx.get(idx) ?? null, claims: list });
    }
  }
  return collisions.sort((a, b) => a.idx - b.idx);
}

/** Pure: stable identity for a collision, for cooldown state keying. */
export function collisionKey(repo, collision) {
  const sources = collision.claims.map((c) => c.source).sort().join(',');
  return `${repo}:idx${collision.idx}:${sources}`;
}

/** Pure: decide whether a given collision is still in cooldown. */
export function needsMigrationAlert({ state, key, nowMs }) {
  const entry = state.collisions?.[key];
  if (!entry?.alertedAt) return true;
  return nowMs - Date.parse(entry.alertedAt) > COOLDOWN_MS;
}

/** Pure: PR comment body for check B. */
export function migrationCollisionCommentBody(collision) {
  const otherSources = collision.claims.map((c) => `${c.source} (\`${c.tag}\`)`).join(', ');
  const masterNote = collision.onMaster
    ? ` \`idx: ${collision.idx}\` is already used on master by \`${collision.masterTag}\` — this PR is stale and needs a rebase, not just a renumber.`
    : ` Renumber one side to the next free \`idx\` — do not just drop a side, that compiles and passes CI while silently losing a migration.`;
  return [
    `Automated PR-hygiene check (scripts/check-pr-hygiene.mjs, AUR-5513).`,
    '',
    `**Duplicate migration \`idx: ${collision.idx}\`** claimed by: ${otherSources}.`,
    '',
    masterNote,
  ].join('\n');
}

/** Pure: Paperclip issue title/body for check B. */
export function migrationIssueTitle(repo, collision) {
  const short = repo.includes('/') ? repo.split('/')[1] : repo;
  const sources = collision.claims.map((c) => c.source).join(', ');
  return `pr-hygiene/${short}: duplicate migration idx ${collision.idx} across ${sources}`;
}

export function migrationIssueBody(repo, collision) {
  const rows = collision.claims
    .map((c) => `- \`${c.source}\` → \`${c.tag}\``)
    .join('\n');
  return [
    `Filed automatically by scripts/check-pr-hygiene.mjs (AUR-5513 check B).`,
    '',
    `**Repo:** ${repo}`,
    `**Colliding \`idx: ${collision.idx}\`:**`,
    rows,
    collision.onMaster ? `- master already has \`idx: ${collision.idx}\` = \`${collision.masterTag}\`` : '',
    '',
    'Resolve by renumbering the later PR to the next free `idx`, NOT by dropping either ' +
      'side — a dropped side compiles and passes CI while silently losing a migration ' +
      '(PR #264/#266, AUR-5513). `pnpm check:migrations` in packages/db validates ordering ' +
      'after the renumber.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// I/O plumbing
// ---------------------------------------------------------------------------

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function ghComment(repo, number, body) {
  execFileSync('gh', ['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`], {
    encoding: 'utf8',
  });
}

/** Fetch and parse a journal file at a given ref; null if the path doesn't exist there. */
function fetchJournal(repo, ref) {
  let raw;
  try {
    raw = ghJson(`repos/${repo}/contents/${MIGRATIONS_JOURNAL_PATH}?ref=${ref}`);
  } catch {
    return null;
  }
  const content = Buffer.from(raw.content ?? '', raw.encoding ?? 'base64').toString('utf8');
  const parsed = JSON.parse(content);
  return (parsed.entries ?? []).map((e) => ({ idx: e.idx, tag: e.tag }));
}

function defaultBranch(repo) {
  return ghJson(`repos/${repo}`).default_branch ?? 'master';
}

function loadState(stateDir, file) {
  const f = join(stateDir, file);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(stateDir, file, state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), `${JSON.stringify(state, null, 2)}\n`);
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

async function fileIssue(args, title, description, priority = 'high') {
  const created = await api(args, 'POST', `/api/companies/${args.companyId}/issues`, {
    title,
    description,
    priority,
    assigneeAgentId: CTO_AGENT_ID,
  });
  // 201 is not proof — read the row back before recording the dispatch.
  await api(args, 'GET', `/api/issues/${created.id}`);
  return created.identifier ?? created.id;
}

// ---------------------------------------------------------------------------
// Check runners
// ---------------------------------------------------------------------------

async function runTerminalIssueCheck(args, prsByRepo) {
  const stateFile = 'terminal-issue-pr.json';
  const state = loadState(args.stateDir, stateFile);
  state.actions = state.actions ?? {};
  const statusCache = new Map();
  const nowMs = Date.now();
  let acted = 0;

  for (const [repo, prs] of prsByRepo) {
    for (const pr of prs) {
      const refs = extractIssueRefs(pr.title);
      for (const ref of refs) {
        if (!statusCache.has(ref)) {
          try {
            const issue = await api(args, 'GET', `/api/issues/${ref}`);
            statusCache.set(ref, issue.status ?? null);
          } catch (err) {
            console.error(`WARN: could not fetch ${ref} status: ${err.message}`);
            statusCache.set(ref, null);
            continue;
          }
        }
        const status = statusCache.get(ref);
        const action = decideTerminalIssueAction({ repo, pr, ref, status, state, nowMs });
        if (!action) continue;

        if (args.dryRun) {
          console.log(
            `DRY-RUN: check-A ${repo}#${pr.number} ${ref}=${status} — comment=${action.needsComment} file-cto-issue=${action.needsIssue}`,
          );
          acted += 1;
          continue;
        }

        const entry = state.actions[action.key] ?? {};
        if (action.needsComment) {
          try {
            ghComment(repo, pr.number, terminalPrCommentBody({ ref, status }));
            entry.commentedAt = new Date().toISOString();
            console.log(`check-A: commented on ${repo}#${pr.number} re ${ref} (${status})`);
          } catch (err) {
            console.error(`DELIVERY-FAILURE check-A comment ${repo}#${pr.number}: ${err.message}`);
          }
        }
        if (action.needsIssue) {
          try {
            const filed = await fileIssue(
              args,
              terminalIssueTitle({ repo, pr, ref }),
              terminalIssueBody({ repo, pr, ref }),
              'critical',
            );
            entry.filedIssue = filed;
            console.log(`check-A: filed ${filed} for ${repo}#${pr.number} re ${ref} (cancelled)`);
          } catch (err) {
            console.error(`DELIVERY-FAILURE check-A file-issue ${repo}#${pr.number}: ${err.message}`);
          }
        }
        state.actions[action.key] = entry;
        saveState(args.stateDir, stateFile, state);
        acted += 1;
      }
    }
  }
  return acted;
}

async function runMigrationIdxCheck(args, prsByRepo) {
  const stateFile = 'migration-idx.json';
  const state = loadState(args.stateDir, stateFile);
  state.collisions = state.collisions ?? {};
  const nowMs = Date.now();
  let acted = 0;

  for (const [repo, prs] of prsByRepo) {
    let masterEntries;
    try {
      masterEntries = fetchJournal(repo, defaultBranch(repo));
    } catch (err) {
      console.error(`WARN: check-B could not read master journal for ${repo}: ${err.message}`);
      continue;
    }
    if (masterEntries === null) {
      console.log(`check-B: ${repo} has no migrations journal at ${MIGRATIONS_JOURNAL_PATH} — skipping`);
      continue;
    }

    const prJournals = [];
    for (const pr of prs) {
      let files;
      try {
        files = ghJson(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
      } catch (err) {
        console.error(`WARN: check-B could not list files for ${repo}#${pr.number}: ${err.message}`);
        continue;
      }
      if (!files.some((f) => f.filename === MIGRATIONS_JOURNAL_PATH)) continue;
      const entries = fetchJournal(repo, pr.headSha);
      if (entries === null) continue;
      prJournals.push({ repo, number: pr.number, entries });
    }
    if (prJournals.length === 0) continue;

    const collisions = findMigrationIdxCollisions({ masterEntries, prJournals });
    for (const collision of collisions) {
      const key = collisionKey(repo, collision);
      if (!needsMigrationAlert({ state, key, nowMs })) continue;

      if (args.dryRun) {
        console.log(`DRY-RUN: check-B ${repo} idx=${collision.idx} sources=${collision.claims.map((c) => c.source).join(',')}`);
        acted += 1;
        continue;
      }

      for (const claim of collision.claims) {
        const number = Number(claim.source.split('#')[1]);
        try {
          ghComment(repo, number, migrationCollisionCommentBody(collision));
        } catch (err) {
          console.error(`DELIVERY-FAILURE check-B comment ${repo}#${number}: ${err.message}`);
        }
      }
      try {
        const filed = await fileIssue(
          args,
          migrationIssueTitle(repo, collision),
          migrationIssueBody(repo, collision),
        );
        console.log(`check-B: filed ${filed} for ${repo} idx=${collision.idx}`);
      } catch (err) {
        console.error(`DELIVERY-FAILURE check-B file-issue ${repo} idx=${collision.idx}: ${err.message}`);
      }
      state.collisions[key] = { alertedAt: new Date().toISOString() };
      saveState(args.stateDir, stateFile, state);
      acted += 1;
    }
  }
  return acted;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    repos: [],
    stateDir: join(process.env.HOME ?? '/home/ievgen', '.paperclip', 'pr-hygiene'),
    apiBase: 'http://127.0.0.1:3100',
    dryRun: false,
    skipTerminalCheck: false,
    skipMigrationCheck: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-terminal-check') args.skipTerminalCheck = true;
    else if (a === '--skip-migration-check') args.skipMigrationCheck = true;
    else if (a === '--repo') {
      args.repos.push(
        ...String(argv[++i] ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      );
    } else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.repos.length === 0) args.repos = [...DEFAULT_REPOS];
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  args.companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!args.dryRun && (!process.env.PAPERCLIP_API_KEY || !args.companyId)) {
    console.error('FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot act.');
    process.exit(2);
  }

  const prsByRepo = new Map();
  let enumerationFailures = 0;
  for (const repo of args.repos) {
    try {
      const prs = ghJson(`repos/${repo}/pulls?state=open&per_page=100`).map((p) => ({
        number: p.number,
        title: p.title ?? '',
        body: p.body ?? '',
        headSha: p.head?.sha ?? '',
      }));
      // Liveness line: printed before anything else can fail, one per repo.
      console.log(`repo=${repo} open=${prs.length}`);
      prsByRepo.set(repo, prs);
    } catch (err) {
      console.error(`FATAL: repo=${repo} could not list open PRs: ${err.message}`);
      enumerationFailures += 1;
    }
  }

  if (!args.skipTerminalCheck) {
    const n = await runTerminalIssueCheck(args, prsByRepo);
    console.log(`check-A (terminal-issue-with-open-PR): ${n} action(s)`);
  }
  if (!args.skipMigrationCheck) {
    const n = await runMigrationIdxCheck(args, prsByRepo);
    console.log(`check-B (duplicate migration idx): ${n} action(s)`);
  }

  if (enumerationFailures > 0) process.exit(2);
}

// Compare realpaths, not argv[1] spelling — a symlinked release dir (AUR-5111)
// makes a string compare never match while systemd still logs Result=success.
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
