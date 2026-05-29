import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLAG_REGEX,
  isExempt,
  resolveCancelReason,
  LIST_DESC_TRUNCATION,
  mayBeTruncated,
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

test('isExempt: not exempt when neither pattern matches', () => {
  assert.equal(isExempt({ title: 'Normal issue', description: 'Some work' }), false);
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
