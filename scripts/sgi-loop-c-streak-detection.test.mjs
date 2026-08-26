import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateBucket,
  withinCooldown,
  selectForCreation,
  hasOpenSelfEditIssue,
  canonicalizeAgentKey,
  orderByWorkTime,
  workDateMs,
  buildSelfEditIssuePayload,
  PLATFORM_LABEL_ID,
} from './sgi-loop-c-streak-detection.mjs';

const REF_DATE = new Date('2026-07-26T00:00:00Z');

function daysAgoIso(days) {
  const d = new Date(REF_DATE);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

const daysAgoDate = (days) => daysAgoIso(days).slice(0, 10);

// records[i] is `days` days old; index 0 = most recent when `days` ascends.
// Each record carries a real `performance/{agent}/{type}/{YYYY-MM-DD}` title,
// because that date — not createdAt — is what the trend detectors order by
// (AUR-4233). createdAt is spread across the same days, so these fixtures are
// the well-behaved (non-backfilled) case.
function makeRecs(qualities, { startDaysAgo = 0, stepDays = 3, rework = [], withTitles = true } = {}) {
  // qualities given oldest → newest, matching the issue's shorthand (e.g. "5,4,4").
  const newestFirst = qualities.slice().reverse();
  return newestFirst.map((q, i) => {
    const daysAgo = startDaysAgo + i * stepDays;
    return {
      ...(withTitles ? { title: `performance/agent-x/feature/${daysAgoDate(daysAgo)}` } : {}),
      quality_signal: q,
      rework_required: rework[qualities.length - 1 - i] === true,
      createdAt: daysAgoIso(daysAgo),
    };
  });
}

/** Explicit fixture for backfill shapes, where work date and createdAt diverge. */
function rec(workDate, quality, { rework = false, createdAt } = {}) {
  return {
    title: `performance/agent-x/feature/${workDate}`,
    quality_signal: quality,
    rework_required: rework,
    createdAt,
  };
}

// ── (a) Detector B fires only on a genuine decline (AUR-4233) ───────────────

test('5,4,4 with no rework does NOT trigger detector B — quality 4 is good work', () => {
  // Flipped from the pre-AUR-4233 test that codified the false positive.
  // This is the exact shape of the live AUR-4215 / AUR-4216 triggers.
  const recs = makeRecs([5, 4, 4]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

test('5,3,2 with rework triggers detector B — a real decline still fires', () => {
  const recs = makeRecs([5, 3, 2], { rework: [false, true, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === 'B'), 'detector B should fire');
});

// ── Gate 1: absolute-quality floor — both directions ────────────────────────

test('quality floor CLEARS a healthy streak: 5,4,4 even WITH rework does not trigger B', () => {
  const recs = makeRecs([5, 4, 4], { rework: [true, true, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(
    !result.triggers || !result.triggers.some((t) => t.detector === 'B'),
    'min quality 4 is at the floor — detector B must not fire',
  );
});

test('quality floor FIRES once the window dips below it: 5,4,3 with rework triggers B', () => {
  const recs = makeRecs([5, 4, 3], { rework: [false, false, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === 'B'), 'min quality 3 is below the floor');
});

// ── Gate 2: rework gate — both directions ───────────────────────────────────

test('rework gate CLEARS a no-rework streak: 5,4,3 with zero rework does not trigger B', () => {
  const recs = makeRecs([5, 4, 3]);
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

test('rework gate FIRES when one record in the window required rework: 5,4,3 triggers B', () => {
  const recs = makeRecs([5, 4, 3], { rework: [false, true, false] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === 'B'));
});

// ── Gate 3: work-time ordering, not insertion order ─────────────────────────

test('detector B reads the trend from work date, not createdAt write order', () => {
  // Backfilled in *reverse*: the newest work was inserted first. Ordering by
  // createdAt would read this as 2→3→5 (improving) and miss a real regression.
  const recs = [
    rec('2026-07-20', 2, { rework: true, createdAt: '2026-07-25T10:00:00.100Z' }),
    rec('2026-07-15', 3, { createdAt: '2026-07-25T10:00:00.200Z' }),
    rec('2026-07-10', 5, { createdAt: '2026-07-25T10:00:00.300Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  const b = result.triggers.find((t) => t.detector === 'B');
  assert.ok(b, 'detector B should fire on the true 5→3→2 work-order decline');
  assert.match(b.desc, /5→3→2/);
});

test('an unresolvable same-day tie inside a backfill burst fails closed to no_trigger', () => {
  // Two records share a work date and were written 100ms apart, so nothing
  // establishes which is newer. Even though a 5→3→2 decline with rework is
  // present, the detector must refuse to report a direction.
  const recs = [
    rec('2026-07-20', 2, { rework: true, createdAt: '2026-07-25T10:00:00.100Z' }),
    rec('2026-07-20', 3, { rework: true, createdAt: '2026-07-25T10:00:00.200Z' }),
    rec('2026-07-10', 5, { rework: true, createdAt: '2026-07-25T10:00:00.300Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
  assert.ok(result.unorderable.includes('ambiguous_detector_b_window'));
});

test('a window with no parseable work date fails closed rather than trusting createdAt', () => {
  const recs = makeRecs([5, 3, 2], { rework: [true, true, true], withTitles: false });
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
  assert.ok(result.unorderable.includes('missing_work_date'));
});

test('the same-day tie guard CLEARS when createdAt is genuinely spread out', () => {
  // Same duplicated work date, but written 3 hours apart — not a backfill
  // burst, so createdAt is a legitimate tiebreaker and B stays live.
  const recs = [
    rec('2026-07-20', 2, { rework: true, createdAt: '2026-07-20T18:00:00.000Z' }),
    rec('2026-07-20', 3, { rework: true, createdAt: '2026-07-20T15:00:00.000Z' }),
    rec('2026-07-10', 5, { rework: true, createdAt: '2026-07-10T12:00:00.000Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  assert.ok(result.triggers.some((t) => t.detector === 'B'));
  assert.deepEqual(result.unorderable, []);
});

// ── Regression: the three live false positives of 2026-07-26T06:49 ──────────

test('regression AUR-4215 — CMO/infra 5→4→4, all success, zero rework → no_trigger', () => {
  // Distinct work dates and spread createdAt, so only the floor and rework
  // gates can suppress this one.
  const recs = [
    rec('2026-07-24', 4, { createdAt: '2026-07-24T09:00:00.000Z' }),
    rec('2026-07-20', 4, { createdAt: '2026-07-20T09:00:00.000Z' }),
    rec('2026-07-16', 5, { createdAt: '2026-07-16T09:00:00.000Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
});

test('regression AUR-4216 — CFO/infra 5→4→4 backfilled within 12 seconds → no_trigger', () => {
  // createdAt-newest first, as the live records were written. By insertion
  // order this reads 5→4→4; by work date the two 2026-06-14 records tie
  // inside the burst, so no direction is establishable at all.
  const recs = [
    rec('2026-07-03', 4, { createdAt: '2026-07-25T10:18:22.000Z' }),
    rec('2026-06-14', 4, { createdAt: '2026-07-25T10:18:14.000Z' }),
    rec('2026-06-14', 5, { createdAt: '2026-07-25T10:18:10.000Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
  assert.ok(result.unorderable.includes('ambiguous_detector_b_window'));
});

test('regression AUR-4217 — CFO/feature 5→5→4, records 54ms apart, title dates reversed → no_trigger', () => {
  // The record createdAt calls "most recent" (quality 4) is titled 2026-07-08,
  // the *oldest* work of the three. The declared decline is exactly backwards.
  const recs = [
    rec('2026-07-08', 4, { createdAt: '2026-07-25T10:18:10.958Z' }),
    rec('2026-07-09', 5, { createdAt: '2026-07-25T10:18:10.915Z' }),
    rec('2026-07-09', 5, { createdAt: '2026-07-25T10:18:10.904Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
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

test('detector A splits recent/baseline by work date, not createdAt (AUR-4233)', () => {
  // Written newest-work-first in one burst: by createdAt the "recent 5" would
  // be the five *oldest* records (all quality 5), inverting the delta to -0.6.
  const qualitiesOldestFirst = [...Array.from({ length: 20 }, () => 5), 5, 4, 4, 4, 5];
  const base = Date.parse('2026-07-25T10:00:00.000Z');
  const recs = qualitiesOldestFirst.map((q, i) => ({
    // work date ascends with i — index 24 is the newest work
    title: `performance/agent-x/feature/${daysAgoDate(60 - i * 2)}`,
    quality_signal: q,
    rework_required: false,
    // createdAt *descends* with i — newest work inserted first, 40ms apart
    createdAt: new Date(base - i * 40).toISOString(),
  }));
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, `expected a trigger, got skip=${result.skip}`);
  const a = result.triggers.find((t) => t.detector === 'A');
  assert.ok(a, 'detector A should fire on the work-ordered split');
  assert.ok(Math.abs(a.severity - 0.6) < 1e-9, `severity should be ~0.6, got ${a.severity}`);
});

test('detector A fails closed when work dates are missing', () => {
  const baselineQ = Array.from({ length: 20 }, () => 5);
  const recentQ = [5, 4, 4, 4, 5];
  const recs = makeRecs([...baselineQ, ...recentQ], { withTitles: false });
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'no_trigger');
  assert.ok(result.unorderable.includes('missing_work_date'));
});

// ── (d) staleness guard ──────────────────────────────────────────────────────

test('a bucket whose most-recent record is older than 30 days is skipped as stale', () => {
  const recs = makeRecs([5, 3, 2], { startDaysAgo: 40, rework: [true, true, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'stale');
});

test('a bucket whose most-recent record is within 30 days is evaluated normally', () => {
  const recs = makeRecs([5, 3, 2], { startDaysAgo: 29, rework: [true, true, true] });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
});

test('staleness is measured from work date, so a freshly backfilled old bucket is still stale', () => {
  const recs = [
    rec('2026-05-01', 5, { rework: true, createdAt: '2026-07-25T10:00:00.100Z' }),
    rec('2026-04-20', 3, { rework: true, createdAt: '2026-07-25T10:00:00.200Z' }),
    rec('2026-04-10', 2, { rework: true, createdAt: '2026-07-25T10:00:00.300Z' }),
  ];
  const result = evaluateBucket(recs, REF_DATE);
  assert.equal(result.skip, 'stale');
});

// ── Detector C — sustained low absolute quality ─────────────────────────────

test('recent5 mean <= 2.5 triggers detector C', () => {
  const recs = makeRecs([2, 2, 3, 2, 3]); // mean 2.4
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip);
  assert.ok(result.triggers.some((t) => t.detector === 'C'));
});

test('detector C stays live when work dates are missing — it is a level, not a trend', () => {
  const recs = makeRecs([2, 2, 3, 2, 3], { withTitles: false });
  const result = evaluateBucket(recs, REF_DATE);
  assert.ok(!result.skip, 'the fail-closed rule must not take the level detectors offline');
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

// ── work-date parsing / ordering units ──────────────────────────────────────

test('workDateMs prefers an explicit metadata date over the title date', () => {
  const withMeta = workDateMs({ title: 'performance/a/feature/2026-07-08', work_date: '2026-01-02' });
  assert.equal(withMeta, Date.parse('2026-01-02T00:00:00Z'));
});

test('workDateMs falls back to the title date and returns null when there is none', () => {
  assert.equal(workDateMs({ title: 'performance/a/feature/2026-07-08' }), Date.parse('2026-07-08T00:00:00Z'));
  assert.equal(workDateMs({ title: 'performance/a/feature' }), null);
  assert.equal(workDateMs({}), null);
});

test('workDateMs accepts the same-day disambiguating suffixes agents actually write', () => {
  // Real live titles. One unparseable record fails its whole bucket closed, so
  // rejecting these would black out healthy buckets rather than protect them.
  const expect = (title, date) =>
    assert.equal(workDateMs({ title }), Date.parse(`${date}T00:00:00Z`), title);
  expect('performance/a/research/2026-07-26-b', '2026-07-26');
  expect('performance/a/ops/2026-05-28-f2', '2026-05-28');
  expect('performance/a/bug/2026-06-03-AUR-793', '2026-06-03');
  expect('performance/a/infra/2026-06-22b', '2026-06-22');
  // ...but a title with no date at all still refuses.
  assert.equal(workDateMs({ title: 'performance/a/ops//bin/bash' }), null);
  assert.equal(workDateMs({ title: 'performance/a/ops/not-a-date' }), null);
});

test('orderByWorkTime refuses outright when any record lacks a work date', () => {
  const out = orderByWorkTime([
    rec('2026-07-20', 4, { createdAt: '2026-07-20T00:00:00Z' }),
    { quality_signal: 3, rework_required: false, createdAt: '2026-07-21T00:00:00Z' },
  ]);
  assert.equal(out.ordered, null);
  assert.equal(out.reason, 'missing_work_date');
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

// ---------------------------------------------------------------------------
// AUR-6215: self-edit issues are self-improvement work, never critical, so
// they must file as backlog + platform label, not the default todo.
// ---------------------------------------------------------------------------

test('self-edit issue payload is created as backlog with the platform label, not todo', () => {
  const payload = buildSelfEditIssuePayload({
    title: 'Prompt self-edit required — agent-1 / bug',
    description: 'desc',
    assigneeAgentId: 'agent-1',
    projectId: 'proj-1',
    parentId: 'parent-1',
  });
  assert.equal(payload.status, 'backlog');
  assert.deepEqual(payload.labelIds, [PLATFORM_LABEL_ID]);
  assert.notEqual(payload.status, 'todo');
  assert.equal(payload.priority, 'high');
  assert.equal(payload.assigneeAgentId, 'agent-1');
  assert.equal(payload.projectId, 'proj-1');
  assert.equal(payload.parentId, 'parent-1');
});

test('self-edit issue payload omits parentId when not given, rather than sending undefined', () => {
  const payload = buildSelfEditIssuePayload({
    title: 'Prompt self-edit required — agent-1 / bug',
    description: 'desc',
    assigneeAgentId: 'agent-1',
    projectId: 'proj-1',
  });
  assert.equal(payload.status, 'backlog');
  assert.deepEqual(payload.labelIds, [PLATFORM_LABEL_ID]);
  assert.ok(!('parentId' in payload));
});
