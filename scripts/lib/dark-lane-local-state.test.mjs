import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLocalState, saveLocalState, stateFilePath } from './dark-lane-local-state.mjs';

function tmpDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur5027-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loadLocalState returns {} for a company with no state file yet (fresh host)', async (t) => {
  const dir = tmpDir(t);
  const state = await loadLocalState(dir, 'company-1');
  assert.deepEqual(state, {});
});

test('saveLocalState then loadLocalState round-trips the exact map', async (t) => {
  const dir = tmpDir(t);
  const map = { agentA: { active: true, alertedAt: '2026-08-05T12:00:00.000Z' } };
  await saveLocalState(dir, 'company-1', map);
  const loaded = await loadLocalState(dir, 'company-1');
  assert.deepEqual(loaded, map);
});

test('state is keyed by companyId — two companies never see each other\'s state', async (t) => {
  const dir = tmpDir(t);
  await saveLocalState(dir, 'company-1', { a1: { active: true } });
  await saveLocalState(dir, 'company-2', { a1: { active: false } });
  assert.deepEqual(await loadLocalState(dir, 'company-1'), { a1: { active: true } });
  assert.deepEqual(await loadLocalState(dir, 'company-2'), { a1: { active: false } });
});

test('loadLocalState throws on corrupt JSON rather than silently treating it as empty', async (t) => {
  const dir = tmpDir(t);
  writeFileSync(stateFilePath(dir, 'company-1'), '{not json');
  await assert.rejects(() => loadLocalState(dir, 'company-1'), /corrupt/);
});

test('saveLocalState leaves no leftover .tmp file after a successful write', async (t) => {
  const dir = tmpDir(t);
  await saveLocalState(dir, 'company-1', { a1: { active: true } });
  const raw = readFileSync(stateFilePath(dir, 'company-1'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { a1: { active: true } });
});
