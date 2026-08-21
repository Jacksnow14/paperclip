import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeConfigDir, credentialsPath, needsWarming, readExpiresAtFromText } from './oauth-warm.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./oauth-warm.mjs', import.meta.url));

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

// Regression for the stdout/exit race: every unit test above calls the
// exported pure functions directly, never the actual process.exit() path in
// main(). That gap let a real bug through — console.log() immediately
// followed by process.exit() drops the write whenever stdout is a
// non-TTY pipe (systemd's journal socket, exactly the production case),
// because the write is async and exit() doesn't wait for it. Spawning the
// real script with piped (non-TTY) stdio is the only way to catch that
// class of bug; calling main() in-process with a TTY stdout would not.
test('spawned as a real subprocess with piped (non-TTY) stdio, the no-op path\'s console.log output survives to stdout', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oauth-warm-test-'));
  try {
    const farFutureMs = Date.now() + 2 * 60 * 60 * 1000; // 2h out, well outside the 5-min buffer
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { expiresAt: farFutureMs, accessToken: 'fake', refreshToken: 'fake' } }),
    );

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--dry-run'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      encoding: 'utf8',
      stdio: 'pipe',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /oauth-warm: fresh, \d+min left — no-op\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression for the symlink-invocation bug: production runs this script via
// /opt/paperclip/app/current/scripts/oauth-warm.mjs, a symlink into a
// release dir (see scripts/deploy/systemd/paperclip-oauth-warm.service).
// Node resolves import.meta.url to the REAL path for a symlinked entry
// script, but leaves process.argv[1] as the symlink path — so an
// unqualified `import.meta.url === new URL('file://' + process.argv[1])`
// comparison never matches, invokedDirectly is always false, and main()
// silently never runs. This left the live AUR-5864 timer a complete no-op
// for its first ~3.5h on the host (100+ ticks, exit 0 every time, zero
// actual work) — spawning the real script through an actual symlink is the
// only way to catch this; the un-symlinked spawn test above cannot.
test('spawned through a symlink (matching the production ExecStart path), main() still runs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oauth-warm-test-'));
  try {
    const farFutureMs = Date.now() + 2 * 60 * 60 * 1000; // 2h out, well outside the 5-min buffer
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { expiresAt: farFutureMs, accessToken: 'fake', refreshToken: 'fake' } }),
    );

    const symlinkPath = path.join(dir, 'oauth-warm-symlink.mjs');
    symlinkSync(SCRIPT_PATH, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath, '--dry-run'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      encoding: 'utf8',
      stdio: 'pipe',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /oauth-warm: fresh, \d+min left — no-op\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
