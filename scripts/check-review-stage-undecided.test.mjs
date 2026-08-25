import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageIsUndecided,
  activityOpensCurrentStage,
  resolveStageOpenedAt,
  latestParticipantComment,
  evaluateIssue,
  commentAuthorKey,
  nudgeMarker,
  buildNudgeBody,
  DEFAULT_MIN_AGE_HOURS,
} from './check-review-stage-undecided.mjs';

// ── Fixture builders ──────────────────────────────────────────────────────────

const STAGE_ID = 'stage-review-1';
const REVIEWER_AGENT_ID = 'agent-reviewer';
const EXECUTOR_AGENT_ID = 'agent-executor';
const DECISION_ID = 'decision-abc';

function undecidedReviewState(overrides = {}) {
  return {
    status: 'pending',
    currentStageId: STAGE_ID,
    currentStageIndex: 0,
    currentStageType: 'review',
    currentParticipant: { type: 'agent', agentId: REVIEWER_AGENT_ID },
    returnAssignee: { type: 'agent', agentId: EXECUTOR_AGENT_ID },
    lastDecisionId: null,
    lastDecisionOutcome: null,
    completedStageIds: [],
    reviewRequest: null,
    monitor: null,
    ...overrides,
  };
}

function issueFixture(overrides = {}) {
  return {
    id: 'issue-1',
    identifier: 'AUR-9001',
    status: 'in_review',
    executionState: undecidedReviewState(),
    ...overrides,
  };
}

function comment({ agentId, createdAt, body = 'looks good to me' }) {
  return { id: `c-${createdAt}`, authorAgentId: agentId, createdAt, body };
}

/** A real-shaped `issue.updated` activity row (fields trimmed to what the detector reads). */
function activityRow({ createdAt, executionState, previousExecutionState }) {
  return {
    action: 'issue.updated',
    entityType: 'issue',
    createdAt,
    details: {
      executionState,
      _previous: { executionState: previousExecutionState ?? null },
    },
  };
}

// ── stageIsUndecided ──────────────────────────────────────────────────────────

test('stageIsUndecided: flags a pending review stage with no decision', () => {
  const verdict = stageIsUndecided(issueFixture());
  assert.equal(verdict.undecided, true);
  assert.equal(verdict.stageId, STAGE_ID);
  assert.equal(verdict.participant, `agent:${REVIEWER_AGENT_ID}`);
});

test('stageIsUndecided: also matches the changes_requested outcome signature', () => {
  const verdict = stageIsUndecided(
    issueFixture({ executionState: undecidedReviewState({ lastDecisionOutcome: 'changes_requested', lastDecisionId: DECISION_ID }) }),
  );
  assert.equal(verdict.undecided, true);
});

test('stageIsUndecided: silent when an approval is on record', () => {
  const verdict = stageIsUndecided(
    issueFixture({ executionState: undecidedReviewState({ status: 'approved', lastDecisionOutcome: 'approved' }) }),
  );
  assert.equal(verdict.undecided, false);
});

test('stageIsUndecided: silent when stage already completed', () => {
  const verdict = stageIsUndecided(
    issueFixture({ executionState: undecidedReviewState({ completedStageIds: [STAGE_ID] }) }),
  );
  assert.equal(verdict.undecided, false);
  assert.equal(verdict.reason, 'stage-already-completed');
});

test('stageIsUndecided: silent on wrong stage type / missing execution state', () => {
  assert.equal(stageIsUndecided(issueFixture({ executionState: undecidedReviewState({ currentStageType: 'implementation' }) })).undecided, false);
  assert.equal(stageIsUndecided(issueFixture({ executionState: null })).undecided, false);
});

// ── activityOpensCurrentStage / resolveStageOpenedAt — REAL shapes ────────────
//
// Row shapes below are transcribed from real activity feed data pulled for
// AUR-5053 (single stage open, never reopened) and AUR-6145 (a genuine
// changes-requested -> resubmit -> re-review cycle), captured live against
// the running control plane during this issue's investigation. Field names
// and value shapes are copied verbatim; only ids/timestamps are relabeled to
// this suite's fixtures.

test('resolveStageOpenedAt: first-round open — _previous.executionState is null (AUR-5053 shape)', () => {
  const issue = issueFixture();
  const activity = [
    activityRow({
      createdAt: '2026-08-01T00:00:00.000Z',
      executionState: undecidedReviewState(),
      previousExecutionState: null,
    }),
  ];
  const bound = resolveStageOpenedAt(issue, { activity });
  assert.equal(bound.reason, 'resolved');
  assert.equal(bound.boundAt, '2026-08-01T00:00:00.000Z');
});

test('resolveStageOpenedAt: an unrelated status flip with an already-pending stage does NOT count (real AUR-5053 restore row)', () => {
  const issue = issueFixture();
  const activity = [
    // The genuine stage-open row.
    activityRow({
      createdAt: '2026-08-01T00:00:00.000Z',
      executionState: undecidedReviewState(),
      previousExecutionState: null,
    }),
    // A later no-op replay: issue was cancelled and restored to in_review;
    // executionState.status was "pending" before AND after — this must NOT
    // read as a fresh stage-open, or every unrelated restore would reset the
    // clock and mask a genuinely stale stage.
    activityRow({
      createdAt: '2026-08-05T00:00:00.000Z',
      executionState: undecidedReviewState(),
      previousExecutionState: undecidedReviewState(),
    }),
  ];
  const bound = resolveStageOpenedAt(issue, { activity });
  assert.equal(bound.boundAt, '2026-08-01T00:00:00.000Z', 'must resolve to the real open, not the no-op restore');
});

test('resolveStageOpenedAt: resubmit-after-changes-requested reopens the SAME stage (real AUR-6145 shape)', () => {
  const issue = issueFixture({
    executionState: undecidedReviewState({
      // lastDecisionOutcome/lastDecisionId are CARRIED FORWARD unchanged from
      // the prior round — verified against real AUR-6145 data. A design that
      // expects this to reset to null (as floated in AUR-4702's write-up)
      // would never resolve a bound for a resubmitted stage.
      lastDecisionId: DECISION_ID,
      lastDecisionOutcome: 'changes_requested',
    }),
  });
  const activity = [
    // Round 2 opens: status flips changes_requested -> pending, same stage id,
    // decision fields unchanged.
    activityRow({
      createdAt: '2026-08-25T09:10:21.339Z',
      executionState: undecidedReviewState({ lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
      previousExecutionState: undecidedReviewState({
        status: 'changes_requested',
        lastDecisionId: DECISION_ID,
        lastDecisionOutcome: 'changes_requested',
      }),
    }),
    // The changes-requested decision itself (round 1 -> decided). Must NOT be
    // read as a stage-open row: its own executionState.status is
    // "changes_requested", not "pending".
    activityRow({
      createdAt: '2026-08-25T08:57:49.684Z',
      executionState: undecidedReviewState({ status: 'changes_requested', lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
      previousExecutionState: undecidedReviewState({ lastDecisionId: null, lastDecisionOutcome: null }),
    }),
    // Round 1 opens.
    activityRow({
      createdAt: '2026-08-25T08:50:03.786Z',
      executionState: undecidedReviewState({ lastDecisionId: null, lastDecisionOutcome: null }),
      previousExecutionState: null,
    }),
  ];
  const bound = resolveStageOpenedAt(issue, { activity });
  assert.equal(bound.reason, 'resolved');
  assert.equal(bound.boundAt, '2026-08-25T09:10:21.339Z', 'must resolve to the resubmit reopen, not round 1');
});

test('resolveStageOpenedAt: a different prior stage id counts as a fresh open', () => {
  const issue = issueFixture();
  const activity = [
    activityRow({
      createdAt: '2026-08-10T00:00:00.000Z',
      executionState: undecidedReviewState(),
      previousExecutionState: undecidedReviewState({ status: 'pending', currentStageId: 'stage-review-0' }),
    }),
  ];
  const bound = resolveStageOpenedAt(issue, { activity });
  assert.equal(bound.boundAt, '2026-08-10T00:00:00.000Z');
});

test('resolveStageOpenedAt: fails CLOSED — empty activity feed', () => {
  const bound = resolveStageOpenedAt(issueFixture(), { activity: [] });
  assert.equal(bound.boundAt, null);
  assert.equal(bound.reason, 'no-activity-rows');
});

test('resolveStageOpenedAt: fails CLOSED — activity has rows but none open the current stage', () => {
  const activity = [
    activityRow({
      createdAt: '2026-08-10T00:00:00.000Z',
      executionState: undecidedReviewState({ status: 'changes_requested' }),
      previousExecutionState: undecidedReviewState({ lastDecisionOutcome: null }),
    }),
  ];
  const bound = resolveStageOpenedAt(issueFixture(), { activity });
  assert.equal(bound.boundAt, null);
  assert.equal(bound.reason, 'stage-open-transition-not-found-in-activity');
});

test('resolveStageOpenedAt: fails CLOSED — no current stage id on the issue', () => {
  const issue = issueFixture({ executionState: undecidedReviewState({ currentStageId: null }) });
  const bound = resolveStageOpenedAt(issue, { activity: [{ action: 'issue.updated' }] });
  assert.equal(bound.boundAt, null);
  assert.equal(bound.reason, 'no-current-stage-id');
});

test('activityOpensCurrentStage: ignores non-issue.updated rows', () => {
  assert.equal(activityOpensCurrentStage({ action: 'issue.comment_added' }, STAGE_ID), false);
});

// ── evaluateIssue: the core discrimination — bound-gated, not "ever spoke" ────

const ROUND1_OPEN = activityRow({
  createdAt: '2026-08-01T00:00:00.000Z',
  executionState: undecidedReviewState({ lastDecisionId: null, lastDecisionOutcome: null }),
  previousExecutionState: null,
});
const ROUND1_CHANGES_REQUESTED = activityRow({
  createdAt: '2026-08-01T01:00:00.000Z',
  executionState: undecidedReviewState({ status: 'changes_requested', lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
  previousExecutionState: undecidedReviewState({ lastDecisionId: null, lastDecisionOutcome: null }),
});
const ROUND2_REOPEN = activityRow({
  createdAt: '2026-08-01T02:00:00.000Z',
  executionState: undecidedReviewState({ lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
  previousExecutionState: undecidedReviewState({ status: 'changes_requested', lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
});

const RESUBMITTED_ISSUE = issueFixture({
  executionState: undecidedReviewState({ lastDecisionId: DECISION_ID, lastDecisionOutcome: 'changes_requested' }),
});
const RESUBMIT_ACTIVITY = [ROUND2_REOPEN, ROUND1_CHANGES_REQUESTED, ROUND1_OPEN];

test('evaluateIssue: FALSE POSITIVE FIXED — reviewer\'s stale round-1 comment does NOT flag after a resubmit reopens the stage', () => {
  // This is the exact defect: without a real bound, the reviewer's old
  // "changes requested" comment (authored during round 1, well before the
  // round-2 reopen) would satisfy a degraded "ever spoke while in_review"
  // fallback. With the real bound (the round-2 reopen timestamp), this
  // comment predates the bound and must not count.
  const comments = [
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T00:30:00.000Z', body: 'Changes requested: fix the null check.' }),
  ];
  const now = new Date('2026-09-01T00:00:00.000Z'); // comment is >24h old — age gate is NOT what saves this case
  const result = evaluateIssue({ issue: RESUBMITTED_ISSUE, comments, activity: RESUBMIT_ACTIVITY, now });
  assert.equal(result.flagged, false);
  assert.equal(result.reason, 'participant-silent');
});

test('evaluateIssue: CONTROL — same reopened stage, but the reviewer speaks AFTER the reopen and goes stale — DOES flag', () => {
  // Proves the check discriminates in both directions off the SAME
  // reopened-stage setup as the false-positive case above: only the
  // comment's position relative to the real bound differs.
  const comments = [
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T00:30:00.000Z', body: 'Changes requested: fix the null check.' }),
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T03:00:00.000Z', body: 'looks fine now' }),
  ];
  const now = new Date('2026-08-05T00:00:00.000Z'); // ~93h after the 2nd comment — past the 24h default
  const result = evaluateIssue({ issue: RESUBMITTED_ISSUE, comments, activity: RESUBMIT_ACTIVITY, now });
  assert.equal(result.flagged, true);
  assert.equal(result.reason, 'participant-spoke-but-recorded-no-decision');
  assert.equal(result.comment.createdAt, '2026-08-01T03:00:00.000Z');
});

test('evaluateIssue: fresh single-round stage, participant spoke long ago and never decided — flags (AUR-3233 shape)', () => {
  const comments = [comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T05:00:00.000Z' })];
  const now = new Date('2026-08-15T00:00:00.000Z');
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [ROUND1_OPEN], now });
  assert.equal(result.flagged, true);
  assert.equal(result.ageHours > DEFAULT_MIN_AGE_HOURS, true);
});

test('evaluateIssue: participant spoke too recently — silent (age gate)', () => {
  const now = new Date('2026-08-01T01:00:00.000Z');
  const comments = [comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T00:30:00.000Z' })];
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [ROUND1_OPEN], now, minAgeHours: 24 });
  assert.equal(result.flagged, false);
  assert.equal(result.reason, 'participant-spoke-recently');
});

test('evaluateIssue: only the EXECUTOR spoke — silent (identical executionState to the true positive)', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');
  const comments = [comment({ agentId: EXECUTOR_AGENT_ID, createdAt: '2026-08-01T05:00:00.000Z' })];
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [ROUND1_OPEN], now });
  assert.equal(result.flagged, false);
  assert.equal(result.reason, 'participant-silent');
});

test('evaluateIssue: FAIL CLOSED — bound cannot be resolved, never falls back to "ever spoke"', () => {
  const comments = [comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2020-01-01T00:00:00.000Z' })];
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [], now: new Date('2026-08-15T00:00:00.000Z') });
  assert.equal(result.flagged, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'bound-unresolved:no-activity-rows');
});

test('evaluateIssue: sentiment-independence — an approval-sounding comment still flags; the defect is the missing decision, not the words', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');
  const comments = [comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T05:00:00.000Z', body: 'LGTM, approved!' })];
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [ROUND1_OPEN], now });
  assert.equal(result.flagged, true);
});

test('evaluateIssue: already-nudged dedup is keyed per stageId', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');
  const comments = [
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T05:00:00.000Z' }),
    { id: 'nudge-1', authorAgentId: 'watchdog-bot', createdAt: '2026-08-10T00:00:00.000Z', body: nudgeMarker(STAGE_ID) },
  ];
  const result = evaluateIssue({ issue: issueFixture(), comments, activity: [ROUND1_OPEN], now });
  assert.equal(result.flagged, true);
  assert.equal(result.alreadyNudged, true);
});

// ── commentAuthorKey / principal identity ─────────────────────────────────────

test('commentAuthorKey: resolves agent and user authors', () => {
  assert.equal(commentAuthorKey({ authorAgentId: 'a1' }), 'agent:a1');
  assert.equal(commentAuthorKey({ authorUserId: 'u1' }), 'user:u1');
  assert.equal(commentAuthorKey({}), null);
  assert.equal(commentAuthorKey(null), null);
});

test('latestParticipantComment: returns the newest qualifying comment, not the oldest', () => {
  const comments = [
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-01T00:00:00.000Z' }),
    comment({ agentId: REVIEWER_AGENT_ID, createdAt: '2026-08-03T00:00:00.000Z' }),
    comment({ agentId: EXECUTOR_AGENT_ID, createdAt: '2026-08-04T00:00:00.000Z' }),
  ];
  const newest = latestParticipantComment(comments, `agent:${REVIEWER_AGENT_ID}`, 0);
  assert.equal(newest.createdAt, '2026-08-03T00:00:00.000Z');
});

// ── buildNudgeBody / nudgeMarker ───────────────────────────────────────────────

test('buildNudgeBody: embeds the marker and names both valid actions', () => {
  const body = buildNudgeBody({ issueId: 'AUR-1', stageId: STAGE_ID, participant: `agent:${REVIEWER_AGENT_ID}`, ageHours: 30 });
  assert.ok(body.includes(nudgeMarker(STAGE_ID)));
  assert.ok(body.includes('status":"done"'));
  assert.ok(body.includes('status":"in_progress"'));
});
