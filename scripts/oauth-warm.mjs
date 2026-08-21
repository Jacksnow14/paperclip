#!/usr/bin/env node
/**
 * Proactively warm the shared claude_local OAuth session (AUR-5864, child of
 * AUR-5857).
 *
 * Root cause of AUR-5857: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`
 * is ONE file shared by every claude_local agent on the host. Refresh only
 * happens as a side effect of a real inference call landing inside the CLI's
 * own refresh window — and, per the CLI binary
 * (checkAndRefreshOAuthTokenIfNeeded -> aTe()), that window is a HARD 5-minute
 * buffer before expiresAt (`Date.now() + 300000 >= expiresAt`), not the
 * "single-digit-hour" cadence the ticket started from. A warmer that runs
 * every 2-3h would almost always miss that 5-minute window. Verification
 * evidence (decompiled threshold + live tests on the real and on an isolated
 * fake credential) is posted on AUR-5864.
 *
 * So this script runs FREQUENTLY (every ~2min, via the paired systemd timer)
 * but only ever spends a real call when it's actually inside the refresh
 * window — every other tick is a single local JSON read.
 *
 * Never writes to .credentials.json directly (AUR-5864 explicitly forbids
 * this) — only invokes the `claude` CLI itself and lets it manage its own
 * credential file/locking.
 *
 * Exit codes: 0 = fresh (no-op) or refreshed · 2 = refresh needed and failed,
 * or credential file unreadable (loud, never silently masked).
 *
 * Usage:
 *   node scripts/oauth-warm.mjs [--dry-run] [--alert-cmd PATH]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Matches the CLI's own aTe() buffer exactly (see decompilation evidence on
// AUR-5864). Keep this in sync if a future claude CLI version changes it.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function claudeConfigDir(env = process.env, home = os.homedir()) {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(home, '.claude');
}

export function credentialsPath(env = process.env, home = os.homedir()) {
  return path.join(claudeConfigDir(env, home), '.credentials.json');
}

/** Pure: given raw file text, extract claudeAiOauth.expiresAt (ms) or null. */
export function readExpiresAtFromText(raw) {
  const parsed = JSON.parse(raw);
  const oauth = parsed?.claudeAiOauth;
  const expiresAt = oauth?.expiresAt;
  return typeof expiresAt === 'number' ? expiresAt : null;
}

/** Pure: decide whether a warming call is needed right now. */
export function needsWarming({ expiresAt, nowMs, bufferMs = REFRESH_BUFFER_MS }) {
  if (expiresAt === null) return true; // can't tell — treat as needing attention
  return nowMs + bufferMs >= expiresAt;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    alertCmd: '/home/ievgen/bot/telegram-alert.sh',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function readExpiresAtFromDisk(credPath) {
  let raw;
  try {
    raw = readFileSync(credPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${credPath}: ${err.message}`);
  }
  try {
    return readExpiresAtFromText(raw);
  } catch (err) {
    throw new Error(`cannot parse ${credPath}: ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const credPath = credentialsPath();
  const nowMs = Date.now();

  const alert = (msg) => {
    console.error(msg);
    try {
      if (!args.dryRun) execFileSync(args.alertCmd, ['INFO', msg], { timeout: 15_000 });
    } catch {
      /* alerting is best-effort; the stderr line above is the durable record */
    }
  };

  let expiresAt;
  try {
    expiresAt = readExpiresAtFromDisk(credPath);
  } catch (err) {
    alert(`SEV3 oauth-warm: ${err.message} — cannot determine token freshness.`);
    process.exitCode = 2;
    return;
  }

  if (expiresAt === null) {
    alert(`SEV3 oauth-warm: ${credPath} has no claudeAiOauth.expiresAt — cannot determine token freshness.`);
    process.exitCode = 2;
    return;
  }

  const msLeft = expiresAt - nowMs;
  if (!needsWarming({ expiresAt, nowMs })) {
    console.log(`oauth-warm: fresh, ${Math.round(msLeft / 60_000)}min left — no-op.`);
    process.exitCode = 0;
    return;
  }

  console.log(
    `oauth-warm: expiresAt is ${msLeft <= 0 ? 'already past' : `${Math.round(msLeft / 1000)}s away`} — ` +
      (args.dryRun ? 'dry-run, would warm now.' : 'warming now.'),
  );
  if (args.dryRun) {
    process.exitCode = 0;
    return;
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('claude', ['-p', 'Reply with exactly: ok', '--max-turns', '1', '--model', 'haiku'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? err.message ?? '';
  }

  let newExpiresAt = null;
  try {
    newExpiresAt = readExpiresAtFromDisk(credPath);
  } catch (err) {
    alert(`SEV3 oauth-warm: warming call finished (exit ${exitCode}) but ${err.message} on re-read.`);
    process.exitCode = 2;
    return;
  }

  const refreshed = newExpiresAt !== null && newExpiresAt > expiresAt;
  if (exitCode === 0 && refreshed) {
    const newMsLeft = newExpiresAt - Date.now();
    console.log(`oauth-warm: refreshed OK — new expiry ${Math.round(newMsLeft / 60_000)}min out.`);
    process.exitCode = 0;
    return;
  }

  alert(
    `SEV3 oauth-warm: warming call did not refresh the shared claude_local OAuth session ` +
      `(exit=${exitCode}, expiresAt before=${expiresAt} after=${newExpiresAt}). ` +
      `stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`,
  );
  process.exitCode = 2;
}

// Resolve symlinks on process.argv[1] before comparing: Node resolves
// import.meta.url to the entry script's REAL path, but process.argv[1] keeps
// whatever path was given on the command line. Production invokes this via
// /opt/paperclip/app/current/scripts/oauth-warm.mjs, a symlink to a release
// dir — without realpathSync() here the two never match, invokedDirectly is
// always false, and main() silently never runs (AUR-5864 live-verified this
// left the deployed timer a no-op for its first ~3.5h on the host).
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href;
if (invokedDirectly) {
  main();
}
