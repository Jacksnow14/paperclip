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
  HISTORICAL_DEBT_CUTOFF,
  HISTORICAL_DEBT_CUTOFF_MS,
  classifyBornDisabledRoutine,
  formatBornDisabledFinding,
  buildBornDisabledIssueBody,
  findBornDisabledFlagIssue,
  runBornDisabledCheck,
  BORN_DISABLED_FLAG_TITLE,
  DEFAULT_STALENESS_MS,
  parseAllowlistDisarmLog,
  isPolicyDisarm,
  readAllowlistLogSafe,
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
      triggerUpdatedAt: '2026-08-16T00:00:00Z', // post-cutoff — active finding, not historical debt (AUR-6069)
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
    disarmLogEntries: [],
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
    disarmLogEntries: [],
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
      triggerUpdatedAt: '2026-08-16T00:00:00Z', // post-cutoff — active finding, not historical debt (AUR-6069)
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
    disarmLogEntries: [],
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
    disarmLogEntries: [],
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
      triggerUpdatedAt: '2026-08-16T00:00:00Z', // post-cutoff — active finding, not historical debt (AUR-6069)
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
    disarmLogEntries: [],
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'dry-run must never mutate');
});

// ── apiPost 403-on-assigneeAgentId retry (AUR-6054/AUR-6058) ────────────────

function makeAssignRetryFetchStub({ findQuery, filePath, always403 = false }) {
  const calls = [];
  return {
    calls,
    fetchStub: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(API_URL, '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (key === findQuery) return { ok: true, status: 200, statusText: 'OK', json: async () => [] };
      if (method === 'POST' && path === filePath) {
        if (always403 || (body && Object.prototype.hasOwnProperty.call(body, 'assigneeAgentId'))) {
          return {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({ error: 'Missing permission: tasks:assign' }),
          };
        }
        return { ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'unassigned1' }) };
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    },
  };
}

test('main(): a 403 on the assigneeAgentId POST retries once unassigned and succeeds instead of throwing', async () => {
  const { fetchStub, calls } = makeAssignRetryFetchStub({
    findQuery: FIND_QUERY,
    filePath: `/api/companies/${COMPANY_ID}/issues`,
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't5',
      routineId: 'r5',
      label: 'nightly',
      triggerUpdatedAt: '2026-08-16T00:00:00Z', // post-cutoff — active finding, not historical debt (AUR-6069)
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
    disarmLogEntries: [],
  });

  assert.equal(code, 0, 'must not throw / must not surface a non-zero exit for the 403-then-retry path');
  const posts = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(posts.length, 2, 'expected the original assigned attempt plus one unassigned retry');
  assert.ok(Object.prototype.hasOwnProperty.call(posts[0].body, 'assigneeAgentId'), 'first attempt carries assigneeAgentId');
  assert.ok(!Object.prototype.hasOwnProperty.call(posts[1].body, 'assigneeAgentId'), 'retry strips assigneeAgentId');
});

test('main(): a 403 that is NOT about assigneeAgentId (or not tasks:assign) is still thrown, not swallowed', async () => {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(API_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (`${method} ${path}` === FIND_QUERY) return { ok: true, status: 200, statusText: 'OK', json: async () => [] };
    if (method === 'POST' && path === `/api/companies/${COMPANY_ID}/issues`) {
      return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: 'Company access denied' }) };
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };

  const rows = [
    {
      triggerId: 't6',
      routineId: 'r6',
      label: null,
      triggerUpdatedAt: '2026-08-16T00:00:00Z', // post-cutoff — active finding, not historical debt (AUR-6069)
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: null,
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];

  await assert.rejects(
    () =>
      main({
        apply: true,
        apiUrl: API_URL,
        apiKey: 'key',
        companyId: COMPANY_ID,
        fetchCandidateRows: async () => rows,
        disarmLogEntries: [],
      }),
    /403/,
  );
  const posts = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(posts.length, 1, 'must not retry a 403 unrelated to tasks:assign');
});

// ── routine-allowlist policy-disarm exemption (AUR-6058) ────────────────────

test('parseAllowlistDisarmLog: extracts DISARM lines, ignores everything else', () => {
  const logText = [
    '2026-08-21T03:04:54.756Z ok: 38 armed, all on policy',
    '2026-08-21T03:20:19.711Z DISARM "AEO design-partner supply build — drip to warmup depth (AUR-5817)"',
    '',
    'not a log line at all',
    '2026-08-21T04:05:34.951Z DISARM "Delivery-claim verification watchdog (daily) — AUR-4613"',
  ].join('\n');
  const entries = parseAllowlistDisarmLog(logText);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'AEO design-partner supply build — drip to warmup depth (AUR-5817)');
  assert.equal(entries[1].title, 'Delivery-claim verification watchdog (daily) — AUR-4613');
  assert.equal(entries[0].ts, Date.parse('2026-08-21T03:20:19.711Z'));
});

test('parseAllowlistDisarmLog: empty/missing log text yields zero entries', () => {
  assert.deepEqual(parseAllowlistDisarmLog(''), []);
  assert.deepEqual(parseAllowlistDisarmLog(undefined), []);
});

test('isPolicyDisarm: true when the enforcer disarmed this exact routine title within tolerance of the trigger update', () => {
  const entries = [{ ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'Some routine' }];
  assert.equal(isPolicyDisarm(entries, 'Some routine', '2026-08-21T03:20:19.900Z', 5000), true);
});

test('isPolicyDisarm: false when the title matches but the timestamp gap exceeds tolerance', () => {
  const entries = [{ ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'Some routine' }];
  assert.equal(isPolicyDisarm(entries, 'Some routine', '2026-08-21T03:30:00.000Z', 5000), false);
});

test('isPolicyDisarm: false when no entry matches the routine title', () => {
  const entries = [{ ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'A different routine' }];
  assert.equal(isPolicyDisarm(entries, 'Some routine', '2026-08-21T03:20:19.900Z', 5000), false);
});

test('isPolicyDisarm: false when routineTitle is null (nothing to match against)', () => {
  const entries = [{ ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'Some routine' }];
  assert.equal(isPolicyDisarm(entries, null, '2026-08-21T03:20:19.900Z', 5000), false);
});

test('main(): a trigger disarmed by the allowlist enforcer within tolerance is excluded from findings and files nothing', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't7',
      routineId: 'r7',
      label: 'nightly',
      triggerUpdatedAt: '2026-08-21T03:20:19.756Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: 'AEO design-partner supply build — drip to warmup depth (AUR-5817)',
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];
  const disarmLogEntries = [
    { ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'AEO design-partner supply build — drip to warmup depth (AUR-5817)' },
  ];

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
    disarmLogEntries,
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'a policy-disarmed trigger must not be filed as unattributed');
});

test('main(): a genuinely unattributed disarm (no matching enforcer log entry) still fires alongside an unrelated policy-disarmed one', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
    [FILE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't8',
      routineId: 'r8',
      label: null,
      triggerUpdatedAt: '2026-08-21T05:00:00.000Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: 'A genuinely unexplained disarm',
      revisionNumber: null,
      revisionCreatedAt: null,
    },
    {
      triggerId: 't9',
      routineId: 'r9',
      label: 'nightly',
      triggerUpdatedAt: '2026-08-21T03:20:19.756Z',
      updatedByAgentId: null,
      updatedByUserId: null,
      routineTitle: 'AEO design-partner supply build — drip to warmup depth (AUR-5817)',
      revisionNumber: null,
      revisionCreatedAt: null,
    },
  ];
  const disarmLogEntries = [
    { ts: Date.parse('2026-08-21T03:20:19.711Z'), title: 'AEO design-partner supply build — drip to warmup depth (AUR-5817)' },
  ];

  const code = await main({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    fetchCandidateRows: async () => rows,
    disarmLogEntries,
  });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1);
  assert.match(filed[0].body.description, /trigger t8/);
  assert.doesNotMatch(filed[0].body.description, /trigger t9/);
});

// ── historical-debt cutoff (AUR-6069) ───────────────────────────────────────

test('main(): a pre-cutoff unattributed disarm is accepted historical debt — excluded, files nothing', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
  });
  global.fetch = fetchStub;

  const rows = [
    {
      // Matches the AUR-6062 mass-disarm timestamp (72 of the 86 findings).
      triggerId: 't10',
      routineId: 'r10',
      label: null,
      triggerUpdatedAt: '2026-08-07T08:56:52.540Z',
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
    disarmLogEntries: [],
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'pre-cutoff historical debt must not be filed as an active finding');
});

test('main(): a post-cutoff unattributed disarm is still flagged normally (negative control — amnesty is not a loophole)', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [FIND_QUERY]: [],
    [FILE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const rows = [
    {
      triggerId: 't11',
      routineId: 'r11',
      label: null,
      triggerUpdatedAt: new Date(HISTORICAL_DEBT_CUTOFF_MS + 60_000).toISOString(), // 1 min after the cutoff
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
    disarmLogEntries: [],
  });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1, 'a genuinely new post-cutoff unattributed disarm must still open the issue');
  assert.match(filed[0].body.description, /trigger t11/);
});

test('HISTORICAL_DEBT_CUTOFF_MS parses to a valid, sane timestamp', () => {
  assert.equal(Number.isNaN(HISTORICAL_DEBT_CUTOFF_MS), false);
  assert.equal(HISTORICAL_DEBT_CUTOFF_MS, Date.parse(HISTORICAL_DEBT_CUTOFF));
});

test('readAllowlistLogSafe: returns empty string instead of throwing when the log file does not exist on this host', () => {
  const text = readAllowlistLogSafe('/nonexistent/path/does-not-exist.log');
  assert.equal(text, '');
});

// ── classifyBornDisabledRoutine (AUR-5780) ──────────────────────────────────

test('classifyBornDisabledRoutine: FIRES on the AUR-5779 root-case shape (725124f5) — born disabled, never fired, stale nextRunAt', () => {
  // Routine 725124f5 (AUR-5668 daily delivery check): created 2026-08-13T17:32Z
  // with its only trigger already enabled=false and nextRunAt frozen at
  // creation's next cron tick, lastFiredAt null — 3 days silent before a
  // human caught it (AUR-5779).
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-13T17:32:00Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-14T03:00:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z'); // ~3.4 days after nextRunAt
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, true);
  assert.equal(c.hasScheduleNextRunAt, true);
  assert.ok(c.staleMs > DEFAULT_STALENESS_MS);
});

test('classifyBornDisabledRoutine: FIRES on the 1b991602 shape — disarmed by founder allowlist policy on its first sweep', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-15T20:23:46Z',
    triggers: [
      { id: '7825ad9a', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-16T03:00:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, true);
});

test('classifyBornDisabledRoutine: PASSES on a normally-enabled routine (has an enabled schedule trigger)', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: true, nextRunAt: '2026-08-18T03:00:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, false);
});

test('classifyBornDisabledRoutine: PASSES once the routine has actually fired', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: '2026-08-16T03:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-14T03:00:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, false);
});

test('classifyBornDisabledRoutine: PASSES on a non-active routine (paused/archived/draft)', () => {
  const routine = {
    status: 'paused',
    lastTriggeredAt: null,
    createdAt: '2026-08-15T20:23:46Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-16T03:00:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, false);
});

test('classifyBornDisabledRoutine: PASSES when disabled but not yet stale (fresh disarm, inside the grace window)', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-17T12:00:00Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-17T12:30:00Z' },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z'); // 30 min past nextRunAt, well under the 24h floor
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, false);
});

test('classifyBornDisabledRoutine: falls back to routine createdAt when no trigger ever computed a nextRunAt, and still fires once stale', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-10T00:00:00Z',
    triggers: [{ id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: null }],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, true);
  assert.equal(c.hasScheduleNextRunAt, false);
});

test('classifyBornDisabledRoutine: PASSES when an enabled non-schedule (e.g. webhook) trigger keeps the routine reachable', () => {
  const routine = {
    status: 'active',
    lastTriggeredAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    triggers: [
      { id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-14T03:00:00Z' },
      { id: 't2', kind: 'webhook', label: 'inbound', enabled: true, nextRunAt: null },
    ],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine(routine, now);
  assert.equal(c.flagged, false);
});

// ── formatBornDisabledFinding / buildBornDisabledIssueBody ──────────────────

test('formatBornDisabledFinding: names the routine, status, and triggers', () => {
  const routine = {
    routineId: 'r1',
    title: 'Some watchdog',
    createdAt: '2026-08-15T20:23:46Z',
    triggers: [{ id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-16T03:00:00Z' }],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine({ ...routine, status: 'active', lastTriggeredAt: null }, now);
  const line = formatBornDisabledFinding(routine, c);
  assert.match(line, /routine r1 "Some watchdog"/);
  assert.match(line, /status=active, lastTriggeredAt=null/);
  assert.match(line, /daily\(kind=schedule/);
});

test('buildBornDisabledIssueBody: lists every finding and carries the skip token', () => {
  const routine = {
    routineId: 'r1',
    title: 'X',
    createdAt: '2026-08-15T20:23:46Z',
    triggers: [{ id: 't1', kind: 'schedule', label: null, enabled: false, nextRunAt: '2026-08-16T03:00:00Z' }],
  };
  const now = new Date('2026-08-17T13:00:00Z');
  const c = classifyBornDisabledRoutine({ ...routine, status: 'active', lastTriggeredAt: null }, now);
  const body = buildBornDisabledIssueBody([{ routine, classification: c }], now);
  assert.match(body, /1 routine\(s\)/);
  assert.match(body, /routine r1/);
  assert.match(body, /exec\.routing-rationale: skip/);
});

// ── findBornDisabledFlagIssue ────────────────────────────────────────────────

test('findBornDisabledFlagIssue: exact title match wins over a loose-search false positive', async () => {
  const apiGet = async (path) => {
    assert.ok(path.includes(`q=${encodeURIComponent(BORN_DISABLED_FLAG_TITLE)}`));
    return [
      { id: 'x1', title: `${BORN_DISABLED_FLAG_TITLE} — old draft` },
      { id: 'x2', title: BORN_DISABLED_FLAG_TITLE, status: 'todo' },
    ];
  };
  const found = await findBornDisabledFlagIssue({ companyId: 'c1', apiGet });
  assert.equal(found.id, 'x2');
});

// ── runBornDisabledCheck() integration ──────────────────────────────────────

const BORN_DISABLED_FIND_QUERY = `GET /api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(BORN_DISABLED_FLAG_TITLE)}&status=${FLAG_SEARCH_STATUSES}&limit=20`;

test('runBornDisabledCheck() FIRES: a synthetic born-disabled routine (725124f5 shape) files exactly one dedup issue', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [BORN_DISABLED_FIND_QUERY]: [],
    [FILE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const routines = [
    {
      routineId: 'r-725124f5',
      title: 'AUR-5668 daily delivery check',
      status: 'active',
      lastTriggeredAt: null,
      createdAt: '2026-08-13T17:32:00Z',
      triggers: [{ id: 't1', kind: 'schedule', label: 'daily', enabled: false, nextRunAt: '2026-08-14T03:00:00Z' }],
    },
  ];

  const code = await runBornDisabledCheck({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    now: new Date('2026-08-17T13:00:00Z'),
    fetchCandidateRoutines: async () => routines,
  });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].body.title, BORN_DISABLED_FLAG_TITLE);
  assert.equal(filed[0].body.assigneeAgentId, DEFAULT_OWNER_AGENT_ID);
  assert.match(filed[0].body.description, /routine r-725124f5/);
});

test('runBornDisabledCheck() PASSES: a normally-enabled routine files nothing', async () => {
  const { fetchStub, calls } = makeFetchStub({
    [BORN_DISABLED_FIND_QUERY]: [],
  });
  global.fetch = fetchStub;

  const routines = [
    {
      routineId: 'r-ok',
      title: 'Normal routine',
      status: 'active',
      lastTriggeredAt: null,
      createdAt: '2026-08-01T00:00:00Z',
      triggers: [{ id: 't1', kind: 'schedule', label: 'daily', enabled: true, nextRunAt: '2026-08-18T03:00:00Z' }],
    },
  ];

  const code = await runBornDisabledCheck({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    now: new Date('2026-08-17T13:00:00Z'),
    fetchCandidateRoutines: async () => routines,
  });

  assert.equal(code, 0);
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 0, 'expected no mutation when nothing is operationally invisible');
});

test('runBornDisabledCheck() RESOLVES: auto-closes the dedup issue once no operationally-invisible routines remain', async () => {
  const existing = { id: 'flagZ', identifier: 'AUR-9003', title: BORN_DISABLED_FLAG_TITLE, status: 'todo' };
  const { fetchStub, calls } = makeFetchStub({
    [BORN_DISABLED_FIND_QUERY]: [existing],
    [`PATCH /api/issues/${existing.id}`]: {},
    [`POST /api/issues/${existing.id}/comments`]: {},
  });
  global.fetch = fetchStub;

  const code = await runBornDisabledCheck({
    apply: true,
    apiUrl: API_URL,
    apiKey: 'key',
    companyId: COMPANY_ID,
    now: new Date('2026-08-17T13:00:00Z'),
    fetchCandidateRoutines: async () => [],
  });

  assert.equal(code, 0);
  const patched = calls.find((c) => c.method === 'PATCH' && c.path === `/api/issues/${existing.id}`);
  assert.ok(patched, 'expected the dedup issue to be closed');
  assert.equal(patched.body.status, 'done');
});
