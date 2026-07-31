import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyParkedAgents, PARK_FLAG_THRESHOLD_MS } from './check-parked-agents.mjs';

const NOW = new Date('2026-07-30T17:00:00.000Z');
const FAR = '2026-08-05T08:46:00.000Z'; // live incident shape: codex weekly reset 6d out
const NEAR = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(); // ordinary backoff rung

test('flags an agent whose only live row is a far park (live CTO Ops shape)', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: FAR, contextSnapshot: { issueId: 'i1' } },
      { agentId: 'a1', status: 'failed', scheduledRetryAt: null },
    ],
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].agentId, 'a1');
  assert.deepEqual(flagged[0].parkedRuns, [{ scheduledRetryAt: FAR, issueId: 'i1' }]);
});

test('does NOT flag an agent with queued work beside the park (live CMO shape)', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: FAR, contextSnapshot: { issueId: 'i1' } },
      { agentId: 'a1', status: 'queued', scheduledRetryAt: null },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('does NOT flag an agent with a running row beside the park', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: FAR },
      { agentId: 'a1', status: 'running', scheduledRetryAt: null },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('a near scheduled_retry is a live continuation path, not a park', () => {
  // Ordinary backoff rung due within the threshold: self-resolves, agent is
  // not dark even though it has zero queued/running rows.
  const flagged = classifyParkedAgents(
    [{ agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: NEAR }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('a near retry beside a far park un-flags the agent', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: FAR },
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: NEAR },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('a park exactly at the threshold boundary is near, one ms past is far', () => {
  const atBoundary = new Date(NOW.getTime() + PARK_FLAG_THRESHOLD_MS).toISOString();
  const pastBoundary = new Date(NOW.getTime() + PARK_FLAG_THRESHOLD_MS + 1).toISOString();
  assert.deepEqual(
    classifyParkedAgents([{ agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: atBoundary }], { now: NOW }),
    [],
  );
  assert.equal(
    classifyParkedAgents([{ agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: pastBoundary }], { now: NOW }).length,
    1,
  );
});

test('an already-lapsed scheduledRetryAt is ignored (promotion is imminent)', () => {
  const past = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const flagged = classifyParkedAgents(
    [{ agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: past }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('historical terminal rows alone never flag an agent', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'failed', scheduledRetryAt: null },
      { agentId: 'a1', status: 'succeeded', scheduledRetryAt: null },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('classifies agents independently and sorts parked runs by due date', () => {
  const later = '2026-08-06T00:00:00.000Z';
  const flagged = classifyParkedAgents(
    [
      { agentId: 'dark', status: 'scheduled_retry', scheduledRetryAt: later, contextSnapshot: { issueId: 'i2' } },
      { agentId: 'dark', status: 'scheduled_retry', scheduledRetryAt: FAR, contextSnapshot: { issueId: 'i1' } },
      { agentId: 'busy', status: 'scheduled_retry', scheduledRetryAt: FAR },
      { agentId: 'busy', status: 'queued', scheduledRetryAt: null },
    ],
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].agentId, 'dark');
  assert.deepEqual(
    flagged[0].parkedRuns.map((r) => r.scheduledRetryAt),
    [FAR, later],
  );
});

test('malformed scheduledRetryAt is ignored rather than crashing the census', () => {
  const flagged = classifyParkedAgents(
    [
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: 'not-a-date' },
      { agentId: 'a1', status: 'scheduled_retry', scheduledRetryAt: FAR },
    ],
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].parkedRuns.length, 1);
});
