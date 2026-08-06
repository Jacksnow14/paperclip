// Tests for reap-stale-worktrees.mjs (AUR-4998).
//
// Runs against a DISPOSABLE sandbox that mimics the shared-clone topology
// (throwaway bare upstream + main clone + linked worktrees) — never against the
// live shared clone. Every skip rule is proven both to FIRE (block a removal when
// it applies) and to PASS (allow removal when it does not):
//   open issue      FIRE: wt-aur1002 (in_progress)   PASS: wt-aur1001 (done) / wt-aur1006 (cancelled)
//   dirty tree      FIRE: wt-aur1003                 PASS: wt-aur1001
//   unpushed        FIRE: wt-aur1004                 PASS: wt-aur1001 (on origin/main), wt-aur1005 (pushed branch)
//   age floor       FIRE: wt-aur1005 (fresh commit)  PASS: wt-aur1001 (40d old)
//   resolvable name FIRE: wt-noname                  PASS: wt-aur1001
//   bounded cap     FIRE: wt-aur1006 under --max-removals 1   PASS: same wt once cap allows
//   main-clone      FIRE: --apply --main <linked wt> refused  PASS: normal runs operate via real main clone
//   stash-free      FIRE: runGit() throws on stash argv       PASS: full --apply run logs zero stash invocations (PATH shim)
//
// Run: node --test scripts/dev/reap-stale-worktrees.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, mkdirSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { runGit, extractIssueId } from './reap-stale-worktrees.mjs';

const SCRIPT = fileURLToPath(new URL('./reap-stale-worktrees.mjs', import.meta.url));
const OLD_DATE = new Date(Date.now() - 40 * 86400_000).toISOString();

let tmp, mc, shimLog, baseEnv, server, port;

function sg(cwd, args, dates) {
  const env = { ...baseEnv };
  if (dates) { env.GIT_AUTHOR_DATE = dates; env.GIT_COMMITTER_DATE = dates; }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// The stub API server lives in THIS process, so the script must run async —
// a spawnSync here would freeze the event loop and deadlock the script's fetch.
function runScript(args, { apiBase } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, '--main', mc, '--api-base', apiBase ?? `http://127.0.0.1:${port}`, '--company-id', 'test-co', ...args], {
      env: baseEnv,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'reap-sandbox-'));
  // git shim: logs every git invocation, then delegates to the real git.
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shimDir = join(tmp, 'shim');
  shimLog = join(tmp, 'git-invocations.log');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> "${shimLog}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  writeFileSync(shimLog, '');
  baseEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test',
    GIT_AUTHOR_DATE: undefined, GIT_COMMITTER_DATE: undefined,
    PAPERCLIP_API_KEY: 'test-token',
  };

  // Throwaway upstream + main clone, seeded with a 40-day-old pushed commit.
  sg(tmp, ['init', '--bare', '-b', 'main', 'upstream.git']);
  mc = join(tmp, 'main-clone');
  sg(tmp, ['init', '-b', 'main', 'main-clone']);
  sg(mc, ['remote', 'add', 'origin', join(tmp, 'upstream.git')]);
  writeFileSync(join(mc, 'README.md'), 'sandbox\n');
  sg(mc, ['add', 'README.md']);
  sg(mc, ['commit', '-m', 'seed'], OLD_DATE);
  sg(mc, ['push', '-u', 'origin', 'main']);

  const wtAdd = (name) => { sg(mc, ['worktree', 'add', join(tmp, name), '-b', `br-${name}`, 'main']); return join(tmp, name); };
  wtAdd('wt-aur1001');                               // reapable: closed, clean, pushed, old
  wtAdd('wt-aur1002');                               // open issue
  const dirtyWt = wtAdd('wt-aur1003');               // dirty tree
  writeFileSync(join(dirtyWt, 'junk.txt'), 'uncommitted\n');
  const unpushedWt = wtAdd('wt-aur1004');            // clean but committed-not-pushed
  writeFileSync(join(unpushedWt, 'patch.txt'), 'work\n');
  sg(unpushedWt, ['add', 'patch.txt']);
  sg(unpushedWt, ['commit', '-m', 'unpushed work'], OLD_DATE);
  const youngWt = wtAdd('wt-aur1005');               // pushed but fresh commit (age floor)
  writeFileSync(join(youngWt, 'fresh.txt'), 'fresh\n');
  sg(youngWt, ['add', 'fresh.txt']);
  sg(youngWt, ['commit', '-m', 'fresh pushed work']);
  sg(youngWt, ['push', '-u', 'origin', 'br-wt-aur1005']);
  wtAdd('wt-aur1006');                               // second reapable (cancelled), for the cap test
  wtAdd('wt-noname');                                // unresolvable name
  const goneWt = wtAdd('wt-aur1007');                // registration whose directory vanished
  rmSync(goneWt, { recursive: true, force: true });

  const ISSUES = [
    { identifier: 'AUR-1001', status: 'done' },
    { identifier: 'AUR-1002', status: 'in_progress' },
    { identifier: 'AUR-1003', status: 'done' },
    { identifier: 'AUR-1004', status: 'done' },
    { identifier: 'AUR-1005', status: 'done' },
    { identifier: 'AUR-1006', status: 'cancelled' },
    { identifier: 'AUR-1007', status: 'done' },
  ];
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer test-token' || url.pathname !== '/api/companies/test-co/issues') {
      res.writeHead(401); res.end('{}'); return;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(offset === 0 ? ISSUES : []));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('dry-run is the default: full decision report, nothing removed', async () => {
  const r = await runScript(['--age-days', '7', '--max-removals', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY-RUN — nothing was removed/);
  assert.match(r.stdout, /REAP \(dry-run\) {2}\S*wt-aur1001/);
  assert.match(r.stdout, /REAP \(dry-run\) {2}\S*wt-aur1006/);
  assert.match(r.stdout, /SKIP {2}\S*wt-aur1002 {2}— AUR-1002 is open \(in_progress\)/);
  assert.match(r.stdout, /SKIP {2}\S*wt-aur1003 {2}— dirty working tree/);
  assert.match(r.stdout, /SKIP {2}\S*wt-aur1004 {2}— 1 commit\(s\) not on any origin ref/);
  assert.match(r.stdout, /SKIP {2}\S*wt-aur1005 {2}— age floor/);
  assert.match(r.stdout, /SKIP {2}\S*wt-noname {2}— unresolvable name/);
  assert.match(r.stdout, /PRUNABLE {2}\S*wt-aur1007/);
  assert.match(r.stdout, /EXCLUDED {2}\S*main-clone {2}\(main clone — never a candidate\)/);
  assert.doesNotMatch(r.stdout, /SKIP {2}\S*wt-aur1001/, 'all rules must PASS on the reapable worktree');
  for (const n of ['wt-aur1001', 'wt-aur1002', 'wt-aur1003', 'wt-aur1004', 'wt-aur1005', 'wt-aur1006', 'wt-noname']) {
    assert.ok(existsSync(join(tmp, n)), `${n} must survive a dry run`);
  }
});

test('runGit refuses any stash argv; issue ids resolve from real naming patterns', () => {
  assert.throws(() => runGit(tmp, ['stash', 'list']), /refusing git invocation containing "stash"/);
  assert.equal(extractIssueId('paperclip-aur4987-mig'), 'AUR-4987');
  assert.equal(extractIssueId('paperclip-aur4055'), 'AUR-4055');
  assert.equal(extractIssueId('wt-noname'), null);
});

test('refuses to operate via anything but a main clone', async () => {
  const viaLinked = await runScript(['--apply', '--main', join(tmp, 'wt-aur1002')]);
  assert.equal(viaLinked.status, 3);
  assert.match(viaLinked.stderr, /REFUSED/);
  const viaNonRepo = await runScript(['--apply', '--main', tmp]);
  assert.equal(viaNonRepo.status, 3);
  assert.ok(existsSync(join(tmp, 'wt-aur1001')), 'refused run must remove nothing');
});

test('bounded apply: cap respected, removal only via git worktree remove, no stash ever', async () => {
  writeFileSync(shimLog, '');
  const r = await runScript(['--apply', '--max-removals', '1', '--age-days', '7']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(tmp, 'wt-aur1001')), 'first reapable removed');
  assert.ok(existsSync(join(tmp, 'wt-aur1006')), 'cap must protect the second reapable');
  assert.match(r.stdout, /SKIP {2}\S*wt-aur1006 {2}— bounded: --max-removals 1 reached/);
  assert.match(r.stdout, /pruned 1 stale registration\(s\)/);
  for (const n of ['wt-aur1002', 'wt-aur1003', 'wt-aur1004', 'wt-aur1005', 'wt-noname']) {
    assert.ok(existsSync(join(tmp, n)), `${n} must survive an apply run`);
  }
  assert.ok(existsSync(join(mc, '.git')), 'main clone untouched');
  const log = readFileSync(shimLog, 'utf8');
  assert.match(log, /worktree remove/, 'removal must go through git worktree remove');
  assert.doesNotMatch(log, /stash/, 'no git invocation may touch the stash stack');
});

test('repeated runs converge: cap lifts, remaining reapable goes, then steady-state zero', async () => {
  const r = await runScript(['--apply', '--max-removals', '10', '--age-days', '7']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(tmp, 'wt-aur1006')), 'cancelled issue is closed — reapable once cap allows');
  const list = sg(mc, ['worktree', 'list', '--porcelain']);
  assert.doesNotMatch(list, /wt-aur1001|wt-aur1006|wt-aur1007/);
  for (const n of ['wt-aur1002', 'wt-aur1003', 'wt-aur1004', 'wt-aur1005', 'wt-noname']) assert.match(list, new RegExp(n));
  const steady = await runScript(['--apply', '--max-removals', '10', '--age-days', '7']);
  assert.match(steady.stdout, /summary: 0 removed/);
});

test('fail closed when the issues API is unreachable: no removals, degraded exit code', async () => {
  const r = await runScript([], { apiBase: 'http://127.0.0.1:9' });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /REAP/);
  assert.match(r.stdout, /AUR-1002: status unavailable \(fail closed\)/);
});
