#!/usr/bin/env node
/**
 * execution-workspace-reaper.mjs — AUR-4110
 *
 * Execution worktrees created by heartbeat runs (server/src/services/workspace-runtime.ts)
 * are only ever cleaned up on a persistence-failure error path or via the explicit
 * /execution-workspaces/:id/archive endpoint, which nothing calls automatically. The
 * happy path leaks a `paperclip-wt-*` directory + branch on every normal run.
 *
 * This is a guarded reaper for the existing backlog, not an automatic hook into the
 * completion path — it is dry-run by default and requires --apply to delete anything.
 *
 * Safety guards (see AUR-3896 — a reaper that blindly force-removes destroys in-flight
 * agent work):
 *   1. Refuses a dirty worktree (uncommitted tracked/untracked changes).
 *   2. Refuses a worktree with unpushed commits (vs upstream, or vs --base-ref when
 *      there is no upstream configured). If unpushed status can't be determined at all,
 *      it refuses rather than guessing.
 *   3. Refuses a worktree it cannot confirm is *not* backing an active execution
 *      workspace / live run, via the Paperclip API. No credentials/API reachable means
 *      refuse, not proceed — an idle-age heuristic alone is not a substitute for this.
 *   4. Hard-excludes registered long-lived checkouts (Auranode, booking-service-runtime,
 *      telephony-gateway-runtime) before any git inspection even runs.
 *
 * Only worktrees that pass every guard are removed, and removal uses a non-force
 * `git worktree remove` (relying on git's own dirty-tree refusal as a second layer,
 * not `--force`).
 *
 * Usage:
 *   node scripts/execution-workspace-reaper.mjs                # dry run, default roots
 *   node scripts/execution-workspace-reaper.mjs --apply         # actually remove
 *   node scripts/execution-workspace-reaper.mjs --root '/home/ievgen/paperclip-wt-*'
 */
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

const execFileAsync = promisify(execFile);

export const HARD_EXCLUDED_PATHS = [
  '/home/ievgen/Auranode',
  '/home/ievgen/booking-service-runtime',
  '/home/ievgen/telephony-gateway-runtime',
];

export const DEFAULT_ROOTS = [
  '/home/ievgen/paperclip-wt-*',
  '/home/ievgen/auranode-worktrees/*',
];

const ACTIVE_EXECUTION_WORKSPACE_STATUSES = new Set(['active', 'idle']);

async function runGit(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrResolve(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function isExcludedPath(dir, excluded = HARD_EXCLUDED_PATHS) {
  const real = await realpathOrResolve(dir);
  return excluded.some((ex) => real === ex || real.startsWith(`${ex}${path.sep}`));
}

/** A linked worktree has a `.git` *file* (not directory) pointing at `<repo>/.git/worktrees/<name>`. */
export async function isLinkedGitWorktree(dir) {
  try {
    const gitPath = path.join(dir, '.git');
    const stat = await fs.stat(gitPath);
    if (!stat.isFile()) return false;
    const content = await fs.readFile(gitPath, 'utf8');
    return /^gitdir:\s*.+[\\/]\.git[\\/]worktrees[\\/]/.test(content.trim());
  } catch {
    return false;
  }
}

export async function checkDirty(dir) {
  const { stdout } = await runGit(dir, ['status', '--porcelain', '--untracked-files=all']);
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  return { dirty: entries.length > 0, entryCount: entries.length };
}

/**
 * Refuses (hasUnpushed: true) whenever it can't positively prove there is nothing to
 * lose: real unpushed commits, or an inability to check at all.
 */
export async function checkUnpushed(dir, baseRef = 'origin/master') {
  try {
    await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const { stdout } = await runGit(dir, ['log', '--oneline', '@{u}..']);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    return { hasUnpushed: entries.length > 0, commitCount: entries.length, mode: 'upstream' };
  } catch {
    // No upstream configured — fall through to a base-ref comparison.
  }
  try {
    const { stdout } = await runGit(dir, ['log', '--oneline', `${baseRef}..HEAD`]);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    return { hasUnpushed: entries.length > 0, commitCount: entries.length, mode: 'base-ref' };
  } catch (err) {
    return {
      hasUnpushed: true,
      commitCount: null,
      mode: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cross-checks a candidate worktree path against the live execution_workspaces table
 * via the Paperclip API. Missing credentials or an unreachable API is reported as
 * `checked: false` so the caller refuses removal rather than assuming it's safe.
 */
export async function findActiveExecutionWorkspaceForPath(dir, { apiBase, apiKey, companyId, fetchImpl = fetch } = {}) {
  if (!apiBase || !apiKey || !companyId) {
    return { checked: false, reason: 'Paperclip API credentials (PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID) not configured' };
  }
  const real = await realpathOrResolve(dir);
  let workspaces;
  try {
    const res = await fetchImpl(`${apiBase}/api/companies/${companyId}/execution-workspaces`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { checked: false, reason: `execution-workspaces API returned ${res.status}` };
    }
    workspaces = await res.json();
  } catch (err) {
    return { checked: false, reason: `execution-workspaces API unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  // A given path can have accumulated multiple execution_workspaces rows over its
  // lifetime (reuse, retries). Any one of them reporting active/idle is disqualifying —
  // do not just inspect the first match.
  const matches = (Array.isArray(workspaces) ? workspaces : []).filter((w) => {
    const wPath = w.providerRef ?? w.cwd;
    return typeof wPath === 'string' && wPath.length > 0 && path.resolve(wPath) === real;
  });
  if (matches.length === 0) return { checked: true, active: false, match: null };
  const activeMatch = matches.find((w) => ACTIVE_EXECUTION_WORKSPACE_STATUSES.has(w.status));
  if (activeMatch) return { checked: true, active: true, match: activeMatch };
  return { checked: true, active: false, match: matches[0] };
}

/**
 * Builds a dry-run plan: one decision per candidate directory, never touching disk.
 */
export async function planReaperRun({
  candidates,
  excludedPaths = HARD_EXCLUDED_PATHS,
  baseRef = 'origin/master',
  activeRunChecker,
}) {
  const decisions = [];
  for (const dir of candidates) {
    if (await isExcludedPath(dir, excludedPaths)) {
      decisions.push({ path: dir, action: 'skip', reason: 'hard-excluded registered long-lived checkout' });
      continue;
    }
    if (!(await pathExists(dir))) {
      decisions.push({ path: dir, action: 'skip', reason: 'path does not exist' });
      continue;
    }
    if (!(await isLinkedGitWorktree(dir))) {
      decisions.push({ path: dir, action: 'skip', reason: 'not a linked git worktree — refusing to touch a full checkout' });
      continue;
    }

    let dirtyResult;
    try {
      dirtyResult = await checkDirty(dir);
    } catch (err) {
      decisions.push({ path: dir, action: 'skip', reason: `could not read git status: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (dirtyResult.dirty) {
      decisions.push({ path: dir, action: 'skip', reason: `dirty working tree (${dirtyResult.entryCount} entr${dirtyResult.entryCount === 1 ? 'y' : 'ies'})` });
      continue;
    }

    const unpushedResult = await checkUnpushed(dir, baseRef);
    if (unpushedResult.hasUnpushed) {
      const reason = unpushedResult.mode === 'unknown'
        ? `could not verify unpushed status, refusing: ${unpushedResult.error}`
        : `${unpushedResult.commitCount} unpushed commit(s) vs ${unpushedResult.mode === 'upstream' ? 'upstream' : baseRef}`;
      decisions.push({ path: dir, action: 'skip', reason });
      continue;
    }

    const activeCheck = activeRunChecker ? await activeRunChecker(dir) : { checked: false, reason: 'no active-run checker configured' };
    if (!activeCheck.checked) {
      decisions.push({ path: dir, action: 'skip', reason: `cannot verify active-run status, refusing: ${activeCheck.reason}` });
      continue;
    }
    if (activeCheck.active) {
      decisions.push({
        path: dir,
        action: 'skip',
        reason: `linked to active execution workspace ${activeCheck.match?.id ?? 'unknown'} (status=${activeCheck.match?.status ?? 'unknown'})`,
      });
      continue;
    }

    decisions.push({ path: dir, action: 'remove', reason: 'clean, fully pushed, no active execution workspace' });
  }
  return decisions;
}

/**
 * Applies a plan's `remove` decisions. Deliberately does NOT use `--force` — every
 * candidate here has already passed the dirty-tree guard, and git's own refusal is a
 * second independent safety net if something changed between plan and apply.
 */
export async function applyReaperPlan(decisions, repoRoot) {
  const results = [];
  for (const decision of decisions) {
    if (decision.action !== 'remove') {
      results.push({ ...decision, applied: false });
      continue;
    }
    let branch = null;
    try {
      const { stdout } = await runGit(decision.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = stdout.trim();
    } catch {
      // Detached HEAD or unreadable — proceed without a branch delete.
    }
    try {
      await runGit(repoRoot, ['worktree', 'remove', decision.path]);
    } catch (err) {
      results.push({ ...decision, applied: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let branchDeleted = false;
    let branchError = null;
    if (branch && branch !== 'HEAD' && branch !== 'main' && branch !== 'master') {
      try {
        await runGit(repoRoot, ['branch', '-d', branch]);
        branchDeleted = true;
      } catch (err) {
        branchError = err instanceof Error ? err.message : String(err);
      }
    }
    results.push({ ...decision, applied: true, branch, branchDeleted, branchError });
  }
  return results;
}

export async function discoverCandidates(rootGlobs) {
  const found = [];
  for (const rootGlob of rootGlobs) {
    const dir = path.dirname(rootGlob);
    const base = path.basename(rootGlob);
    if (!base.endsWith('*')) {
      if (await pathExists(rootGlob)) found.push(rootGlob);
      continue;
    }
    const prefix = base.slice(0, -1);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      repo: { type: 'string', default: process.cwd() },
      'base-ref': { type: 'string', default: 'origin/master' },
      root: { type: 'string', multiple: true },
    },
  });
  const roots = values.root && values.root.length > 0 ? values.root : DEFAULT_ROOTS;
  const candidates = await discoverCandidates(roots);

  const apiBase = await resolveApiBase();
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const activeRunChecker = (dir) => findActiveExecutionWorkspaceForPath(dir, { apiBase, apiKey, companyId });

  const decisions = await planReaperRun({ candidates, baseRef: values['base-ref'], activeRunChecker });

  console.log(`Scanned ${candidates.length} candidate director${candidates.length === 1 ? 'y' : 'ies'} under: ${roots.join(', ')}\n`);
  for (const d of decisions) {
    console.log(`${d.action.toUpperCase().padEnd(6)} ${d.path}\n       ${d.reason}`);
  }
  const toRemove = decisions.filter((d) => d.action === 'remove');
  console.log(`\n${toRemove.length} of ${decisions.length} candidate(s) eligible for removal.`);

  if (values.apply) {
    if (toRemove.length === 0) {
      console.log('\nNothing eligible — no changes made.');
    } else {
      console.log('\nApplying...');
      const results = await applyReaperPlan(toRemove, values.repo);
      for (const r of results) {
        if (r.applied) {
          console.log(`REMOVED ${r.path}${r.branch ? ` (branch ${r.branch}${r.branchDeleted ? ' deleted' : r.branchError ? `, delete failed: ${r.branchError}` : ''})` : ''}`);
        } else {
          console.log(`FAILED  ${r.path} — ${r.error}`);
        }
      }
    }
  } else {
    console.log('\nDry run only (default) — pass --apply to actually remove.');
  }

  console.log(`\nPLAN_JSON=${JSON.stringify(decisions)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
