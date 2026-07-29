import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MIN_AGE_HOURS,
  buildNudgeBody,
  evaluateIssue,
  nudgeMarker,
  participantSpokeSinceStageOpened,
  resolveStageOpenedAt,
  stageIsUndecided,
} from "./check-review-stage-undecided.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// The whole point of this suite: the TRUE POSITIVE and CONTROLS 1 & 2 share a
// byte-identical `executionState`. Stage state alone is NOT discriminating —
// only "the current participant spoke and recorded nothing" is. If the detector
// ever keys on stage state alone, controls 1 and 2 go red.

const NOW = new Date("2026-07-29T12:00:00.000Z");
const DAYS_10_AGO = new Date("2026-07-19T12:00:00.000Z").toISOString();
const HOURS_2_AGO = new Date("2026-07-29T10:00:00.000Z").toISOString();

const STAGE_ID = "fec89de6-6a5a-4f2b-9a2c-8b0b8b8a1d47";
const PARTICIPANT_AGENT_ID = "371a1b08-0286-4a12-a516-f587f42df5eb"; // reviewer
const EXECUTOR_A = "9c1e4a70-5c37-4d31-9b0a-2f4d6c7e1a55"; // AUR-4093 executor
const EXECUTOR_B = "b7d0f2c9-8e11-4a63-8d55-1c9a3e6f4b20"; // AUR-4035 executor

/**
 * The live AUR-3233 executionState signature: pending review stage, stage not
 * in completedStageIds, NO decision ever recorded (`lastDecisionOutcome: null`).
 */
function undecidedReviewState(overrides = {}) {
  return {
    status: "pending",
    currentStageId: STAGE_ID,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: PARTICIPANT_AGENT_ID },
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    ...overrides,
  };
}

function issueFixture({ identifier, state = undecidedReviewState(), status = "in_review" }) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `${identifier} fixture`,
    status,
    executionState: state,
  };
}

function comment({ authorAgentId, body, createdAt }) {
  return {
    id: `c-${authorAgentId}-${createdAt}`,
    authorType: "agent",
    authorAgentId,
    authorUserId: null,
    body,
    createdAt,
  };
}

// AUR-3233 — reviewer "approved" in prose, never recorded the stage decision.
const TRUE_POSITIVE = {
  issue: issueFixture({ identifier: "AUR-3233" }),
  comments: [
    comment({
      authorAgentId: PARTICIPANT_AGENT_ID,
      body: "## Review decision: APPROVE — merge already landed & verified",
      createdAt: DAYS_10_AGO,
    }),
  ],
};

// AUR-4093 — same stage state, but ONLY the executor has spoken. Reviewer has
// not looked yet. Healthy: must stay silent.
const CONTROL_1 = {
  issue: issueFixture({ identifier: "AUR-4093" }),
  comments: [
    comment({
      authorAgentId: EXECUTOR_A,
      body: "Implementation landed in PR #134. Binding board gate wired, tests green. Handing to review.",
      createdAt: DAYS_10_AGO,
    }),
  ],
};

// AUR-4035 — same again, different executor + body.
const CONTROL_2 = {
  issue: issueFixture({ identifier: "AUR-4035" }),
  comments: [
    comment({
      authorAgentId: EXECUTOR_B,
      body: "Backup retention restore path rebuilt; 3 restores verified end-to-end. Ready for review.",
      createdAt: DAYS_10_AGO,
    }),
  ],
};

// ── The load-bearing discrimination proof ────────────────────────────────────

test("controls 1 and 2 carry a BYTE-IDENTICAL executionState to the true positive", () => {
  const tp = JSON.stringify(TRUE_POSITIVE.issue.executionState);
  assert.equal(JSON.stringify(CONTROL_1.issue.executionState), tp);
  assert.equal(JSON.stringify(CONTROL_2.issue.executionState), tp);

  // ...and the stage-state half of the predicate agrees on all three. Anything
  // that separates them MUST come from the comment authorship, not the state.
  const v = stageIsUndecided(TRUE_POSITIVE.issue);
  assert.equal(v.undecided, true);
  assert.deepEqual(stageIsUndecided(CONTROL_1.issue), v);
  assert.deepEqual(stageIsUndecided(CONTROL_2.issue), v);
});

// ── True positive ────────────────────────────────────────────────────────────

test("TRUE POSITIVE (AUR-3233): participant spoke 10d ago, no decision recorded → FLAG", () => {
  const r = evaluateIssue({ ...TRUE_POSITIVE, now: NOW });
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "participant-spoke-but-recorded-no-decision");
  assert.equal(r.stageId, STAGE_ID);
  assert.equal(r.participant, `agent:${PARTICIPANT_AGENT_ID}`);
  assert.ok(r.ageHours >= 240 - 1, `expected ~240h, got ${r.ageHours}`);
  assert.equal(r.alreadyNudged, false);
});

test("second signature: lastDecisionOutcome 'changes_requested' also FLAGS", () => {
  const issue = issueFixture({
    identifier: "AUR-3233-cr",
    state: undecidedReviewState({
      lastDecisionId: "d-prev-round",
      lastDecisionOutcome: "changes_requested",
    }),
  });
  const r = evaluateIssue({ issue, comments: TRUE_POSITIVE.comments, now: NOW });
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "participant-spoke-but-recorded-no-decision");
  assert.equal(r.stageId, STAGE_ID);
});

test("both undecided signatures are covered — a detector keyed only on 'changes_requested' would miss the live null case", () => {
  const nullCase = evaluateIssue({ ...TRUE_POSITIVE, now: NOW });
  const crCase = evaluateIssue({
    issue: issueFixture({
      identifier: "AUR-3233-cr",
      state: undecidedReviewState({ lastDecisionOutcome: "changes_requested" }),
    }),
    comments: TRUE_POSITIVE.comments,
    now: NOW,
  });
  assert.equal(nullCase.flagged, true);
  assert.equal(crCase.flagged, true);
});

// ── Controls ─────────────────────────────────────────────────────────────────

test("CONTROL 1 (AUR-4093): only the EXECUTOR commented → SILENT", () => {
  const r = evaluateIssue({ ...CONTROL_1, now: NOW });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-silent");
  assert.equal(r.participant, `agent:${PARTICIPANT_AGENT_ID}`);
  assert.equal(participantSpokeSinceStageOpened(CONTROL_1.issue, CONTROL_1.comments), null);
});

test("CONTROL 2 (AUR-4035): different executor / body, still no participant comment → SILENT", () => {
  const r = evaluateIssue({ ...CONTROL_2, now: NOW });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-silent");
  assert.equal(participantSpokeSinceStageOpened(CONTROL_2.issue, CONTROL_2.comments), null);
});

test("CONTROL 3: lastDecisionOutcome 'approved' + stage in completedStageIds → SILENT", () => {
  const issue = issueFixture({
    identifier: "AUR-4171-approved",
    state: undecidedReviewState({
      completedStageIds: [STAGE_ID],
      lastDecisionId: "d-approved",
      lastDecisionOutcome: "approved",
    }),
  });
  const r = evaluateIssue({ issue, comments: TRUE_POSITIVE.comments, now: NOW });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "stage-already-completed");
});

test("CONTROL 3b: 'approved' outcome alone (stage not yet in completedStageIds) → SILENT", () => {
  const issue = issueFixture({
    identifier: "AUR-4171-approved-b",
    state: undecidedReviewState({ lastDecisionId: "d-approved", lastDecisionOutcome: "approved" }),
  });
  const r = evaluateIssue({ issue, comments: TRUE_POSITIVE.comments, now: NOW });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "lastDecisionOutcome=approved");
});

test("CONTROL 4: participant comment newer than --min-age-hours → SILENT", () => {
  const r = evaluateIssue({
    issue: TRUE_POSITIVE.issue,
    comments: [
      comment({
        authorAgentId: PARTICIPANT_AGENT_ID,
        body: "## Review decision: APPROVE — merge already landed & verified",
        createdAt: HOURS_2_AGO,
      }),
    ],
    now: NOW,
    minAgeHours: DEFAULT_MIN_AGE_HOURS,
  });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-spoke-recently");
  assert.ok(r.ageHours < DEFAULT_MIN_AGE_HOURS);
});

test("CONTROL 4b: staleness is measured against the participant's LATEST word", () => {
  // Spoke 10d ago AND 2h ago → actively engaged, nudging would be noise.
  const r = evaluateIssue({
    issue: TRUE_POSITIVE.issue,
    comments: [
      comment({ authorAgentId: PARTICIPANT_AGENT_ID, body: "looking now", createdAt: DAYS_10_AGO }),
      comment({ authorAgentId: PARTICIPANT_AGENT_ID, body: "one more question", createdAt: HOURS_2_AGO }),
    ],
    now: NOW,
  });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-spoke-recently");
});

test("CONTROL 5: non-review stage type and non-pending status → SILENT", () => {
  const codeStage = issueFixture({
    identifier: "AUR-4171-code",
    state: undecidedReviewState({ currentStageType: "execution" }),
  });
  assert.equal(evaluateIssue({ issue: codeStage, comments: TRUE_POSITIVE.comments, now: NOW }).reason,
    "stageType=execution");

  const idle = issueFixture({
    identifier: "AUR-4171-idle",
    state: undecidedReviewState({ status: "idle" }),
  });
  assert.equal(evaluateIssue({ issue: idle, comments: TRUE_POSITIVE.comments, now: NOW }).reason,
    "state.status=idle");

  const noState = issueFixture({ identifier: "AUR-4171-nostate", state: null });
  assert.equal(evaluateIssue({ issue: noState, comments: TRUE_POSITIVE.comments, now: NOW }).reason,
    "no-execution-state");
});

// ── Sentiment independence (the discriminator must be syntactic) ─────────────

test("detection is SYNTACTIC: a participant comment with no approval words still FLAGS", () => {
  const r = evaluateIssue({
    issue: TRUE_POSITIVE.issue,
    comments: [
      comment({
        authorAgentId: PARTICIPANT_AGENT_ID,
        body: "Pulled the branch. Will take another look tomorrow.",
        createdAt: DAYS_10_AGO,
      }),
    ],
    now: NOW,
  });
  assert.equal(r.flagged, true);
});

test("detection is SYNTACTIC: approval-sounding EXECUTOR prose does NOT flag", () => {
  const r = evaluateIssue({
    issue: CONTROL_1.issue,
    comments: [
      comment({
        authorAgentId: EXECUTOR_A,
        body: "## Review decision: APPROVE — merge already landed & verified",
        createdAt: DAYS_10_AGO,
      }),
    ],
    now: NOW,
  });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-silent");
});

// ── Stage-open bound ─────────────────────────────────────────────────────────

test("resolveStageOpenedAt prefers an explicit executionState write time", () => {
  const issue = { ...TRUE_POSITIVE.issue, executionStateUpdatedAt: DAYS_10_AGO };
  assert.equal(resolveStageOpenedAt(issue), DAYS_10_AGO);
});

test("resolveStageOpenedAt falls back to the lastDecisionId decision timestamp", () => {
  const issue = issueFixture({
    identifier: "AUR-4171-bound",
    state: undecidedReviewState({ lastDecisionId: "d1", lastDecisionOutcome: "changes_requested" }),
  });
  assert.equal(
    resolveStageOpenedAt(issue, { decisions: [{ id: "d1", createdAt: DAYS_10_AGO }] }),
    DAYS_10_AGO,
  );
  // No decision list and no explicit hint → no bound.
  assert.equal(resolveStageOpenedAt(TRUE_POSITIVE.issue), null);
});

test("a participant comment predating the re-opened stage does NOT count", () => {
  const issue = issueFixture({
    identifier: "AUR-4171-stale-comment",
    state: undecidedReviewState({ lastDecisionId: "d1", lastDecisionOutcome: "changes_requested" }),
  });
  // Stage re-opened 2h ago; the participant's only comment is 10d old.
  const decisions = [{ id: "d1", createdAt: HOURS_2_AGO }];
  const spoke = participantSpokeSinceStageOpened(issue, TRUE_POSITIVE.comments, { decisions });
  assert.equal(spoke, null);
  const r = evaluateIssue({ issue, comments: TRUE_POSITIVE.comments, now: NOW, decisions });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "participant-silent");
});

test("fallback bound: with no stage-open timestamp the issue must be in_review", () => {
  const notInReview = issueFixture({ identifier: "AUR-4171-todo", status: "todo" });
  assert.equal(participantSpokeSinceStageOpened(notInReview, TRUE_POSITIVE.comments), null);
  assert.equal(evaluateIssue({ issue: notInReview, comments: TRUE_POSITIVE.comments, now: NOW }).flagged, false);
});

// ── Dedup + nudge body ───────────────────────────────────────────────────────

test("dedup is per STAGE ID: an existing marker comment suppresses a re-nudge", () => {
  const withNudge = {
    issue: TRUE_POSITIVE.issue,
    comments: [
      ...TRUE_POSITIVE.comments,
      comment({
        authorAgentId: "watchdog",
        body: buildNudgeBody({
          issueId: "AUR-3233",
          stageId: STAGE_ID,
          participant: `agent:${PARTICIPANT_AGENT_ID}`,
          ageHours: 240,
        }),
        createdAt: DAYS_10_AGO,
      }),
    ],
  };
  const r = evaluateIssue({ ...withNudge, now: NOW });
  assert.equal(r.flagged, true, "still a real defect — only the nudge is deduped");
  assert.equal(r.alreadyNudged, true);

  // A DIFFERENT stage id must not be suppressed by the old marker.
  const reopened = issueFixture({
    identifier: "AUR-3233",
    state: undecidedReviewState({ currentStageId: "a-new-stage-id" }),
  });
  const r2 = evaluateIssue({ issue: reopened, comments: withNudge.comments, now: NOW });
  assert.equal(r2.flagged, true);
  assert.equal(r2.alreadyNudged, false);
  assert.equal(r2.stageId, "a-new-stage-id");
});

test("nudge body names the stage, the participant, and BOTH valid actions", () => {
  const body = buildNudgeBody({
    issueId: "AUR-3233",
    stageId: STAGE_ID,
    participant: `agent:${PARTICIPANT_AGENT_ID}`,
    ageHours: 240,
  });
  assert.ok(body.includes(nudgeMarker(STAGE_ID)));
  assert.ok(body.includes(STAGE_ID));
  assert.ok(body.includes(PARTICIPANT_AGENT_ID));
  assert.match(body, /"status":"done"/);
  assert.match(body, /"status":"in_progress"/);
  assert.match(body, /Approve/);
  assert.match(body, /Request changes/);
});

// ── Participant identity resolution ──────────────────────────────────────────

test("a user-type participant is matched on authorUserId, not authorAgentId", () => {
  const userId = "8f2c1d90-1111-4222-8333-444455556666";
  const issue = issueFixture({
    identifier: "AUR-4171-user",
    state: undecidedReviewState({ currentParticipant: { type: "user", userId } }),
  });
  // Agent comment from the same-looking id must NOT match.
  const agentOnly = evaluateIssue({
    issue,
    comments: [comment({ authorAgentId: userId, body: "hi", createdAt: DAYS_10_AGO })],
    now: NOW,
  });
  assert.equal(agentOnly.flagged, false);
  assert.equal(agentOnly.reason, "participant-silent");

  const userComment = {
    id: "cu1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: userId,
    body: "lgtm",
    createdAt: DAYS_10_AGO,
  };
  const r = evaluateIssue({ issue, comments: [userComment], now: NOW });
  assert.equal(r.flagged, true);
  assert.equal(r.participant, `user:${userId}`);
});
