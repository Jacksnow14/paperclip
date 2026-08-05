import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editStats, boundedVerdict, abVerdict, pickTasks, diffHash } from './prompt-edit-gate.mjs';

const BASE = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');

test('editStats counts added/removed lines, ignores unchanged', () => {
  const proposed = `${BASE}\nnew rule A\nnew rule B`;
  const s = editStats(BASE, proposed);
  assert.equal(s.added, 2);
  assert.equal(s.removed, 0);
  assert.equal(s.changed, 2);
});

test('bounded: small edits pass, oversized and rewrites reject, no-op rejects', () => {
  const small = editStats(BASE, `${BASE}\nextra`);
  assert.equal(boundedVerdict(small, 60).ok, true);

  const bigLines = editStats(BASE, `${BASE}\n${Array.from({ length: 70 }, (_, i) => `add ${i}`).join('\n')}`);
  assert.equal(boundedVerdict(bigLines, 60).ok, false);
  assert.match(boundedVerdict(bigLines, 60).reason, /unbounded/);

  const rewrite = editStats(BASE, Array.from({ length: 100 }, (_, i) => `rewritten ${i}`).join('\n'));
  assert.equal(boundedVerdict(rewrite, 500).ok, false);
  assert.match(boundedVerdict(rewrite, 500).reason, /35%/);

  assert.equal(boundedVerdict(editStats(BASE, BASE), 60).ok, false);
});

test('A/B verdict: strict — must win more than lose; all-tie rejects', () => {
  assert.equal(abVerdict(['proposed', 'proposed', 'current']).accepted, true);
  assert.equal(abVerdict(['proposed', 'tie', 'tie']).accepted, true);
  assert.equal(abVerdict(['tie', 'tie', 'tie']).accepted, false);
  assert.equal(abVerdict(['proposed', 'current', 'current']).accepted, false);
  assert.equal(abVerdict(['proposed', 'current', 'tie']).accepted, false);
});

test('pickTasks skips thin descriptions and caps at n', () => {
  const issues = [
    { identifier: 'A-1', title: 't1', description: 'x'.repeat(200) },
    { identifier: 'A-2', title: 't2', description: 'short' },
    { identifier: 'A-3', title: 't3', description: 'y'.repeat(200) },
    { identifier: 'A-4', title: 't4', description: 'z'.repeat(200) },
  ];
  const picked = pickTasks(issues, 2);
  assert.deepEqual(picked.map((t) => t.identifier), ['A-1', 'A-3']);
  assert.match(picked[0].prompt, /plan of action/);
});

test('diffHash is stable and order-sensitive', () => {
  assert.equal(diffHash('a', 'b'), diffHash('a', 'b'));
  assert.notEqual(diffHash('a', 'b'), diffHash('b', 'a'));
});
