import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_REPOS,
  decideActions,
  escalationMessage,
  issueBody,
  issueTitle,
  migrateState,
  pickReviewer,
  stateKey,
} from './check-pr-backlog.mjs';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const REPO = 'Jacksnow14/paperclip';
const pr = (n, over = {}) => ({
  number: n,
  title: `fix(AUR-${9000 + n}): thing ${n}`,
  draft: false,
  headSha: `abcdef${n}00000000`,
  createdAt: '2026-08-06T10:00:00Z',
  ...over,
});

test('files a review issue for a PR never seen before', () => {
  const { file, escalate } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: {} },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].number, 1);
  assert.equal(file[0].sha7, 'abcdef1');
  assert.equal(escalate.length, 0);
});

test('does not re-file for an already-dispatched head sha', () => {
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 0);
});

test('a new push (new head sha) re-arms dispatch for the same PR', () => {
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1, { headSha: 'fffffff000' })],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].sha7, 'fffffff');
});

test('cross-repo PR-number collision: repo A state never suppresses repo B (AUR-5111)', () => {
  // Same PR number, same head sha, two different repos. Before (repo, pr)
  // keying, the second repo's PR was silently skipped as "already filed".
  const state = { prs: { [stateKey('Jacksnow14/paperclip', 79)]: { filedSha: 'abcdef7' } } };
  const suppressed = decideActions({
    repo: 'Jacksnow14/paperclip',
    prs: [pr(79, { headSha: 'abcdef70000000' })],
    state,
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(suppressed.file.length, 0);

  const otherRepo = decideActions({
    repo: 'Jacksnow14/Auranode',
    prs: [pr(79, { headSha: 'abcdef70000000' })],
    state,
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(otherRepo.file.length, 1);
  assert.equal(otherRepo.file[0].number, 79);
});

test('legacy bare-number state rows migrate to the paperclip repo key (AUR-5111)', () => {
  const migrated = migrateState({
    prs: {
      214: { filedSha: 'f49a25d', issue: 'AUR-5004' },
      'Jacksnow14/Auranode#9': { filedSha: 'aaaaaaa' },
    },
  });
  assert.equal(migrated.version, 2);
  assert.deepEqual(Object.keys(migrated.prs).sort(), [
    'Jacksnow14/Auranode#9',
    'Jacksnow14/paperclip#214',
  ]);
  assert.equal(migrated.prs['Jacksnow14/paperclip#214'].issue, 'AUR-5004');
  // Idempotent: migrating a migrated state is a no-op.
  assert.deepEqual(migrateState(migrated), migrated);
});

test('draft PRs are skipped entirely', () => {
  const { file, escalate } = decideActions({
    repo: REPO,
    prs: [pr(1, { draft: true, createdAt: '2026-07-01T00:00:00Z' })],
    state: { prs: {} },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 0);
  assert.equal(escalate.length, 0);
});

test('PR open past stale-hours escalates, rate-limited to 24h', () => {
  const old = pr(2, { createdAt: '2026-08-01T00:00:00Z' });
  const first = decideActions({
    repo: REPO,
    prs: [old],
    state: { prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(first.escalate.length, 1);
  assert.ok(first.escalate[0].ageHours >= 72);

  const recentlyEscalated = decideActions({
    repo: REPO,
    prs: [old],
    state: {
      prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2', escalatedAt: '2026-08-06T02:00:00Z' } },
    },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(recentlyEscalated.escalate.length, 0);

  const dayLater = decideActions({
    repo: REPO,
    prs: [old],
    state: {
      prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2', escalatedAt: '2026-08-05T02:00:00Z' } },
    },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(dayLater.escalate.length, 1);
});

test('escalation batches into one message per repo, capped listing, oldest first', () => {
  const escalate = Array.from({ length: 11 }, (_, i) => ({
    number: i + 1,
    ageHours: 100 + i,
    title: `t${i}`,
  }));
  const msg = escalationMessage('Jacksnow14/Auranode', escalate, 72);
  assert.match(msg, /^pr-backlog\[Jacksnow14\/Auranode\]: 11 PR\(s\) open >72h/);
  assert.match(msg, /oldest 110h/);
  assert.match(msg, /#11\(110h\)/);
  assert.match(msg, /\(\+3 more\)/);
  assert.match(msg, /pipeline alarm, not a code-review request/);
});

test('pickReviewer prefers running, refuses error/terminated instances', () => {
  const agents = [
    { id: 'a', name: 'Claude Code Max', status: 'error' },
    { id: 'b', name: 'Claude Code Max', status: 'idle' },
    { id: 'c', name: 'Claude Code Max', status: 'running' },
    { id: 'd', name: 'CEO', status: 'running' },
  ];
  assert.equal(pickReviewer(agents, 'Claude Code Max').id, 'c');
  assert.equal(pickReviewer(agents.slice(0, 2), 'Claude Code Max').id, 'b');
  assert.equal(pickReviewer([agents[0]], 'Claude Code Max'), null);
  assert.equal(pickReviewer(agents, 'Nonexistent'), null);
});

test('issue title is per-repo-per-PR-per-sha (the idempotency key)', () => {
  assert.equal(
    issueTitle({ number: 7, sha7: 'abc1234' }, 'Jacksnow14/Auranode'),
    'pr-review/Auranode#7@abc1234: review, correct and land',
  );
  assert.equal(
    issueTitle({ number: 7, sha7: 'abc1234' }, 'Jacksnow14/paperclip'),
    'pr-review/paperclip#7@abc1234: review, correct and land',
  );
});

test('issue body forbids founder code review and demands loop closure', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'o/r');
  assert.match(body, /never ask the founder to review/i);
  assert.match(body, /FINAL review authority/);
  assert.match(body, /never batch/i);
  assert.match(body, /merged or closed/);
  assert.match(body, /check-trunk-ci-red/);
});

test('entrypoint fires when invoked through a release symlink (AUR-5111)', () => {
  // Reproduce the production layout that killed the dispatcher:
  //   root/releases/abc123/scripts/check-pr-backlog.mjs   (real file)
  //   root/current -> releases/abc123                     (symlink, as in ExecStart)
  // The old string-compare guard exits 0 with ZERO output on this layout; the
  // realpath guard must run main() and print one summary line per default repo.
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-backlog.mjs');
  const root = mkdtempSync(join(tmpdir(), 'prb-symlink-'));
  try {
    const releaseScripts = join(root, 'releases', 'abc123', 'scripts');
    mkdirSync(releaseScripts, { recursive: true });
    copyFileSync(script, join(releaseScripts, 'check-pr-backlog.mjs'));
    symlinkSync(join(root, 'releases', 'abc123'), join(root, 'current'));

    // Stub `gh` on PATH so the sweep is hermetic: every enumeration returns [].
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho []\n');
    chmodSync(join(bin, 'gh'), 0o755);

    const out = execFileSync(
      process.execPath,
      [
        join(root, 'current', 'scripts', 'check-pr-backlog.mjs'),
        '--dry-run',
        '--state-dir',
        join(root, 'state'),
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );

    const lines = out.trim().split('\n');
    assert.equal(lines.length, DEFAULT_REPOS.length);
    for (const [i, repo] of DEFAULT_REPOS.entries()) {
      assert.match(lines[i], new RegExp(`^repo=${repo.replace('/', '\\/')} open=0 to-file=0`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
