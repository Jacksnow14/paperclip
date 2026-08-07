import assert from 'node:assert/strict';
import test from 'node:test';

import { tick, CRITICAL_ROUTINES } from './check-critical-routine-staleness.mjs';

const NOW = new Date('2026-08-06T13:00:00.000Z');

function routine({ id, cronExpression = '30 6 * * *', lastSuccessfulCompletionAt, createdAt = '2026-06-01T00:00:00.000Z', status = 'active', activeIssue = null }) {
  return {
    id,
    status,
    activeIssue,
    createdAt,
    lastSuccessfulCompletionAt,
    triggers: [{ kind: 'schedule', cronExpression }],
  };
}

test('CRITICAL_ROUTINES declares both AUR-2880 deliverability and AUR-2878 0-send watchdog (issue requirement #4)', () => {
  const ids = CRITICAL_ROUTINES.map((r) => r.id);
  assert.ok(ids.includes('42a19235-94c4-4013-8ac4-8f06646be674'));
  assert.ok(ids.includes('ac2c352d-912c-4ae6-9986-d995ff741819'));
});

test('FIRES: a stale routine with no prior alert sends the audit-log signal and files exactly one issue', async () => {
  const spec = { id: '42a19235-94c4-4013-8ac4-8f06646be674', label: 'deliverability' };
  const auditCalls = [];
  const filed = [];
  const { results, localState } = await tick({
    fetched: [{ spec, routine: routine({ id: spec.id, lastSuccessfulCompletionAt: '2026-07-29T12:34:01.894Z' }) }],
    now: NOW,
    sendAuditLog: async (msg) => {
      auditCalls.push(msg);
      return 'confirmed';
    },
    fileIssue: async ({ result }) => {
      filed.push(result);
      return { identifier: 'AUR-9001', id: 'uuid-9001' };
    },
    localState: {},
  });

  assert.equal(auditCalls.length, 1);
  assert.match(auditCalls[0], /deliverability/);
  assert.equal(filed.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].stale, true);
  assert.equal(results[0].alertNeeded, true);
  assert.equal(results[0].filedIssueId, 'AUR-9001');
  assert.equal(localState[spec.id].alertedForSince, '2026-07-29T12:34:01.894Z');
  assert.equal(localState[spec.id].issueId, 'AUR-9001');
});

test('CLEARS: a currently-healthy routine sends no audit signal and files no issue', async () => {
  const spec = { id: 'ecf900c6-67d4-4202-9e40-92ffb442a7b8', label: 'trunk-red CI detector' };
  let auditCalled = false;
  let fileCalled = false;
  const { results } = await tick({
    fetched: [{ spec, routine: routine({ id: spec.id, cronExpression: '0 */6 * * *', lastSuccessfulCompletionAt: '2026-08-06T11:33:09.156Z' }) }],
    now: NOW,
    sendAuditLog: async () => {
      auditCalled = true;
      return 'confirmed';
    },
    fileIssue: async () => {
      fileCalled = true;
      return {};
    },
    localState: {},
  });

  assert.equal(auditCalled, false);
  assert.equal(fileCalled, false);
  assert.equal(results[0].stale, false);
  assert.equal(results[0].alertNeeded, false);
});

test('dedup: a routine already alerted for the same `since` does not re-alert on the next tick', async () => {
  const spec = { id: '42a19235-94c4-4013-8ac4-8f06646be674', label: 'deliverability' };
  let auditCount = 0;
  let fileCount = 0;
  const { results } = await tick({
    fetched: [{ spec, routine: routine({ id: spec.id, lastSuccessfulCompletionAt: '2026-07-29T12:34:01.894Z' }) }],
    now: NOW,
    sendAuditLog: async () => {
      auditCount += 1;
      return 'confirmed';
    },
    fileIssue: async () => {
      fileCount += 1;
      return { identifier: 'AUR-9001' };
    },
    localState: {
      [spec.id]: { alertedForSince: '2026-07-29T12:34:01.894Z', alertedAt: '2026-08-05T00:00:00.000Z', issueId: 'AUR-9001' },
    },
  });

  assert.equal(auditCount, 0);
  assert.equal(fileCount, 0);
  assert.equal(results[0].alertNeeded, false);
});

test('re-alert: a routine that recovered then went stale again (`since` advanced) alerts a second time', async () => {
  const spec = { id: '42a19235-94c4-4013-8ac4-8f06646be674', label: 'deliverability' };
  let auditCount = 0;
  const { localState } = await tick({
    fetched: [{ spec, routine: routine({ id: spec.id, lastSuccessfulCompletionAt: '2026-08-10T06:30:00.000Z' }) }],
    now: new Date('2026-08-11T10:00:00.000Z'),
    sendAuditLog: async () => {
      auditCount += 1;
      return 'confirmed';
    },
    fileIssue: async () => ({ identifier: 'AUR-9002' }),
    localState: {
      [spec.id]: { alertedForSince: '2026-07-29T12:34:01.894Z', alertedAt: '2026-08-05T00:00:00.000Z', issueId: 'AUR-9001' },
    },
  });

  assert.equal(auditCount, 1);
  assert.equal(localState[spec.id].issueId, 'AUR-9002');
});

test('dry-run: computes staleness but sends no audit signal, files no issue, and does not mutate local state', async () => {
  const spec = { id: '42a19235-94c4-4013-8ac4-8f06646be674', label: 'deliverability' };
  let auditCalled = false;
  let fileCalled = false;
  const { results, localState } = await tick({
    fetched: [{ spec, routine: routine({ id: spec.id, lastSuccessfulCompletionAt: '2026-07-29T12:34:01.894Z' }) }],
    now: NOW,
    dryRun: true,
    sendAuditLog: async () => {
      auditCalled = true;
      return 'confirmed';
    },
    fileIssue: async () => {
      fileCalled = true;
      return { identifier: 'AUR-9001' };
    },
    localState: {},
  });

  assert.equal(auditCalled, false);
  assert.equal(fileCalled, false);
  assert.equal(results[0].stale, true);
  assert.equal(results[0].alertNeeded, true);
  assert.deepEqual(localState, {});
});

test('a routine with no schedule trigger is reported as skipped, not silently dropped', async () => {
  const spec = { id: 'no-trigger', label: 'weird routine' };
  const { results } = await tick({
    fetched: [{ spec, routine: { id: spec.id, triggers: [], createdAt: '2026-06-01T00:00:00.000Z' } }],
    now: NOW,
    sendAuditLog: async () => 'confirmed',
    fileIssue: async () => ({}),
    localState: {},
  });

  assert.equal(results[0].skipped, true);
  assert.equal(results[0].reason, 'no-schedule-trigger');
});
