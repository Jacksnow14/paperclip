import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DARK_LANE_STATE,
  planDarkLaneTransition,
  finalizeDarkLaneState,
  darkLaneStatesEqual,
} from './dark-lane-transition.mjs';

const T0 = '2026-08-05T12:00:00.000Z';
const T1 = '2026-08-05T12:15:00.000Z';
const T2 = '2026-08-05T12:30:00.000Z';
const DETAIL = { adapterType: 'codex', reason: 'provider_reset_park', resetAt: '2026-08-11T00:00:00.000Z' };

test('newly dark agent (no prior state) plans an "opened" alert', () => {
  const { tentativeState, alert } = planDarkLaneTransition({
    prevState: null,
    isDarkNow: true,
    detail: DETAIL,
    nowIso: T0,
  });
  assert.deepEqual(alert, { kind: 'opened' });
  assert.equal(tentativeState.active, true);
  assert.equal(tentativeState.since, T0);
  assert.equal(tentativeState.adapterType, 'codex');
  assert.equal(tentativeState.alertedAt, null);
});

test('AC2: still dark on next tick after a CONFIRMED open alert fires zero further alerts', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  const persisted = finalizeDarkLaneState(opened.tentativeState, opened.alert, true, T0);
  assert.equal(persisted.alertedAt, T0);

  const next = planDarkLaneTransition({ prevState: persisted, isDarkNow: true, detail: DETAIL, nowIso: T1 });
  assert.equal(next.alert, null);
  assert.deepEqual(next.tentativeState, persisted);
});

test('AC3: breaker closes after a confirmed open alert plans exactly one recovery alert', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  const persistedOpen = finalizeDarkLaneState(opened.tentativeState, opened.alert, true, T0);

  const closed = planDarkLaneTransition({ prevState: persistedOpen, isDarkNow: false, detail: null, nowIso: T1 });
  assert.deepEqual(closed.alert, { kind: 'recovered' });
  assert.equal(closed.tentativeState.active, false);
  assert.equal(closed.tentativeState.recoveryPending, true);

  const persistedRecovered = finalizeDarkLaneState(closed.tentativeState, closed.alert, true, T1);
  assert.ok(darkLaneStatesEqual(persistedRecovered, DEFAULT_DARK_LANE_STATE));

  // Next tick: fully quiescent, no further alert.
  const settled = planDarkLaneTransition({ prevState: persistedRecovered, isDarkNow: false, detail: null, nowIso: T2 });
  assert.equal(settled.alert, null);
});

test('AC4: rate-window refusal (unconfirmed send) leaves the guard unset so the next tick retries', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  // Send was blocked/failed — finalize with confirmed=false.
  const persisted = finalizeDarkLaneState(opened.tentativeState, opened.alert, false, T0);
  assert.equal(persisted.alertedAt, null);
  assert.equal(persisted.active, true);

  // Next tick, still dark: must retry the "opened" alert since it was never confirmed.
  const retry = planDarkLaneTransition({ prevState: persisted, isDarkNow: true, detail: DETAIL, nowIso: T1 });
  assert.deepEqual(retry.alert, { kind: 'opened' });
});

test('AC4 recovery-side: unconfirmed recovery send retries on next tick instead of clearing state', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  const persistedOpen = finalizeDarkLaneState(opened.tentativeState, opened.alert, true, T0);

  const closed = planDarkLaneTransition({ prevState: persistedOpen, isDarkNow: false, detail: null, nowIso: T1 });
  const persistedUnconfirmed = finalizeDarkLaneState(closed.tentativeState, closed.alert, false, T1);
  assert.equal(persistedUnconfirmed.recoveryPending, true);
  assert.equal(persistedUnconfirmed.active, false);

  const retry = planDarkLaneTransition({ prevState: persistedUnconfirmed, isDarkNow: false, detail: null, nowIso: T2 });
  assert.deepEqual(retry.alert, { kind: 'recovered' });
});

test('goes dark and recovers before the open alert ever confirmed: silent clear, no recovery alert', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  const persistedUnconfirmed = finalizeDarkLaneState(opened.tentativeState, opened.alert, false, T0);
  assert.equal(persistedUnconfirmed.alertedAt, null);

  const closed = planDarkLaneTransition({ prevState: persistedUnconfirmed, isDarkNow: false, detail: null, nowIso: T1 });
  assert.equal(closed.alert, null);
  assert.ok(darkLaneStatesEqual(closed.tentativeState, DEFAULT_DARK_LANE_STATE));
});

test('healthy idle agent (never dark) stays fully quiescent forever', () => {
  const tick = planDarkLaneTransition({ prevState: null, isDarkNow: false, detail: null, nowIso: T0 });
  assert.equal(tick.alert, null);
  assert.ok(darkLaneStatesEqual(tick.tentativeState, DEFAULT_DARK_LANE_STATE));
});

test('still-dark retry preserves an updated resetAt from fresh detail', () => {
  const opened = planDarkLaneTransition({ prevState: null, isDarkNow: true, detail: DETAIL, nowIso: T0 });
  const persistedUnconfirmed = finalizeDarkLaneState(opened.tentativeState, opened.alert, false, T0);

  const newerDetail = { ...DETAIL, resetAt: '2026-08-12T00:00:00.000Z' };
  const retry = planDarkLaneTransition({ prevState: persistedUnconfirmed, isDarkNow: true, detail: newerDetail, nowIso: T1 });
  assert.equal(retry.tentativeState.resetAt, '2026-08-12T00:00:00.000Z');
});

test('finalizeDarkLaneState is a no-op when there is no alert to act on', () => {
  const state = { ...DEFAULT_DARK_LANE_STATE, active: false, recoveryPending: false };
  assert.deepEqual(finalizeDarkLaneState(state, null, true, T0), state);
});

test('darkLaneStatesEqual treats missing fields as defaults', () => {
  assert.ok(darkLaneStatesEqual(undefined, DEFAULT_DARK_LANE_STATE));
  assert.ok(darkLaneStatesEqual({ active: true }, { active: true, since: null }));
  assert.ok(!darkLaneStatesEqual({ active: true }, { active: false }));
});
