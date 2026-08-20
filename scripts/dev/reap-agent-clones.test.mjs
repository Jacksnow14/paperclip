// Tests for reap-agent-clones.mjs (AUR-5959, generalizes AUR-4998's reap-stale-worktrees.mjs
// to every per-agent private clone, not just the single shared /home/ievgen/paperclip clone).
//
// Runs against a DISPOSABLE sandbox tree shaped like paperclip-data/instances/<instance>/
// projects/<companyId>/<agentSessionId>/ — never against the live fleet. Covers:
//   discovery        FIRE: co-located linked worktree excluded as its own "clone"
//                    PASS: top-level main clone AND one-level-nested main clone both found
//   cross-location   PASS: a worktree registered outside projectsRoot entirely is still
//                          reaped (git worktree list is location-independent)
//   global budget    FIRE: --max-removals shared ACROSS clones, not per clone
//   unresolvable     FIRE: aggregated into one "NEEDS MANUAL TRIAGE" report across clones
//   pnpm prune       FIRE: invoked exactly once per run (not per clone) iff apply && removed>0
//                    PASS: never invoked on a dry run or a zero-removal run
//   walk bounds      FIRE: a .git inside a SKIP_DIR_NAMES directory (e.g. node_modules) is
//                          never discovered
//
// Run: node --test scripts/dev/reap-agent-clones.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { walkForGitRoots } from './reap-agent-clones.mjs';

const SCRIPT = fileURLToPath(new URL('./reap-agent-clones.mjs', import.meta.url));
const OLD_DATE = new Date(Date.now() - 40 * 86400_000).toISOString();

let tmp, shimDir, shimLog, pnpmLog, baseEnv, server, port;

function sg(cwd, args, dates) {
  const env = { ...baseEnv };
  if (dates) { env.GIT_AUTHOR_DATE = dates; env.GIT_COMMITTER_DATE = dates; }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runScript(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, '--api-base', `http://127.0.0.1:${port}`, ...args], {
      env: baseEnv,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

// Builds one bare upstream + one main clone (with an "origin" remote) inside `dir`,
// seeded with an old pushed commit. Returns the main clone path.
function makeMainClone(dir, name) {
  const upstream = join(dir, `${name}-upstream.git`);
  sg(dir, ['init', '--bare', '-b', 'main', upstream]);
  const mc = join(dir, name);
  sg(dir, ['init', '-b', 'main', mc]);
  sg(mc, ['remote', 'add', 'origin', upstream]);
  writeFileSync(join(mc, 'README.md'), 'seed\n');
  sg(mc, ['add', 'README.md']);
  sg(mc, ['commit', '-m', 'seed'], OLD_DATE);
  sg(mc, ['push', '-u', 'origin', 'main']);
  return mc;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'reap-agent-sandbox-'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  shimDir = join(tmp, 'shim');
  shimLog = join(tmp, 'git-invocations.log');
  pnpmLog = join(tmp, 'pnpm-invocations.log');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> "${shimLog}"\nexec "${realGit}" "$@"\n`);
  writeFileSync(join(shimDir, 'pnpm'), `#!/bin/sh\necho "$@" >> "${pnpmLog}"\necho "pruned 0 packages"\nexit 0\n`);
  spawnSync('chmod', ['755', join(shimDir, 'git'), join(shimDir, 'pnpm')]);
  writeFileSync(shimLog, '');
  writeFileSync(pnpmLog, '');
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

  const ISSUES = {
    'co-a': [
      { identifier: 'AUR-3001', status: 'done' },
      { identifier: 'AUR-3002', status: 'done' },
    ],
    'co-b': [
      { identifier: 'AUR-4001', status: 'done' },
    ],
  };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/api\/companies\/([^/]+)\/issues$/.exec(url.pathname);
    if (req.headers.authorization !== 'Bearer test-token' || !m) { res.writeHead(401); res.end('{}'); return; }
    const offset = Number(url.searchParams.get('offset') || 0);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(offset === 0 ? (ISSUES[m[1]] || []) : []));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('walkForGitRoots: finds a git root, does not descend past it, and skips SKIP_DIR_NAMES', () => {
  const root = mkdtempSync(join(tmp, 'walk-'));
  const top = join(root, 'top-clone');
  mkdirSync(top, { recursive: true });
  mkdirSync(join(top, '.git'));
  mkdirSync(join(top, 'src', 'nested-should-not-be-found', '.git'), { recursive: true });
  const nested = join(root, 'a', 'b', 'nested-clone');
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(nested, '.git'));
  const buried = join(root, 'a', 'node_modules', 'pkg');
  mkdirSync(buried, { recursive: true });
  mkdirSync(join(buried, '.git'));

  const out = [];
  walkForGitRoots(root, 4, out);
  assert.ok(out.includes(top), 'top-level clone found');
  assert.ok(out.includes(nested), 'clone nested 2 levels deep found');
  assert.ok(!out.some((p) => p.includes('nested-should-not-be-found')), 'never descends past a found .git');
  assert.ok(!out.some((p) => p.includes('node_modules')), 'node_modules is never descended into');
});

test('discovery + dry run: finds top-level AND one-level-nested main clones; excludes co-located linked worktree as its own clone; sees a worktree registered outside projectsRoot', async () => {
  const projectsRoot = join(tmp, 'instances');
  const sess1 = join(projectsRoot, 'default', 'projects', 'co-a', 'sess1');
  mkdirSync(sess1, { recursive: true });
  const clone1 = makeMainClone(sess1, '_default');
  // co-located linked worktree, sibling of _default inside the session dir — reapable target,
  // but must never itself be treated as a distinct "clone" to scan.
  sg(clone1, ['worktree', 'add', join(sess1, 'wt-aur3001'), '-b', 'br-aur3001', 'main']);
  // worktree registered OUTSIDE projectsRoot entirely — proves location-independence.
  const external = mkdtempSync(join(tmp, 'external-'));
  sg(clone1, ['worktree', 'add', join(external, 'ext-aur3002'), '-b', 'br-aur3002', 'main']);

  const sess2 = join(projectsRoot, 'default', 'projects', 'co-a', 'sess2');
  mkdirSync(join(sess2, '_default'), { recursive: true });
  const clone2 = makeMainClone(join(sess2, '_default'), 'subrepo'); // nested one level under _default
  sg(clone2, ['worktree', 'add', join(sess2, '_default', 'subrepo-wt-noname'), '-b', 'br-noname', 'main']);

  const r = await runScript(['--projects-root', projectsRoot, '--age-days', '7', '--max-removals', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 clone\(s\) scanned/);
  assert.match(r.stdout, /REAP \(dry-run\).*wt-aur3001/);
  assert.match(r.stdout, /REAP \(dry-run\).*ext-aur3002/, 'externally-located worktree still reaped via git worktree list');
  assert.match(r.stdout, /NEEDS MANUAL TRIAGE/);
  assert.match(r.stdout, /subrepo-wt-noname/);
  // The co-located linked worktree must never appear as its own "clone scanned" —
  // only 2 distinct main clones exist in this sandbox.
  assert.doesNotMatch(r.stdout, /REFUSED/, 'refusals for co-located worktrees are swallowed, not surfaced as errors');
});

test('global removal budget is shared across clones, not per clone', async () => {
  const projectsRoot = join(tmp, 'instances-budget');
  const sessA = join(projectsRoot, 'default', 'projects', 'co-a', 'sessA');
  mkdirSync(sessA, { recursive: true });
  const cloneA = makeMainClone(sessA, '_default');
  sg(cloneA, ['worktree', 'add', join(sessA, 'wt-aur3001'), '-b', 'br-a-aur3001', 'main']);

  const sessB = join(projectsRoot, 'default', 'projects', 'co-b', 'sessB');
  mkdirSync(sessB, { recursive: true });
  const cloneB = makeMainClone(sessB, '_default');
  sg(cloneB, ['worktree', 'add', join(sessB, 'wt-aur4001'), '-b', 'br-b-aur4001', 'main']);

  writeFileSync(pnpmLog, '');
  const r = await runScript(['--projects-root', projectsRoot, '--age-days', '7', '--max-removals', '1', '--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 removed/);
  assert.match(r.stdout, /bounded: --max-removals 0 reached this run/, 'second clone gets zero remaining budget');
  const removedA = !existsSync(join(sessA, 'wt-aur3001'));
  const removedB = !existsSync(join(sessB, 'wt-aur4001'));
  assert.equal(removedA !== removedB, true, 'exactly one of the two clones actually removed its candidate');
  assert.equal(pnpmLog && readFileSync(pnpmLog, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'pnpm store prune invoked exactly once for the whole run');
});

test('pnpm store prune is never invoked on a dry run or when nothing was removed', async () => {
  const projectsRoot = join(tmp, 'instances-nopnpm');
  const sess = join(projectsRoot, 'default', 'projects', 'co-a', 'sess');
  mkdirSync(sess, { recursive: true });
  const clone = makeMainClone(sess, '_default');
  sg(clone, ['worktree', 'add', join(sess, 'wt-aur3001'), '-b', 'br-nopnpm', 'main']);

  writeFileSync(pnpmLog, '');
  const dry = await runScript(['--projects-root', projectsRoot, '--age-days', '7', '--max-removals', '10']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(pnpmLog, 'utf8').trim(), '', 'dry run must never invoke pnpm store prune');

  writeFileSync(pnpmLog, '');
  const applyYoung = await runScript(['--projects-root', projectsRoot, '--age-days', '365', '--apply', '--max-removals', '10']);
  assert.equal(applyYoung.status, 0, applyYoung.stderr);
  assert.match(applyYoung.stdout, /0 removed/);
  assert.equal(readFileSync(pnpmLog, 'utf8').trim(), '', 'a zero-removal apply run must never invoke pnpm store prune');
});
