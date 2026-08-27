import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyStaleQueuedRuns,
  classifyStaleQueuedWakeups,
  STALE_QUEUED_THRESHOLD_MS,
  FLAG_REGEX,
  flagTitle,
  main,
} from './check-queued-run-health.mjs';

const NOW = new Date('2026-08-27T09:12:00.000Z');
const STALE = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min old
const FRESH = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min old

test('flags a queued run older than threshold with zero token usage (live Claude Code Max shape)', () => {
  const flagged = classifyStaleQueuedRuns(
    [
      {
        id: 'run-1',
        agentId: 'a1',
        status: 'queued',
        startedAt: null,
        createdAt: STALE,
        usageJson: null,
        contextSnapshot: { issueId: 'AUR-1' },
      },
    ],
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].runId, 'run-1');
  assert.equal(flagged[0].issueId, 'AUR-1');
});

test('does NOT flag a queued run younger than the threshold', () => {
  const flagged = classifyStaleQueuedRuns(
    [{ id: 'run-1', agentId: 'a1', status: 'queued', startedAt: null, createdAt: FRESH, usageJson: null }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag a run that has been admitted (startedAt set)', () => {
  const flagged = classifyStaleQueuedRuns(
    [{ id: 'run-1', agentId: 'a1', status: 'queued', startedAt: STALE, createdAt: STALE, usageJson: null }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag a run with nonzero token usage in nested usageJson', () => {
  const flagged = classifyStaleQueuedRuns(
    [
      {
        id: 'run-1',
        agentId: 'a1',
        status: 'queued',
        startedAt: null,
        createdAt: STALE,
        usageJson: { inputTokens: 120, outputTokens: 40 },
      },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag a run with nonzero flat inputTokens/outputTokens (per-agent runs shape)', () => {
  const flagged = classifyStaleQueuedRuns(
    [{ id: 'run-1', agentId: 'a1', status: 'queued', startedAt: null, createdAt: STALE, inputTokens: 50, outputTokens: 0 }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag a non-queued status', () => {
  const flagged = classifyStaleQueuedRuns(
    [{ id: 'run-1', agentId: 'a1', status: 'running', startedAt: STALE, createdAt: STALE, usageJson: null }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('classifyStaleQueuedRuns uses default threshold when unset', () => {
  assert.equal(STALE_QUEUED_THRESHOLD_MS, 10 * 60 * 1000);
});

test('flags a stale queued wakeup request', () => {
  const flagged = classifyStaleQueuedWakeups(
    [{ id: 'wr-1', status: 'queued', requestedAt: STALE }],
    { agentId: 'a1', now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].requestId, 'wr-1');
  assert.equal(flagged[0].agentId, 'a1');
});

test('does NOT flag a fresh queued wakeup request', () => {
  const flagged = classifyStaleQueuedWakeups(
    [{ id: 'wr-1', status: 'queued', requestedAt: FRESH }],
    { agentId: 'a1', now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag a wakeup request that already finished', () => {
  const flagged = classifyStaleQueuedWakeups(
    [{ id: 'wr-1', status: 'finished', requestedAt: STALE }],
    { agentId: 'a1', now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('main() requests the heartbeat-runs census with status=queued (AUR-6285: avoids the unbounded-read OOM)', async () => {
  const requestedUrls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('/heartbeat-runs')) {
      return { ok: true, json: async () => [] };
    }
    if (String(url).includes('/wakeup-requests')) {
      return { ok: true, json: async () => [] };
    }
    if (String(url).includes('/agents')) {
      return { ok: true, json: async () => [] };
    }
    if (String(url).includes('/issues?')) {
      return { ok: true, json: async () => [] };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const code = await main({ apply: false, apiUrl: 'https://api.test', apiKey: 'k', companyId: 'c1' });
    assert.equal(code, 0);
  } finally {
    global.fetch = originalFetch;
  }

  const runsUrl = requestedUrls.find((u) => u.includes('/heartbeat-runs'));
  assert.ok(runsUrl, `expected a heartbeat-runs request, got: ${requestedUrls.join(', ')}`);
  assert.ok(runsUrl.includes('status=queued'), `expected status=queued filter, got: ${runsUrl}`);
  assert.ok(runsUrl.includes('limit=500'), `expected limit=500 cap to prevent OOM on large queued-run sets, got: ${runsUrl}`);
});

test('flagTitle/FLAG_REGEX round-trip for both incident kinds', () => {
  const runTitle = flagTitle('run', 'abc-123');
  const runMatch = FLAG_REGEX.exec(runTitle);
  assert.ok(runMatch);
  assert.equal(runMatch[1].toLowerCase(), 'run');
  assert.equal(runMatch[2], 'abc-123');

  const wakeupTitle = flagTitle('wakeup', 'def-456');
  const wakeupMatch = FLAG_REGEX.exec(wakeupTitle);
  assert.ok(wakeupMatch);
  assert.equal(wakeupMatch[1].toLowerCase(), 'wakeup');
  assert.equal(wakeupMatch[2], 'def-456');
});
