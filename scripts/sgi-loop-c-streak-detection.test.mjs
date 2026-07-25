import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateBucket,
  withinCooldown,
  selectForCreation,
  hasOpenSelfEditIssue,
  canonicalizeAgentKey,
} from './sgi-loop-c-streak-detection.mjs';

const REF_DATE = new Date('2026-07-25T00:00:00Z');

function daysAgoIso(days) {
  const d = new Date(REF_DATE);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

// records[i] is `days` days old; index 0 = most recent when `days` ascends.
function makeRecs(qualities, { startDaysAgo = 0, stepDays = 3, rework = [] } = {}) {
  // qualities given oldest → newest, matching the issue's shorthand (e.g. "5,4,4").
  const newestFirst = qualities.slice().reverse();
  return newestFirst.map((q, i) => ({
    quality_signal: q,
    rework_required: rework[qualities.length - 1 - i] === true,
    createdAt: daysAgoIso(startDaysAgo + i * stepDays),
  }));
}

// ── (a) non-strict decline triggers Detector B ──────────────────────────────

test('5,4,4 non-strict decline (oldest→newest) triggers detector B', () => {
  const recs = makeRecs([5, 4, 4]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === 'B'), 'detector B should fire');
});

// ── (b) flat 4,4,4 does NOT trigger ─────────────────────────────────────────

test('flat 4,4,4 does not trigger any detector', () => {
  const recs = makeRecs([4, 4, 4]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

// ── (c) baseline-delta regression triggers Detector A ───────────────────────

test('25-record bucket with recent5 mean 0.6 below prior20 mean triggers detector A', () => {
  // baseline (oldest 20): quality 5 each → mean 5.0
  // recent (newest 5): 5,4,4,4,5 → mean 4.4 → delta = 0.6 >= 0.5
  const baselineQ = Array.from({ length: 20 }, () => 5);
  const recentQ = [5, 4, 4, 4, 5];
  const recs = makeRecs([...baselineQ, ...recentQ]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  const a = result.triggers.find((t) => t.detector === 'A');
  assert.ok(a, 'detector A should fire');
  assert.ok(Math.abs(a.severity - 0.6) < 1e-9, `severity should be ~0.6, got ${a.severity}`);
});

test('25-record bucket with flat quality does not trigger detector A', () => {
  const recs = makeRecs(Array.from({ length: 25 }, () => 4));
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

// ── (d) staleness guard ──────────────────────────────────────────────────────

test('a bucket whose most-recent record is older than 30 days is skipped as stale', () => {
  // Even though the pattern would trigger B, the newest record is 40 days old.
  const recs = makeRecs([5, 4, 4], { startDaysAgo: 40 });
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'stale');
});

test('a bucket whose most-recent record is within 30 days is evaluated normally', () => {
  const recs = makeRecs([5, 4, 4], { startDaysAgo: 29 });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
});

// ── Detector C — sustained low absolute quality ─────────────────────────────

test('recent5 mean <= 2.5 triggers detector C', () => {
  const recs = makeRecs([2, 2, 3, 2, 3]); // mean 2.4
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === 'C'));
});

// ── Detector D — relaxed rework streak (3 of 5, was 3 of 3) ────────────────

test('3 of last 5 rework_required triggers detector D even with 2 clean runs', () => {
  const recs = makeRecs([4, 4, 4, 4, 4], { rework: [true, false, true, false, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === 'D'));
});

test('2 of last 5 rework_required does not trigger detector D', () => {
  const recs = makeRecs([4, 4, 4, 4, 4], { rework: [true, false, true, false, false] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

// ── too-few-records floor ────────────────────────────────────────────────────

test('fewer than 3 records is skipped as too_few_records, not evaluated', () => {
  const recs = makeRecs([4, 4]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'too_few_records');
});

// ── (e) cooldown suppresses a repeat trigger ────────────────────────────────

test('a recent prompt-improvement-proposal record suppresses via cooldown', () => {
  const records = [
    { title: 'prompt-improvement-proposal/agent-x/2026-07-10', createdAt: daysAgoIso(15) },
  ];
  const suppressed = withinCooldown(records, [], 'agent-x', 'feature', REF_DATE);
  assert.equal(suppressed, true);
});

test('a closed self-edit issue for the same agent/task_type within 30 days suppresses via cooldown', () => {
  const closedIssues = [
    { title: 'Prompt self-edit required — agent-x / feature', status: 'done', updatedAt: daysAgoIso(10) },
  ];
  const suppressed = withinCooldown([], closedIssues, 'agent-x', 'feature', REF_DATE);
  assert.equal(suppressed, true);
});

test('cooldown does not suppress a different task_type', () => {
  const closedIssues = [
    { title: 'Prompt self-edit required — agent-x / feature', status: 'done', updatedAt: daysAgoIso(10) },
  ];
  const suppressed = withinCooldown([], closedIssues, 'agent-x', 'bug', REF_DATE);
  assert.equal(suppressed, false);
});

test('cooldown expires after 30 days', () => {
  const records = [
    { title: 'prompt-improvement-proposal/agent-x/2026-06-01', createdAt: daysAgoIso(45) },
  ];
  const suppressed = withinCooldown(records, [], 'agent-x', 'feature', REF_DATE);
  assert.equal(suppressed, false);
});

// ── (f) 3-per-run cap logs what it dropped ──────────────────────────────────

test('selectForCreation caps at N, highest severity first, and reports dropped', () => {
  const eligible = [
    { key: 'a/feature', severity: 0.5 },
    { key: 'b/feature', severity: 2.0 },
    { key: 'c/feature', severity: 1.2 },
    { key: 'd/feature', severity: 0.9 },
  ];
  const { selected, dropped } = selectForCreation(eligible, 3);
  assert.deepEqual(selected.map((t) => t.key), ['b/feature', 'c/feature', 'd/feature']);
  assert.deepEqual(dropped.map((t) => t.key), ['a/feature']);
});

test('selectForCreation does not drop anything under the cap', () => {
  const eligible = [{ key: 'a/feature', severity: 1 }];
  const { selected, dropped } = selectForCreation(eligible, 3);
  assert.equal(selected.length, 1);
  assert.equal(dropped.length, 0);
});

// ── existing per-agent open-issue dedup (unchanged behavior) ───────────────

test('hasOpenSelfEditIssue matches on agent id regardless of task_type', () => {
  const open = [{ title: 'Prompt self-edit required — agent-x / bug', status: 'todo' }];
  assert.equal(hasOpenSelfEditIssue(open, 'agent-x'), true);
  assert.equal(hasOpenSelfEditIssue(open, 'agent-y'), false);
});

// ── (AUR-3856) agent-key canonicalization ───────────────────────────────────

const LIVE_AGENTS = [
  { id: '371a1b08-0286-4a12-a516-f587f42df5eb', name: 'CTO' },
  { id: '3823a155-1111-4a12-a516-f587f42df5ee', name: 'CEO' },
  { id: 'e8f947d2-2222-4a12-a516-f587f42df5ee', name: 'Predictor' },
];

test('(a) a bare uuid prefix and a decorated prefix both fold into the full uuid', () => {
  const bare = canonicalizeAgentKey('371a1b08', LIVE_AGENTS);
  const decorated = canonicalizeAgentKey('371a1b08 (CTO)', LIVE_AGENTS);
  assert.equal(bare.resolved, '371a1b08-0286-4a12-a516-f587f42df5eb');
  assert.equal(bare.method, 'prefix');
  assert.equal(decorated.resolved, '371a1b08-0286-4a12-a516-f587f42df5eb');
  assert.equal(decorated.method, 'prefix');
});

test('(a) a dash-suffixed prefix key resolves via prefix match', () => {
  const result = canonicalizeAgentKey('3823a155-ceo', LIVE_AGENTS);
  assert.equal(result.resolved, '3823a155-1111-4a12-a516-f587f42df5ee');
});

test('(b) cto/ceo fold in by case-insensitive name match', () => {
  const cto = canonicalizeAgentKey('cto', LIVE_AGENTS);
  const ceo = canonicalizeAgentKey('CEO', LIVE_AGENTS);
  assert.equal(cto.resolved, '371a1b08-0286-4a12-a516-f587f42df5eb');
  assert.equal(cto.method, 'name');
  assert.equal(ceo.resolved, '3823a155-1111-4a12-a516-f587f42df5ee');
  assert.equal(ceo.method, 'name');
});

test('(c) a prefix matching 2+ live agents stays unresolved and is never merged', () => {
  const ambiguousAgents = [
    { id: 'abcdef12-1111-4a12-a516-f587f42df5ee', name: 'agent-one' },
    { id: 'abcdef12-2222-4a12-a516-f587f42df5ee', name: 'agent-two' },
  ];
  const result = canonicalizeAgentKey('abcdef12', ambiguousAgents);
  assert.equal(result.resolved, null);
  assert.equal(result.method, 'ambiguous-prefix');
});

test('(d) an unknown key with no uuid, prefix, or name match stays unresolved', () => {
  const result = canonicalizeAgentKey('totally-unknown-key', LIVE_AGENTS);
  assert.equal(result.resolved, null);
  assert.equal(result.method, 'unresolved');
});

test('an exact uuid match (any case) resolves directly, not via prefix', () => {
  const result = canonicalizeAgentKey('371A1B08-0286-4A12-A516-F587F42DF5EB', LIVE_AGENTS);
  assert.equal(result.resolved, '371a1b08-0286-4a12-a516-f587f42df5eb');
  assert.equal(result.method, 'exact');
});
