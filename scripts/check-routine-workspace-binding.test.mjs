import assert from 'node:assert/strict';
import test from 'node:test';

import { diffUnbound, buildDigestComment, STATE_TITLE } from './check-routine-workspace-binding.mjs';

test('diffUnbound: first run (no prior state) reports everything as fresh', () => {
  const current = [{ id: 'a' }, { id: 'b' }];
  const { fresh, resolved, currentIds } = diffUnbound(current, []);
  assert.deepEqual(fresh.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(resolved, []);
  assert.deepEqual(currentIds, ['a', 'b']);
});

test('diffUnbound: only newly-created routines are fresh', () => {
  const current = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { fresh, resolved } = diffUnbound(current, ['a', 'b']);
  assert.deepEqual(fresh.map((r) => r.id), ['c']);
  assert.deepEqual(resolved, []);
});

test('diffUnbound: routines bound/archived since last run are resolved', () => {
  const current = [{ id: 'a' }];
  const { fresh, resolved } = diffUnbound(current, ['a', 'b', 'c']);
  assert.deepEqual(fresh, []);
  assert.deepEqual(resolved.sort(), ['b', 'c']);
});

test('diffUnbound: simultaneous fresh + resolved', () => {
  const current = [{ id: 'a' }, { id: 'd' }];
  const { fresh, resolved, currentIds } = diffUnbound(current, ['a', 'b']);
  assert.deepEqual(fresh.map((r) => r.id), ['d']);
  assert.deepEqual(resolved, ['b']);
  assert.deepEqual(currentIds, ['a', 'd']);
});

test('buildDigestComment: no drift renders a clean "no new drift" message', () => {
  const body = buildDigestComment({ fresh: [], resolvedCount: 2, totalUnbound: 5 });
  assert.match(body, /No new drift this week\./);
  assert.match(body, /Resolved since last run: 2/);
  assert.match(body, /Active\/paused unbound routines: 5/);
});

test('buildDigestComment: fresh routines are each listed with id/title/assignee', () => {
  const body = buildDigestComment({
    fresh: [
      { id: 'r1', title: 'PR review check', assigneeAgentId: 'agent-1', parentIssueId: 'iss-1', createdAt: '2026-08-25T00:00:00.000Z' },
    ],
    resolvedCount: 0,
    totalUnbound: 1,
  });
  assert.match(body, /`r1`/);
  assert.match(body, /PR review check/);
  assert.match(body, /agent-1/);
  assert.match(body, /iss-1/);
});

test('STATE_TITLE has no scope-limiting segments (org-wide by construction)', () => {
  assert.equal(STATE_TITLE, 'routine-binding-watchdog/last-seen');
});
