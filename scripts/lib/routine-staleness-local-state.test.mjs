import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLocalState, saveLocalState, stateFilePath, needsAlert } from './routine-staleness-local-state.mjs';

function tmpDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur5042-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loadLocalState returns {} for a fresh host (no state file yet)', async (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(await loadLocalState(dir, 'company-1'), {});
});

test('saveLocalState then loadLocalState round-trips exactly', async (t) => {
  const dir = tmpDir(t);
  const map = { 'routine-a': { alertedForSince: '2026-07-29T12:34:01.894Z', alertedAt: '2026-08-06T13:00:00.000Z', issueId: 'iss-1' } };
  await saveLocalState(dir, 'company-1', map);
  assert.deepEqual(await loadLocalState(dir, 'company-1'), map);
});

test('loadLocalState throws on corrupt JSON rather than silently treating it as empty', async (t) => {
  const dir = tmpDir(t);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(stateFilePath(dir, 'company-1'), '{not json');
  await assert.rejects(() => loadLocalState(dir, 'company-1'), /corrupt/);
});

test('needsAlert: true with no prior entry', () => {
  assert.equal(needsAlert(undefined, '2026-07-29T12:34:01.894Z'), true);
});

test('needsAlert: false once already alerted for the same outage (same `since`)', () => {
  const prev = { alertedForSince: '2026-07-29T12:34:01.894Z', alertedAt: '2026-08-05T00:00:00.000Z', issueId: 'iss-1' };
  assert.equal(needsAlert(prev, '2026-07-29T12:34:01.894Z'), false);
});

test('needsAlert: true again once the routine recovers and then goes stale a second time (`since` advances)', () => {
  const prev = { alertedForSince: '2026-07-29T12:34:01.894Z', alertedAt: '2026-08-05T00:00:00.000Z', issueId: 'iss-1' };
  assert.equal(needsAlert(prev, '2026-08-10T06:30:00.000Z'), true);
});
