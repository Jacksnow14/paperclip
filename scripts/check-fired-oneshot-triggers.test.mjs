import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDateGatedCronField,
  isDateGatedCron,
  hasDisarmMechanism,
  classifyTrigger,
  findCandidates,
  groupByOwner,
  flagTitle,
  trackedRoutineIds,
  buildFlagBody,
  buildAppendComment,
  mergeTrackedIds,
  shouldAutoResolve,
  FLAG_TITLE_PREFIX,
} from './check-fired-oneshot-triggers.mjs';

// ── isDateGatedCronField / isDateGatedCron ──────────────────────────────────

test('isDateGatedCronField: wildcard is not date-gated', () => {
  assert.equal(isDateGatedCronField('*'), false);
  assert.equal(isDateGatedCronField('*/5'), false);
});

test('isDateGatedCronField: a single bare integer is date-gated', () => {
  assert.equal(isDateGatedCronField('10'), true);
  assert.equal(isDateGatedCronField('1'), true);
});

test('isDateGatedCronField: lists and ranges are recurring sets, not date-gated', () => {
  assert.equal(isDateGatedCronField('13,14,15'), false);
  assert.equal(isDateGatedCronField('1-5'), false);
});

test('isDateGatedCron: true only when both dom and month are single fixed values', () => {
  assert.equal(isDateGatedCron('0 8 10 8 *'), true); // one-shot: Aug 10
  assert.equal(isDateGatedCron('0 9 * * 1'), false); // weekly: every Monday
  assert.equal(isDateGatedCron('0 0 1 * *'), false); // monthly: 1st of every month
  assert.equal(isDateGatedCron('*/15 * * * *'), false); // every 15 minutes
});

test('isDateGatedCron: a quarterly recurrence (month is a list) is not date-gated', () => {
  // Live false positive caught during dry-run: routine 7924834c, "Etsy v3
  // AI-Disclosure Schema Quarterly Recheck" — genuinely recurring 4x/year,
  // not a disguised one-shot.
  assert.equal(isDateGatedCron('0 9 1 1,4,7,10 *'), false);
});

test('isDateGatedCron: malformed cron is not date-gated', () => {
  assert.equal(isDateGatedCron(''), false);
  assert.equal(isDateGatedCron(null), false);
  assert.equal(isDateGatedCron('0 8 10'), false);
});

// ── hasDisarmMechanism ───────────────────────────────────────────────────────

test('hasDisarmMechanism: detects archive/disable/disarm language', () => {
  assert.equal(hasDisarmMechanism('## DISARM\nAfter firing, archive this routine.'), true);
  assert.equal(hasDisarmMechanism('Once done, disable the trigger.'), true);
  assert.equal(hasDisarmMechanism('Terminator will disarm all triggers.'), true);
  assert.equal(hasDisarmMechanism('PATCH trigger {"enabled": false}'), true);
});

test('hasDisarmMechanism: false when description says nothing about disarming', () => {
  assert.equal(hasDisarmMechanism('Wake me on 2026-09-24 to re-verify the WABA sender.'), false);
  assert.equal(hasDisarmMechanism(''), false);
  assert.equal(hasDisarmMechanism(null), false);
});

// ── classifyTrigger ──────────────────────────────────────────────────────────

const activeRoutine = (overrides = {}) => ({
  id: 'r1',
  identifier: 'AUR-1',
  title: 'Some one-shot',
  status: 'active',
  assigneeAgentId: 'agent-1',
  description: '',
  ...overrides,
});

const scheduleTrigger = (overrides = {}) => ({
  id: 't1',
  kind: 'schedule',
  enabled: true,
  cronExpression: '0 8 10 8 *',
  lastFiredAt: null,
  ...overrides,
});

test('classifyTrigger: fired-still-armed when date-gated, enabled, already fired, routine active', () => {
  const result = classifyTrigger(activeRoutine(), scheduleTrigger({ lastFiredAt: '2026-08-10T08:00:00Z' }));
  assert.deepEqual(result, { severity: 'fired-still-armed' });
});

test('classifyTrigger: armed-will-recur when date-gated, not yet fired, no disarm mechanism', () => {
  const result = classifyTrigger(activeRoutine(), scheduleTrigger({ lastFiredAt: null }));
  assert.deepEqual(result, { severity: 'armed-will-recur' });
});

test('classifyTrigger: null when not yet fired but routine documents a disarm step', () => {
  const routine = activeRoutine({ description: '## DISARM\nArchive this routine after firing.' });
  const result = classifyTrigger(routine, scheduleTrigger({ lastFiredAt: null }));
  assert.equal(result, null);
});

test('classifyTrigger: null when routine is not active', () => {
  const result = classifyTrigger(activeRoutine({ status: 'paused' }), scheduleTrigger({ lastFiredAt: '2026-08-10T08:00:00Z' }));
  assert.equal(result, null);
});

test('classifyTrigger: null when trigger is disabled — never trust nextRunAt (AUR-5569 ask 3)', () => {
  const result = classifyTrigger(activeRoutine(), scheduleTrigger({
    enabled: false,
    lastFiredAt: '2026-08-10T08:00:00Z',
    nextRunAt: '2027-08-10T08:00:00Z',
  }));
  assert.equal(result, null);
});

test('classifyTrigger: null when trigger is not kind schedule', () => {
  const result = classifyTrigger(activeRoutine(), scheduleTrigger({ kind: 'webhook' }));
  assert.equal(result, null);
});

test('classifyTrigger: null when cron is not date-gated (recurring, not one-shot)', () => {
  const result = classifyTrigger(activeRoutine(), scheduleTrigger({ cronExpression: '0 9 * * 1' }));
  assert.equal(result, null);
});

// ── findCandidates / groupByOwner ────────────────────────────────────────────

test('findCandidates: scans all routines and triggers, skips non-candidates', () => {
  const routines = [
    activeRoutine({ id: 'r1', triggers: [scheduleTrigger({ id: 't1', lastFiredAt: '2026-08-10T08:00:00Z' })] }),
    activeRoutine({ id: 'r2', triggers: [scheduleTrigger({ id: 't2', cronExpression: '0 9 * * 1' })] }),
    activeRoutine({ id: 'r3', triggers: [scheduleTrigger({ id: 't3', enabled: false })] }),
  ];
  const candidates = findCandidates(routines);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].routine.id, 'r1');
  assert.equal(candidates[0].severity, 'fired-still-armed');
});

test('groupByOwner: buckets by assigneeAgentId, separates unowned', () => {
  const candidates = [
    { routine: { id: 'r1', assigneeAgentId: 'a1' }, severity: 'fired-still-armed' },
    { routine: { id: 'r2', assigneeAgentId: 'a1' }, severity: 'armed-will-recur' },
    { routine: { id: 'r3', assigneeAgentId: 'a2' }, severity: 'fired-still-armed' },
    { routine: { id: 'r4', assigneeAgentId: null }, severity: 'fired-still-armed' },
  ];
  const { byOwner, unowned } = groupByOwner(candidates);
  assert.equal(byOwner.get('a1').length, 2);
  assert.equal(byOwner.get('a2').length, 1);
  assert.equal(unowned.length, 1);
  assert.equal(unowned[0].routine.id, 'r4');
});

// ── flag content + idempotency ───────────────────────────────────────────────

test('flagTitle: stable prefix used for search/dedup', () => {
  assert.equal(flagTitle('CTO'), `${FLAG_TITLE_PREFIX} — CTO`);
});

test('trackedRoutineIds: extracts marker line, empty set when absent', () => {
  const desc = 'blah blah\n\nroutine-ids-tracked: r1,r2,r3\n';
  assert.deepEqual(trackedRoutineIds(desc), new Set(['r1', 'r2', 'r3']));
  assert.deepEqual(trackedRoutineIds('no marker here'), new Set());
  assert.deepEqual(trackedRoutineIds(null), new Set());
});

test('buildFlagBody: embeds a routine-ids-tracked marker covering every candidate', () => {
  const candidates = [
    { routine: { id: 'r1', identifier: 'AUR-1', title: 'Etsy gate' }, trigger: { id: 't1', cronExpression: '0 8 10 8 *', lastFiredAt: '2026-08-10T08:00:00Z' }, severity: 'fired-still-armed' },
    { routine: { id: 'r2', identifier: 'AUR-2', title: 'WABA reverify' }, trigger: { id: 't2', cronExpression: '0 9 24 9 *', lastFiredAt: null }, severity: 'armed-will-recur' },
  ];
  const body = buildFlagBody(candidates);
  assert.match(body, /routine-ids-tracked: r1,r2/);
  assert.match(body, /AUR-1/);
  assert.match(body, /AUR-2/);
  assert.equal(trackedRoutineIds(body).size, 2);
});

test('buildAppendComment: marker covers only the newly-added candidates', () => {
  const newCandidates = [
    { routine: { id: 'r3', identifier: 'AUR-3', title: 'New one' }, trigger: { id: 't3', cronExpression: '0 8 1 1 *', lastFiredAt: null }, severity: 'armed-will-recur' },
  ];
  const comment = buildAppendComment(newCandidates);
  assert.match(comment, /routine-ids-tracked: r3/);
});

// ── mergeTrackedIds ───────────────────────────────────────────────────────────

test('mergeTrackedIds: unions new ids into an existing marker', () => {
  const description = 'blah blah\n\nroutine-ids-tracked: r1,r2';
  const merged = mergeTrackedIds(description, ['r3']);
  assert.deepEqual(trackedRoutineIds(merged), new Set(['r1', 'r2', 'r3']));
});

test('mergeTrackedIds: appends a marker when description has none', () => {
  const merged = mergeTrackedIds('no marker here', ['r1']);
  assert.deepEqual(trackedRoutineIds(merged), new Set(['r1']));
});

test('mergeTrackedIds: deduplicates ids already tracked', () => {
  const merged = mergeTrackedIds('routine-ids-tracked: r1,r2', ['r2', 'r3']);
  assert.deepEqual(trackedRoutineIds(merged), new Set(['r1', 'r2', 'r3']));
});

test('mergeTrackedIds regression: extend-then-recompute keeps auto-resolve honest about a routine only tracked via a later extend', () => {
  // Simulates two runs: (1) issue created tracking r1, r2; (2) a later run
  // sees a NEW candidate r3 for the same owner and extends. Before this fix,
  // extend only posted a comment — the description (which trackedRoutineIds
  // and shouldAutoResolve actually read) never learned about r3, so a
  // subsequent run would both re-flag r3 as "new" forever AND could
  // auto-resolve the issue while r3 was still a live armed one-shot.
  let description = buildFlagBody([
    { routine: { id: 'r1', identifier: 'AUR-1', title: 'A' }, trigger: { id: 't1', cronExpression: '0 8 10 8 *', lastFiredAt: '2026-08-10T08:00:00Z' }, severity: 'fired-still-armed' },
    { routine: { id: 'r2', identifier: 'AUR-2', title: 'B' }, trigger: { id: 't2', cronExpression: '0 8 11 8 *', lastFiredAt: '2026-08-11T08:00:00Z' }, severity: 'fired-still-armed' },
  ]);

  const newOnes = [
    { routine: { id: 'r3', identifier: 'AUR-3', title: 'C' }, trigger: { id: 't3', cronExpression: '0 8 12 8 *', lastFiredAt: null }, severity: 'armed-will-recur' },
  ];
  description = mergeTrackedIds(description, newOnes.map((c) => c.routine.id));

  // A later run resolves r1 and r2 but r3 is still armed.
  const stillLiveCandidateIds = new Set(['r3']);
  assert.equal(shouldAutoResolve({ description }, stillLiveCandidateIds), false);

  // Once r3 is also disarmed, auto-resolve is safe.
  assert.equal(shouldAutoResolve({ description }, new Set()), true);

  // And r3 is never re-treated as "new" on a subsequent scan.
  assert.equal(trackedRoutineIds(description).has('r3'), true);
});

// ── shouldAutoResolve ─────────────────────────────────────────────────────────

test('shouldAutoResolve: true when none of the tracked routines are still candidates', () => {
  const flagIssue = { description: 'routine-ids-tracked: r1,r2' };
  assert.equal(shouldAutoResolve(flagIssue, new Set()), true);
  assert.equal(shouldAutoResolve(flagIssue, new Set(['r3'])), true);
});

test('shouldAutoResolve: false when at least one tracked routine is still a candidate', () => {
  const flagIssue = { description: 'routine-ids-tracked: r1,r2' };
  assert.equal(shouldAutoResolve(flagIssue, new Set(['r1'])), false);
});

test('shouldAutoResolve: false when the flag issue tracks nothing (no marker — leave it for a human, don\'t guess)', () => {
  const flagIssue = { description: 'no marker' };
  assert.equal(shouldAutoResolve(flagIssue, new Set()), false);
});
