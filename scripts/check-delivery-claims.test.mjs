import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_COMMENT_CHARS,
  CONTROLS,
  longestOwnCommentLength,
  isCandidate,
  classify,
  controlVerdict,
  validateListShape,
  withinLookback,
  violationRunId,
  FLAG_REGEX,
  flagTitle,
  buildFlagDescription,
  resolveCancelReason,
} from './check-delivery-claims.mjs';

// ── Real fixtures — exact live shapes verified against the API 2026-08-12 ─────

const CMO = '1685f8cf-1b6f-4f17-a2d3-aa6372c95aa0';
const CEO = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';

/** AUR-4482 as of 2026-07-29: the incident. MUST classify as a violation. */
const AUR_4482 = {
  issue: {
    id: '8856b5cd-8715-4402-bbcf-136bb6619a24',
    identifier: 'AUR-4482',
    status: 'done',
    originKind: 'routine_execution',
    assigneeAgentId: CMO,
    title: 'Daily AI opportunity brief',
  },
  comments: [
    // The CMO's entire delivery claim — 95 chars, verified length of comment 12863274.
    { id: '12863274', authorAgentId: CMO, body: 'Daily AI opportunity brief posted. CEO review interaction created for mirror handoff to AUR-27.' },
    // The CEO's later re-run comments sit on the SAME thread and are longer
    // than the threshold — they must not mask the violation.
    { id: '0fefd047', authorAgentId: CEO, body: 'x'.repeat(24005) },
    { id: 'a5dc8ae9', authorAgentId: CEO, body: 'y'.repeat(3636) },
  ],
  documents: [],
  attachments: [],
};

/** AUR-4361: same routine, same agent, one day earlier, real 11,093-char brief. MUST NOT flag. */
const AUR_4361 = {
  issue: {
    id: '83d6f852-c7e0-4ec0-be12-411b26ad3934',
    identifier: 'AUR-4361',
    status: 'done',
    originKind: 'routine_execution',
    assigneeAgentId: CMO,
    title: 'Daily AI opportunity brief',
  },
  comments: [
    { id: 'c232862d', authorAgentId: CMO, body: 'z'.repeat(1231) },
    { id: 'ab661f20', authorAgentId: CMO, body: 'z'.repeat(11093) },
  ],
  documents: [],
  attachments: [],
};

// ── The two mandated controls, through the exact scan path ────────────────────

test('negative control: AUR-4482 shape MUST classify as a violation', () => {
  const c = classify(AUR_4482);
  assert.equal(c.violation, true);
  assert.equal(c.longestOwn, 95);
  assert.equal(c.documentCount, 0);
  assert.equal(c.attachmentCount, 0);
});

test('positive control: AUR-4361 shape MUST NOT classify as a violation', () => {
  const c = classify(AUR_4361);
  assert.equal(c.violation, false);
  assert.equal(c.longestOwn, 11093);
});

test('the rule separates the two controls — same routine, same agent, one day apart', () => {
  assert.notEqual(classify(AUR_4482).violation, classify(AUR_4361).violation);
});

// ── longestOwnCommentLength ───────────────────────────────────────────────────

test('longestOwnCommentLength ignores other agents\' comments (CEO re-run must not mask)', () => {
  assert.equal(longestOwnCommentLength(AUR_4482.comments, CMO), 95);
});

test('longestOwnCommentLength is 0 when the assignee never commented', () => {
  assert.equal(longestOwnCommentLength([{ authorAgentId: CEO, body: 'x'.repeat(5000) }], CMO), 0);
  assert.equal(longestOwnCommentLength([], CMO), 0);
});

// ── isCandidate / classify edges ──────────────────────────────────────────────

test('isCandidate: false for manual-origin issues (rule a)', () => {
  assert.equal(isCandidate({ ...AUR_4482.issue, originKind: 'manual' }), false);
  assert.equal(isCandidate({ ...AUR_4482.issue, originKind: null }), false);
});

test('isCandidate: false for issues that never claimed completion (rule b)', () => {
  for (const status of ['backlog', 'todo', 'in_progress', 'blocked', 'cancelled']) {
    assert.equal(isCandidate({ ...AUR_4482.issue, status }), false, status);
  }
  assert.equal(isCandidate({ ...AUR_4482.issue, status: 'in_review' }), true);
});

test('isCandidate: false with no assignee — no executing assignee to measure', () => {
  assert.equal(isCandidate({ ...AUR_4482.issue, assigneeAgentId: null }), false);
});

test('classify: a document is a verifiable deliverable (rule d clears)', () => {
  assert.equal(classify({ ...AUR_4482, documents: [{ id: 'doc1' }] }).violation, false);
});

test('classify: an attachment is a verifiable deliverable (rule d clears)', () => {
  assert.equal(classify({ ...AUR_4482, attachments: [{ id: 'att1' }] }).violation, false);
});

test('classify: threshold boundary — exactly MIN_COMMENT_CHARS chars clears, one less flags', () => {
  const at = { ...AUR_4482, comments: [{ authorAgentId: CMO, body: 'x'.repeat(MIN_COMMENT_CHARS) }] };
  const under = { ...AUR_4482, comments: [{ authorAgentId: CMO, body: 'x'.repeat(MIN_COMMENT_CHARS - 1) }] };
  assert.equal(classify(at).violation, false);
  assert.equal(classify(under).violation, true);
});

// ── controlVerdict (DETECTOR BLIND paths) ─────────────────────────────────────

test('controlVerdict: null when both controls behave', () => {
  assert.equal(controlVerdict(CONTROLS[0], AUR_4482.issue, classify(AUR_4482)), null);
  assert.equal(controlVerdict(CONTROLS[1], AUR_4361.issue, classify(AUR_4361)), null);
});

test('controlVerdict: blind when the fixture does not come back (200 + empty body class)', () => {
  const verdict = controlVerdict(CONTROLS[0], null, { violation: false, longestOwn: 0, documentCount: 0, attachmentCount: 0 });
  assert.match(verdict, /did not come back/);
});

test('controlVerdict: blind when the negative control stops flagging (detector can no longer fire)', () => {
  const verdict = controlVerdict(CONTROLS[0], AUR_4482.issue, { violation: false, longestOwn: 95, documentCount: 0, attachmentCount: 0 });
  assert.match(verdict, /expected VIOLATION/);
});

test('controlVerdict: blind when the positive control starts flagging (detector can no longer clear)', () => {
  const verdict = controlVerdict(CONTROLS[1], AUR_4361.issue, { violation: true, longestOwn: 11093, documentCount: 0, attachmentCount: 0 });
  assert.match(verdict, /expected clean/);
});

// ── validateListShape ─────────────────────────────────────────────────────────

test('validateListShape: blind on an empty list — a clean zero from a blind query', () => {
  assert.match(validateListShape([]), /empty/);
  assert.match(validateListShape(null), /empty/);
});

test('validateListShape: blind when a filtered field is absent from every row (AUR-4105 class)', () => {
  const row = { id: '1', identifier: 'AUR-1', status: 'done', assigneeAgentId: 'a', updatedAt: 'now' };
  assert.match(validateListShape([row]), /"originKind"/);
});

test('validateListShape: valid when each field appears on at least one row', () => {
  const row = { id: '1', identifier: 'AUR-1', originKind: null, status: 'done', assigneeAgentId: null, updatedAt: 'now' };
  assert.equal(validateListShape([row]), null);
});

// ── withinLookback / violationRunId ───────────────────────────────────────────

test('withinLookback: inside and outside the window', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(withinLookback({ updatedAt: '2026-08-10T12:00:00Z' }, 7, now), true);
  assert.equal(withinLookback({ updatedAt: '2026-08-01T12:00:00Z' }, 7, now), false);
  assert.equal(withinLookback({}, 7, now), false);
});

test('withinLookback prefers lastActivityAt over updatedAt', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(withinLookback({ lastActivityAt: '2026-08-11T12:00:00Z', updatedAt: '2026-07-01T00:00:00Z' }, 7, now), true);
});

test('violationRunId falls back across run-id fields', () => {
  assert.equal(violationRunId({ completedByRunId: 'a', executionRunId: 'b' }), 'a');
  assert.equal(violationRunId({ executionRunId: 'b', originRunId: 'c' }), 'b');
  assert.equal(violationRunId({ originRunId: 'c' }), 'c');
  assert.equal(violationRunId({}), 'unknown');
});

// ── Flag plumbing ─────────────────────────────────────────────────────────────

test('flagTitle round-trips through FLAG_REGEX', () => {
  const title = flagTitle('AUR-4482');
  assert.equal(FLAG_REGEX.exec(title)[1], 'AUR-4482');
});

test('FLAG_REGEX does not match unrelated titles', () => {
  assert.equal(FLAG_REGEX.test('stalled-blocked: AUR-1234 blocked with no blocker'), false);
});

test('buildFlagDescription names issue, agent, run, and the routing-rationale skip token', () => {
  const desc = buildFlagDescription({ ...AUR_4482.issue, completedByRunId: '91c51306' }, classify(AUR_4482));
  assert.match(desc, /AUR-4482/);
  assert.match(desc, new RegExp(CMO));
  assert.match(desc, /91c51306/);
  assert.match(desc, /95 chars/);
  assert.match(desc, /exec\.routing-rationale: skip/);
});

// ── resolveCancelReason ───────────────────────────────────────────────────────

test('resolveCancelReason: cancels when target vanished or was cancelled', () => {
  assert.match(resolveCancelReason({ target: null, targetIdentifier: 'AUR-1', classification: null }), /not found/);
  assert.match(
    resolveCancelReason({ target: { status: 'cancelled' }, targetIdentifier: 'AUR-1', classification: null }),
    /cancelled/,
  );
});

test('resolveCancelReason: cancels when the target no longer violates (deliverable added)', () => {
  const fixed = classify({ ...AUR_4482, documents: [{ id: 'doc1' }] });
  assert.match(
    resolveCancelReason({ target: AUR_4482.issue, targetIdentifier: 'AUR-4482', classification: fixed }),
    /no longer violates/,
  );
});

test('resolveCancelReason: null while the violation stands', () => {
  assert.equal(
    resolveCancelReason({ target: AUR_4482.issue, targetIdentifier: 'AUR-4482', classification: classify(AUR_4482) }),
    null,
  );
});
