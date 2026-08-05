import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideActions, pickReviewer, issueTitle, issueBody } from './check-pr-backlog.mjs';

const NOW = Date.parse('2026-08-06T12:00:00Z');
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
    prs: [pr(1)],
    state: { prs: { 1: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 0);
});

test('a new push (new head sha) re-arms dispatch for the same PR', () => {
  const { file } = decideActions({
    prs: [pr(1, { headSha: 'fffffff000' })],
    state: { prs: { 1: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].sha7, 'fffffff');
});

test('draft PRs are skipped entirely', () => {
  const { file, escalate } = decideActions({
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
    prs: [old],
    state: { prs: { 2: { filedSha: 'abcdef2' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(first.escalate.length, 1);
  assert.ok(first.escalate[0].ageHours >= 72);

  const recentlyEscalated = decideActions({
    prs: [old],
    state: { prs: { 2: { filedSha: 'abcdef2', escalatedAt: '2026-08-06T02:00:00Z' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(recentlyEscalated.escalate.length, 0);

  const dayLater = decideActions({
    prs: [old],
    state: { prs: { 2: { filedSha: 'abcdef2', escalatedAt: '2026-08-05T02:00:00Z' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(dayLater.escalate.length, 1);
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

test('issue title is per-PR-per-sha (the idempotency key)', () => {
  assert.equal(
    issueTitle({ number: 7, sha7: 'abc1234' }),
    'pr-review/PR-7@abc1234: review, correct and land',
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
