import assert from 'node:assert/strict';
import test from 'node:test';

import { countMissedOccurrences, evaluateRoutineStaleness } from './routine-staleness.mjs';

// Real values captured live 2026-08-06 from
// GET /api/companies/b26d3647-3e6c-4a28-9c25-e9315696484d/routines/{id}
// (branch@sha of the server that computed them: master@647d768ba).
const NOW = new Date('2026-08-06T13:00:00.000Z');

test('FIRES: AUR-2880 deliverability routine (42a19235), stale since Jul 29, is stale against its real Aug 5-6 window', () => {
  const result = evaluateRoutineStaleness({
    routineId: '42a19235-94c4-4013-8ac4-8f06646be674',
    label: 'Daily email-deliverability LIVE safe-outreach (AUR-2880)',
    cronExpression: '30 6 * * *',
    lastSuccessfulCompletionAt: new Date('2026-07-29T12:34:01.894Z'),
    createdAt: new Date('2026-06-15T13:19:14.492Z'),
    now: NOW,
    graceHours: 3,
    missedThreshold: 1,
  });
  assert.equal(result.stale, true);
  // Expected daily fires missed with >=3h grace, 07-30 .. 08-06 inclusive = 8.
  assert.equal(result.missedCount, 8);
});

test('FIRES: AUR-2878 0-send watchdog (ac2c352d), stale since Jul 29, is stale against the same real window', () => {
  const result = evaluateRoutineStaleness({
    routineId: 'ac2c352d-912c-4ae6-9986-d995ff741819',
    label: 'Outreach 0-send watchdog (escalate silent send drift) — AUR-2878',
    cronExpression: '15 8 * * *',
    lastSuccessfulCompletionAt: new Date('2026-07-29T17:04:43.679Z'),
    createdAt: new Date('2026-06-24T00:31:16.300Z'),
    now: NOW,
    graceHours: 3,
    missedThreshold: 1,
  });
  assert.equal(result.stale, true);
  assert.ok(result.missedCount >= 7, `expected several missed fires, got ${result.missedCount}`);
});

test('CLEARS: a currently-healthy routine (AUR-4675 trunk-red CI detector, every 6h) stays silent', () => {
  // lastSuccessfulCompletionAt captured live: 2026-08-06T11:33:09.156Z,
  // less than 2h before NOW on a 6h cadence — well within one interval.
  const result = evaluateRoutineStaleness({
    routineId: 'ecf900c6-67d4-4202-9e40-92ffb442a7b8',
    label: 'AUR-4675 trunk-red CI detector (every 6h)',
    cronExpression: '0 */6 * * *',
    lastSuccessfulCompletionAt: new Date('2026-08-06T11:33:09.156Z'),
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    now: NOW,
    graceHours: 3,
    missedThreshold: 1,
  });
  assert.equal(result.stale, false);
  assert.equal(result.missedCount, 0);
});

test('CLEARS: a routine that just barely finished within its grace window does not fire', () => {
  // Daily 06:30 fire, completed same day at 09:00 (2.5h late) — inside a 3h grace.
  const result = evaluateRoutineStaleness({
    routineId: 'routine-x',
    label: 'x',
    cronExpression: '30 6 * * *',
    lastSuccessfulCompletionAt: new Date('2026-08-06T09:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    now: new Date('2026-08-06T09:05:00.000Z'),
    graceHours: 3,
    missedThreshold: 1,
  });
  assert.equal(result.stale, false);
});

test('a routine that never once succeeded falls back to createdAt as the reference', () => {
  const result = evaluateRoutineStaleness({
    routineId: 'routine-y',
    label: 'y',
    cronExpression: '0 0 * * *',
    lastSuccessfulCompletionAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    now: new Date('2026-08-05T00:00:00.000Z'),
    graceHours: 3,
    missedThreshold: 1,
  });
  assert.equal(result.stale, true);
  assert.ok(result.missedCount >= 3);
});

test('countMissedOccurrences respects the grace window boundary', () => {
  const since = new Date('2026-08-01T00:00:00.000Z');
  const cronExpression = '0 0 * * *'; // daily midnight
  // One second before fire + 3h grace: not yet due.
  const beforeBoundary = countMissedOccurrences({
    cronExpression,
    since,
    now: new Date('2026-08-02T02:59:59.000Z'),
    graceMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(beforeBoundary, 0);
  // Exactly at fire + 3h grace: due.
  const atBoundary = countMissedOccurrences({
    cronExpression,
    since,
    now: new Date('2026-08-02T03:00:00.000Z'),
    graceMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(atBoundary, 1);
});
