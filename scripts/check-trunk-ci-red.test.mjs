/**
 * Unit coverage for the trunk-red detector's verdict logic (AUR-4675).
 *
 * Fixtures mirror real check-run shapes observed on Jacksnow14/paperclip:
 * the red cases are modeled on master@277c8e308 / master@1900948a9 (test job
 * failure, others green — the July 2026 silent-red incident AUR-4555), the
 * green case on master@037635bb9. Both directions are covered because a
 * check that can never fire and a check that can never clear are equally
 * broken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommit, latestRunsByName, trunkVerdict } from './check-trunk-ci-red.mjs';

const JOBS = ['test', 'typecheck', 'scripts-test'];
const YOUNG = { ageMinutes: 10, graceMinutes: 90 };
const OLD = { ageMinutes: 300, graceMinutes: 90 };

function run(name, conclusion, status = 'completed', started_at = '2026-07-30T02:00:00Z', id = 1) {
  return { name, status, conclusion, started_at, id };
}

const allGreen = [run('test', 'success'), run('typecheck', 'success'), run('scripts-test', 'success')];
const testRed = [run('test', 'failure'), run('typecheck', 'success'), run('scripts-test', 'success')];

test('FIRE direction: test-job failure classifies red (the 277c8e308 shape)', () => {
  const c = classifyCommit(testRed, JOBS, OLD);
  assert.equal(c.verdict, 'red');
  assert.deepEqual(c.jobs.filter((j) => j.state === 'red').map((j) => j.name), ['test']);
});

test('PASS direction: all-success classifies green (the 037635bb9 shape)', () => {
  assert.equal(classifyCommit(allGreen, JOBS, OLD).verdict, 'green');
});

test('rerun dedup: newer success supersedes older failure of the same job', () => {
  const runs = [
    run('test', 'failure', 'completed', '2026-07-30T02:00:00Z', 1),
    run('test', 'success', 'completed', '2026-07-30T03:00:00Z', 2),
    run('typecheck', 'success'), run('scripts-test', 'success'),
  ];
  assert.equal(latestRunsByName(runs).get('test').conclusion, 'success');
  assert.equal(classifyCommit(runs, JOBS, OLD).verdict, 'green');
});

test('cancelled (superseded by newer trunk push) is inconclusive, not red', () => {
  const runs = [run('test', 'cancelled'), run('typecheck', 'cancelled'), run('scripts-test', 'cancelled')];
  assert.equal(classifyCommit(runs, JOBS, OLD).verdict, 'inconclusive');
});

test('missing check-runs: pending inside grace, RED once past grace (gate silent)', () => {
  assert.equal(classifyCommit([], JOBS, YOUNG).verdict, 'pending');
  const late = classifyCommit([], JOBS, OLD);
  assert.equal(late.verdict, 'red');
  assert.match(late.jobs[0].reason, /gate not reporting/);
});

test('required job skipped is red — a conditional-free gate must never skip', () => {
  const runs = [run('test', 'skipped'), run('typecheck', 'success'), run('scripts-test', 'success')];
  assert.equal(classifyCommit(runs, JOBS, OLD).verdict, 'red');
});

test('unrecognized conclusion fails closed', () => {
  const runs = [run('test', 'mystery_state'), run('typecheck', 'success'), run('scripts-test', 'success')];
  assert.equal(classifyCommit(runs, JOBS, OLD).verdict, 'red');
});

test('trunk verdict: newest conclusive commit decides; pending head is walked past', () => {
  const classified = [
    { sha: 'aaa', ...classifyCommit([], JOBS, YOUNG) },          // fresh push, CI still running
    { sha: 'bbb', ...classifyCommit(testRed, JOBS, OLD) },       // settled red
    { sha: 'ccc', ...classifyCommit(allGreen, JOBS, OLD) },
  ];
  const v = trunkVerdict(classified);
  assert.equal(v.verdict, 'red');
  assert.equal(v.decidingSha, 'bbb');
  assert.equal(v.redStreak, 1);
});

test('trunk verdict: red streak counts consecutive reds, broken by green', () => {
  const classified = [
    { sha: 'aaa', ...classifyCommit(testRed, JOBS, OLD) },
    { sha: 'bbb', ...classifyCommit(testRed, JOBS, OLD) },
    { sha: 'ccc', ...classifyCommit(allGreen, JOBS, OLD) },
    { sha: 'ddd', ...classifyCommit(testRed, JOBS, OLD) },
  ];
  const v = trunkVerdict(classified);
  assert.equal(v.redStreak, 2);
});

test('trunk verdict: green head clears immediately', () => {
  const classified = [
    { sha: 'aaa', ...classifyCommit(allGreen, JOBS, OLD) },
    { sha: 'bbb', ...classifyCommit(testRed, JOBS, OLD) },
  ];
  const v = trunkVerdict(classified);
  assert.equal(v.verdict, 'green');
  assert.equal(v.redStreak, 0);
});
