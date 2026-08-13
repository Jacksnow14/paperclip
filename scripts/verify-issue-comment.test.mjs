import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyReadBack, DEFAULT_MIN_CHARS } from './verify-issue-comment.mjs';

test('DEFAULT_MIN_CHARS matches the check-delivery-claims threshold', async () => {
  const { MIN_COMMENT_CHARS } = await import('./check-delivery-claims.mjs');
  assert.equal(DEFAULT_MIN_CHARS, MIN_COMMENT_CHARS);
});

test('verifyReadBack: ok when the comment comes back intact from the list path', () => {
  const body = 'x'.repeat(2500);
  const verdict = verifyReadBack([{ id: 'c1', body: 'other' }, { id: 'c2', body }], 'c2', body);
  assert.deepEqual(verdict, { ok: true, length: 2500 });
});

test('verifyReadBack: fails when the id is not in the list — write response is not the outcome', () => {
  const verdict = verifyReadBack([{ id: 'c1', body: 'other' }], 'c2', 'body');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not returned by the comments list read path/);
});

test('verifyReadBack: fails when the body came back mangled', () => {
  const verdict = verifyReadBack([{ id: 'c2', body: 'truncated' }], 'c2', 'the full original body');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different body/);
});

test('verifyReadBack: tolerates an empty list without throwing', () => {
  assert.equal(verifyReadBack([], 'c2', 'body').ok, false);
  assert.equal(verifyReadBack(null, 'c2', 'body').ok, false);
});

test('verifyReadBack: ok when the stored body reflects the API\'s escaped-linebreak normalization (AUR-5577)', () => {
  const posted = 'line one\\nline two\\r\\nline three\\rline four';
  const stored = 'line one\nline two\nline three\nline four';
  const verdict = verifyReadBack([{ id: 'c2', body: stored }], 'c2', posted);
  assert.deepEqual(verdict, { ok: true, length: stored.length });
});

test('verifyReadBack: still fails on a genuinely truncated body containing escaped linebreaks', () => {
  const posted = 'a regex sample: \\n matches newline, in full';
  const verdict = verifyReadBack([{ id: 'c2', body: 'a regex sample: \n matches' }], 'c2', posted);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different body/);
});
