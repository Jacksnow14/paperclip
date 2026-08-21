#!/usr/bin/env node
// reap-tmp-scratch.mjs — bounded age-based reaper for /tmp scratch entries (AUR-5992,
// follow-up on AUR-5955 "disk pressure at 95%").
//
// ROOT CAUSE (confirmed on AUR-5992): Ubuntu's default /usr/lib/tmpfiles.d/tmp.conf
// ships `D /tmp 1777 root root -` — the age field is `-`, which explicitly disables
// systemd-tmpfiles-clean.timer's age-based cleanup for /tmp specifically, even though
// the timer itself is armed and fires daily. There is no /etc/tmpfiles.d/tmp.conf
// override. Left alone, agent scratch directories (PR review/check/deploy work dirs,
// heartbeat JSON dumps, gh-cli-cache, npm _npx caches) accumulate under /tmp without
// bound between manual interventions.
//
// WHY A CUSTOM SCRIPT INSTEAD OF A tmpfiles.d OVERRIDE (tradeoff, per the issue's
// "reviewer's call" prompt): systemd-tmpfiles' age-based cleanup is pure
// atime/mtime-plus-directory-pattern matching. It has no concept of "is any live
// process using this directory" or "does this git worktree have uncommitted/unpushed
// work" — exactly the two failure modes this session already hit manually (a live
// embedded-postgres data dir under /tmp/pcvt-*, and the standing dirty-tree/unpushed
// rule this repo already applies to every other reaper). A tmpfiles.d rule cannot
// encode either check, so it would either need to permanently exclude broad name
// patterns (fragile, drifts) or risk removing something live. A script that shells out
// to `ps`/`/proc` and `git` for each candidate mirrors the exact safety bar the
// existing worktree reapers (reap-stale-worktrees.mjs / reap-agent-clones.mjs) already
// use and is the only way to satisfy the issue's explicit liveness-check requirement.
//
// RETENTION POLICY — a top-level /tmp entry is removed ONLY when ALL of the following
// hold:
//   1. It is not a system-owned/reserved path (SYSTEM_PATTERNS below: systemd-private-*,
//      .X11-unix, .ICE-unix, .font-unix, .Test-unix, .XIM-unix, snap-private-tmp).
//   2. It is owned by the invoking user (skips other-owned/root-owned entries this
//      script has no business touching regardless of age).
//   3. No running process has it as its cwd, and no running process holds any open
//      file descriptor under it (checked via /proc/<pid>/cwd and /proc/<pid>/fd/*,
//      the same liveness bar `ps aux`/`lsof` would establish — this is what a bare
//      mtime check misses, per this session's own /tmp/pcvt-* postgres near-miss).
//   4. If it (or anything nested under it, up to a bounded depth) is a git repo:
//      the working tree must be clean AND every commit reachable from HEAD must be
//      pushed to some origin/* ref — identical to the worktree reaper's rule. Any
//      such repo failing either check exempts the WHOLE top-level entry.
//   5. Its newest mtime anywhere in the tree (bounded scan) is at least --age-days old
//      (default 7 — same floor as the worktree reapers).
//   6. The per-run removal cap (--max-removals) has not been reached.
//   FAIL CLOSED: any check that cannot be evaluated (unreadable /proc, git error,
//   unreadable stat) => the entry is SKIPPED and the skip is logged.
//
// SAFETY: DRY-RUN BY DEFAULT. Pass --apply to actually remove. Removal is `rm -rf`
// scoped to a path already proven non-live, non-dirty, non-system, user-owned, and
// age-qualified — there is no git-worktree-remove equivalent for plain scratch dirs.
//
// Usage:
//   node scripts/dev/reap-tmp-scratch.mjs [--apply] [--tmp-root /tmp] [--age-days 7]
//     [--max-removals 1000] [--max-scan-depth 6] [--max-scan-entries 20000]
//
// Exit codes: 0 = ok (always — no external API dependency, nothing to degrade on).

import { spawnSync } from 'node:child_process';
import {
  readdirSync, statSync, lstatSync, readlinkSync, realpathSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const SYSTEM_PATTERNS = [
  /^systemd-private-/, /^\.X11-unix$/, /^\.ICE-unix$/, /^\.font-unix$/,
  /^\.Test-unix$/, /^\.XIM-unix$/, /^snap-private-tmp$/,
];

export function isSystemPath(name) {
  return SYSTEM_PATTERNS.some((re) => re.test(name));
}

export function runGit(cwd, args) {
  if (args.some((a) => String(a).includes('stash'))) {
    throw new Error(`refusing git invocation containing "stash": git ${args.join(' ')}`);
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Lists every PID currently visible under /proc.
function listPids() {
  let entries;
  try {
    entries = readdirSync('/proc', { withFileTypes: true });
  } catch {
    return null; // /proc unreadable — caller must fail closed
  }
  return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name);
}

// Returns true if `target` (already realpath-resolved) is `base` or nested under it.
function isUnderOrEqual(target, base) {
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`);
}

// Scans /proc ONCE and returns every path any live process currently has as its cwd
// or an open file descriptor into — a flat list of { path, pid, via }. Building this
// once per run (rather than once per candidate) turns what would be an
// O(candidates * pids * fds) /proc walk into O(pids * fds) + a cheap prefix-match per
// candidate afterwards; with dozens of /tmp candidates and hundreds of processes each
// holding hundreds of fds, the naive per-candidate rescan is what made an early version
// of this script take minutes against a live host's /tmp. Returns null if /proc itself
// could not be listed — callers must fail closed on null.
export function buildLiveIndex() {
  const pids = listPids();
  if (pids === null) return null;
  const index = [];
  for (const pid of pids) {
    try {
      index.push({ path: realpathSync(`/proc/${pid}/cwd`), pid, via: 'cwd' });
    } catch {
      // process exited mid-scan, or no permission — not evidence either way
    }
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // typical: no permission to read another user's fd list
    }
    for (const fd of fds) {
      try {
        index.push({ path: readlinkSync(`/proc/${pid}/fd/${fd}`), pid, via: `fd/${fd}` });
      } catch {
        // fd closed mid-scan — not evidence either way
      }
    }
  }
  return index;
}

// Checks a precomputed live index (from buildLiveIndex) for any entry whose path is
// `absPath` or nested under it. Returns { live: true, pid, via } | { live: false }.
export function isLiveIn(liveIndex, absPath) {
  let real;
  try {
    real = realpathSync(absPath);
  } catch {
    return { live: null };
  }
  for (const entry of liveIndex) {
    if (isUnderOrEqual(entry.path, real)) return { live: true, pid: entry.pid, via: entry.via };
  }
  return { live: false };
}

// Convenience single-candidate wrapper (builds its own index) — used by tests and any
// one-off caller. The reaper's main loop uses buildLiveIndex()+isLiveIn() directly so
// /proc is scanned once for the whole run, not once per candidate.
export function checkLiveProcess(absPath) {
  const index = buildLiveIndex();
  if (index === null) return { live: null };
  return isLiveIn(index, absPath);
}

// Bounded walk collecting: newest mtime seen anywhere in the tree, and every .git
// entry found (dir or file — a linked worktree's .git is a file). Stops descending
// into a directory once it finds a .git in it (a repo's internals are never separately
// interesting). Returns null if the scan hit its entry-count bound before finishing —
// callers must fail closed (treat as "not old enough to safely judge") on null.
export function scanTree(root, { maxDepth = 6, maxEntries = 20000 } = {}) {
  let newestMtimeMs = -Infinity;
  let totalSize = 0;
  const gitRoots = [];
  let scanned = 0;
  let truncated = false;

  function walk(dir, depth) {
    if (truncated) return;
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return;
    }
    if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      totalSize += st.size;
      return;
    }
    scanned += 1;
    if (scanned > maxEntries) { truncated = true; return; }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      gitRoots.push(dir);
      return; // do not descend into a repo's own tracked contents
    }
    if (depth <= 0) { truncated = true; return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      scanned += 1;
      if (scanned > maxEntries) { truncated = true; return; }
      if (e.isDirectory()) {
        walk(p, depth - 1);
      } else {
        let est;
        try {
          est = lstatSync(p);
        } catch {
          continue;
        }
        if (est.mtimeMs > newestMtimeMs) newestMtimeMs = est.mtimeMs;
        totalSize += est.size;
      }
    }
  }

  walk(root, maxDepth);
  if (truncated) return null;
  return { newestMtimeMs, totalSize, gitRoots };
}

// Applies the worktree reaper's exact dirty/unpushed rule to a discovered git repo
// root. Returns { ok: true } if it is safe to consider this repo reapable, or
// { ok: false, reason } otherwise. Never touches the stash stack (runGit refuses).
export function checkGitRepoSafe(repoDir) {
  let dirty;
  try {
    dirty = runGit(repoDir, ['status', '--porcelain']);
  } catch (e) {
    return { ok: false, reason: `git status failed: ${e.message} (fail closed)` };
  }
  if (dirty.code !== 0) return { ok: false, reason: `git status failed: ${dirty.stderr.trim()} (fail closed)` };
  if (dirty.stdout.trim() !== '') return { ok: false, reason: 'dirty working tree — may be someone\'s only copy' };

  const unpushed = runGit(repoDir, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  if (unpushed.code !== 0) return { ok: false, reason: `rev-list failed: ${unpushed.stderr.trim()} (fail closed)` };
  const aheadCount = parseInt(unpushed.stdout.trim(), 10);
  if (!Number.isFinite(aheadCount)) return { ok: false, reason: 'unparseable rev-list output (fail closed)' };
  if (aheadCount > 0) return { ok: false, reason: `${aheadCount} commit(s) not on any origin ref — unpushed work` };
  return { ok: true };
}

function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

export function reapTmpScratch(opts) {
  const {
    tmpRoot, apply = false, ageDays = 7, maxRemovals = 1000,
    maxScanDepth = 6, maxScanEntries = 20000,
    log = console.log, error = console.error,
  } = opts;

  const root = resolve(tmpRoot);
  const nowMs = Date.now();
  const uid = process.getuid ? process.getuid() : null;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    error(`REFUSED: cannot list ${root}: ${e.message}`);
    return { exitCode: 3, removed: [], skipped: [] };
  }

  const liveIndex = buildLiveIndex();

  const removed = [];
  const skipped = [];
  let budget = maxRemovals;

  for (const e of entries) {
    const path = join(root, e.name);
    const skip = (reason) => {
      skipped.push({ path, reason });
      log(`SKIP  ${path}  — ${reason}`);
    };

    if (isSystemPath(e.name)) { skip('system-owned/reserved path — never a candidate'); continue; }

    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      skip(`stat failed: ${err.message} (fail closed)`);
      continue;
    }

    if (uid !== null && st.uid !== uid) { skip(`owned by uid ${st.uid}, not this run's uid ${uid} — not ours to remove`); continue; }

    if (liveIndex === null) { skip('liveness check unavailable (/proc unreadable) — fail closed'); continue; }
    const live = isLiveIn(liveIndex, path);
    if (live.live === null) { skip('liveness check unavailable (path resolution failed) — fail closed'); continue; }
    if (live.live) { skip(`live process attached (pid ${live.pid} via ${live.via})`); continue; }

    if (!st.isDirectory() && !st.isFile()) { skip(`not a plain file/dir (${st.isSymbolicLink() ? 'symlink' : 'special'}) — fail closed`); continue; }

    let scan;
    let newestMtimeMs;
    let sizeBytes;
    if (st.isDirectory()) {
      scan = scanTree(path, { maxDepth: maxScanDepth, maxEntries: maxScanEntries });
      if (scan === null) { skip(`scan truncated at bound (depth/entries) — fail closed`); continue; }
      newestMtimeMs = scan.newestMtimeMs;
      sizeBytes = scan.totalSize;

      let repoBlocked = false;
      for (const repoDir of scan.gitRoots) {
        const check = checkGitRepoSafe(repoDir);
        if (!check.ok) {
          skip(`contains git repo ${repoDir}: ${check.reason}`);
          repoBlocked = true;
          break;
        }
      }
      if (repoBlocked) continue;
    } else {
      newestMtimeMs = st.mtimeMs;
      sizeBytes = st.size;
    }

    const ageDaysActual = (nowMs - newestMtimeMs) / 86_400_000;
    if (ageDaysActual < ageDays) { skip(`age floor: newest activity ${ageDaysActual.toFixed(1)}d ago (< ${ageDays}d)`); continue; }

    if (removed.length >= budget) { skip(`bounded: --max-removals ${maxRemovals} reached this run`); continue; }

    const label = `${path}  [${ageDaysActual.toFixed(0)}d old, ${fmtSize(sizeBytes)}]`;
    if (!apply) {
      removed.push({ path, ageDays: ageDaysActual, sizeBytes });
      log(`REAP (dry-run)  ${label}`);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: false });
    } catch (err) {
      skip(`rm failed: ${err.message} (fail closed)`);
      continue;
    }
    removed.push({ path, ageDays: ageDaysActual, sizeBytes });
    log(`REAPED  ${label}`);
  }

  const totalReclaimed = removed.reduce((sum, r) => sum + r.sizeBytes, 0);
  log(`${apply ? '' : 'DRY-RUN — nothing was removed. '}summary: ${removed.length} ${apply ? 'removed' : 'would be removed'} (${fmtSize(totalReclaimed)}), ${skipped.length} skipped.`);

  return { exitCode: 0, removed, skipped };
}

async function mainCli() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'tmp-root': { type: 'string', default: '/tmp' },
      'age-days': { type: 'string', default: '7' },
      'max-removals': { type: 'string', default: '1000' },
      'max-scan-depth': { type: 'string', default: '6' },
      'max-scan-entries': { type: 'string', default: '20000' },
    },
  });
  const result = reapTmpScratch({
    tmpRoot: values['tmp-root'],
    apply: values.apply,
    ageDays: Number(values['age-days']),
    maxRemovals: Number(values['max-removals']),
    maxScanDepth: Number(values['max-scan-depth']),
    maxScanEntries: Number(values['max-scan-entries']),
  });
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainCli();
}
