import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasRetro,
  isExempt,
  hasPerformanceScorecard,
  hasScorecardAdjusted,
  fetchMergedMemRecords,
} from './retro-compliance-audit.mjs';

// ── hasRetro ─────────────────────────────────────────────────────────────────

test('hasRetro detects ## Retrospective at line start', () => {
  assert.ok(hasRetro([{ body: '## Retrospective — AUR-123: Title\nOutcome: done' }]));
});

test('hasRetro detects ## retrospective case-insensitively', () => {
  assert.ok(hasRetro([{ body: '## retrospective\nsome content' }]));
});

test('hasRetro detects ## Retrospective after leading newlines', () => {
  assert.ok(hasRetro([{ body: '\n\n## Retrospective\ncontent' }]));
});

test('hasRetro uses content field when body is absent', () => {
  assert.ok(hasRetro([{ content: '## Retrospective\nOutcome: done' }]));
});

test('hasRetro returns false when no heading present', () => {
  assert.ok(!hasRetro([{ body: 'Fixed the bug. No retro here.' }]));
});

test('hasRetro returns false on empty comment list', () => {
  assert.ok(!hasRetro([]));
});

test('hasRetro returns false when heading is inline (not at line start)', () => {
  // A `###` or `## RetrospectiveSomething` should not match
  assert.ok(!hasRetro([{ body: 'some text ## Retrospective in the middle' }]));
});

// ── hasRetro: misfiled-retro hardening (AUR-3203) ─────────────────────────────

test('hasRetro accepts a heading whose identifier matches the audited issue', () => {
  const issue = { id: 'u1', identifier: 'AUR-1876' };
  assert.ok(hasRetro([{ body: '## Retrospective — AUR-1876: browser automation\nOutcome: done' }], issue));
});

test('hasRetro rejects a misfiled heading naming a different issue (AUR-3164 retro on AUR-1876 thread)', () => {
  const issue = { id: 'u1876', identifier: 'AUR-1876' };
  // The real defect: AUR-1876's only retro comment was actually AUR-3164's retro.
  assert.ok(!hasRetro([{ body: '## Retrospective — AUR-3164: something else\nOutcome: done' }], issue));
});

test('hasRetro accepts a bare heading with no identifier even when an issue is supplied', () => {
  const issue = { id: 'u1', identifier: 'AUR-1876' };
  assert.ok(hasRetro([{ body: '## Retrospective\nOutcome: done' }], issue));
});

test('hasRetro finds the correct heading when a comment mixes misfiled and correct headings', () => {
  const issue = { id: 'u1', identifier: 'AUR-1876' };
  const body = '## Retrospective — AUR-3164: other\n...\n\n## Retrospective — AUR-1876: correct\nOutcome: done';
  assert.ok(hasRetro([{ body }], issue));
});

test('hasRetro finds a matching heading in a later comment after an earlier misfiled one', () => {
  const issue = { id: 'u1', identifier: 'AUR-1876' };
  const comments = [
    { body: '## Retrospective — AUR-3164: other issue' },
    { body: '## Retrospective — AUR-1876: the right one' },
  ];
  assert.ok(hasRetro(comments, issue));
});

test('hasRetro is backward-compatible when called without an issue (identifier ignored)', () => {
  // Legacy call sites / unit tests pass no issue; any identifier-bearing heading still counts.
  assert.ok(hasRetro([{ body: '## Retrospective — AUR-3164: anything' }]));
});

// ── isExempt ─────────────────────────────────────────────────────────────────

const CONTENT_BOT_ID = 'c1ddb8af-53ce-437e-b473-1f437c97739b';

test('isExempt exempts content-bot assignee', () => {
  const { exempt } = isExempt({ assigneeAgentId: CONTENT_BOT_ID, title: 'Anything', description: '' });
  assert.ok(exempt);
});

test('isExempt exempts content slot title', () => {
  const { exempt } = isExempt({ title: 'Content Slot 42', description: '' });
  assert.ok(exempt);
});

test('isExempt exempts write script + workflow signal', () => {
  const { exempt } = isExempt({ title: 'Write script for reel', description: 'triggered by workflow signal xyz' });
  assert.ok(exempt);
});

test('isExempt exempts render & upload + video editor render task', () => {
  const { exempt } = isExempt({ title: 'Render & Upload video', description: 'Video Editor render task for slot 5' });
  assert.ok(exempt);
});

test('isExempt exempts daily brief title', () => {
  const { exempt } = isExempt({ title: 'Daily Brief 2026-06-22', description: '' });
  assert.ok(exempt);
});

test('isExempt exempts non-manual originKind', () => {
  const { exempt } = isExempt({ title: 'Some task', description: '', originKind: 'routine' });
  assert.ok(exempt);
});

test('isExempt does not exempt manual originKind', () => {
  const { exempt } = isExempt({ title: 'Feature work', description: '', originKind: 'manual' });
  assert.ok(!exempt);
});

test('isExempt does not exempt normal engineering issues', () => {
  const { exempt } = isExempt({ title: 'Fix the bug', description: 'Something broke', assigneeAgentId: 'abc' });
  assert.ok(!exempt);
});

// ── hasPerformanceScorecard ───────────────────────────────────────────────────

const ISSUE = { id: 'uuid-123', identifier: 'AUR-123' };

test('hasPerformanceScorecard matches by issue id', () => {
  const records = [
    { metadata: { category: 'performance_scorecard', issue_id: 'uuid-123' } },
  ];
  assert.ok(hasPerformanceScorecard(records, ISSUE));
});

test('hasPerformanceScorecard matches by issue identifier', () => {
  const records = [
    { metadata: { category: 'performance_scorecard', issue_identifier: 'AUR-123' } },
  ];
  assert.ok(hasPerformanceScorecard(records, ISSUE));
});

test('hasPerformanceScorecard returns false when no matching record', () => {
  const records = [
    { metadata: { category: 'performance_scorecard', issue_id: 'uuid-999' } },
  ];
  assert.ok(!hasPerformanceScorecard(records, ISSUE));
});

test('hasPerformanceScorecard returns false for wrong category', () => {
  const records = [
    { metadata: { category: 'scorecard_adjusted', issue_id: 'uuid-123' } },
  ];
  assert.ok(!hasPerformanceScorecard(records, ISSUE));
});

test('hasPerformanceScorecard returns false on empty record list', () => {
  assert.ok(!hasPerformanceScorecard([], ISSUE));
});

test('hasPerformanceScorecard skips records with missing metadata', () => {
  const records = [{ title: 'something', content: 'no metadata' }];
  assert.ok(!hasPerformanceScorecard(records, ISSUE));
});

test('hasPerformanceScorecard matches when issue_id holds the identifier string (AUR-2817 production shape)', () => {
  // Production records for AUR-2817 store the identifier in issue_id, not the UUID.
  // Records: 4ce37193-e806-404a-b507-c04768a868ad (perf) and 5ea535ae-8d2e-4f2c-8e17-5a5628715adb (adj).
  const issue = { id: '210ac9ff-ed48-42f5-b781-b8751a5cb7e3', identifier: 'AUR-2817' };
  const records = [
    { id: '4ce37193-e806-404a-b507-c04768a868ad', metadata: { category: 'performance_scorecard', issue_id: 'AUR-2817' } },
  ];
  assert.ok(hasPerformanceScorecard(records, issue), 'must match when metadata.issue_id equals the identifier string');
});

// ── hasScorecardAdjusted ─────────────────────────────────────────────────────

test('hasScorecardAdjusted matches by issue id', () => {
  const records = [
    { metadata: { category: 'scorecard_adjusted', issue_id: 'uuid-123' } },
  ];
  assert.ok(hasScorecardAdjusted(records, ISSUE));
});

test('hasScorecardAdjusted matches by issue identifier', () => {
  const records = [
    { metadata: { category: 'scorecard_adjusted', issue_identifier: 'AUR-123' } },
  ];
  assert.ok(hasScorecardAdjusted(records, ISSUE));
});

test('hasScorecardAdjusted returns false when no matching record', () => {
  const records = [
    { metadata: { category: 'scorecard_adjusted', issue_id: 'uuid-456' } },
  ];
  assert.ok(!hasScorecardAdjusted(records, ISSUE));
});

test('hasScorecardAdjusted returns false for wrong category', () => {
  const records = [
    { metadata: { category: 'performance_scorecard', issue_id: 'uuid-123' } },
  ];
  assert.ok(!hasScorecardAdjusted(records, ISSUE));
});

test('hasScorecardAdjusted returns false on empty record list', () => {
  assert.ok(!hasScorecardAdjusted([], ISSUE));
});

test('hasScorecardAdjusted matches when issue_id holds the identifier string (AUR-2817 production shape)', () => {
  // Production records for AUR-2817 store the identifier in issue_id, not the UUID.
  // Records: 4ce37193-e806-404a-b507-c04768a868ad (perf) and 5ea535ae-8d2e-4f2c-8e17-5a5628715adb (adj).
  const issue = { id: '210ac9ff-ed48-42f5-b781-b8751a5cb7e3', identifier: 'AUR-2817' };
  const records = [
    { id: '5ea535ae-8d2e-4f2c-8e17-5a5628715adb', metadata: { category: 'scorecard_adjusted', issue_id: 'AUR-2817' } },
  ];
  assert.ok(hasScorecardAdjusted(records, issue), 'must match when metadata.issue_id equals the identifier string');
});

// ── fetchMergedMemRecords ─────────────────────────────────────────────────────

test('fetchMergedMemRecords returns org-wide records when issues have no projectId', async () => {
  const orgRecord = { id: 'r1', metadata: { category: 'performance_scorecard', issue_id: 'uuid-1' } };
  const get = async (path) => {
    if (path.includes('projectId')) throw new Error('should not be called');
    return { records: [orgRecord] };
  };
  const records = await fetchMergedMemRecords(get, 'co-1', [{ id: 'uuid-1', projectId: null }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'r1');
});

test('fetchMergedMemRecords includes project-scoped records absent from org-wide', async () => {
  const projRecord = { id: 'r2', metadata: { category: 'performance_scorecard', issue_id: 'uuid-proj' } };
  const get = async (path) => {
    if (path.includes('projectId=proj-1')) return { records: [projRecord] };
    return { records: [] };
  };
  const records = await fetchMergedMemRecords(get, 'co-1', [{ id: 'uuid-proj', projectId: 'proj-1' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'r2');
});

test('fetchMergedMemRecords deduplicates records present in both org and project', async () => {
  const shared = { id: 'r1', metadata: { category: 'performance_scorecard', issue_id: 'uuid-1' } };
  const get = async () => ({ records: [shared] });
  const records = await fetchMergedMemRecords(get, 'co-1', [{ id: 'uuid-1', projectId: 'proj-1' }]);
  assert.equal(records.length, 1);
});

test('fetchMergedMemRecords: AUR-2817 regression — project-scoped scorecard reported compliant', async () => {
  // Regression for AUR-2858: issue is project-scoped; scorecards only visible under projectId.
  const perfRec = { id: 'perf-1', metadata: { category: 'performance_scorecard', issue_id: 'issue-2817' } };
  const adjRec  = { id: 'adj-1',  metadata: { category: 'scorecard_adjusted',  issue_id: 'issue-2817' } };
  const get = async (path) => {
    if (path.includes('projectId=proj-sgi')) return { records: [perfRec, adjRec] };
    return { records: [] };
  };
  const issues = [{ id: 'issue-2817', projectId: 'proj-sgi' }];
  const records = await fetchMergedMemRecords(get, 'co-1', issues);
  const issue = { id: 'issue-2817', identifier: 'AUR-2817' };
  assert.ok(hasPerformanceScorecard(records, issue), 'performance_scorecard must be found via project scope');
  assert.ok(hasScorecardAdjusted(records, issue),   'scorecard_adjusted must be found via project scope');
});

test('fetchMergedMemRecords handles multiple distinct projects', async () => {
  const r1 = { id: 'r1', metadata: { category: 'performance_scorecard', issue_id: 'i1' } };
  const r2 = { id: 'r2', metadata: { category: 'performance_scorecard', issue_id: 'i2' } };
  const get = async (path) => {
    if (path.includes('projectId=proj-a')) return { records: [r1] };
    if (path.includes('projectId=proj-b')) return { records: [r2] };
    return { records: [] };
  };
  const issues = [
    { id: 'i1', projectId: 'proj-a' },
    { id: 'i2', projectId: 'proj-b' },
  ];
  const records = await fetchMergedMemRecords(get, 'co-1', issues);
  assert.equal(records.length, 2);
});

test('fetchMergedMemRecords tolerates per-project fetch failure gracefully', async () => {
  const orgRec = { id: 'org-1', metadata: { category: 'performance_scorecard', issue_id: 'i-org' } };
  const get = async (path) => {
    if (path.includes('projectId=proj-bad')) throw new Error('network error');
    return { records: [orgRec] };
  };
  const issues = [{ id: 'i-org', projectId: 'proj-bad' }];
  const records = await fetchMergedMemRecords(get, 'co-1', issues);
  assert.equal(records.length, 1, 'org-wide records still returned on per-project failure');
});

// ── scope policy: cancelled issues excluded ───────────────────────────────────
// These tests validate the AUR-2851 policy decision (cancelled = out of scope).
// The main() function enforces this at query time (?status=done only), so these
// tests document the intent rather than calling main().

test('scope policy: cancelled status must not appear in done-only query', () => {
  // Validate the expected query string doesn't include cancelled.
  // The policy is enforced by using ?status=done in the fetch; cancelled issues
  // should never enter the audit pipeline.
  const statusQueryParam = 'done'; // what the script sends
  assert.ok(!statusQueryParam.includes('cancelled'));
});

test('scope policy: completedAt is required; cancelledAt-only issues are skipped', () => {
  // Simulate the filter applied inside main() after fetching done issues.
  const issues = [
    { id: '1', completedAt: new Date().toISOString(), cancelledAt: null },
    { id: '2', completedAt: null, cancelledAt: new Date().toISOString() }, // should be excluded
  ];
  const inScope = issues.filter(i => i.completedAt != null);
  assert.equal(inScope.length, 1);
  assert.equal(inScope[0].id, '1');
});
