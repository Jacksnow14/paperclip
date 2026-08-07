// node --test scripts/sgi-loop-h-approval-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  routeForExperiment,
  resolveGateVerdict,
  decideGateArming,
  decideActivationCredential,
} from './sgi-loop-h-approval-route.mjs';

const exp = (metadata) => ({ id: 'rec-1', metadata });
const verdict = (diffHash, v, id = 'v-1') => ({ id, metadata: { kind: 'prompt_edit_verdict', diff_hash: diffHash, verdict: v } });

test('every change_type Loop H actually drafts is gate-routed, not board-routed', () => {
  for (const changeType of ['routing', 'prompt_edit', 'threshold', 'agent_assignment']) {
    const r = routeForExperiment(exp({ change_type: changeType, change: 'Tighten the retro checklist wording.' }));
    assert.equal(r.route, 'gate', `${changeType} must not reach the board`);
  }
});

test('genuine founder decisions still route to the board', () => {
  assert.equal(routeForExperiment(exp({ change_type: 'spend' })).route, 'board');
  assert.equal(routeForExperiment(exp({ change_type: 'prompt_edit', requires_founder_decision: true })).route, 'board');
  assert.equal(
    routeForExperiment(exp({ change_type: 'threshold', change: 'Buy additional API credits for the codex lane.' })).route,
    'board',
  );
  assert.equal(
    routeForExperiment(exp({ change_type: 'routing', change: 'Store the Stripe api key in the agent env.' })).route,
    'board',
  );
});

test('the wording screen does not fire on ordinary token/budget/cost hypotheses', () => {
  // The whole point of Loop H is token efficiency; a screen that matched these
  // words would route every experiment to the board — the defect being fixed.
  const cases = [
    'Raise the budget cap for bug tasks from 50k to 80k tokens.',
    'Cut token cost per task by front-loading the repo map.',
    'Lower the priority threshold at which the router escalates to Max.',
    'Charge the retrospective step with a shorter template to reduce cost.',
  ];
  for (const change of cases) {
    assert.equal(routeForExperiment(exp({ change_type: 'threshold', change })).route, 'gate', change);
  }
});

test('resolveGateVerdict matches on the diff hash only', () => {
  const record = exp({ gate_diff_hash: 'abc123' });
  assert.equal(resolveGateVerdict(record, [verdict('other', 'accepted')]).verdict, null);
  assert.equal(resolveGateVerdict(record, [verdict('abc123', 'accepted')]).verdict, 'accepted');
  assert.equal(resolveGateVerdict(record, [verdict('abc123', 'rejected')]).verdict, 'rejected');
  // an accepted re-judgement of the same hash wins over the earlier rejection
  assert.equal(
    resolveGateVerdict(record, [verdict('abc123', 'rejected', 'v-old'), verdict('abc123', 'accepted', 'v-new')]).recordId,
    'v-new',
  );
  // no hash stamped → no verdict, whatever else is in the store
  assert.equal(resolveGateVerdict(exp({}), [verdict('abc123', 'accepted')]).verdict, null);
});

test('decideGateArming walks needs_gate → awaiting → armed', () => {
  const fresh = exp({ change_type: 'prompt_edit' });
  assert.equal(decideGateArming(fresh, []).action, 'needs_gate');

  const requested = exp({ change_type: 'prompt_edit', gate_issue_id: 'iss-1' });
  assert.equal(decideGateArming(requested, []).action, 'awaiting_gate');

  const stamped = exp({ change_type: 'prompt_edit', gate_issue_id: 'iss-1', gate_diff_hash: 'abc123' });
  assert.equal(decideGateArming(stamped, [verdict('abc123', 'accepted')]).action, 'arm');
  assert.equal(decideGateArming(stamped, [verdict('abc123', 'rejected')]).action, 'reject');
  assert.equal(decideGateArming(stamped, []).action, 'awaiting_gate');
});

test('activation: a gate-armed experiment never waits on a board approval', () => {
  const armed = exp({ change_type: 'prompt_edit', armed_by: 'prompt_edit_gate' });
  assert.equal(decideActivationCredential(armed, null).ok, true);

  const notArmed = exp({ change_type: 'prompt_edit' });
  assert.equal(decideActivationCredential(notArmed, 'approved').ok, false,
    'a stale board approval must not activate a gate-routed experiment');
});

test('activation: a board-routed experiment still requires an accepted approval', () => {
  const boardExp = (extra) => exp({ change_type: 'spend', ...extra });
  assert.equal(decideActivationCredential(boardExp({ board_approval_id: 'a-1' }), 'approved').ok, true);
  assert.equal(decideActivationCredential(boardExp({ board_approval_id: 'a-1' }), 'accepted').ok, true);
  assert.equal(decideActivationCredential(boardExp({ board_approval_id: 'a-1' }), 'pending').ok, false);
  assert.equal(decideActivationCredential(boardExp({}), 'approved').ok, false, 'no approval id → no activation');
});
