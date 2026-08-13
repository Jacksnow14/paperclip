import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDormantErrorAgents, DORMANCY_FLAG_THRESHOLD_MS } from './check-agent-error-dormancy.mjs';

const NOW = new Date('2026-08-13T15:00:00.000Z');
const STALE = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h in error — live CTO shape
const FRESH = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString(); // 2m in error — hasn't crossed threshold yet

// FIRE: the exact live incident shape (AUR-5643) — agent wedged in `error`
// for hours while still holding actionable issues, including a critical.
test('flags an agent stuck in error while holding actionable issues past the threshold', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'cto', status: 'error', statusSince: STALE }],
    [
      { assigneeAgentId: 'cto', status: 'in_progress', identifier: 'AUR-5642' },
      { assigneeAgentId: 'cto', status: 'todo', identifier: 'AUR-5641' },
    ],
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].agentId, 'cto');
  assert.equal(flagged[0].actionableIssues.length, 2);
});

// CLEARING: a healthy fleet — no agent in `error` at all — must not fire.
test('does NOT flag when no agent is in status=error', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'idle', statusSince: STALE }],
    [{ assigneeAgentId: 'a1', status: 'in_progress', identifier: 'AUR-1' }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

// CLEARING: `error` with zero actionable issues is not blocking anything —
// e.g. an agent that finished all its work and then the last run failed.
test('does NOT flag an error agent holding no actionable issues', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'error', statusSince: STALE }],
    [{ assigneeAgentId: 'a1', status: 'done', identifier: 'AUR-1' }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

// CLEARING: backlog issues never get a wake in the first place
// (queueIssueAssignmentWakeup's own skip check) — an error agent "holding"
// only backlog issues isn't refusing anything live.
test('does NOT count backlog issues as actionable', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'error', statusSince: STALE }],
    [{ assigneeAgentId: 'a1', status: 'backlog', identifier: 'AUR-1' }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

// CLEARING: a freshly-failed agent (below threshold) is not yet dormant —
// give the assignment-wake self-heal (or an operator) a chance first.
test('does NOT flag an error agent below the dormancy threshold', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'error', statusSince: FRESH }],
    [{ assigneeAgentId: 'a1', status: 'in_progress', identifier: 'AUR-1' }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});

test('a run exactly at the threshold is not yet flagged; just past it is', () => {
  const exact = new Date(NOW.getTime() - DORMANCY_FLAG_THRESHOLD_MS).toISOString();
  const justPast = new Date(NOW.getTime() - DORMANCY_FLAG_THRESHOLD_MS - 1000).toISOString();
  const issues = [{ assigneeAgentId: 'a1', status: 'in_progress', identifier: 'AUR-1' }];

  assert.deepEqual(
    classifyDormantErrorAgents([{ id: 'a1', status: 'error', statusSince: exact }], issues, { now: NOW }),
    [],
  );
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'error', statusSince: justPast }],
    issues,
    { now: NOW },
  );
  assert.equal(flagged.length, 1);
});

test('multiple flagged agents are sorted longest-dormant first', () => {
  const shortStale = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
  const flagged = classifyDormantErrorAgents(
    [
      { id: 'short', status: 'error', statusSince: shortStale },
      { id: 'long', status: 'error', statusSince: STALE },
    ],
    [
      { assigneeAgentId: 'short', status: 'todo', identifier: 'AUR-1' },
      { assigneeAgentId: 'long', status: 'todo', identifier: 'AUR-2' },
    ],
    { now: NOW },
  );
  assert.deepEqual(flagged.map((f) => f.agentId), ['long', 'short']);
});

test('an agent with no statusSince timestamp is skipped rather than crashing the census', () => {
  const flagged = classifyDormantErrorAgents(
    [{ id: 'a1', status: 'error', statusSince: null }],
    [{ assigneeAgentId: 'a1', status: 'todo', identifier: 'AUR-1' }],
    { now: NOW },
  );
  assert.deepEqual(flagged, []);
});
