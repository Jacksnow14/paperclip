import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATED_STATUS,
  decideGateAction,
  extractAurToken,
  matchPrsForIssue,
  normalizeIssueId,
  pickPr,
  stateKey,
} from './enforce-execution-review-gate.mjs';

const pr = (n, over = {}) => ({
  number: n,
  title: `fix(AUR-${9000 + n}): thing ${n}`,
  draft: false,
  createdAt: '2026-08-06T10:00:00Z',
  ...over,
});

test('extractAurToken pulls the canonical AUR-NNNN token out of a PR title', () => {
  assert.equal(extractAurToken('fix(email-deliverability): thing (AUR-6009) (#202)'), 'AUR-6009');
  assert.equal(extractAurToken('no token here'), null);
  assert.equal(extractAurToken(undefined), null);
});

test('normalizeIssueId accepts every common spelling', () => {
  assert.equal(normalizeIssueId('AUR-6150'), 'AUR-6150');
  assert.equal(normalizeIssueId('aur6150'), 'AUR-6150');
  assert.equal(normalizeIssueId('6150'), 'AUR-6150');
  assert.equal(normalizeIssueId(''), null);
});

test('matchPrsForIssue finds only PRs carrying this exact issue token', () => {
  const prs = [pr(1, { title: 'fix(AUR-6150): guard' }), pr(2, { title: 'fix(AUR-6008): unrelated' })];
  const matches = matchPrsForIssue(prs, 'AUR-6150');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].number, 1);
});

test('matchPrsForIssue returns nothing for an unparsable issue id', () => {
  assert.deepEqual(matchPrsForIssue([pr(1)], ''), []);
});

test('pickPr never throws on an empty list and picks the newest on ties', () => {
  assert.equal(pickPr([]), null);
  const older = pr(1, { createdAt: '2026-08-01T00:00:00Z' });
  const newer = pr(2, { createdAt: '2026-08-06T00:00:00Z' });
  assert.equal(pickPr([older, newer]).number, 2);
});

test('stateKey is stable and repo-qualified', () => {
  assert.equal(stateKey('Jacksnow14/paperclip', 42), 'Jacksnow14/paperclip#42');
});

test('decideGateAction: changes_requested + ready PR -> draft (close the merge path)', () => {
  const d = decideGateAction({ issueStatus: GATED_STATUS, prDraft: false, draftedByGate: false });
  assert.deepEqual(d, { action: 'draft', reason: 'changes_requested' });
});

test('decideGateAction: changes_requested + already-draft PR -> noop', () => {
  const d = decideGateAction({ issueStatus: GATED_STATUS, prDraft: true, draftedByGate: true });
  assert.equal(d.action, 'noop');
});

test('decideGateAction: resolved + draft we own -> undraft (release our own block)', () => {
  const d = decideGateAction({ issueStatus: 'idle', prDraft: true, draftedByGate: true });
  assert.deepEqual(d, { action: 'undraft', reason: 'resolved' });
});

test('decideGateAction: resolved + draft we do NOT own -> noop (never touch a draft we did not set)', () => {
  const d = decideGateAction({ issueStatus: 'completed', prDraft: true, draftedByGate: false });
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'draft-not-ours');
});

test('decideGateAction: resolved + already-ready PR -> noop', () => {
  const d = decideGateAction({ issueStatus: 'completed', prDraft: false, draftedByGate: false });
  assert.deepEqual(d, { action: 'noop', reason: 'ready' });
});

test('decideGateAction: no execution state (null) is always a noop', () => {
  const d = decideGateAction({ issueStatus: null, prDraft: false, draftedByGate: false });
  assert.equal(d.action, 'noop');
});

test('decideGateAction: pending status does not gate', () => {
  const d = decideGateAction({ issueStatus: 'pending', prDraft: false, draftedByGate: false });
  assert.equal(d.action, 'noop');
});
