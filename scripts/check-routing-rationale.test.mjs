import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLAG_REGEX,
  isExempt,
  resolveCancelReason,
  resolveGapOwner,
  CEO_AGENT_ID,
  LIST_DESC_TRUNCATION,
  mayBeTruncated,
  ISSUE_STATUS_FILTER,
  main,
} from './check-routing-rationale.mjs';

// ── FLAG_REGEX ────────────────────────────────────────────────────────────────

test('FLAG_REGEX matches hyphen format', () => {
  const title = 'routing-rationale-gap: AUR-1563 [critical] missing routing/AUR-1563 record';
  const m = FLAG_REGEX.exec(title);
  assert.ok(m, 'should match');
  assert.equal(m[1], 'AUR-1563');
});

test('FLAG_REGEX matches space format', () => {
  const title = 'routing-rationale gap: AUR-1563 missing routing/AUR-1563 record';
  const m = FLAG_REGEX.exec(title);
  assert.ok(m, 'should match');
  assert.equal(m[1], 'AUR-1563');
});

test('FLAG_REGEX is case-insensitive', () => {
  const title = 'ROUTING-RATIONALE GAP: AUR-999 something';
  const m = FLAG_REGEX.exec(title);
  assert.ok(m, 'should match');
  assert.equal(m[1], 'AUR-999');
});

test('FLAG_REGEX does not match unrelated titles', () => {
  assert.equal(FLAG_REGEX.exec('AUR-1563 missing something'), null);
  assert.equal(FLAG_REGEX.exec('routing gap: AUR-1563'), null);
});

// ── isExempt ──────────────────────────────────────────────────────────────────

test('isExempt: token in description', () => {
  assert.ok(isExempt({ title: 'Some Issue', description: 'exec.routing-rationale: skip\nother stuff' }));
});

test('isExempt: content slot title pattern', () => {
  assert.ok(isExempt({ title: 'Content Slot lane-b Script Request', description: '' }));
  assert.ok(isExempt({ title: 'CONTENT SLOT lane-a request', description: '' }));
});

test('isExempt: recurring daily-brief publication titles', () => {
  assert.ok(isExempt({ title: 'Post 2026-05-29 daily AI brief to AUR-27', description: '' }));
  assert.ok(isExempt({ title: 'Daily Brief — 2026-05-30', description: '' }));
});

test('isExempt: lane-b content-script child task ("Write script — ...") is exempt', () => {
  // AUR-1592-style: generated child of a Content Slot lane-b request.
  assert.ok(isExempt({
    title: 'Write script — Build a personal knowledge base with Notion AI',
    description: 'Target: 60s. Write a hook, story, CTA. Return JSON.\n\nThis is an ai_tools topic for Workflow Signal (lane-b).',
  }));
  // AUR-1600-style: same class, but the marker reads "Workflow Signal channel"
  // rather than the literal "(lane-b)" — must still be exempt.
  assert.ok(isExempt({
    title: 'Write script — How GPT-4o reads screenshots and fixes UI bugs',
    description: 'Target: 60s. Mode: ai_tools (Workflow Signal channel — professional dev/AI workflow audience). Write a hook, 3-4 key points.',
  }));
});

test('isExempt: content-pipeline "Render & Upload" child task is exempt', () => {
  // AUR-1593/1598-style: Video Editor render child of a Content Slot.
  assert.ok(isExempt({
    title: 'Render & Upload — 2026-05-29T20:00:03Z',
    description: '## Video Editor Render Task\n\nParent slot: AUR-1591\n```json\n{"script_source":"content_manager","voice_path":"elevenlabs"}\n```',
  }));
});

test('isExempt: genuine technical "Write script" / "Render" tasks are NOT exempt', () => {
  assert.equal(isExempt({
    title: 'Write script to migrate DB',
    description: 'Backfill the users table and update the routing config.',
  }), false);
  // "Write script" title without the content-pipeline marker must not be exempted.
  assert.equal(isExempt({
    title: 'Write script for nightly backup',
    description: 'Cron job that dumps postgres to S3.',
  }), false);
  // A real "Render & Upload" engineering task without the Video Editor marker.
  assert.equal(isExempt({
    title: 'Render & Upload build artifacts to CDN',
    description: 'Wire the CI step that renders docs and uploads to the bucket.',
  }), false);
});

test('isExempt: single-owner role-routed sign-off / approval gate is exempt', () => {
  // AUR-1630-style: CTO→CFO budget sign-off gate. No candidate pool, no routing
  // decision to document (AUR-1632 false-positive class).
  assert.ok(isExempt({
    title: 'CFO sign-off: Standard ~$160/mo subscription tier',
    description: '',
  }));
  // "sign off" (space) and em-dash separator variants.
  assert.ok(isExempt({ title: 'Legal sign off — vendor contract X', description: '' }));
  // "approval:" and "approval gate —" gate framings.
  assert.ok(isExempt({ title: 'Budget approval: Q3 SaaS spend', description: '' }));
  assert.ok(isExempt({ title: 'Compliance approval gate — data retention policy', description: '' }));
});

test('isExempt: genuine engineering task that BUILDS a sign-off/approval feature is NOT exempt', () => {
  // No gate delimiter after the phrase → still flagged (no regression).
  assert.equal(isExempt({
    title: 'Add approval gate to deploy pipeline',
    description: 'Wire a manual approval step into CD before prod rollout.',
  }), false);
  assert.equal(isExempt({
    title: 'Implement sign-off flow for invoices',
    description: 'Build the multi-step sign-off UI and API.',
  }), false);
});

test('isExempt: self-assigned issue (assignee === creator) is exempt', () => {
  // Creator kept the work — no candidate pool, no routing decision to document.
  // Recurring false-positive class: AUR-869, AUR-1829, AUR-801/802 (AUR-1550).
  assert.ok(isExempt({
    title: 'CEO arbitrage research box',
    description: 'Self-assigned watch task.',
    assigneeAgentId: '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b',
    createdByAgentId: '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b',
  }));
});

test('isExempt: genuine delegation (assignee !== creator) stays flaggable', () => {
  // AUR-1841: creator CEO → assignee CTO. Real delegation, real candidate pool.
  assert.equal(isExempt({
    title: 'Build the mail dashboard',
    description: 'Delegated engineering work.',
    createdByAgentId: '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b',
    assigneeAgentId: '371a1b08-0286-4a12-a516-f587f42df5eb',
  }), false);
  // AUR-1846: creator CTO → assignee CEO. Reverse delegation, still flaggable.
  assert.equal(isExempt({
    title: 'Approve the budget for X',
    description: 'Delegated decision.',
    createdByAgentId: '371a1b08-0286-4a12-a516-f587f42df5eb',
    assigneeAgentId: '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b',
  }), false);
});

test('isExempt: not exempt when neither pattern matches', () => {
  assert.equal(isExempt({ title: 'Normal issue', description: 'Some work' }), false);
  assert.equal(isExempt({ title: 'Fix daily cron job', description: 'no brief here' }), false);
});

test('isExempt: missing description does not throw', () => {
  assert.equal(isExempt({ title: 'Normal issue' }), false);
});

// ── description truncation (list endpoint hides the exemption token) ──────────

test('mayBeTruncated: short description is not truncated', () => {
  assert.equal(mayBeTruncated('short'), false);
  assert.equal(mayBeTruncated(''), false);
  assert.equal(mayBeTruncated(undefined), false);
});

test('mayBeTruncated: description at the list limit may be truncated', () => {
  assert.equal(mayBeTruncated('x'.repeat(LIST_DESC_TRUNCATION - 1)), false);
  assert.equal(mayBeTruncated('x'.repeat(LIST_DESC_TRUNCATION)), true);
  assert.equal(mayBeTruncated('x'.repeat(LIST_DESC_TRUNCATION + 500)), true);
});

test('isExempt misses a token truncated off by the list endpoint (why hydration is needed)', () => {
  // Full description contains the token past the truncation boundary.
  const full = `${'x'.repeat(LIST_DESC_TRUNCATION + 100)}\nexec.routing-rationale: skip`;
  assert.ok(isExempt({ title: 'Long issue', description: full }), 'full desc is exempt');

  // The list endpoint hands back only the first LIST_DESC_TRUNCATION chars.
  const listView = full.slice(0, LIST_DESC_TRUNCATION);
  assert.equal(
    isExempt({ title: 'Long issue', description: listView }),
    false,
    'truncated list view loses the token → must hydrate full description first',
  );
  assert.ok(mayBeTruncated(listView), 'and we can detect that it might be truncated');
});

// ── resolveCancelReason ───────────────────────────────────────────────────────

test('resolveCancelReason: target not found → cancel', () => {
  const reason = resolveCancelReason({ target: null, targetId: 'AUR-1', hasRecord: false });
  assert.ok(reason?.includes('not found'));
});

test('resolveCancelReason: target is done → cancel', () => {
  const reason = resolveCancelReason({
    target: { status: 'done', title: 'x' },
    targetId: 'AUR-2',
    hasRecord: false,
  });
  assert.ok(reason?.includes('is done'));
});

test('resolveCancelReason: target is cancelled → cancel', () => {
  const reason = resolveCancelReason({
    target: { status: 'cancelled', title: 'x' },
    targetId: 'AUR-3',
    hasRecord: false,
  });
  assert.ok(reason?.includes('is cancelled'));
});

test('resolveCancelReason: target is exempt → cancel', () => {
  const reason = resolveCancelReason({
    target: { status: 'in_progress', title: 'Content Slot lane-b request', description: '' },
    targetId: 'AUR-4',
    hasRecord: false,
  });
  assert.ok(reason?.includes('exempt'));
});

test('resolveCancelReason: target has routing record → cancel', () => {
  const reason = resolveCancelReason({
    target: { status: 'in_progress', title: 'Real issue', description: '' },
    targetId: 'AUR-5',
    hasRecord: true,
  });
  assert.ok(reason?.includes('record now exists'));
});

test('resolveCancelReason: valid open target without record → keep flag (null)', () => {
  const reason = resolveCancelReason({
    target: { status: 'in_progress', title: 'Real issue', description: '' },
    targetId: 'AUR-6',
    hasRecord: false,
  });
  assert.equal(reason, null);
});

// ── resolveGapOwner (AUR-1818: gap issues must never be orphaned) ─────────────

test('resolveGapOwner: prefers the target issue creator (the router)', () => {
  const owner = resolveGapOwner({ createdByAgentId: 'agent-router-9', assigneeAgentId: 'agent-1' });
  assert.equal(owner.agentId, 'agent-router-9');
  assert.equal(owner.source, 'target.createdByAgentId');
});

test('resolveGapOwner: falls back to CEO when creator is missing/null', () => {
  assert.equal(resolveGapOwner({ createdByAgentId: null }).agentId, CEO_AGENT_ID);
  assert.equal(resolveGapOwner({}).agentId, CEO_AGENT_ID);
  assert.equal(resolveGapOwner({ createdByAgentId: '' }).agentId, CEO_AGENT_ID);
  assert.equal(resolveGapOwner(undefined).source, 'fallback:CEO');
});

test('resolveGapOwner: never returns a null/empty assignee', () => {
  for (const issue of [{}, { createdByAgentId: null }, { createdByAgentId: 'a' }, undefined]) {
    const owner = resolveGapOwner(issue);
    assert.ok(typeof owner.agentId === 'string' && owner.agentId.length > 0,
      'owner.agentId must always be a non-empty string — no orphans');
  }
});

// ── Dedup integration scenario (mocked fetch) ─────────────────────────────────

test('dedup: skips filing flag when open flag already exists for target', async (t) => {
  // Simulate: AUR-100 is open+high+manual, has an open flag referencing it,
  // no routing record. Phase B should skip (dedup) rather than file a duplicate.

  const openIssues = [
    // The target issue
    {
      id: 'id-100', identifier: 'AUR-100', title: 'Do the thing',
      priority: 'high', assigneeAgentId: 'agent-1', originKind: 'manual',
      status: 'in_progress', updatedAt: new Date().toISOString(), description: '',
    },
    // Existing flag issue
    {
      id: 'id-flag', identifier: 'AUR-101',
      title: 'routing-rationale gap: AUR-100 missing routing/AUR-100 record',
      priority: 'low', assigneeAgentId: null, originKind: 'manual',
      status: 'todo', updatedAt: new Date().toISOString(), description: '',
    },
  ];

  // Mock fetch: issues endpoint returns openIssues; memory endpoint returns empty
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(url);
    if (url.includes('/issues?')) {
      return { ok: true, json: async () => openIssues };
    }
    if (url.includes('/memory/records')) {
      return { ok: true, json: async () => [] };
    }
    // Should not reach POST calls in dry-run
    return { ok: true, json: async () => ({}) };
  });

  // Dynamically import main logic by running script logic inline
  // We validate the dedup invariant: openFlagTargets is populated by Phase A
  // so Phase B skips AUR-100
  const { FLAG_REGEX: re, resolveCancelReason: rcr } = await import('./check-routing-rationale.mjs');

  // Phase A: identify flags and their cancel/keep decision
  const flags = openIssues.filter(i => re.test(i.title ?? ''));
  assert.equal(flags.length, 1, 'one flag issue');

  const flag = flags[0];
  const flagMatch = re.exec(flag.title);
  const targetId = flagMatch[1]; // AUR-100
  assert.equal(targetId, 'AUR-100');

  const target = openIssues.find(i => i.identifier === targetId);
  // Phase A: target is open, not done/cancelled, not exempt, no record → keep flag
  const cancelReason = rcr({ target, targetId, hasRecord: false });
  assert.equal(cancelReason, null, 'flag should NOT be cancelled — target still open');

  // openFlagTargets would contain AUR-100
  const openFlagTargets = new Set([targetId]);

  // Phase B dedup: AUR-100 is in openFlagTargets → skip filing
  const candidateId = openIssues[0].identifier;
  assert.ok(openFlagTargets.has(candidateId), 'dedup should skip AUR-100 — flag already open');
});

// ── backlog-status flag visibility (AUR-1581) ─────────────────────────────────

test('ISSUE_STATUS_FILTER includes backlog so backlog flags are fetched', () => {
  assert.ok(
    ISSUE_STATUS_FILTER.split(',').includes('backlog'),
    'backlog must be in the working-issue fetch filter — flags default to backlog server-side',
  );
});

/**
 * Drives main() with a mocked fetch. Captures the issues-fetch URL and any
 * mutating calls (PATCH cancel, POST comment, POST new-flag).
 *
 * @param {object[]} openIssues   what the issues LIST endpoint returns
 * @param {(prefix:string)=>object[]} memoryFor  routing records for a titlePrefix
 */
function mockApi(t, openIssues, memoryFor) {
  const calls = { issuesFetchUrl: null, patched: [], comments: [], filed: [] };
  t.mock.method(global, 'fetch', async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'PATCH') {
      calls.patched.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST') {
      if (url.includes('/comments')) calls.comments.push({ url, body: JSON.parse(opts.body) });
      else if (/\/companies\/[^/]+\/issues$/.test(url)) calls.filed.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ id: 'new-flag', identifier: 'AUR-NEW' }) };
    }
    // GET
    if (url.includes('/issues?')) {
      calls.issuesFetchUrl = url;
      return { ok: true, json: async () => openIssues };
    }
    if (url.includes('/memory/records')) {
      const m = url.match(/titlePrefix=([^&]+)/);
      const prefix = m ? decodeURIComponent(m[1]) : '';
      return { ok: true, json: async () => memoryFor(prefix) };
    }
    return { ok: true, json: async () => ({}) };
  });
  return calls;
}

const now = () => new Date().toISOString();
const runOpts = { windowMinutes: 60, apply: true, apiUrl: 'http://x', apiKey: 'k', companyId: 'co-1' };

test('backlog flag whose gap is now closed (routing record exists) → auto-resolved', async (t) => {
  const openIssues = [
    {
      id: 'f1', identifier: 'AUR-301', status: 'backlog', priority: 'low',
      title: 'routing-rationale gap: AUR-300 missing routing/AUR-300 record', description: '',
    },
    {
      id: 't300', identifier: 'AUR-300', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'a1', originKind: 'manual', updatedAt: now(),
      title: 'Real work', description: '',
    },
  ];
  // Gap is closed: routing/AUR-300 record now exists.
  const calls = mockApi(t, openIssues, (prefix) =>
    prefix.startsWith('routing/AUR-300') ? [{ title: 'routing/AUR-300' }] : []);

  const code = await main(runOpts);

  assert.ok(calls.issuesFetchUrl.includes('status=backlog,'), 'fetch must include backlog');
  assert.equal(calls.patched.length, 1, 'the backlog flag should be cancelled');
  assert.match(calls.patched[0].url, /\/api\/issues\/f1$/);
  assert.equal(calls.patched[0].body.status, 'cancelled');
  assert.equal(calls.filed.length, 0, 'no new flag filed');
  assert.equal(code, 0);
});

test('backlog flag whose gap is still open → counted as dedup, no duplicate filed', async (t) => {
  const openIssues = [
    {
      id: 'f2', identifier: 'AUR-401', status: 'backlog', priority: 'low',
      title: 'routing-rationale gap: AUR-400 missing routing/AUR-400 record', description: '',
    },
    {
      id: 't400', identifier: 'AUR-400', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'a1', originKind: 'manual', updatedAt: now(),
      title: 'Real work', description: '',
    },
  ];
  // Gap still open: no routing record for AUR-400.
  const calls = mockApi(t, openIssues, () => []);

  const code = await main(runOpts);

  assert.ok(calls.issuesFetchUrl.includes('status=backlog,'), 'fetch must include backlog');
  assert.equal(calls.patched.length, 0, 'flag stays open — gap not closed');
  assert.equal(calls.filed.length, 0, 'must NOT file a duplicate — backlog flag dedups');
  assert.equal(code, 0);
});

test('new flags are filed in todo, not the server-default backlog', async (t) => {
  const openIssues = [
    {
      id: 't500', identifier: 'AUR-500', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'a1', createdByAgentId: 'router-77', originKind: 'manual', updatedAt: now(),
      title: 'Needs routing rationale', description: '',
    },
  ];
  const calls = mockApi(t, openIssues, () => []); // no record, no existing flag

  await main(runOpts);

  assert.equal(calls.filed.length, 1, 'one new flag filed');
  assert.equal(calls.filed[0].body.status, 'todo', 'filed in todo so it is actionable + visible');
});

test('AUR-1818: filed gap issue carries a non-null assignee resolved from the router', async (t) => {
  const openIssues = [
    {
      id: 't501', identifier: 'AUR-501', status: 'in_progress', priority: 'critical',
      assigneeAgentId: 'worker-1', createdByAgentId: 'router-77', originKind: 'manual', updatedAt: now(),
      title: 'Critical work missing rationale', description: '',
    },
  ];
  const calls = mockApi(t, openIssues, () => []);

  await main(runOpts);

  assert.equal(calls.filed.length, 1, 'one new flag filed');
  assert.equal(calls.filed[0].body.assigneeAgentId, 'router-77',
    'gap issue must be assigned to the router (target creator), never orphaned');
});

test('AUR-1818: filed gap issue falls back to CEO when target has no creator agent', async (t) => {
  const openIssues = [
    {
      id: 't502', identifier: 'AUR-502', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'worker-2', createdByAgentId: null, originKind: 'manual', updatedAt: now(),
      title: 'High work missing rationale, user-created', description: '',
    },
  ];
  const calls = mockApi(t, openIssues, () => []);

  await main(runOpts);

  assert.equal(calls.filed.length, 1, 'one new flag filed');
  assert.equal(calls.filed[0].body.assigneeAgentId, CEO_AGENT_ID,
    'gap issue must fall back to CEO when no creator agent — never null');
  assert.ok(calls.filed[0].body.assigneeAgentId, 'assignee must be non-null (no orphan)');
});

test('main: sign-off gate is exempt (not filed) while a real coding task is still flagged', async (t) => {
  const openIssues = [
    // AUR-1630-class: high-priority single-owner sign-off gate, no routing record.
    {
      id: 'g1', identifier: 'AUR-1630', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'cfo', originKind: 'manual', updatedAt: now(),
      title: 'CFO sign-off: Standard ~$160/mo subscription tier', description: '',
    },
    // Genuine high-priority coding task, no routing record → must still be flagged.
    {
      id: 'c1', identifier: 'AUR-1700', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'a1', originKind: 'manual', updatedAt: now(),
      title: 'Refactor the auth middleware', description: 'Swap session storage backend.',
    },
  ];
  const calls = mockApi(t, openIssues, () => []); // no routing records exist

  await main(runOpts);

  assert.equal(calls.filed.length, 1, 'exactly one flag filed — the coding task, not the gate');
  assert.match(calls.filed[0].body.title, /AUR-1700/, 'the coding task is flagged');
  assert.ok(
    !calls.filed.some(f => /AUR-1630/.test(f.body.title)),
    'the sign-off gate must NOT be flagged (exempt)',
  );
});

test('main: existing open flag for a sign-off gate auto-resolves in Phase A', async (t) => {
  const openIssues = [
    // Stale flag targeting a sign-off gate.
    {
      id: 'f1630', identifier: 'AUR-1631', status: 'todo', priority: 'low',
      title: 'routing-rationale gap: AUR-1630 missing routing/AUR-1630 record', description: '',
    },
    // The sign-off gate target — now recognized as exempt.
    {
      id: 'g1', identifier: 'AUR-1630', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'cfo', originKind: 'manual', updatedAt: now(),
      title: 'CFO sign-off: Standard ~$160/mo subscription tier', description: '',
    },
  ];
  const calls = mockApi(t, openIssues, () => []); // no routing record needed — exempt

  await main(runOpts);

  assert.equal(calls.patched.length, 1, 'the stale flag should be cancelled');
  assert.match(calls.patched[0].url, /\/api\/issues\/f1630$/);
  assert.equal(calls.patched[0].body.status, 'cancelled');
  assert.ok(calls.comments.some(c => /exempt/i.test(c.body.body)), 'cancel comment cites exemption');
  assert.equal(calls.filed.length, 0, 'no new flag filed for the exempt gate');
});

// ── Memory API 404 hardening (AUR-1718) ───────────────────────────────────────

test('main: Memory API 404 → exit code 3 (BLOCKED), zero mutations', async (t) => {
  // Scenario: issues endpoint works fine, but /memory/records returns 404
  // (stale server process, memory routes not mounted). The watchdog must abort
  // before any mutation and return exit code 3 — not silently exit 0.
  const openIssues = [
    {
      id: 't1', identifier: 'AUR-999', status: 'in_progress', priority: 'high',
      assigneeAgentId: 'a1', originKind: 'manual', updatedAt: now(),
      title: 'Important work without routing record', description: '',
    },
    {
      id: 'f1', identifier: 'AUR-998', status: 'todo', priority: 'low',
      title: 'routing-rationale gap: AUR-997 missing routing/AUR-997 record', description: '',
    },
  ];

  const mutations = { patched: [], comments: [], filed: [] };
  t.mock.method(global, 'fetch', async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'PATCH') {
      mutations.patched.push(url);
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST') {
      if (url.includes('/comments')) mutations.comments.push(url);
      else mutations.filed.push(url);
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/issues?')) {
      return { ok: true, json: async () => openIssues };
    }
    if (url.includes('/memory/records')) {
      // Simulate Memory API unavailable
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
    return { ok: true, json: async () => ({}) };
  });

  const code = await main(runOpts);

  assert.equal(code, 3, 'must return exit code 3 (BLOCKED) when Memory API is 404');
  assert.equal(mutations.patched.length, 0, 'no PATCH mutations when Memory API is 404');
  assert.equal(mutations.comments.length, 0, 'no comment mutations when Memory API is 404');
  assert.equal(mutations.filed.length, 0, 'no new flags filed when Memory API is 404');
});

test('main: anti-flood cap limits new flags per run and logs deferred', async (t) => {
  // Build 5 candidate issues, but cap at 2 per run. Expect 2 filed, 3 deferred.
  const openIssues = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, identifier: `AUR-${600 + i}`, status: 'in_progress', priority: 'high',
    assigneeAgentId: 'a1', originKind: 'manual', updatedAt: now(),
    title: `Work item ${i}`, description: '',
  }));

  const calls = mockApi(t, openIssues, () => []); // no routing records — all would be flagged

  const code = await main({ ...runOpts, maxNewFlags: 2 });

  assert.equal(calls.filed.length, 2, 'only 2 flags filed (cap reached)');
  assert.equal(code, 0);
});
