import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRIFT_CANDIDATE_STATUSES,
  ISSUE_STATUS_FILTER,
  isDriftedBlockedStatus,
  hoursSince,
  FLAG_REGEX,
  flagTitle,
  buildFlagDescription,
  resolveCancelReason,
  resolveFlagOwner,
  CEO_AGENT_ID,
  DEFAULT_MAX_FLAGS_PER_RUN,
  resolveMaxFlagsPerRun,
  main,
} from './check-blocked-status-drift.mjs';

// ── isDriftedBlockedStatus ───────────────────────────────────────────────────

test('isDriftedBlockedStatus: true for backlog with a genuine needs_attention/attention_required blocker (AUR-4130 shape)', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'backlog',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  }), true);
});

test('isDriftedBlockedStatus: false for "covered" — a healthy soft dependency, not drift (live AUR-6251/AUR-801 shape)', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'todo',
    blockerAttention: { state: 'covered', reason: 'active_dependency', unresolvedBlockerCount: 1 },
  }), false);
  assert.equal(isDriftedBlockedStatus({
    status: 'todo',
    blockerAttention: { state: 'covered', reason: 'active_child', unresolvedBlockerCount: 1 },
  }), false);
});

test('isDriftedBlockedStatus: false for a dangling cancelled-blocker reference — different bug, different fix (live AUR-4241 shape)', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'backlog',
    blockerAttention: { state: 'needs_attention', reason: 'cancelled_blocker', unresolvedBlockerCount: 1 },
  }), false);
});

test('isDriftedBlockedStatus: false when status is blocked (correctly modelled)', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'blocked',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  }), false);
});

test('isDriftedBlockedStatus: false when unresolvedBlockerCount is 0', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'backlog',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 0 },
  }), false);
});

test('isDriftedBlockedStatus: false when blockerAttention is absent', () => {
  assert.equal(isDriftedBlockedStatus({ status: 'backlog' }), false);
});

test('isDriftedBlockedStatus: false for terminal statuses (done/cancelled excluded from candidates)', () => {
  assert.equal(isDriftedBlockedStatus({
    status: 'done',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  }), false);
  assert.equal(isDriftedBlockedStatus({
    status: 'cancelled',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  }), false);
});

test('DRIFT_CANDIDATE_STATUSES excludes blocked and terminal statuses', () => {
  assert.deepEqual(DRIFT_CANDIDATE_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review']);
});

test('ISSUE_STATUS_FILTER includes blocked plus every drift candidate status', () => {
  assert.equal(ISSUE_STATUS_FILTER, 'blocked,backlog,todo,in_progress,in_review');
});

// ── flagTitle / FLAG_REGEX ───────────────────────────────────────────────────

test('flagTitle: names the target and its current status', () => {
  assert.equal(
    flagTitle('AUR-4130', 'backlog'),
    'blocked-status-drift: AUR-4130 has a live blocker but status is `backlog`',
  );
});

test('FLAG_REGEX: matches a filed flag title and captures the target identifier', () => {
  const match = FLAG_REGEX.exec('blocked-status-drift: AUR-4130 has a live blocker but status is `backlog`');
  assert.ok(match);
  assert.equal(match[1], 'AUR-4130');
});

test('FLAG_REGEX: does not match an unrelated title', () => {
  assert.equal(FLAG_REGEX.test('stalled-blocked: AUR-9999 blocked with no blocker'), false);
});

// ── buildFlagDescription ─────────────────────────────────────────────────────

test('buildFlagDescription: names the identifier, status, and unresolved count', () => {
  const desc = buildFlagDescription({
    identifier: 'AUR-4130',
    title: 'Example',
    status: 'backlog',
    updatedAt: '2026-08-26T00:00:00Z',
    blockerAttention: { unresolvedBlockerCount: 1, sampleBlockerIdentifier: 'AUR-9000' },
  }, new Date('2026-08-26T12:00:00Z'));
  assert.match(desc, /AUR-4130/);
  assert.match(desc, /`backlog`/);
  assert.match(desc, /unresolvedBlockerCount = 1/);
  assert.match(desc, /AUR-9000/);
  assert.match(desc, /exec\.routing-rationale: skip/);
});

// ── resolveCancelReason ──────────────────────────────────────────────────────

test('resolveCancelReason: resolves when target reaches blocked again', () => {
  const reason = resolveCancelReason({
    target: { status: 'blocked' },
    targetId: 'AUR-4130',
  });
  assert.match(reason, /is `blocked` again/);
});

test('resolveCancelReason: resolves when target no longer has an unresolved blocker', () => {
  const reason = resolveCancelReason({
    target: { status: 'backlog', blockerAttention: { unresolvedBlockerCount: 0 } },
    targetId: 'AUR-4130',
  });
  assert.match(reason, /no longer has an unresolved blocker/);
});

test('resolveCancelReason: resolves when target is done/cancelled', () => {
  assert.match(resolveCancelReason({ target: { status: 'done' }, targetId: 'AUR-4130' }), /is done/);
  assert.match(resolveCancelReason({ target: { status: 'cancelled' }, targetId: 'AUR-4130' }), /is cancelled/);
});

test('resolveCancelReason: resolves when target is not found among open issues', () => {
  assert.match(resolveCancelReason({ target: null, targetId: 'AUR-4130' }), /not found among open issues/);
});

test('resolveCancelReason: null (still open) when the drift is still live', () => {
  assert.equal(resolveCancelReason({
    target: { status: 'backlog', blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 } },
    targetId: 'AUR-4130',
  }), null);
});

// ── resolveFlagOwner ──────────────────────────────────────────────────────────

test('resolveFlagOwner: prefers the issue assignee', () => {
  assert.equal(resolveFlagOwner({ assigneeAgentId: 'agentX' }), 'agentX');
});

test('resolveFlagOwner: falls back to CEO when unassigned', () => {
  assert.equal(resolveFlagOwner({}), CEO_AGENT_ID);
});

// ── resolveMaxFlagsPerRun ─────────────────────────────────────────────────────

test('resolveMaxFlagsPerRun: default when env unset', () => {
  assert.equal(resolveMaxFlagsPerRun({}), DEFAULT_MAX_FLAGS_PER_RUN);
});

test('resolveMaxFlagsPerRun: honors a valid override', () => {
  assert.equal(resolveMaxFlagsPerRun({ BLOCKED_DRIFT_MAX_FLAGS_PER_RUN: '2' }), 2);
});

test('resolveMaxFlagsPerRun: falls back to default on garbage input', () => {
  assert.equal(resolveMaxFlagsPerRun({ BLOCKED_DRIFT_MAX_FLAGS_PER_RUN: 'nope' }), DEFAULT_MAX_FLAGS_PER_RUN);
});

// ── main() integration ───────────────────────────────────────────────────────

const API_URL = 'http://test.local';
const COMPANY_ID = 'c1';

function makeFetchStub(routes) {
  const calls = [];
  return {
    calls,
    fetchStub: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(API_URL, '');
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const key = `${method} ${path}`;
      if (!Object.prototype.hasOwnProperty.call(routes, key)) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      }
      const value = routes[key];
      return { ok: true, status: 200, statusText: 'OK', json: async () => value };
    },
  };
}

const ALL_QUERY = `GET /api/companies/${COMPANY_ID}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`;
const FILE_ISSUE_ROUTE = `POST /api/companies/${COMPANY_ID}/issues`;

let originalFetch;
let originalLog;
test.beforeEach(() => {
  originalFetch = global.fetch;
  originalLog = console.log;
  console.log = () => {};
});
test.afterEach(() => {
  global.fetch = originalFetch;
  console.log = originalLog;
});

test('main() FIRES: a backlog issue with a live blocker (AUR-4130 shape) files exactly one flag', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4130',
    title: 'Example drifted issue',
    status: 'backlog',
    priority: 'medium',
    assigneeAgentId: 'agentX',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1, sampleBlockerIdentifier: 'AUR-9000' },
  };
  const { fetchStub, calls } = makeFetchStub({
    [ALL_QUERY]: [subject],
    [FILE_ISSUE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1, 'expected exactly one flag to be filed');
  assert.match(filed[0].body.title, /^blocked-status-drift: AUR-4130/);
  assert.equal(filed[0].body.assigneeAgentId, 'agentX');
  assert.equal(filed[0].body.priority, 'medium');
});

test('main() PASSES: an issue correctly `blocked` with a live blocker is never flagged', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4131',
    title: 'Correctly modelled',
    status: 'blocked',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1 },
  };
  const { fetchStub, calls } = makeFetchStub({ [ALL_QUERY]: [subject] });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filedAnyFlag = calls.some((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filedAnyFlag, false);
});

test('main() PASSES: a backlog issue with no unresolved blocker is never flagged', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4132',
    title: 'Fine',
    status: 'backlog',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
  };
  const { fetchStub, calls } = makeFetchStub({ [ALL_QUERY]: [subject] });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('main() DEDUPES: does not re-file when an open flag already targets the drifted issue', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4130',
    title: 'Example',
    status: 'backlog',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  };
  const existingFlag = {
    id: 'f1',
    identifier: 'AUR-9001',
    title: 'blocked-status-drift: AUR-4130 has a live blocker but status is `backlog`',
    status: 'todo',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
  };
  const { fetchStub, calls } = makeFetchStub({
    [ALL_QUERY]: [subject, existingFlag],
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`), false);
});

test('main() RESOLVES: auto-cancels a flag once its target is blocked again', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4130',
    title: 'Example',
    status: 'blocked',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1 },
  };
  const staleFlag = {
    id: 'f1',
    identifier: 'AUR-9001',
    title: 'blocked-status-drift: AUR-4130 has a live blocker but status is `backlog`',
    status: 'todo',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
  };
  const { fetchStub, calls } = makeFetchStub({
    [ALL_QUERY]: [subject, staleFlag],
    'PATCH /api/issues/f1': { id: 'f1', status: 'cancelled' },
    'POST /api/issues/f1/comments': { id: 'comment1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const cancelled = calls.find((c) => c.method === 'PATCH' && c.path === '/api/issues/f1');
  assert.ok(cancelled, 'the stale flag should be auto-resolved once the target is blocked again');
  assert.equal(cancelled.body.status, 'cancelled');
});

test('main() CAPS: more candidates than maxFlagsPerRun files exactly the cap and drops the rest (logged, not silent)', async () => {
  const subjects = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    identifier: `AUR-500${i}`,
    title: `Drifted ${i}`,
    status: 'backlog',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  }));
  const { fetchStub, calls } = makeFetchStub({
    [ALL_QUERY]: subjects,
    [FILE_ISSUE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 2 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 2, 'expected exactly the cap to be filed');
});

test('main() dry-run: reports pending actions via exit code 1 and writes nothing', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4130',
    title: 'Example',
    status: 'backlog',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  };
  const { fetchStub, calls } = makeFetchStub({ [ALL_QUERY]: [subject] });
  global.fetch = fetchStub;

  const code = await main({ apply: false, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 1);
  assert.equal(calls.some((c) => c.method === 'POST' || c.method === 'PATCH'), false);
});

test('main() exits 4 when every intended mutation fails', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-4130',
    title: 'Example',
    status: 'backlog',
    priority: 'medium',
    updatedAt: '2026-08-26T12:02:01Z',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required', unresolvedBlockerCount: 1 },
  };
  const { fetchStub } = makeFetchStub({ [ALL_QUERY]: [subject] });
  global.fetch = fetchStub; // FILE_ISSUE_ROUTE deliberately unmocked → 404 on the POST

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 4);
});
