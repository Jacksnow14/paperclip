import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeConfigDir, credentialsPath, needsWarming, readExpiresAtFromText } from './oauth-warm.mjs';

test('claudeConfigDir defaults to ~/.claude, honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeConfigDir({}, '/home/ievgen'), '/home/ievgen/.claude');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom' }, '/home/ievgen'), '/custom');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/ievgen'), '/home/ievgen/.claude');
});

test('credentialsPath joins the config dir with .credentials.json', () => {
  assert.equal(credentialsPath({}, '/home/ievgen'), '/home/ievgen/.claude/.credentials.json');
});

test('readExpiresAtFromText extracts claudeAiOauth.expiresAt', () => {
  const raw = JSON.stringify({ claudeAiOauth: { expiresAt: 12345, accessToken: 'x' } });
  assert.equal(readExpiresAtFromText(raw), 12345);
});

test('readExpiresAtFromText returns null when the shape is missing', () => {
  assert.equal(readExpiresAtFromText(JSON.stringify({})), null);
  assert.equal(readExpiresAtFromText(JSON.stringify({ claudeAiOauth: {} })), null);
});

// Matches the CLI's decompiled aTe() buffer: refresh once expiresAt is within
// 5 minutes, not on any looser cadence. See AUR-5864 verification comment.
test('needsWarming is false well outside the 5-minute buffer', () => {
  const nowMs = 1_000_000_000;
  assert.equal(needsWarming({ expiresAt: nowMs + 2 * 60 * 60 * 1000, nowMs }), false);
});

test('needsWarming is true inside the 5-minute buffer', () => {
  const nowMs = 1_000_000_000;
  assert.equal(needsWarming({ expiresAt: nowMs + 4 * 60 * 1000, nowMs }), true);
});

test('needsWarming is true exactly at the 5-minute boundary and past expiry', () => {
  const nowMs = 1_000_000_000;
  assert.equal(needsWarming({ expiresAt: nowMs + 5 * 60 * 1000, nowMs }), true);
  assert.equal(needsWarming({ expiresAt: nowMs - 1, nowMs }), true);
});

test('needsWarming treats an unknown expiresAt as needing attention', () => {
  assert.equal(needsWarming({ expiresAt: null, nowMs: Date.now() }), true);
});
