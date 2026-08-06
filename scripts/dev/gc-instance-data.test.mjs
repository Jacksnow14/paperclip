// Tests for gc-instance-data.mjs (AUR-5100).
//
// Runs against a DISPOSABLE sandbox instance tree — never against the live instance
// root. Every retention rule is proven both to FIRE (delete/rotate when it applies)
// and to PASS (keep when it does not); a rule that can never clear is as broken as
// one that never fires (AUR-4185 corollary).
//   backup byte budget    FIRE: over-budget dumps deleted oldest-first
//                         PASS: under-budget dir untouched
//   backup min-keep       FIRE: budget 0 still keeps newest K (newest inviolable)
//   non-candidates        PASS: inflight dir, lock, foreign filenames untouched by
//                               an aggressive (budget 0) run
//   server.log rotation   FIRE: oversized log truncated, tail archived, content match
//                         PASS: small log untouched
//   run-log age           FIRE: >maxAgeDays deleted   PASS: fresh file kept
//   run-log byte budget   FIRE: over-budget deleted oldest-first, newest inviolable
//   fail closed           FIRE: unreadable backups dir aborts THAT rule (exit 2),
//                               deletes nothing there, other rules still run
//   identity check        FIRE: non-instance root refused (exit 3)
//   dry-run default       FIRE scenario without --apply deletes nothing
//   deletion cap          FIRE: --max-deletions bounds a run, remainder deferred
//   assertDeletable       FIRE: outside-root / inflight / lock paths throw
//                         PASS: governed backup file resolves
//
// Run: node --test scripts/dev/gc-instance-data.test.mjs

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { assertDeletable, gc, planBackupRetention, planRunLogRetention } from './gc-instance-data.mjs';

const SCRIPT = fileURLToPath(new URL('./gc-instance-data.mjs', import.meta.url));
const KIB = 1024;

let root;

function makeInstanceRoot() {
  const r = mkdtempSync(join(tmpdir(), 'gc5100-sandbox-'));
  mkdirSync(join(r, 'db'), { recursive: true });
  writeFileSync(join(r, 'db', 'PG_VERSION'), '16\n');
  writeFileSync(join(r, 'config.json'), '{}\n');
  mkdirSync(join(r, 'data', 'backups', '.paperclip-inflight'), { recursive: true });
  mkdirSync(join(r, 'data', 'run-logs'), { recursive: true });
  mkdirSync(join(r, 'logs'), { recursive: true });
  return r;
}

// A fake dump: `sizeKib` KiB of filler, mtime `ageDays` in the past.
function addDump(r, stamp, sizeKib, ageDays) {
  const p = join(r, 'data', 'backups', `paperclip-${stamp}.sql.gz`);
  writeFileSync(p, Buffer.alloc(sizeKib * KIB, 0x61));
  const t = new Date(Date.now() - ageDays * 86400_000);
  utimesSync(p, t, t);
  return p;
}

function addRunLog(r, rel, sizeKib, ageDays) {
  const p = join(r, 'data', 'run-logs', rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(sizeKib * KIB, 0x62));
  const t = new Date(Date.now() - ageDays * 86400_000);
  utimesSync(p, t, t);
  return p;
}

function runGc(overrides = {}) {
  const lines = [];
  const errs = [];
  return gc({
    instanceRoot: root,
    apply: true,
    backupBudgetBytes: 100 * KIB,
    backupMinKeep: 2,
    logBudgetBytes: 100 * KIB,
    logTailBytes: 10 * KIB,
    runLogMaxAgeDays: 14,
    runLogBudgetBytes: 100 * KIB,
    reportDir: join(root, 'gc-reports'),
    log: (m) => lines.push(m),
    error: (m) => errs.push(m),
    ...overrides,
  }).then((res) => ({ ...res, out: lines.join('\n'), err: errs.join('\n') }));
}

beforeEach(() => { root = makeInstanceRoot(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// ---------- planners (pure) ----------

test('planBackupRetention: budget boundary is inclusive; one byte over evicts', () => {
  const entries = [
    { name: 'new', sizeBytes: 60, mtimeMs: 3000 },
    { name: 'mid', sizeBytes: 40, mtimeMs: 2000 },
    { name: 'old', sizeBytes: 1, mtimeMs: 1000 },
  ];
  const exact = planBackupRetention(entries, { budgetBytes: 101, minKeep: 1 });
  assert.deepEqual(exact.del, []);
  const over = planBackupRetention(entries, { budgetBytes: 100, minKeep: 1 });
  assert.deepEqual(over.del.map((d) => d.name), ['old']);
});

test('planBackupRetention: min-keep beats budget and newest is inviolable at budget 0', () => {
  const entries = [
    { name: 'n1', sizeBytes: 50, mtimeMs: 3000 },
    { name: 'n2', sizeBytes: 50, mtimeMs: 2000 },
    { name: 'n3', sizeBytes: 50, mtimeMs: 1000 },
  ];
  const p = planBackupRetention(entries, { budgetBytes: 0, minKeep: 2 });
  assert.deepEqual(p.keep.map((k) => k.name), ['n1', 'n2']);
  assert.deepEqual(p.del.map((d) => d.name), ['n3']);
  const p1 = planBackupRetention(entries, { budgetBytes: 0, minKeep: 0 }); // clamped to 1
  assert.equal(p1.keep[0].name, 'n1');
  assert.deepEqual(p1.del.map((d) => d.name), ['n2', 'n3']);
});

test('planRunLogRetention: age fires before budget; newest inviolable', () => {
  const now = Date.now();
  const files = [
    { name: 'newest', sizeBytes: 80, mtimeMs: now - 1000 },
    { name: 'recent-big', sizeBytes: 80, mtimeMs: now - 2000 },
    { name: 'ancient', sizeBytes: 1, mtimeMs: now - 20 * 86400_000 },
  ];
  const p = planRunLogRetention(files, { maxAgeDays: 14, budgetBytes: 100, nowMs: now });
  assert.deepEqual(p.keep.map((k) => k.name), ['newest']);
  assert.equal(p.del.find((d) => d.name === 'ancient').reason, 'older than 14d');
  assert.match(p.del.find((d) => d.name === 'recent-big').reason, /over byte budget/);
});

// ---------- backups rule ----------

test('backup budget FIRE: over-budget dumps deleted oldest-first; PASS: survivors intact', async () => {
  const keepA = addDump(root, '20260806-170000', 40, 0);
  const keepB = addDump(root, '20260806-160000', 40, 0.1);
  const evict1 = addDump(root, '20260805-160000', 40, 1);
  const evict2 = addDump(root, '20260804-160000', 40, 2);
  const res = await runGc(); // budget 100KiB, minKeep 2: keeps 40+40, evicts the two older
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.deleted.map((d) => d.path).sort(), [evict1, evict2].sort());
  assert.ok(existsSync(keepA) && existsSync(keepB));
  assert.ok(!existsSync(evict1) && !existsSync(evict2));
});

test('backup budget PASS: under-budget dir is untouched', async () => {
  addDump(root, '20260806-170000', 30, 0);
  addDump(root, '20260805-170000', 30, 1);
  const res = await runGc();
  assert.equal(res.exitCode, 0);
  assert.equal(res.deleted.length, 0);
});

test('newest dump survives even a zero budget with minKeep 1', async () => {
  const newest = addDump(root, '20260806-170000', 500, 0);
  addDump(root, '20260805-170000', 500, 1);
  const res = await runGc({ backupBudgetBytes: 0, backupMinKeep: 1 });
  assert.ok(existsSync(newest), 'newest dump must never be a candidate');
  assert.equal(res.deleted.length, 1);
});

test('non-candidates PASS: inflight, lock, foreign files survive an aggressive run', async () => {
  const inflight = join(root, 'data', 'backups', '.paperclip-inflight', 'paperclip-20260806-180000.sql.gz');
  writeFileSync(inflight, Buffer.alloc(64 * KIB));
  const lock = join(root, 'data', 'backups', '.paperclip-backup.lock');
  writeFileSync(lock, '{}');
  const foreign = join(root, 'data', 'backups', 'random-notes.txt');
  writeFileSync(foreign, 'not a dump');
  const otherPrefix = join(root, 'data', 'backups', 'otherapp-20260101-000000.sql.gz');
  writeFileSync(otherPrefix, Buffer.alloc(64 * KIB));
  const newest = addDump(root, '20260806-170000', 10, 0);
  const res = await runGc({ backupBudgetBytes: 0, backupMinKeep: 1 });
  assert.equal(res.exitCode, 0);
  for (const p of [inflight, lock, foreign, otherPrefix, newest]) {
    assert.ok(existsSync(p), `${p} must survive`);
  }
});

// ---------- server.log rotation ----------

test('server.log rotation FIRE: truncates in place and archives the exact tail', async () => {
  const logPath = join(root, 'logs', 'server.log');
  const content = Buffer.alloc(200 * KIB);
  for (let i = 0; i < content.length; i += 8) content.writeUInt32BE(i, i); // position-dependent content
  writeFileSync(logPath, content);
  const res = await runGc(); // budget 100KiB, tail 10KiB
  assert.equal(res.exitCode, 0);
  assert.equal(res.rotated, true);
  assert.equal(statSync(logPath).size, 0, 'live log truncated in place');
  const archived = gunzipSync(readFileSync(join(root, 'logs', 'server.log.prev.gz')));
  assert.deepEqual(archived, content.subarray(content.length - 10 * KIB), 'archive holds exactly the last tail bytes');
});

test('server.log rotation PASS: file within budget is untouched', async () => {
  const logPath = join(root, 'logs', 'server.log');
  writeFileSync(logPath, Buffer.alloc(50 * KIB, 0x63));
  const res = await runGc();
  assert.equal(res.rotated, false);
  assert.equal(statSync(logPath).size, 50 * KIB);
});

// ---------- run-logs rule ----------

test('run-log age FIRE / fresh PASS, budget FIRE with newest inviolable', async () => {
  const ancient = addRunLog(root, 'co1/agent1/ancient.ndjson', 1, 20);
  const fresh = addRunLog(root, 'co1/agent1/fresh.ndjson', 1, 1);
  const newest = addRunLog(root, 'co1/agent2/newest.ndjson', 90, 0);
  const big = addRunLog(root, 'co1/agent2/big-older.ndjson', 90, 2);
  const res = await runGc(); // age 14d, budget 100KiB
  assert.equal(res.exitCode, 0);
  assert.ok(!existsSync(ancient), 'over-age file deleted');
  assert.ok(existsSync(fresh), 'fresh small file kept');
  assert.ok(existsSync(newest), 'newest run log inviolable');
  assert.ok(!existsSync(big), 'over-budget older file deleted');
});

// ---------- fail closed / identity / dry-run / cap ----------

test('fail closed FIRE: unreadable backups dir aborts that rule only; exit 2; nothing deleted there', async () => {
  const dump = addDump(root, '20260101-000000', 500, 200);
  const logPath = join(root, 'logs', 'server.log');
  writeFileSync(logPath, Buffer.alloc(200 * KIB, 0x64));
  const backupsDir = join(root, 'data', 'backups');
  chmodSync(backupsDir, 0o000);
  try {
    const res = await runGc({ backupBudgetBytes: 0, backupMinKeep: 1 });
    assert.equal(res.exitCode, 2, 'degraded exit');
    assert.deepEqual(res.aborted, ['backups']);
    assert.equal(res.rotated, true, 'independent rules still run');
    assert.match(res.err, /backups rule ABORTED/);
  } finally {
    chmodSync(backupsDir, 0o755);
  }
  assert.ok(existsSync(dump), 'no deletion under fail-closed abort');
});

test('identity FIRE: refuses a root that is not an instance root', () => {
  const notRoot = mkdtempSync(join(tmpdir(), 'gc5100-notroot-'));
  const stray = join(notRoot, 'data', 'backups');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, 'paperclip-20260101-000000.sql.gz'), Buffer.alloc(KIB));
  const r = spawnSync(process.execPath, [SCRIPT, '--apply', '--instance-root', notRoot, '--backup-budget-gib', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /REFUSED/);
  assert.ok(existsSync(join(stray, 'paperclip-20260101-000000.sql.gz')));
  rmSync(notRoot, { recursive: true, force: true });
});

test('dry-run is the default: FIRE scenario deletes and rotates nothing via CLI', () => {
  const evictable = addDump(root, '20260101-000000', 200, 200);
  addDump(root, '20260806-170000', 200, 0);
  const logPath = join(root, 'logs', 'server.log');
  writeFileSync(logPath, Buffer.alloc(300 * KIB, 0x65));
  const r = spawnSync(process.execPath, [
    SCRIPT, '--instance-root', root, '--backup-budget-gib', '0', '--backup-min-keep', '1', '--log-budget-mib', '0.1',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY-RUN — nothing was deleted or rotated/);
  assert.ok(existsSync(evictable), 'dry-run must not delete');
  assert.equal(statSync(logPath).size, 300 * KIB, 'dry-run must not rotate');
});

test('deletion cap FIRE: --max-deletions bounds the run and reports the deferral', async () => {
  addDump(root, '20260806-170000', 10, 0);
  addDump(root, '20260101-000000', 10, 200);
  addDump(root, '20260102-000000', 10, 199);
  addDump(root, '20260103-000000', 10, 198);
  const res = await runGc({ backupBudgetBytes: 0, backupMinKeep: 1, maxDeletions: 1 });
  assert.equal(res.deleted.length, 1);
  assert.match(res.out, /deletion cap/);
});

// ---------- assertDeletable guard ----------

test('assertDeletable FIRE: outside root, inflight, lock and non-file all throw; PASS: governed file resolves', () => {
  const backupsDir = realpathSync(join(root, 'data', 'backups'));
  const governed = [backupsDir];
  const dump = addDump(root, '20260806-170000', 1, 0);
  assert.equal(assertDeletable(dump, governed), realpathSync(dump));
  assert.throws(() => assertDeletable(join(root, 'db', 'PG_VERSION'), governed), /outside every governed root/);
  const inflight = join(backupsDir, '.paperclip-inflight', 'x.sql.gz');
  writeFileSync(inflight, 'x');
  assert.throws(() => assertDeletable(inflight, governed), /guard tripped/);
  const lock = join(backupsDir, 'producer.lock');
  writeFileSync(lock, 'x');
  assert.throws(() => assertDeletable(lock, governed), /inflight\/lock/);
  assert.throws(() => assertDeletable(backupsDir, governed), /not a plain file/);
});
