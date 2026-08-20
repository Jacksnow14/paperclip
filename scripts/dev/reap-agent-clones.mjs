#!/usr/bin/env node
// reap-agent-clones.mjs — generalizes AUR-4998's bounded worktree reaper to every
// per-agent private git clone under paperclip-data/instances/*/projects/*/*, not just
// the single shared /home/ievgen/paperclip clone (AUR-5959, follow-up on AUR-5955).
//
// BACKGROUND: each agent's session directory (paperclip-data/instances/<instance>/
// projects/<companyId>/<agentSessionId>/) contains its own private git clone — usually
// rooted at `_default`, sometimes nested one or two levels deeper (e.g. `_default/
// paperclip`, `_default/some-worker/repo`). Every issue worked from that session then
// creates `git worktree add` entries that can land ANYWHERE on disk: siblings of
// `_default` inside the session tree, under $HOME directly (e.g. /home/ievgen/foo-bar),
// or under /tmp. `git worktree list --porcelain` run from the true main clone already
// enumerates every one of those, wherever it physically lives — this script only needs
// to find the MAIN clone roots; reap() (imported unmodified from reap-stale-worktrees.mjs)
// does the rest with the exact safety rules already proven and armed under AUR-4998:
//   age floor, dirty-tree skip, unpushed-commit skip ("pushed anywhere on origin"),
//   closed-issue-only removal, per-run removal cap, fail-closed on any unresolvable
//   check, removal only ever via `git worktree remove` (never rm -rf, never --force,
//   never stash).
//
// DISCOVERY: walk each agent-session directory up to --max-nest-depth levels looking
// for `.git` entries (dirs or files — a linked worktree's `.git` is a file). For every
// git root found, attempt reap({main: root, ...}); reap() itself refuses (exitCode 3)
// anything that isn't a true main clone (its own git-dir == git-common-dir check), so
// a linked worktree that happens to be co-located inside the same session tree (e.g.
// `<session>/aur3175-telephony`, itself a worktree of `<session>/_default`) is silently
// and cheaply excluded from the candidate list rather than duplicated or misread as its
// own clone. This is the SAME check the module already uses to protect the shared
// clone — reused, not reimplemented.
//
// GLOBAL BUDGET: --max-removals bounds the TOTAL removals across every clone in one
// run (not per clone) — each clone gets whatever budget remains after the clones
// scanned before it. Once exhausted, remaining clones are still fully evaluated and
// logged (so every skip reason stays visible every run) but reap() will not remove
// anything further from them this run.
//
// UNRESOLVABLE-NAME REPORT: a worktree directory that doesn't parse to an aurNNNN issue
// id can never be safely auto-removed (there's no issue to confirm closed) — that part
// of AUR-4998's fail-closed posture is intentionally unchanged. What changes here is
// visibility: every such skip, across every clone scanned, is collected into one
// "NEEDS MANUAL TRIAGE" section printed at the end of the run, so these worktrees
// surface on a periodic cron run instead of scrolling past as anonymous per-line noise
// forever (AUR-5959 scope item 2, option b).
//
// PNPM STORE PRUNE: pnpm's content-addressable store hardlinks package files across
// worktrees/clones (confirmed on AUR-5955: `stat -c 'links=%h'` showed links=52 on
// shared package files) — removing a worktree alone leaves the now-unreferenced blobs
// in the store. After any batch with at least one removal, this script runs
// `pnpm store prune` once (not per clone).
//
// Usage:
//   node scripts/dev/reap-agent-clones.mjs [--apply] [--age-days 7] [--max-removals 25]
//     [--projects-root /home/ievgen/paperclip-data/instances] [--max-nest-depth 3]
//     [--api-base http://127.0.0.1:3100] [--skip-pnpm-prune]
//   Auth: reads bearer token from $PAPERCLIP_API_KEY (used for every company scanned;
//   a company the token cannot query degrades to fail-closed for that company only —
//   see fetchIssueStatusMap in reap-stale-worktrees.mjs).
//
// Exit codes: 0 = ok; 2 = degraded (one or more scanned clones had issue-status
// resolution failures — nothing named with an issue was removed from those clones).
// This script itself never "refuses" globally the way reap() does for a single bad
// --main; a single unreadable session directory is skipped, not fatal.

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { reap } from './reap-stale-worktrees.mjs';

// Directories never worth descending into looking for a nested clone: either they are
// themselves package/build output (never contain a *distinct* repo worth reaping) or
// they are large enough to make the walk slow for zero payoff.
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.turbo', '.cache', 'vendor', '.git',
]);

// Finds every directory at or below `dir` (within `depthRemaining` levels) that
// contains a `.git` entry, WITHOUT descending further once one is found — a repo's own
// internal structure is never itself a candidate. Returns paths via `out`.
export function walkForGitRoots(dir, depthRemaining, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === '.git')) {
    out.push(dir);
    return;
  }
  if (depthRemaining <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(e.name)) continue;
    walkForGitRoots(join(dir, e.name), depthRemaining - 1, out);
  }
}

// Enumerates agent-session directories under <projectsRoot>/<instance>/projects/
// <companyId>/<agentSessionId>/ and returns every git root found within each, tagged
// with the companyId the API calls for that clone must use.
export function discoverGitRoots(projectsRoot, maxNestDepth = 3) {
  const found = [];
  let instances;
  try {
    instances = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const inst of instances) {
    if (!inst.isDirectory()) continue;
    const projectsDir = join(projectsRoot, inst.name, 'projects');
    let companies;
    try {
      companies = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const co of companies) {
      if (!co.isDirectory()) continue;
      const companyDir = join(projectsDir, co.name);
      let sessions;
      try {
        sessions = readdirSync(companyDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sess of sessions) {
        if (!sess.isDirectory()) continue;
        const roots = [];
        walkForGitRoots(join(companyDir, sess.name), maxNestDepth, roots);
        for (const path of roots) {
          found.push({ path, companyId: co.name, agentSessionId: sess.name, instance: inst.name });
        }
      }
    }
  }
  return found;
}

export async function reapAgentClones(opts) {
  const {
    projectsRoot, maxNestDepth = 3, apply = false, ageDays = 7, maxRemovals = 25,
    apiBase, token, skipPnpmPrune = false, log = console.log, error = console.error,
  } = opts;

  const candidates = discoverGitRoots(projectsRoot, maxNestDepth);
  const clonesScanned = [];
  const unresolvableNameReport = [];
  let budget = maxRemovals;
  let totalRemoved = 0;
  let totalSkipped = 0;
  let degradedAny = false;

  for (const cand of candidates) {
    // A candidate discovered by the walk can vanish mid-run: it may be a co-located
    // linked worktree of an EARLIER candidate's true main clone, already removed by
    // that clone's own reap() pass this same run (discovery order is not guaranteed to
    // visit a main clone before its co-located worktrees). Re-check existence right
    // before use rather than trusting the walk snapshot.
    if (!existsSync(cand.path)) continue;
    const prefix = `[${cand.companyId}/${cand.agentSessionId}] `;
    let refused = false;
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await reap({
        main: cand.path,
        apply,
        ageDays,
        maxRemovals: budget,
        apiBase,
        companyId: cand.companyId,
        token,
        log: (m) => log(prefix + m),
        error: (m) => {
          if (/REFUSED:.*not a main clone/.test(m)) { refused = true; return; }
          error(prefix + m);
        },
      });
    } catch (e) {
      log(`${prefix}SKIP clone probe — ${e.message} (fail closed)`);
      continue;
    }
    if (refused) continue; // co-located linked worktree, not a distinct clone — cheap, silent skip

    clonesScanned.push({ path: cand.path, companyId: cand.companyId, ...result });
    budget = Math.max(0, budget - result.removed.length);
    totalRemoved += result.removed.length;
    totalSkipped += result.skipped.length;
    if (result.exitCode === 2) degradedAny = true;
    for (const s of result.skipped) {
      if (s.reason.startsWith('unresolvable name')) {
        unresolvableNameReport.push({ clone: cand.path, worktree: s.path });
      }
    }
  }

  if (apply && totalRemoved > 0 && !skipPnpmPrune) {
    const pr = spawnSync('pnpm', ['store', 'prune'], { encoding: 'utf8' });
    if (pr.error) {
      log(`pnpm store prune skipped: ${pr.error.message}`);
    } else if (pr.status === 0) {
      const lastLine = pr.stdout.trim().split('\n').filter(Boolean).slice(-1)[0] || 'ok';
      log(`pnpm store prune: ${lastLine}`);
    } else {
      log(`pnpm store prune failed (exit ${pr.status}): ${pr.stderr.trim()}`);
    }
  }

  if (unresolvableNameReport.length > 0) {
    log('=== NEEDS MANUAL TRIAGE (unresolvable name — no aurNNNN in directory name, never auto-removed) ===');
    for (const u of unresolvableNameReport) log(`  ${u.worktree}  (clone: ${u.clone})`);
  }

  log(`ALL-CLONES SUMMARY: ${clonesScanned.length} clone(s) scanned, ${totalRemoved} ${apply ? 'removed' : 'would be removed'}, ${totalSkipped} skipped, ${unresolvableNameReport.length} unresolvable-name (manual triage).`);

  return {
    exitCode: degradedAny ? 2 : 0, clonesScanned, totalRemoved, totalSkipped, unresolvableNameReport,
  };
}

async function mainCli() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'projects-root': { type: 'string', default: '/home/ievgen/paperclip-data/instances' },
      'max-nest-depth': { type: 'string', default: '3' },
      'age-days': { type: 'string', default: '7' },
      'max-removals': { type: 'string', default: '25' },
      'api-base': { type: 'string', default: process.env.PAPERCLIP_API_BASE || 'http://127.0.0.1:3100' },
      'skip-pnpm-prune': { type: 'boolean', default: false },
    },
  });
  const result = await reapAgentClones({
    projectsRoot: resolve(values['projects-root']),
    maxNestDepth: Number(values['max-nest-depth']),
    apply: values.apply,
    ageDays: Number(values['age-days']),
    maxRemovals: Number(values['max-removals']),
    apiBase: values['api-base'],
    token: process.env.PAPERCLIP_API_KEY,
    skipPnpmPrune: values['skip-pnpm-prune'],
  });
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainCli().catch((e) => { console.error(e); process.exit(1); });
}
