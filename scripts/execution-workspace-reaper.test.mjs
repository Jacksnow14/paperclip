import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HARD_EXCLUDED_PATHS,
  isExcludedPath,
  isLinkedGitWorktree,
  checkDirty,
  checkUnpushed,
  findActiveExecutionWorkspaceForPath,
  planReaperRun,
  applyReaperPlan,
  discoverCandidates,
} from './execution-workspace-reaper.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { cwd });
}

async function mkRepo(prefix) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await runGit(repoRoot, ['init']);
  await runGit(repoRoot, ['config', 'user.name', 'Paperclip Test']);
  await runGit(repoRoot, ['config', 'user.email', 'test@paperclip.local']);
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# test\n', 'utf8');
  await runGit(repoRoot, ['add', 'README.md']);
  await runGit(repoRoot, ['commit', '-m', 'initial']);
  await runGit(repoRoot, ['branch', '-M', 'master']);
  return repoRoot;
}

async function addWorktree(repoRoot, name, branch) {
  const wt = path.join(repoRoot, `..${path.sep}${name}`);
  const resolved = path.resolve(wt);
  await runGit(repoRoot, ['worktree', 'add', '-b', branch, resolved, 'master']);
  return resolved;
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

const noopActiveChecker = async () => ({ checked: true, active: false, match: null });

// ── isExcludedPath ───────────────────────────────────────────────────────────

test('isExcludedPath refuses the exact registered long-lived checkout paths', async () => {
  for (const p of HARD_EXCLUDED_PATHS) {
    assert.ok(await isExcludedPath(p), `expected ${p} to be excluded`);
  }
});

test('isExcludedPath refuses a path nested under a registered checkout', async () => {
  assert.ok(await isExcludedPath('/home/ievgen/Auranode/some/nested/dir'));
});

test('isExcludedPath allows an unrelated path', async () => {
  assert.ok(!(await isExcludedPath('/home/ievgen/paperclip-wt-example')));
});

// ── isLinkedGitWorktree ──────────────────────────────────────────────────────

test('isLinkedGitWorktree accepts a real linked worktree and rejects a full checkout', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-linked-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-linked', 'wt-linked-branch');
    try {
      assert.ok(await isLinkedGitWorktree(wt));
      assert.ok(!(await isLinkedGitWorktree(repoRoot)), 'a full checkout has a .git directory, not a linked worktree');
    } finally {
      await rmrf(wt);
    }
  } finally {
    await rmrf(repoRoot);
  }
});

// ── Guard: dirty worktree (red-before / green-after) ────────────────────────

test('planReaperRun refuses a dirty worktree, and clears once committed', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-dirty-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-dirty', 'wt-dirty-branch');
    try {
      // RED: uncommitted change present.
      await fs.writeFile(path.join(wt, 'scratch.txt'), 'uncommitted work\n', 'utf8');
      const dirty = await checkDirty(wt);
      assert.equal(dirty.dirty, true);

      const dirtyPlan = await planReaperRun({
        candidates: [wt],
        baseRef: 'master',
        activeRunChecker: noopActiveChecker,
      });
      assert.equal(dirtyPlan[0].action, 'skip');
      assert.match(dirtyPlan[0].reason, /dirty working tree/);

      // GREEN: commit and push the branch back to the repo root (acts as upstream-equivalent
      // via base-ref comparison against master after merging).
      await runGit(wt, ['add', 'scratch.txt']);
      await runGit(wt, ['commit', '-m', 'commit the scratch file']);
      await runGit(repoRoot, ['merge', 'wt-dirty-branch']);

      const cleanPlan = await planReaperRun({
        candidates: [wt],
        baseRef: 'master',
        activeRunChecker: noopActiveChecker,
      });
      assert.equal(cleanPlan[0].action, 'remove');
    } finally {
      await rmrf(wt);
    }
  } finally {
    await rmrf(repoRoot);
  }
});

// ── Guard: unpushed commits ───────────────────────────────────────────────

test('planReaperRun refuses a worktree with commits not yet merged into the base ref', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-unpushed-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-unpushed', 'wt-unpushed-branch');
    try {
      await fs.writeFile(path.join(wt, 'feature.txt'), 'feature work\n', 'utf8');
      await runGit(wt, ['add', 'feature.txt']);
      await runGit(wt, ['commit', '-m', 'feature commit, never merged']);

      const unpushed = await checkUnpushed(wt, 'master');
      assert.equal(unpushed.hasUnpushed, true);
      assert.equal(unpushed.commitCount, 1);

      const plan = await planReaperRun({
        candidates: [wt],
        baseRef: 'master',
        activeRunChecker: noopActiveChecker,
      });
      assert.equal(plan[0].action, 'skip');
      assert.match(plan[0].reason, /unpushed commit/);
    } finally {
      await rmrf(wt);
    }
  } finally {
    await rmrf(repoRoot);
  }
});

// ── Guard: active run (red-before / green-after) ────────────────────────────

test('planReaperRun refuses a clean, fully-merged worktree that is linked to an active execution workspace', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-active-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-active', 'wt-active-branch');
    try {
      // Clean and fully merged — every git guard passes.
      await runGit(repoRoot, ['merge', 'wt-active-branch']);
      const clean = await checkDirty(wt);
      assert.equal(clean.dirty, false);

      // RED: an active-run checker reports this path as backing a live execution workspace.
      const activeChecker = async () => ({
        checked: true,
        active: true,
        match: { id: 'ew-123', status: 'active', cwd: wt },
      });
      const blockedPlan = await planReaperRun({ candidates: [wt], baseRef: 'master', activeRunChecker: activeChecker });
      assert.equal(blockedPlan[0].action, 'skip');
      assert.match(blockedPlan[0].reason, /active execution workspace ew-123/);

      // GREEN: the same path with no active run attached is eligible.
      const idleChecker = async () => ({ checked: true, active: false, match: null });
      const openPlan = await planReaperRun({ candidates: [wt], baseRef: 'master', activeRunChecker: idleChecker });
      assert.equal(openPlan[0].action, 'remove');
    } finally {
      await rmrf(wt);
    }
  } finally {
    await rmrf(repoRoot);
  }
});

test('planReaperRun refuses when active-run status cannot be verified at all (fail safe, not fail open)', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-unverifiable-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-unverifiable', 'wt-unverifiable-branch');
    try {
      await runGit(repoRoot, ['merge', 'wt-unverifiable-branch']);
      const uncheckedChecker = async () => ({ checked: false, reason: 'Paperclip API credentials not configured' });
      const plan = await planReaperRun({ candidates: [wt], baseRef: 'master', activeRunChecker: uncheckedChecker });
      assert.equal(plan[0].action, 'skip');
      assert.match(plan[0].reason, /cannot verify active-run status/);
    } finally {
      await rmrf(wt);
    }
  } finally {
    await rmrf(repoRoot);
  }
});

// ── findActiveExecutionWorkspaceForPath ──────────────────────────────────────

test('findActiveExecutionWorkspaceForPath refuses (checked: false) with no credentials configured', async () => {
  const result = await findActiveExecutionWorkspaceForPath('/tmp/whatever', { apiBase: 'http://127.0.0.1:3100' });
  assert.equal(result.checked, false);
});

test('findActiveExecutionWorkspaceForPath matches by resolved providerRef and reports active status', async () => {
  const dir = '/tmp/paperclip-wt-match-example';
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ id: 'ew-1', status: 'active', providerRef: dir, cwd: null }],
  });
  const result = await findActiveExecutionWorkspaceForPath(dir, {
    apiBase: 'http://127.0.0.1:3100',
    apiKey: 'k',
    companyId: 'c',
    fetchImpl,
  });
  assert.equal(result.checked, true);
  assert.equal(result.active, true);
  assert.equal(result.match.id, 'ew-1');
});

test('findActiveExecutionWorkspaceForPath treats any active/idle row for a reused path as disqualifying, even if it is not the first match', async () => {
  const dir = '/tmp/paperclip-wt-reused-example';
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { id: 'ew-old', status: 'archived', providerRef: dir, cwd: null },
      { id: 'ew-current', status: 'idle', providerRef: dir, cwd: null },
    ],
  });
  const result = await findActiveExecutionWorkspaceForPath(dir, {
    apiBase: 'http://127.0.0.1:3100',
    apiKey: 'k',
    companyId: 'c',
    fetchImpl,
  });
  assert.equal(result.checked, true);
  assert.equal(result.active, true);
  assert.equal(result.match.id, 'ew-current');
});

test('findActiveExecutionWorkspaceForPath treats an unreachable API as unverifiable', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await findActiveExecutionWorkspaceForPath('/tmp/x', {
    apiBase: 'http://127.0.0.1:3100',
    apiKey: 'k',
    companyId: 'c',
    fetchImpl,
  });
  assert.equal(result.checked, false);
});

// ── Never touch registered long-lived checkouts ─────────────────────────────

test('planReaperRun skips hard-excluded paths before any git inspection runs', async () => {
  const plan = await planReaperRun({
    candidates: HARD_EXCLUDED_PATHS,
    baseRef: 'master',
    activeRunChecker: noopActiveChecker,
  });
  for (const decision of plan) {
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /hard-excluded/);
  }
});

// ── applyReaperPlan actually removes on a clean, merged, non-active worktree ─

test('applyReaperPlan removes a worktree and its branch only for remove decisions', async () => {
  const repoRoot = await mkRepo('paperclip-reaper-apply-');
  try {
    const wt = await addWorktree(repoRoot, 'wt-apply', 'wt-apply-branch');
    await runGit(repoRoot, ['merge', 'wt-apply-branch']);

    const plan = await planReaperRun({ candidates: [wt], baseRef: 'master', activeRunChecker: noopActiveChecker });
    assert.equal(plan[0].action, 'remove');

    const results = await applyReaperPlan(plan, repoRoot);
    assert.equal(results[0].applied, true);
    assert.equal(results[0].branchDeleted, true);

    const stillExists = await fs.access(wt).then(() => true, () => false);
    assert.equal(stillExists, false);

    const { stdout: branches } = await runGit(repoRoot, ['branch', '--list', 'wt-apply-branch']);
    assert.equal(branches.trim(), '');
  } finally {
    await rmrf(repoRoot);
  }
});

test('applyReaperPlan is a no-op for skip decisions', async () => {
  const results = await applyReaperPlan([{ path: '/tmp/whatever', action: 'skip', reason: 'dirty' }], '/tmp');
  assert.equal(results[0].applied, false);
});

// ── discoverCandidates ────────────────────────────────────────────────────

test('discoverCandidates expands a trailing-* glob to matching child directories only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-reaper-discover-'));
  try {
    await fs.mkdir(path.join(root, 'paperclip-wt-aur1'));
    await fs.mkdir(path.join(root, 'paperclip-wt-aur2'));
    await fs.mkdir(path.join(root, 'unrelated-dir'));
    await fs.writeFile(path.join(root, 'paperclip-wt-file'), 'not a dir', 'utf8');

    const found = await discoverCandidates([path.join(root, 'paperclip-wt-*')]);
    assert.equal(found.length, 2);
    assert.ok(found.every((p) => path.basename(p).startsWith('paperclip-wt-')));
  } finally {
    await rmrf(root);
  }
});
