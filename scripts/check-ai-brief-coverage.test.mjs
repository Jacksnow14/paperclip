import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_COMMENT_CHARS,
  DARK_DAY_ALARM_THRESHOLD,
  extractDateFromTitle,
  runIssuesForDate,
  largestCommentAcrossBundles,
  classifyDayCoverage,
  extractFailureReason,
  CONTROLS,
  controlVerdict,
  shiftDate,
  computeDarkStreak,
  ALARM_TITLE,
} from './check-ai-brief-coverage.mjs';

// ── Real fixtures — exact live shapes verified against the API 2026-08-19 ────

const AUR_5422_ISSUE = {
  id: '65bbece8-db6f-43f0-9794-8ab0f8ff7b20',
  identifier: 'AUR-5422',
  status: 'cancelled',
  title: 'Daily AI opportunity research brief for 2026-08-09',
};

// Exact verbatim bodies fetched from the live API 2026-08-19 — lengths matter
// for the FIRE control (largest = 755ch, comment 7b85eb4c).
const AUR_5422_COMMENTS = [
  {
    id: 'e9605367-8600-4bd3-a4bf-3d2988157295',
    body:
      'Acknowledged. Agree with the cancellation — a research brief for 2026-08-09 produced on 2026-08-12 has no value; ' +
      'the outage window (2026-08-08 through 2026-08-12) is documented in the manifest at ' +
      '`/home/ievgen/.paperclip/queue-plan-2026-08-12.json`. No further action needed on this issue; leaving it ' +
      '`cancelled`. If a fresh brief is wanted, it should be filed as a new issue for the current date rather than ' +
      'resuming this one.',
  },
  {
    id: '2c766d75-7ea1-4447-bb77-abd5752f457c',
    body:
      'Cancelled in the 2026-08-12 post-outage sweep. Reason: catch-up AI brief for 2026-08-09 — the day is gone.\n\n' +
      'Context: the Claude subscription hit its weekly usage limit and one agent on the credit-metered ' +
      '`claude-fable-5` model triggered a fleet-wide adapter quota pause, so 2026-08-08 through 2026-08-12 produced ' +
      'almost no completed work. Issues describing that condition are being closed rather than worked. Manifest: ' +
      '/home/ievgen/.paperclip/queue-plan-2026-08-12.json',
  },
  {
    id: '7b85eb4c-1ee6-4d5c-ac9e-6e0bfc33e0d8',
    body:
      '**Cancelled under [AUR-5431](/AUR/issues/AUR-5431) — board directive.**\n\n' +
      'This issue is an artifact of the 2026-08-06 → 2026-08-12 provider outage, not of anything anyone did or ' +
      'failed to do. Every Claude lane was hard-blocked by the Anthropic org policy `Your organization has disabled ' +
      'Claude subscription access for Claude Code`. 70 runs failed that way; the fleet last executed successfully ' +
      'at 2026-08-07 13:30 UTC. No agent could act on this.\n\n' +
      'A stale fire of a daily/monitor routine has no value once the day has passed — the reading it would produce ' +
      'is about a moment that is gone. The routine fires fresh on its next tick, so nothing is lost by cancelling.\n\n' +
      'Do not re-open. If the underlying routine needs a run, let the schedule mint a current one.',
  },
];

const AUR_5123_ISSUE = {
  id: '59a77959-7db1-4757-abc4-96ca2a596185',
  identifier: 'AUR-5123',
  status: 'done',
  title: 'Daily AI opportunity research brief for 2026-08-06',
};

const AUR_5123_COMMENTS = [
  { id: 'c5b2afe9', body: 'x'.repeat(2612) },
  { id: '117a45d7', body: 'x'.repeat(4149) },
  { id: '03dc9059', body: 'x'.repeat(779) },
  { id: 'fee5ace2', body: 'x'.repeat(4506) },
  { id: '41b34007-5f36-42ce-8bd4-645adfd4ffa8', body: 'y'.repeat(16311) },
];

// ── extractDateFromTitle / runIssuesForDate ──────────────────────────────────

test('extractDateFromTitle pulls the date out of the canonical title', () => {
  assert.equal(extractDateFromTitle('Daily AI opportunity research brief for 2026-08-09'), '2026-08-09');
  assert.equal(extractDateFromTitle('AUR-27 mirror-gap audit for week of 2026-08-12'), null);
  assert.equal(extractDateFromTitle(undefined), null);
});

test('runIssuesForDate matches by title date, not creation time', () => {
  const issues = [AUR_5422_ISSUE, AUR_5123_ISSUE, { id: 'x', title: 'Daily AI opportunity research brief for 2026-08-01' }];
  assert.deepEqual(runIssuesForDate(issues, '2026-08-09'), [AUR_5422_ISSUE]);
  assert.deepEqual(runIssuesForDate(issues, '2026-08-31'), []);
});

// ── largestCommentAcrossBundles / classifyDayCoverage ────────────────────────

test('largestCommentAcrossBundles finds the max across multiple matched issues', () => {
  const bundles = [
    { issue: AUR_5422_ISSUE, comments: AUR_5422_COMMENTS },
    { issue: AUR_5123_ISSUE, comments: AUR_5123_COMMENTS },
  ];
  const best = largestCommentAcrossBundles(bundles);
  assert.equal(best.chars, 16311);
  assert.equal(best.issueIdentifier, 'AUR-5123');
  assert.equal(best.commentId, '41b34007-5f36-42ce-8bd4-645adfd4ffa8');
});

test('MUST FIRE: 2026-08-09 (AUR-5422) classifies FIRED_NO_BRIEF — largest comment 755ch, under threshold', () => {
  const bundles = [{ issue: AUR_5422_ISSUE, comments: AUR_5422_COMMENTS }];
  const coverage = classifyDayCoverage({ date: '2026-08-09', matchedIssues: [AUR_5422_ISSUE], bundles });
  assert.equal(coverage.status, 'FIRED_NO_BRIEF');
  assert.equal(coverage.healthy, false);
  assert.equal(coverage.largest.chars, 755);
  assert.ok(coverage.largest.chars < MIN_COMMENT_CHARS);
});

test('MUST PASS: 2026-08-06 (AUR-5123) classifies HEALTHY — largest comment 16,311ch, comment 41b34007', () => {
  const bundles = [{ issue: AUR_5123_ISSUE, comments: AUR_5123_COMMENTS }];
  const coverage = classifyDayCoverage({ date: '2026-08-06', matchedIssues: [AUR_5123_ISSUE], bundles });
  assert.equal(coverage.status, 'HEALTHY');
  assert.equal(coverage.healthy, true);
  assert.equal(coverage.largest.chars, 16311);
  assert.equal(coverage.largest.commentId, '41b34007-5f36-42ce-8bd4-645adfd4ffa8');
});

test('classifyDayCoverage reports NO_RUN_ISSUE distinctly from FIRED_NO_BRIEF', () => {
  const coverage = classifyDayCoverage({ date: '2026-09-01', matchedIssues: [], bundles: [] });
  assert.equal(coverage.status, 'NO_RUN_ISSUE');
  assert.equal(coverage.healthy, false);
  assert.equal(coverage.largest.chars, 0);
});

// ── extractFailureReason — must quote verbatim, never guess ─────────────────

test('extractFailureReason prefers an explicit adapter_failed token', () => {
  const bundles = [
    {
      issue: AUR_5422_ISSUE,
      comments: [{ id: 'a', body: 'system: adapter_failed — quota exceeded' }, { id: 'b', body: 'Cancelled. Reason: unrelated.' }],
    },
  ];
  const reason = extractFailureReason(bundles);
  assert.equal(reason.rule, 'adapter_failed');
  assert.equal(reason.comment.id, 'a');
});

test('extractFailureReason falls back to a cancellation comment stating a Reason (AUR-5422 real shape)', () => {
  const bundles = [{ issue: AUR_5422_ISSUE, comments: AUR_5422_COMMENTS }];
  const reason = extractFailureReason(bundles);
  assert.equal(reason.rule, 'cancellation-reason');
  assert.equal(reason.comment.id, '2c766d75-7ea1-4447-bb77-abd5752f457c');
  // Verbatim — the exact body text must be quotable unmodified.
  assert.match(reason.comment.body, /adapter quota pause/);
});

test('extractFailureReason returns null when nothing to quote', () => {
  const bundles = [{ issue: AUR_5123_ISSUE, comments: AUR_5123_COMMENTS }];
  assert.equal(extractFailureReason(bundles), null);
});

// ── The two mandated controls, through the exact classify path ──────────────

test('controlVerdict: AUR-5422 fixture behaves as the FIRE control expects', () => {
  const control = CONTROLS.find((c) => c.date === '2026-08-09');
  const bundles = [{ issue: AUR_5422_ISSUE, comments: AUR_5422_COMMENTS }];
  const coverage = classifyDayCoverage({ date: control.date, matchedIssues: [AUR_5422_ISSUE], bundles });
  const reason = extractFailureReason(bundles);
  assert.equal(controlVerdict(control, coverage, reason), null);
});

test('controlVerdict: AUR-5123 fixture behaves as the PASS control expects', () => {
  const control = CONTROLS.find((c) => c.date === '2026-08-06');
  const bundles = [{ issue: AUR_5123_ISSUE, comments: AUR_5123_COMMENTS }];
  const coverage = classifyDayCoverage({ date: control.date, matchedIssues: [AUR_5123_ISSUE], bundles });
  const reason = extractFailureReason(bundles);
  assert.equal(controlVerdict(control, coverage, reason), null);
});

test('controlVerdict flags a regression when a control stops matching expectations', () => {
  const control = { date: '2026-08-09', mustBeHealthy: false, mustHaveReason: true, note: 'x' };
  const wronglyHealthy = { status: 'HEALTHY', healthy: true, largest: { chars: 5000 } };
  assert.match(controlVerdict(control, wronglyHealthy, null), /classified HEALTHY, expected dark/);

  const darkNoReason = { status: 'FIRED_NO_BRIEF', healthy: false, largest: { chars: 100 } };
  assert.match(controlVerdict(control, darkNoReason, null), /found no quotable/);
});

// ── shiftDate / computeDarkStreak — recomputed fresh, no persisted state ────

test('shiftDate walks calendar days across month/year boundaries', () => {
  assert.equal(shiftDate('2026-08-09', -1), '2026-08-08');
  assert.equal(shiftDate('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
});

test('computeDarkStreak walks backward until a HEALTHY day and stops', async () => {
  const coverageByDate = {
    '2026-08-11': { date: '2026-08-11', healthy: false, status: 'FIRED_NO_BRIEF' },
    '2026-08-10': { date: '2026-08-10', healthy: false, status: 'NO_RUN_ISSUE' },
    '2026-08-09': { date: '2026-08-09', healthy: false, status: 'FIRED_NO_BRIEF' },
    '2026-08-08': { date: '2026-08-08', healthy: true, status: 'HEALTHY' },
  };
  const streak = await computeDarkStreak('2026-08-11', async (d) => coverageByDate[d]);
  assert.equal(streak.length, 3);
  assert.deepEqual(streak.map((d) => d.date), ['2026-08-11', '2026-08-10', '2026-08-09']);
});

test('computeDarkStreak returns empty when the target date itself is healthy', async () => {
  const streak = await computeDarkStreak('2026-08-06', async () => ({ date: '2026-08-06', healthy: true }));
  assert.equal(streak.length, 0);
});

test('DARK_DAY_ALARM_THRESHOLD is 2 — one dark day is noise, two is a pattern', () => {
  assert.equal(DARK_DAY_ALARM_THRESHOLD, 2);
});

test('ALARM_TITLE is a stable string usable for dedup search', () => {
  assert.equal(typeof ALARM_TITLE, 'string');
  assert.ok(ALARM_TITLE.length > 0);
});
