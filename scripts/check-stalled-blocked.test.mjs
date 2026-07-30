import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasNoBlocker,
  gradeBlockedIssue,
  hoursSince,
  FLAG_REGEX,
  flagTitle,
  isChainFlagTitle,
  isSchedulerGatedStalled,
  resolveCancelReason,
  resolveFlagOwner,
  hasPendingInteractionInList,
  CEO_AGENT_ID,
  HUMAN_GATED_TOKEN,
} from './check-stalled-blocked.mjs';

// ── hasNoBlocker ──────────────────────────────────────────────────────────────

test('hasNoBlocker: true when needs_attention with zero unresolved blockers', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
  }), true);
});

test('hasNoBlocker: false — AUR-4032 sanity check (real covered blocker)', () => {
  // Matches the live AUR-4032 shape: state "covered" with 1 real blocker.
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'covered', reason: 'active_dependency', unresolvedBlockerCount: 1 },
  }), false);
});

test('hasNoBlocker: false when needs_attention but a real blocker itself needs attention', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1, attentionBlockerCount: 1 },
  }), false);
});

test('hasNoBlocker: false when blockerAttention is absent', () => {
  assert.equal(hasNoBlocker({}), false);
});

test('hasNoBlocker: false for state "stalled" (a blocker chain is itself stalled, not "no blocker")', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'stalled', unresolvedBlockerCount: 1 },
  }), false);
});

// ── isSchedulerGatedStalled (AUR-4664 chain class) ────────────────────────────

test('isSchedulerGatedStalled: FIRES on the AUR-4149 shape — todo with an unworked unresolved blocker', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'todo',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1, attentionBlockerCount: 1 },
  }), true);
});

test('isSchedulerGatedStalled: FIRES on a stalled-review chain for an in_progress dependent', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'in_progress',
    blockerAttention: { state: 'stalled', unresolvedBlockerCount: 1, stalledBlockerCount: 1 },
  }), true);
});

test('isSchedulerGatedStalled: PASSES a genuinely-unblocked todo issue (state none, zero unresolved)', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'todo',
    blockerAttention: { state: 'none', unresolvedBlockerCount: 0 },
  }), false);
});

test('isSchedulerGatedStalled: PASSES a covered chain — someone is working the blocker (AUR-4187 shape)', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'todo',
    blockerAttention: { state: 'covered', reason: 'active_dependency', unresolvedBlockerCount: 1, coveredBlockerCount: 1 },
  }), false);
});

test('isSchedulerGatedStalled: PASSES blocked-status issues — that is the hasNoBlocker/stalled/human-gated domain', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'blocked',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1 },
  }), false);
});

test('isSchedulerGatedStalled: PASSES when blockerAttention is absent (pre-AUR-4664 server — fail-quiet)', () => {
  assert.equal(isSchedulerGatedStalled({ status: 'todo' }), false);
});

test('isSchedulerGatedStalled: PASSES needs_attention with zero unresolved — that is the no-blocker anomaly, not a chain', () => {
  assert.equal(isSchedulerGatedStalled({
    status: 'todo',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
  }), false);
});

// ── gradeBlockedIssue ─────────────────────────────────────────────────────────

test('gradeBlockedIssue: stalled by default', () => {
  assert.equal(gradeBlockedIssue({ title: 'Refactor the widget factory', description: 'no reason given' }), 'stalled');
});

test('gradeBlockedIssue: human-gated via founder-gate title (AUR-2209 shape)', () => {
  assert.equal(gradeBlockedIssue({
    title: 'Founder gate: send ONE WhatsApp message to +1555... from your own phone',
    description: '',
  }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via identity docs (AUR-3945 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Verify business identity docs', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via recovery codes (AUR-2162 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Obtain 2FA recovery codes for X', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via payment rail (AUR-1879 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Set up payment rail for vendor Y', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via [alex@]/[board@] inbox marker', () => {
  assert.equal(gradeBlockedIssue({ title: '[alex@] approve renewal', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via explicit opt-out token', () => {
  assert.equal(gradeBlockedIssue({
    title: 'Some ordinary-looking title',
    description: `blah blah\n${HUMAN_GATED_TOKEN}\nmore text`,
  }), 'human-gated');
});

test('gradeBlockedIssue: does not false-positive on "manual" alone', () => {
  assert.equal(gradeBlockedIssue({ title: 'Write the manual test plan', description: '' }), 'stalled');
});

// ── hoursSince ────────────────────────────────────────────────────────────────

test('hoursSince: computes elapsed hours against a fixed now', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  assert.equal(hoursSince('2026-07-26T06:00:00Z', now), 6);
});

// ── flagTitle / FLAG_REGEX round-trip ────────────────────────────────────────

test('flagTitle + FLAG_REGEX: stalled title round-trips the target identifier', () => {
  const title = flagTitle('AUR-3347', 'stalled');
  assert.match(title, /^stalled-blocked:/);
  const match = FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-3347');
});

test('flagTitle + FLAG_REGEX: human-gated title round-trips the target identifier', () => {
  const title = flagTitle('AUR-3945', 'human-gated');
  assert.match(title, /^stalled-blocked-mismodelled:/);
  const match = FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-3945');
});

test('FLAG_REGEX: does not match unrelated titles', () => {
  assert.equal(FLAG_REGEX.test('Refactor the widget factory'), false);
});

test('flagTitle + FLAG_REGEX: chain title round-trips the target identifier (AUR-4664)', () => {
  const title = flagTitle('AUR-4149', 'chain');
  assert.match(title, /^stalled-blocked-chain:/);
  const match = FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-4149');
});

test('isChainFlagTitle: discriminates chain flags from both no-blocker flag formats', () => {
  assert.equal(isChainFlagTitle(flagTitle('AUR-4149', 'chain')), true);
  assert.equal(isChainFlagTitle(flagTitle('AUR-3347', 'stalled')), false);
  assert.equal(isChainFlagTitle(flagTitle('AUR-3945', 'human-gated')), false);
});

// ── resolveCancelReason (Phase A auto-resolve) ───────────────────────────────

test('resolveCancelReason: null (stays open) when target is still blocked with no blocker', () => {
  const target = { status: 'blocked', blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 } };
  assert.equal(resolveCancelReason({ target, targetId: 'AUR-3347' }), null);
});

test('resolveCancelReason: cancels when target is done', () => {
  const target = { status: 'done' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /is done/);
});

test('resolveCancelReason: cancels when target is cancelled', () => {
  const target = { status: 'cancelled' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /is cancelled/);
});

test('resolveCancelReason: cancels when target is missing entirely', () => {
  const reason = resolveCancelReason({ target: null, targetId: 'AUR-3347' });
  assert.match(reason, /not found/);
});

test('resolveCancelReason: cancels when target moved off blocked (e.g. re-armed to todo)', () => {
  const target = { status: 'todo' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /no longer `blocked`/);
});

test('resolveCancelReason: cancels when target now has a real blocker attached', () => {
  const target = { status: 'blocked', blockerAttention: { state: 'covered', unresolvedBlockerCount: 1 } };
  const reason = resolveCancelReason({ target, targetId: 'AUR-4032' });
  assert.match(reason, /now has a real blocker/);
});

test('resolveCancelReason (chain): null (stays open) while the target is still scheduler-gated with an unworked blocker', () => {
  const target = { status: 'todo', blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1 } };
  assert.equal(resolveCancelReason({ target, targetId: 'AUR-4149', kind: 'chain' }), null);
});

test('resolveCancelReason (chain): does NOT insta-cancel because the target is not status blocked (AUR-4664 regression trap)', () => {
  // The no-blocker rules cancel any non-`blocked` target; chain targets are
  // never `blocked`, so running those rules against a chain flag kills it on
  // the next sweep. The kind switch exists to prevent exactly that.
  const target = { status: 'todo', blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1 } };
  assert.notEqual(resolveCancelReason({ target, targetId: 'AUR-4149' }), null);
  assert.equal(resolveCancelReason({ target, targetId: 'AUR-4149', kind: 'chain' }), null);
});

test('resolveCancelReason (chain): cancels once the chain is covered — someone started the blocker', () => {
  const target = { status: 'todo', blockerAttention: { state: 'covered', unresolvedBlockerCount: 1, coveredBlockerCount: 1 } };
  const reason = resolveCancelReason({ target, targetId: 'AUR-4149', kind: 'chain' });
  assert.match(reason, /no longer scheduler-gated/);
});

test('resolveCancelReason (chain): cancels once the blocker resolves entirely', () => {
  const target = { status: 'todo', blockerAttention: { state: 'none', unresolvedBlockerCount: 0 } };
  const reason = resolveCancelReason({ target, targetId: 'AUR-4149', kind: 'chain' });
  assert.match(reason, /no longer scheduler-gated/);
});

test('resolveCancelReason (chain): cancels when the target is done', () => {
  const reason = resolveCancelReason({ target: { status: 'done' }, targetId: 'AUR-4149', kind: 'chain' });
  assert.match(reason, /is done/);
});

// ── hasPendingInteractionInList (AUR-4275) ───────────────────────────────────

test('hasPendingInteractionInList: true when a pending interaction is present (AUR-1879 shape)', () => {
  assert.equal(hasPendingInteractionInList([
    { id: '41e09620-0c34-4ccc-a2ea-74743e0f47b3', kind: 'request_confirmation', status: 'pending' },
  ]), true);
});

test('hasPendingInteractionInList: false when interactions exist but none are pending', () => {
  assert.equal(hasPendingInteractionInList([
    { kind: 'ask_user_questions', status: 'answered' },
    { kind: 'request_confirmation', status: 'accepted' },
  ]), false);
});

test('hasPendingInteractionInList: false for an empty list', () => {
  assert.equal(hasPendingInteractionInList([]), false);
});

test('hasPendingInteractionInList: handles a {items: [...]} wrapper response shape', () => {
  assert.equal(hasPendingInteractionInList({ items: [{ kind: 'ask_user_questions', status: 'pending' }] }), true);
});

// ── resolveFlagOwner ──────────────────────────────────────────────────────────

test('resolveFlagOwner: uses the target issue assignee when present', () => {
  assert.equal(resolveFlagOwner({ assigneeAgentId: 'agent-123' }), 'agent-123');
});

test('resolveFlagOwner: falls back to CEO when the target has no assignee', () => {
  assert.equal(resolveFlagOwner({ assigneeAgentId: null }), CEO_AGENT_ID);
});
