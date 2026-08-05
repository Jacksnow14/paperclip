#!/usr/bin/env node
// reap-stale-worktrees.mjs — bounded GC for linked worktrees of the shared paperclip clone (AUR-4998).
//
// RETENTION POLICY (explicit, per AUR-4998):
//   A linked worktree is removed ONLY when ALL of the following hold:
//     1. Its directory name resolves to an issue identifier (aurNNNN → AUR-NNNN) whose
//        status is CLOSED (`done` or `cancelled`) per the Paperclip issues API.
//     2. Its working tree is clean (`git status --porcelain` empty).
//     3. Every commit reachable from its HEAD is present on some `origin/*` ref
//        (`git rev-list HEAD --not --remotes=origin` empty). "Pushed anywhere on origin"
//        is the recoverability bar — squash-merged PR branches clear it because the
//        branch itself was pushed, even though master never contains their shas.
//     4. Its HEAD commit is at least --age-days old (default 7). Worktrees are created
//        off then-current master, so HEAD age approximates worktree age.
//     5. The per-run removal cap (--max-removals, default 25) has not been reached.
//        The script is idempotent and converges over repeated (e.g. scheduled) runs.
//   FAIL CLOSED: any check that cannot be evaluated (unresolvable name, issue not found,
//   API unreachable, git error, locked worktree) ⇒ the worktree is SKIPPED and the skip
//   is logged. Nothing is ever silently dropped from the report.
//
// SAFETY (doctrine, not preference):
//   - Removal is ONLY ever `git -C <main-clone> worktree remove <path>` — never rm -rf,
//     never --force. git itself re-checks cleanliness at removal time.
//   - The main clone is never a candidate; the script refuses to run at all if --main
//     does not point at a main (non-linked) working tree. A second guard compares
//     realpaths immediately before each removal.
//   - `git stash` is never invoked: runGit() rejects any argv containing "stash"
//     (the shared clone has ONE stash stack for all worktrees — see
//     scripts/dev/shared-clone-guard/).
//   - DRY-RUN BY DEFAULT. Pass --apply to actually remove.
//
// Registered-but-missing worktrees (directory already gone) are reported as "prunable"
// and, under --apply, cleaned with `git worktree prune -v` — which by definition only
// touches administrative data of worktrees whose directories no longer exist.
//
// Usage:
//   node scripts/dev/reap-stale-worktrees.mjs [--apply] [--main /home/ievgen/paperclip]
//     [--age-days 7] [--max-removals 25] [--api-base http://127.0.0.1:3100]
//     [--company-id <uuid>]
//   Auth: reads bearer token from $PAPERCLIP_API_KEY.
//
// Exit codes: 0 = ok; 2 = degraded (issue-status map unavailable — every
// issue-resolution failed closed, nothing with an issue name was removed);
// 3 = refused (--main is not a main clone).

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const CLOSED_STATUSES = new Set(['done', 'cancelled']);

export function runGit(cwd, args) {
  if (args.some((a) => String(a).includes('stash'))) {
    throw new Error(`refusing git invocation containing "stash": git ${args.join(' ')}`);
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function extractIssueId(dirName) {
  const m = /aur[-_]?(\d+)/i.exec(dirName);
  return m ? `AUR-${m[1]}` : null;
}

export function parseWorktreeList(porcelain) {
  const entries = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), locked: false, prunable: false, bare: false };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
  }
  return entries;
}

// Pages the whole issues list (the API has no lookup-by-identifier route and caps at
// 1000 rows/page) and returns Map<identifier, status>, or null if the map could not be
// built — the caller must fail closed on null.
export async function fetchIssueStatusMap(apiBase, companyId, token) {
  if (!token) return null;
  const map = new Map();
  try {
    for (let offset = 0; ; offset += 1000) {
      const res = await fetch(
        `${apiBase}/api/companies/${companyId}/issues?limit=1000&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      for (const row of rows) {
        if (row?.identifier && row?.status) map.set(String(row.identifier).toUpperCase(), row.status);
      }
      if (rows.length < 1000) break;
    }
  } catch {
    return null;
  }
  return map;
}

function isMainClone(dir) {
  // In the main working tree, --git-dir and --git-common-dir resolve to the same path;
  // in a linked worktree, --git-dir is <common>/worktrees/<name>.
  const gitDir = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir.code !== 0 || commonDir.code !== 0) return false;
  return realpathSync(gitDir.stdout.trim()) === realpathSync(commonDir.stdout.trim());
}

export async function reap(opts) {
  const {
    main, apply = false, ageDays = 7, maxRemovals = 25,
    apiBase, companyId, token, log = console.log, error = console.error,
  } = opts;

  const mainReal = realpathSync(resolve(main));
  if (!isMainClone(mainReal)) {
    error(`REFUSED: ${main} is not a main clone (it is a linked worktree or not a git work tree). This script only operates via the main clone.`);
    return { exitCode: 3, removed: [], skipped: [], prunable: [] };
  }

  const listed = runGit(mainReal, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) {
    error(`REFUSED: git worktree list failed: ${listed.stderr.trim()}`);
    return { exitCode: 3, removed: [], skipped: [], prunable: [] };
  }
  const entries = parseWorktreeList(listed.stdout);

  const statusMap = await fetchIssueStatusMap(apiBase, companyId, token);
  const degraded = statusMap === null;
  if (degraded) error('WARNING: issue-status map unavailable (API/token) — failing closed on every issue resolution.');

  const removed = [];
  const skipped = [];   // { path, reason }
  const prunable = [];
  const nowSec = Date.now() / 1000;

  for (const wt of entries) {
    const wtReal = existsSync(wt.path) ? realpathSync(wt.path) : wt.path;
    if (wt.bare || wtReal === mainReal) {
      log(`EXCLUDED  ${wt.path}  (main clone — never a candidate)`);
      continue;
    }
    if (wt.prunable || !existsSync(wt.path)) { prunable.push(wt.path); continue; }

    const skip = (reason) => skipped.push({ path: wt.path, reason });
    if (wt.locked) { skip('locked worktree (fail closed)'); continue; }

    const issueId = extractIssueId(basename(wt.path));
    if (!issueId) { skip('unresolvable name — no aurNNNN in directory name (fail closed)'); continue; }
    if (degraded) { skip(`${issueId}: status unavailable (fail closed)`); continue; }
    const status = statusMap.get(issueId);
    if (!status) { skip(`${issueId}: not found in issues API (fail closed)`); continue; }
    if (!CLOSED_STATUSES.has(status)) { skip(`${issueId} is open (${status})`); continue; }

    let dirty;
    try { dirty = runGit(wt.path, ['status', '--porcelain']); } catch (e) { skip(`git status failed: ${e.message} (fail closed)`); continue; }
    if (dirty.code !== 0) { skip(`git status failed: ${dirty.stderr.trim()} (fail closed)`); continue; }
    if (dirty.stdout.trim() !== '') { skip(`dirty working tree (${dirty.stdout.trim().split('\n').length} entries) — may be someone's only copy`); continue; }

    const unpushed = runGit(wt.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
    if (unpushed.code !== 0) { skip(`rev-list failed: ${unpushed.stderr.trim()} (fail closed)`); continue; }
    const aheadCount = parseInt(unpushed.stdout.trim(), 10);
    if (!Number.isFinite(aheadCount)) { skip('unparseable rev-list output (fail closed)'); continue; }
    if (aheadCount > 0) { skip(`${aheadCount} commit(s) not on any origin ref — unpushed work`); continue; }

    const headTime = runGit(wt.path, ['log', '-1', '--format=%ct']);
    const headEpoch = parseInt(headTime.stdout.trim(), 10);
    if (headTime.code !== 0 || !Number.isFinite(headEpoch)) { skip('cannot determine HEAD commit age (fail closed)'); continue; }
    const ageInDays = (nowSec - headEpoch) / 86400;
    if (ageInDays < ageDays) { skip(`age floor: HEAD is ${ageInDays.toFixed(1)}d old (< ${ageDays}d)`); continue; }

    if (removed.length >= maxRemovals) { skip(`bounded: --max-removals ${maxRemovals} reached this run`); continue; }

    if (!apply) {
      removed.push(wt.path);
      log(`REAP (dry-run)  ${wt.path}  [${issueId} ${status}, clean, pushed, ${ageInDays.toFixed(0)}d old]`);
      continue;
    }
    if (realpathSync(wt.path) === mainReal) throw new Error(`guard tripped: candidate resolves to main clone: ${wt.path}`);
    const rm = runGit(mainReal, ['worktree', 'remove', wt.path]);
    if (rm.code !== 0) { skip(`git worktree remove refused: ${rm.stderr.trim()} (fail closed)`); continue; }
    removed.push(wt.path);
    log(`REAPED  ${wt.path}  [${issueId} ${status}, clean, pushed, ${ageInDays.toFixed(0)}d old]`);
  }

  for (const p of prunable) log(`PRUNABLE  ${p}  (registered worktree, directory missing)`);
  if (prunable.length > 0 && apply) {
    const pr = runGit(mainReal, ['worktree', 'prune', '-v']);
    log(pr.code === 0 ? `pruned ${prunable.length} stale registration(s)` : `worktree prune failed: ${pr.stderr.trim()}`);
  }

  for (const s of skipped) log(`SKIP  ${s.path}  — ${s.reason}`);
  log(`${apply ? '' : 'DRY-RUN — nothing was removed. '}summary: ${removed.length} ${apply ? 'removed' : 'would be removed'}, ${skipped.length} skipped, ${prunable.length} prunable registration(s).`);
  return { exitCode: degraded ? 2 : 0, removed, skipped, prunable };
}

async function mainCli() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      main: { type: 'string', default: '/home/ievgen/paperclip' },
      'age-days': { type: 'string', default: '7' },
      'max-removals': { type: 'string', default: '25' },
      'api-base': { type: 'string', default: process.env.PAPERCLIP_API_BASE || 'http://127.0.0.1:3100' },
      'company-id': { type: 'string', default: process.env.PAPERCLIP_COMPANY_ID || 'b26d3647-3e6c-4a28-9c25-e9315696484d' },
    },
  });
  const result = await reap({
    main: values.main,
    apply: values.apply,
    ageDays: Number(values['age-days']),
    maxRemovals: Number(values['max-removals']),
    apiBase: values['api-base'],
    companyId: values['company-id'],
    token: process.env.PAPERCLIP_API_KEY,
  });
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainCli().catch((e) => { console.error(e); process.exit(1); });
}
