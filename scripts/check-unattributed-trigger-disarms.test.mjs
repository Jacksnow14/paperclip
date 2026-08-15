import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRow,
  formatFinding,
  buildIssueBody,
  findFlagIssue,
  main,
  FLAG_TITLE,
  FLAG_SEARCH_STATUSES,
  DEFAULT_TOLERANCE_MS,
  DEFAULT_OWNER_AGENT_ID,
} from './check-unattributed-trigger-disarms.mjs';

// ── classifyRow ──────────────────────────────────────────────────────────────

test('classifyRow: unattributed when disabled with no routine_revisions row at all (the AUR-5744 pre-fix shape)', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:00:00Z',
    updatedByAgentId: null,
    updatedByUserId: null,
    revisionCreatedAt: null,
  };
  const c = classifyRow(row);
  assert.equal(c.unattributed, true);
  assert.equal(c.hasRevision, false);
  assert.equal(c.gapMs, null);
  assert.equal(c.noActorIdentity, true);
});

test('classifyRow: unattributed when the trigger was disabled well after the latest revision was written', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:01:00Z',
    updatedByAgentId: null,
    updatedByUserId: 'some-old-actor',
    revisionCreatedAt: '2026-08-14T12:00:00Z', // stale revision, unrelated to this disarm
  };
  const c = classifyRow(row);
  assert.equal(c.unattributed, true);
  assert.equal(c.hasRevision, true);
  assert.equal(c.gapMs, 12 * 60 * 60 * 1000 + 60 * 1000);
});

test('classifyRow: NOT unattributed — a normal PATCH /api/routine-triggers/:id disarm writes the revision in the same transaction', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:00:00.100Z',
    updatedByAgentId: 'agent-1',
    updatedByUserId: null,
    revisionCreatedAt: '2026-08-15T00:00:00.050Z',
  };
  const c = classifyRow(row);
  assert.equal(c.unattributed, false);
  assert.equal(c.hasRevision, true);
  assert.equal(c.gapMs, 50);
  assert.equal(c.noActorIdentity, false);
});

test('classifyRow: gap exactly at the tolerance boundary is NOT flagged (strict greater-than)', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:00:05.000Z',
    updatedByAgentId: 'agent-1',
    updatedByUserId: null,
    revisionCreatedAt: '2026-08-15T00:00:00.000Z',
  };
  const c = classifyRow(row, 5000);
  assert.equal(c.gapMs, 5000);
  assert.equal(c.unattributed, false);
});

test('classifyRow: gap one ms past the tolerance boundary IS flagged', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:00:05.001Z',
    updatedByAgentId: 'agent-1',
    updatedByUserId: null,
    revisionCreatedAt: '2026-08-15T00:00:00.000Z',
  };
  const c = classifyRow(row, 5000);
  assert.equal(c.gapMs, 5001);
  assert.equal(c.unattributed, true);
});

test('classifyRow: revision written AFTER the disarm (negative gap) is not flagged — attribution landed, just clocked slightly later', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:00:00.000Z',
    updatedByAgentId: 'agent-1',
    updatedByUserId: null,
    revisionCreatedAt: '2026-08-15T00:00:00.200Z',
  };
  const c = classifyRow(row);
  assert.equal(c.gapMs, -200);
  assert.equal(c.unattributed, false);
});

test('classifyRow: the AUR-5744 fixed enforcer shape (updated_by_user_id set to the actor string, revision in same tx) is NOT flagged', () => {
  const row = {
    triggerUpdatedAt: '2026-08-15T00:15:00.010Z',
    updatedByAgentId: null,
    updatedByUserId: 'routine-allowlist-enforcer',
    revisionCreatedAt: '2026-08-15T00:15:00.000Z',
  };
  const c = classifyRow(row);
  assert.equal(c.unattributed, false);
  assert.equal(c.noActorIdentity, false);
});

test('DEFAULT_TOLERANCE_MS is applied when no explicit toleranceMs is passed', () => {
  const row = {
    triggerUpdatedAt: new Date(Date.parse('2026-08-15T00:00:00Z') + DEFAULT_TOLERANCE_MS + 1).toISOString(),
    updatedByAgentId: 'agent-1',
    updatedByUserId: null,
    revisionCreatedAt: '2026-08-15T00:00:00Z',
  };
  assert.equal(classifyRow(row).unattributed, true);
});

// ── formatFinding / buildIssueBody ──────────────────────────────────────────

test('formatFinding: names the trigger, routine, timestamps, and identity columns', () => {
  const row = {
    triggerId: 't1',
    routineId: 'r1',
    routineTitle: 'Some routine',
    label: 'nightly',
    triggerUpdatedAt: '2026-08-15T00:00:00Z',
    updatedByAgentId: null,
    updatedByUserId: null,
    revisionCreatedAt: null,
  };
  const c = classifyRow(row);
  const line = formatFinding(row, c);
  assert.match(line, /trigger t1/);
  assert.match(line, /routine r1 "Some routine"/);
  assert.match(line, /no routine_revisions row exists/);
  assert.match(line, /BOTH null/);
});

test('formatFinding: reports the numeric gap when a stale revision exists', () => {
  const row = {
    triggerId: 't2',
    routineId: 'r2',
    routineTitle: null,
    label: null,
    triggerUpdatedAt: '2026-08-15T00:01:00Z',
    updatedByAgentId: 'a1',
    updatedByUserId: null,
    revisionNumber: 3,
    revisionCreatedAt: '2026-08-15T00:00:00Z',
  };
  const c = classifyRow(row);
  const line = formatFinding(row, c);
  assert.match(line, /60s after the latest revision \(routine_revisions#3/);
});

test('buildIssueBody: lists every finding and carries the skip token', () => {
  const row = {
    triggerId: 't1',
    routineId: 'r1',
    routineTitle: 'X',
    label: null,
    triggerUpdatedAt: '2026-08-15T00:00:00Z',
    updatedByAgentId: null,
    updatedByUserId: null,
    revisionCreatedAt: null,
  };
  const c = classifyRow(row);
  const body = buildIssueBody([{ row, classification: c }], new Date('2026-08-15T01:00:00Z'));
  assert.match(body, /1 disabled schedule trigger/);
  assert.match(body, /trigger t1/);
  assert.match(body, /exec\.routing-rationale: skip/);
});

// ── findFlagIssue ────────────────────────────────────────────────────────────

test('findFlagIssue: exact title match wins over a loose-search false positive', async () => {
  const apiGet = async (path) => {
    assert.ok(path.includes(`q=${encodeURIComponent(FLAG_TITLE)}`));
    assert.ok(path.includes(`status=${FLAG_SEARCH_STATUSES}`));
    return [
      { id: 'x1', title: 'Watchdog: unattributed schedule-trigger disarm(s) detected — old draft' },
      { id: 'x2', title: FLAG_TITLE, status: 'todo' },
    ];
  };
  const found = await findFlagIssue({ companyId: 'c1', apiGet });
  assert.equal(found.id, 'x2');
});

test('findFlagIssue: null when nothing matches', async () => {
  const apiGet = async () => [];
  const found = await findFlagIssue({ companyId: 'c1', apiGet });
  assert.equal(found, null);
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
      return { ok: true, status: 200, statusText: 'OK', json: async () => routes[key] };
    },
  };
}

const FIND_QUERY = `GET /api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(FLAG_TITLE)}&status=${FLAG_SEARCH_STATUSES}&limit=20`;
const FILE_ROUTE = `POST /api/companies/${COMPANY_ID}/issues`;

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

test('main() FIRES: a synthetic raw-SQL-style disarm (no revision, no identity) files exactly one dedup issue', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
    [FILE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't1',
      routineId: 'r1',
      label: 'nightly',
      triggerUpdatedAt: '2026-08-15T00:00:00Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: 'Some routine',
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
  });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].body.title, FLAG_TITLE);
  assert.equal(filed[0].body.assigneeAgentId, DEFAULT_OWNER_AGENT_ID);
  assert.match(filed[0].body.description, /trigger t1/);
});

test('main() PASSES: a normal PATCH-shaped disarm (revision in the same transaction) files nothing', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't2',
      routineId: 'r2',
      label: 'weekly',
      triggerUpdatedAt: '2026-08-15T00:00:00.050Z',
      updatedByAgentId: 'agent-9',
      updatedByUserId: null,
      routineTitle: 'Another routine',
      revisionNumber: 4,
      revisionCreatedAt: '2026-08-15T00:00:00.000Z',
    },
  ];

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'expected no mutation when nothing is unattributed');
});

test('main() UPDATES: rewrites an existing open dedup issue in place instead of filing a duplicate', async () => {
  const existing = { id: 'flagX', identifier: 'AUR-9001', title: FLAG_TITLE, status: 'todo' };
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [existing],
    [`PATCH /api/issues/${existing.id}`]: {},
    [`POST /api/issues/${existing.id}/comments`]: {},
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't3',
      routineId: 'r3',
      label: null,
      triggerUpdatedAt: '2026-08-15T00:00:00Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: null,
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
  });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 0, 'must not file a second issue when one is already open');
  const patched = calls.find((c) => c.method === 'PATCH' && c.path === `/api/issues/${existing.id}`);
  assert.ok(patched, 'expected the existing dedup issue to be patched');
  assert.match(patched.body.description, /trigger t3/);
});

test('main() RESOLVES: auto-closes the dedup issue once no unattributed disarms remain', async () => {
  const existing = { id: 'flagY', identifier: 'AUR-9002', title: FLAG_TITLE, status: 'todo' };
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [existing],
    [`PATCH /api/issues/${existing.id}`]: {},
    [`POST /api/issues/${existing.id}/comments`]: {},
  });
  global.fetch = fetchStub;

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => [],
  });

  assert.equal(code, 0);
  const patched = calls.find((c) => c.method === 'PATCH' && c.path === `/api/issues/${existing.id}`);
  assert.ok(patched, 'expected the dedup issue to be closed');
  assert.equal(patched.body.status, 'done');
});

test('main() DRY-RUN: --apply=false computes findings but performs zero mutations', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't4',
      routineId: 'r4',
      label: null,
      triggerUpdatedAt: '2026-08-15T00:00:00Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: null,
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];

  const code = await main({
    apply: false,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'dry-run must never mutate');
});
