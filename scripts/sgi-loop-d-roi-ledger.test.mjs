// node --test scripts/sgi-loop-d-roi-ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRoi, deriveValueSignal, PRIORITY_VALUE_WEIGHTS } from './sgi-loop-d-roi-ledger.mjs';

const card = (issueId, meta = {}) => ({
  metadata: { category: 'scorecard_adjusted', issue_id: issueId, token_cost: 1000, ...meta },
  content: '',
});

test('deriveValueSignal respects an explicit non-default value_signal', () => {
  const derived = deriveValueSignal({ value_signal: 4 }, { priority: 'low' });
  assert.deepEqual(derived, { value: 4, basis: 'explicit' });
});

test('deriveValueSignal derives from priority when the signal is the default 1', () => {
  assert.equal(deriveValueSignal({ value_signal: 1 }, { priority: 'urgent' }).value, PRIORITY_VALUE_WEIGHTS.urgent);
  assert.equal(deriveValueSignal({ value_signal: 1 }, { priority: 'low' }).value, PRIORITY_VALUE_WEIGHTS.low);
  assert.equal(deriveValueSignal({}, { priority: 'high' }).value, PRIORITY_VALUE_WEIGHTS.high);
  assert.equal(deriveValueSignal({ value_signal: 0 }, null).value, 1); // unknown priority → neutral
  assert.equal(deriveValueSignal({ value_signal: 1 }, { priority: 'high' }).basis, 'derived_priority_outcome');
});

test('deriveValueSignal discounts failures and rework', () => {
  assert.equal(deriveValueSignal({ value_signal: 1, outcome: 'failure' }, { priority: 'medium' }).value, 0.15);
  assert.equal(deriveValueSignal({ value_signal: 1, rework_required: true }, { priority: 'medium' }).value, 0.6);
  // failure dominates over rework
  assert.equal(deriveValueSignal({ value_signal: 1, outcome: 'failure', rework_required: true }, { priority: 'urgent' }).value, 3 * 0.15);
});

test('computeRoi ranks an urgent-success project above a low-failure project at equal token cost', () => {
  const issueProjects = new Map([
    ['AUR-1', { projectId: 'p-urgent', projectName: 'Urgent Work', priority: 'urgent' }],
    ['AUR-2', { projectId: 'p-fail', projectName: 'Failing Work', priority: 'low' }],
  ]);
  const all = [
    card('AUR-1', { value_signal: 1, quality_signal: 4, outcome: 'success' }),
    card('AUR-1', { value_signal: 1, quality_signal: 4, outcome: 'success' }),
    card('AUR-2', { value_signal: 1, quality_signal: 4, outcome: 'failure' }),
    card('AUR-2', { value_signal: 1, quality_signal: 4, outcome: 'failure' }),
  ];
  const { rows } = computeRoi(all, issueProjects);
  const urgent = rows.find((r) => r.projectId === 'p-urgent');
  const failing = rows.find((r) => r.projectId === 'p-fail');
  assert.ok(urgent && failing);
  assert.ok(urgent.roi > failing.roi, `expected urgent (${urgent.roi}) > failing (${failing.roi})`);
  assert.equal(urgent.explicitValueSamples, 0);
});

test('computeRoi still counts explicit value signals as explicit', () => {
  const issueProjects = new Map([['AUR-3', { projectId: 'p-explicit', projectName: null, priority: 'medium' }]]);
  const { rows } = computeRoi([card('AUR-3', { value_signal: 5, quality_signal: 5 })], issueProjects);
  assert.equal(rows[0].explicitValueSamples, 1);
  assert.equal(rows[0].valueSignal, 5);
});

test('computeRoi keeps the revenue basis when a project_value record exists', () => {
  const issueProjects = new Map([['AUR-4', { projectId: 'p-rev', projectName: 'Revenue', priority: 'medium' }]]);
  const all = [
    card('AUR-4', { value_signal: 1, quality_signal: 4 }),
    {
      metadata: { category: 'project_value', project_id: 'p-rev', revenue_usd: 100, cost_usd: 10, computed_at: '2026-07-06' },
      title: 'project-value/p-rev',
      content: '',
    },
  ];
  const { rows } = computeRoi(all, issueProjects);
  assert.equal(rows[0].basis, 'revenue');
  assert.equal(rows[0].revenueUsd, 100);
});
