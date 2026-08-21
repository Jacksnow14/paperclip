// Tests for reap-tmp-scratch.mjs (AUR-5992).
//
// Every safety rule is proven both to FIRE (block removal when it applies) and to
// PASS (allow removal when it does not), against a DISPOSABLE sandbox directory that
// stands in for /tmp — never the real /tmp:
//   system path      FIRE: systemd-private-foo          PASS: plain-old-dir
//   uid ownership    (not exercised — would require root to create another-uid files;
//                      isSystemPath/uid-compare logic itself is a plain equality check)
//   live process     FIRE: dir a spawned child cwd's into   PASS: same dir after child exits
//   dirty git repo   FIRE: uncommitted change              PASS: clean + pushed repo
//   unpushed commits FIRE: commit not on any origin ref     PASS: clean + pushed repo
//   age floor        FIRE: freshly-touched dir              PASS: mtime backdated past floor
//   bounded cap      FIRE: --max-removals 1 with 2 eligible  PASS: same dirs with cap raised
//
// Run: node --test scripts/dev/reap-tmp-scratch.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSystemPath, checkLiveProcess, scanTree, checkGitRepoSafe, reapTmpScratch,
} from './reap-tmp-scratch.mjs';

let sandbox;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'reap-tmp-scratch-sandbox-'));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function backdate(path, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(path, t, t);
}

function sg(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

test('isSystemPath: FIRE on known system dir names, PASS on plain names', () => {
  assert.equal(isSystemPath('systemd-private-abc123-foo.service-xyz'), true);
  assert.equal(isSystemPath('.X11-unix'), true);
  assert.equal(isSystemPath('.ICE-unix'), true);
  assert.equal(isSystemPath('snap-private-tmp'), true);
  assert.equal(isSystemPath('pcvt-abcdef'), false);
  assert.equal(isSystemPath('gh-cli-cache'), false);
});

test('checkLiveProcess: FIRE while a child has the dir as cwd, PASS once it exits', async () => {
  const dir = join(sandbox, 'live-check');
  mkdirSync(dir);

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir });
  await new Promise((r) => setTimeout(r, 200)); // let the child actually chdir

  const whileLive = checkLiveProcess(dir);
  assert.equal(whileLive.live, true);
  assert.equal(whileLive.via, 'cwd');

  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300)); // let /proc drop the entry

  const afterExit = checkLiveProcess(dir);
  assert.equal(afterExit.live, false);
});

test('checkGitRepoSafe: FIRE on dirty tree, PASS on clean+pushed', () => {
  const upstream = join(sandbox, 'upstream.git');
  mkdirSync(upstream);
  sg(upstream, ['init', '--bare', '-q']);

  const repo = join(sandbox, 'repo-clean');
  sg(sandbox, ['clone', '-q', upstream, repo]);
  sg(repo, ['config', 'user.email', 'test@example.com']);
  sg(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'a.txt'), 'hello');
  sg(repo, ['add', 'a.txt']);
  sg(repo, ['commit', '-q', '-m', 'init']);
  sg(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);

  const clean = checkGitRepoSafe(repo);
  assert.equal(clean.ok, true);

  writeFileSync(join(repo, 'a.txt'), 'dirty change');
  const dirty = checkGitRepoSafe(repo);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /dirty working tree/);
});

test('checkGitRepoSafe: FIRE on unpushed commit, PASS once pushed', () => {
  const upstream = join(sandbox, 'upstream2.git');
  mkdirSync(upstream);
  sg(upstream, ['init', '--bare', '-q']);

  const repo = join(sandbox, 'repo-unpushed');
  sg(sandbox, ['clone', '-q', upstream, repo]);
  sg(repo, ['config', 'user.email', 'test@example.com']);
  sg(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'a.txt'), 'hello');
  sg(repo, ['add', 'a.txt']);
  sg(repo, ['commit', '-q', '-m', 'init']);

  const unpushed = checkGitRepoSafe(repo);
  assert.equal(unpushed.ok, false);
  assert.match(unpushed.reason, /unpushed work/);

  sg(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const pushed = checkGitRepoSafe(repo);
  assert.equal(pushed.ok, true);
});

test('scanTree: FIRE truncation under a tiny entry bound, PASS under a generous one', () => {
  const dir = join(sandbox, 'scan-bound');
  mkdirSync(dir);
  for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x');

  const truncated = scanTree(dir, { maxDepth: 6, maxEntries: 2 });
  assert.equal(truncated, null);

  const full = scanTree(dir, { maxDepth: 6, maxEntries: 1000 });
  assert.notEqual(full, null);
  assert.equal(full.gitRoots.length, 0);
});

test('reapTmpScratch end-to-end: age floor, system path, dirty-repo, live-process, and cap all fire and pass correctly', async () => {
  const root = join(sandbox, 'tmp-root');
  mkdirSync(root);

  // 1. old plain dir -> reapable
  const oldDir = join(root, 'old-scratch');
  mkdirSync(oldDir);
  writeFileSync(join(oldDir, 'x.json'), '{}');
  backdate(join(oldDir, 'x.json'), 10);
  backdate(oldDir, 10);

  // 2. fresh dir -> age floor skip
  const freshDir = join(root, 'fresh-scratch');
  mkdirSync(freshDir);
  writeFileSync(join(freshDir, 'x.json'), '{}');

  // 3. system path -> always skip regardless of age
  const sysDir = join(root, 'systemd-private-abc-foo.service-xyz');
  mkdirSync(sysDir);
  backdate(sysDir, 30);

  // 4. old dir containing a dirty git repo -> whole entry exempted
  const dirtyParent = join(root, 'old-with-dirty-repo');
  mkdirSync(dirtyParent);
  const upstream = join(sandbox, 'upstream3.git');
  mkdirSync(upstream);
  sg(upstream, ['init', '--bare', '-q']);
  const dirtyRepo = join(dirtyParent, 'repo');
  sg(dirtyParent, ['clone', '-q', upstream, dirtyRepo]);
  sg(dirtyRepo, ['config', 'user.email', 'test@example.com']);
  sg(dirtyRepo, ['config', 'user.name', 'Test']);
  writeFileSync(join(dirtyRepo, 'a.txt'), 'hi');
  sg(dirtyRepo, ['add', 'a.txt']);
  sg(dirtyRepo, ['commit', '-q', '-m', 'init']);
  sg(dirtyRepo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  writeFileSync(join(dirtyRepo, 'a.txt'), 'dirty');
  backdate(dirtyParent, 30);

  // 5. old dir with a live process cwd'd into it -> skip
  const liveDir = join(root, 'old-but-live');
  mkdirSync(liveDir);
  backdate(liveDir, 30);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: liveDir });
  await new Promise((r) => setTimeout(r, 200));

  const dryRun = reapTmpScratch({
    tmpRoot: root, apply: false, ageDays: 7, maxRemovals: 200, log: () => {}, error: () => {},
  });
  const dryRunPaths = dryRun.removed.map((r) => r.path).sort();
  assert.deepEqual(dryRunPaths, [oldDir].sort());
  assert.equal(existsSync(oldDir), true, 'dry-run must not remove anything');

  const skipReasons = Object.fromEntries(dryRun.skipped.map((s) => [s.path, s.reason]));
  assert.match(skipReasons[freshDir], /age floor/);
  assert.match(skipReasons[sysDir], /system-owned/);
  assert.match(skipReasons[dirtyParent], /dirty working tree/);
  assert.match(skipReasons[liveDir], /live process attached/);

  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));

  // liveDir was old + system-clean all along; once the process exits it becomes
  // reapable on the next run — proving PASS for the liveness rule, not just FIRE.
  const afterExitDryRun = reapTmpScratch({
    tmpRoot: root, apply: false, ageDays: 7, maxRemovals: 200, log: () => {}, error: () => {},
  });
  assert.ok(afterExitDryRun.removed.some((r) => r.path === liveDir), 'liveDir should be reapable once the process exits');

  // bounded cap: three eligible dirs (oldDir, liveDir, and the new capDir), cap of 1
  // removes only one this run.
  const capDir = join(root, 'old-scratch-2');
  mkdirSync(capDir);
  backdate(capDir, 10);
  const capped = reapTmpScratch({
    tmpRoot: root, apply: false, ageDays: 7, maxRemovals: 1, log: () => {}, error: () => {},
  });
  assert.equal(capped.removed.length, 1);

  const uncapped = reapTmpScratch({
    tmpRoot: root, apply: true, ageDays: 7, maxRemovals: 200, log: () => {}, error: () => {},
  });
  const removedPaths = uncapped.removed.map((r) => r.path).sort();
  assert.deepEqual(removedPaths, [oldDir, liveDir, capDir].sort());
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(liveDir), false);
  assert.equal(existsSync(capDir), false);
  assert.equal(existsSync(freshDir), true, 'fresh dir must survive --apply');
  assert.equal(existsSync(sysDir), true, 'system path must survive --apply');
  assert.equal(existsSync(dirtyParent), true, 'dirty-repo-containing dir must survive --apply');
});
