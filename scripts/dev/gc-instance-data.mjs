#!/usr/bin/env node
// gc-instance-data.mjs — bounded, byte-budgeted GC for paperclip-data instance data (AUR-5100).
//
// The other half of AUR-4998 (worktree reaper): worktrees were reaped, but
// `paperclip-data/instances/<name>` kept growing (20G measured 2026-08-06 — backups 5.2G,
// an unrotated 1.87G server.log, unbounded run-logs). This script governs exactly THREE
// areas inside one instance root, and touches nothing else:
//
//   1. DB backup dumps   <root>/data/backups/<prefix>-YYYYMMDD-HHMMSS.sql(.gz)
//   2. Server log        <root>/logs/server.log            (size-capped copy-truncate rotation)
//   3. Run logs          <root>/data/run-logs/**           (age + byte budget)
//
// RETENTION POLICY (explicit, per AUR-5100):
//   Backups — "keep >= K most-recent AND <= N bytes": the newest --backup-min-keep dumps
//     (default 2) are kept UNCONDITIONALLY (min-keep beats the budget; the newest dump is
//     inviolable). Older dumps are kept newest-first while the cumulative footprint stays
//     under --backup-budget-gib (default 3 GiB). A growing unit size therefore cannot
//     defeat the bound (the AUR-4611 count-ladder lesson).
//     NOTE: the PRIMARY backup bound is the in-app tier-aware pruner
//     (packages/db/src/backup-lib.ts pruneOldBackups, instance settings
//     backupRetention.maxBytes = 2 GiB set under AUR-5100). This script is the
//     OUT-OF-BAND BACKSTOP for when the server is dead or its pruner regresses, so its
//     default budget sits deliberately ABOVE the in-app cap — it only fires when the
//     primary has already failed, and never thins the primary's kept set in steady state.
//   Server log — if logs/server.log exceeds --log-budget-mib (default 256), the last
//     --log-tail-mib (default 64) are gzipped to server.log.prev.gz (one generation,
//     overwritten) and the live file is truncated to 0 in place (same inode — the server
//     holds an O_APPEND fd via pino/sonic-boom, so post-truncate writes land at the new
//     EOF). Lines logged between the tail copy and the truncate are lost; that is the
//     stated, accepted cost of rotating without server cooperation.
//   Run logs — files older than --runlog-age-days (default 14) are deleted; the remainder
//     is kept newest-first under --runlog-budget-mib (default 1024). The newest run-log
//     file is never deleted.
//
// FAIL CLOSED: any check that cannot be evaluated (stat/readdir error, unresolvable
//   root) ⇒ the affected rule is ABORTED for the whole run — it deletes NOTHING and the
//   abort is reported (exit 2). Deleting on partial information is never allowed.
//
// SAFETY (doctrine, not preference):
//   - The instance root must look like an instance root (config.json AND db/PG_VERSION)
//     or the script refuses to run at all (exit 3).
//   - NEVER touched, structurally: <root>/db (a corrupt-DB recovery must stay possible),
//     data/backups/.paperclip-inflight/ (in-flight dumps), the backup producer lock,
//     secrets/, projects/, companies/, workspaces/, data/storage. Every unlink passes
//     assertDeletable(), which requires the realpath to sit under one of the three
//     governed roots and rejects dotfile/lock/inflight paths — a guard tripping throws
//     and aborts the run.
//   - Only plain files are ever unlinked. No directory is ever removed.
//   - Per-run deletion cap: --max-deletions (default 500) across all rules; the cap
//     being hit is reported, never silent. The script is idempotent and converges over
//     scheduled runs.
//   - DRY-RUN BY DEFAULT. Pass --apply to actually delete/rotate.
//   - Nothing is silently truncated in the report: small rule outputs are listed in
//     full; when a run-log deletion list exceeds 40 entries the remainder goes to a
//     complete on-disk report file whose path is printed.
//
// Usage:
//   node scripts/dev/gc-instance-data.mjs [--apply]
//     [--instance-root /home/ievgen/paperclip-data/instances/default]
//     [--backup-prefix paperclip] [--backup-budget-gib 3] [--backup-min-keep 2]
//     [--log-budget-mib 256] [--log-tail-mib 64]
//     [--runlog-age-days 14] [--runlog-budget-mib 1024]
//     [--max-deletions 500] [--report-dir /home/ievgen/paperclip-data/logs]
//
// Exit codes: 0 = ok; 2 = degraded (>=1 rule aborted fail-closed); 3 = refused
//   (instance root failed the identity check).

import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync,
  realpathSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < MIB) return `${(n / 1024).toFixed(1)}KiB`;
  if (n < GIB) return `${(n / MIB).toFixed(1)}MiB`;
  return `${(n / GIB).toFixed(2)}GiB`;
}

// Every unlink in this script must pass through here. Containment is checked on the
// realpath (symlinks cannot smuggle a governed-looking path out of the governed roots),
// and inflight/lock/dot paths are rejected even inside a governed root.
export function assertDeletable(path, governedRootRealpaths) {
  const real = realpathSync(path);
  const contained = governedRootRealpaths.some((root) => real === root || real.startsWith(root + sep));
  if (!contained) throw new Error(`guard tripped: ${path} (real: ${real}) is outside every governed root`);
  if (real.includes(`${sep}.`)) throw new Error(`guard tripped: refusing dotfile/dotdir path ${real}`);
  if (real.includes('inflight') || real.endsWith('.lock')) {
    throw new Error(`guard tripped: refusing inflight/lock path ${real}`);
  }
  if (!statSync(real).isFile()) throw new Error(`guard tripped: ${real} is not a plain file`);
  return real;
}

// Pure planner: entries [{name, sizeBytes, mtimeMs}] -> {keep, del}. Newest minKeep are
// unconditional; older entries kept newest-first while under budgetBytes.
export function planBackupRetention(entries, { budgetBytes, minKeep }) {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const effMinKeep = Math.max(1, minKeep);
  const keep = [];
  const del = [];
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (i < effMinKeep) { keep.push({ ...e, reason: `min-keep newest ${effMinKeep}` }); total += e.sizeBytes; continue; }
    if (total + e.sizeBytes <= budgetBytes) { keep.push({ ...e, reason: 'within byte budget' }); total += e.sizeBytes; continue; }
    del.push({ ...e, reason: `over byte budget (${formatBytes(budgetBytes)})` });
  }
  return { keep, del, keptBytes: total };
}

// Pure planner for run logs: age rule first, then newest-first byte budget over the
// survivors. The newest file overall is never a candidate.
export function planRunLogRetention(files, { maxAgeDays, budgetBytes, nowMs }) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = [];
  const del = [];
  let total = 0;
  const ageCutoffMs = nowMs - maxAgeDays * 86400_000;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (i === 0) { keep.push({ ...e, reason: 'newest run log (inviolable)' }); total += e.sizeBytes; continue; }
    if (e.mtimeMs < ageCutoffMs) { del.push({ ...e, reason: `older than ${maxAgeDays}d` }); continue; }
    if (total + e.sizeBytes <= budgetBytes) { keep.push({ ...e, reason: 'within byte budget' }); total += e.sizeBytes; continue; }
    del.push({ ...e, reason: `over byte budget (${formatBytes(budgetBytes)})` });
  }
  return { keep, del, keptBytes: total };
}

function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const name of readdirSync(cur, { withFileTypes: true })) {
      if (name.name.startsWith('.')) continue; // dot entries are never candidates (inflight dirs, locks, editor droppings)
      const full = join(cur, name.name);
      if (name.isDirectory()) stack.push(full);
      else if (name.isFile()) {
        const st = statSync(full);
        out.push({ name: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}

function duBytes(dir) {
  if (!existsSync(dir)) return null;
  try {
    return listFilesRecursive(dir).reduce((s, f) => s + f.sizeBytes, 0);
  } catch {
    return null;
  }
}

export async function gc(opts) {
  const {
    instanceRoot, apply = false,
    backupPrefix = 'paperclip', backupBudgetBytes = 3 * GIB, backupMinKeep = 2,
    logBudgetBytes = 256 * MIB, logTailBytes = 64 * MIB,
    runLogMaxAgeDays = 14, runLogBudgetBytes = 1024 * MIB,
    maxDeletions = 500, reportDir = '/home/ievgen/paperclip-data/logs',
    log = console.log, error = console.error, nowMs = Date.now(),
  } = opts;

  const root = resolve(instanceRoot);
  // Identity check: refuse to run against anything that does not look like an instance
  // root. (An instance root always carries config.json and an embedded-PG db dir.)
  if (!existsSync(join(root, 'config.json')) || !existsSync(join(root, 'db', 'PG_VERSION'))) {
    error(`REFUSED: ${root} does not look like an instance root (missing config.json or db/PG_VERSION).`);
    return { exitCode: 3, deleted: [], aborted: ['identity'], rotated: false };
  }

  const backupsDir = join(root, 'data', 'backups');
  const logsDir = join(root, 'logs');
  const runLogsDir = join(root, 'data', 'run-logs');
  const governed = [backupsDir, logsDir, runLogsDir].filter(existsSync).map((p) => realpathSync(p));

  const deleted = [];   // { path, sizeBytes, rule }
  const aborted = [];   // rule names that failed closed
  let rotated = false;
  let deletionBudget = maxDeletions;

  const unlinkGoverned = (path, sizeBytes, rule) => {
    if (deletionBudget <= 0) return false;
    // The guard runs in dry-run too, so a dry-run faithfully predicts what --apply does.
    const real = assertDeletable(path, governed);
    if (apply) unlinkSync(real);
    deleted.push({ path, sizeBytes, rule });
    deletionBudget--;
    return true;
  };

  // ---- Rule 1: backups (byte budget + min-keep; newest inviolable) ----
  const backupRe = new RegExp(`^${backupPrefix}-\\d{8}-\\d{6}\\.sql(\\.gz)?$`);
  if (!existsSync(backupsDir)) {
    log(`backups: ${backupsDir} does not exist — nothing to do`);
  } else {
    try {
      const names = readdirSync(backupsDir);
      const entries = [];
      let ignored = 0;
      for (const name of names) {
        if (!backupRe.test(name)) { ignored++; continue; } // dotdirs, locks, foreign files: never candidates
        const full = join(backupsDir, name);
        const st = statSync(full); // a stat error here aborts the whole rule (catch below)
        if (!st.isFile()) { ignored++; continue; }
        entries.push({ name: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      }
      const plan = planBackupRetention(entries, { budgetBytes: backupBudgetBytes, minKeep: backupMinKeep });
      for (const k of plan.keep) log(`KEEP    ${basename(k.name)}  ${formatBytes(k.sizeBytes)}  [${k.reason}]`);
      for (const d of plan.del) {
        const ok = unlinkGoverned(d.name, d.sizeBytes, 'backup-budget');
        log(`${ok ? (apply ? 'DELETE ' : 'DELETE (dry-run)') : 'SKIP (deletion cap)'}  ${basename(d.name)}  ${formatBytes(d.sizeBytes)}  [${d.reason}]`);
      }
      log(`backups: kept ${plan.keep.length} (${formatBytes(plan.keptBytes)}), ${plan.del.length} over budget, ${ignored} non-candidate entr${ignored === 1 ? 'y' : 'ies'} untouched`);
    } catch (e) {
      aborted.push('backups');
      error(`backups rule ABORTED (fail closed, nothing deleted): ${e.message}`);
    }
  }

  // ---- Rule 2: server.log rotation (copy-truncate, one archive generation) ----
  const serverLog = join(logsDir, 'server.log');
  if (!existsSync(serverLog)) {
    log(`server.log: ${serverLog} does not exist — nothing to do`);
  } else {
    try {
      const st = statSync(serverLog);
      if (st.size <= logBudgetBytes) {
        log(`server.log: ${formatBytes(st.size)} <= budget ${formatBytes(logBudgetBytes)} — no rotation`);
      } else if (!apply) {
        log(`ROTATE (dry-run)  server.log ${formatBytes(st.size)} > ${formatBytes(logBudgetBytes)} — would archive last ${formatBytes(logTailBytes)} to server.log.prev.gz and truncate in place`);
      } else {
        const fd = openSync(serverLog, 'r');
        try {
          const size = fstatSync(fd).size; // re-stat via fd: the file is live
          const tailLen = Math.min(logTailBytes, size);
          const buf = Buffer.alloc(tailLen);
          let read = 0;
          while (read < tailLen) {
            const n = readSync(fd, buf, read, tailLen - read, size - tailLen + read);
            if (n === 0) break;
            read += n;
          }
          const archive = join(logsDir, 'server.log.prev.gz');
          const tmp = `${archive}.tmp`;
          writeFileSync(tmp, gzipSync(buf.subarray(0, read)));
          renameSync(tmp, archive);
          truncateSync(serverLog, 0); // same inode; the server's O_APPEND fd keeps working
          rotated = true;
          log(`ROTATED  server.log ${formatBytes(size)} -> 0B; last ${formatBytes(read)} archived to ${basename(archive)} (${formatBytes(statSync(archive).size)} compressed)`);
        } finally {
          closeSync(fd);
        }
      }
    } catch (e) {
      aborted.push('server-log');
      error(`server.log rule ABORTED (fail closed, nothing rotated): ${e.message}`);
    }
  }

  // ---- Rule 3: run logs (age + byte budget; newest inviolable) ----
  if (!existsSync(runLogsDir)) {
    log(`run-logs: ${runLogsDir} does not exist — nothing to do`);
  } else {
    try {
      const files = listFilesRecursive(runLogsDir);
      const plan = planRunLogRetention(files, {
        maxAgeDays: runLogMaxAgeDays, budgetBytes: runLogBudgetBytes, nowMs,
      });
      const shown = plan.del.slice(0, 40);
      const rest = plan.del.slice(40);
      for (const d of shown) {
        const ok = unlinkGoverned(d.name, d.sizeBytes, 'runlog-retention');
        log(`${ok ? (apply ? 'DELETE ' : 'DELETE (dry-run)') : 'SKIP (deletion cap)'}  ${d.name}  ${formatBytes(d.sizeBytes)}  [${d.reason}]`);
      }
      if (rest.length > 0) {
        mkdirSync(reportDir, { recursive: true });
        const reportFile = join(reportDir, `aur5100-runlog-deletions-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}.txt`);
        const lines = [];
        for (const d of rest) {
          const ok = unlinkGoverned(d.name, d.sizeBytes, 'runlog-retention');
          lines.push(`${ok ? (apply ? 'DELETE' : 'DELETE (dry-run)') : 'SKIP (deletion cap)'}  ${d.name}  ${d.sizeBytes}  [${d.reason}]`);
        }
        writeFileSync(reportFile, lines.join('\n') + '\n');
        log(`… and ${rest.length} more run-log deletions — complete list: ${reportFile}`);
      }
      log(`run-logs: kept ${plan.keep.length} (${formatBytes(plan.keptBytes)}), ${plan.del.length} deletion candidate(s)`);
    } catch (e) {
      aborted.push('run-logs');
      error(`run-logs rule ABORTED (fail closed, nothing deleted): ${e.message}`);
    }
  }

  // ---- Report-only: name every other consumer; this script never touches them ----
  log('--- report-only (NEVER touched by this script) ---');
  for (const [label, p] of [
    ['db (never touched — recovery path)', join(root, 'db')],
    ['projects (live agent workspaces)', join(root, 'projects')],
    ['companies', join(root, 'companies')],
    ['workspaces', join(root, 'workspaces')],
    ['data/storage', join(root, 'data', 'storage')],
  ]) {
    const b = duBytes(p);
    log(`REPORT  ${label}: ${b === null ? 'unreadable/absent' : formatBytes(b)}`);
  }

  const freed = deleted.reduce((s, d) => s + d.sizeBytes, 0);
  if (deletionBudget <= 0) log(`NOTE: per-run deletion cap (${maxDeletions}) reached — remaining candidates deferred to the next run.`);
  log(`${apply ? '' : 'DRY-RUN — nothing was deleted or rotated. '}summary: ${deleted.length} file(s) ${apply ? 'deleted' : 'would be deleted'} (${formatBytes(freed)})${rotated ? ', server.log rotated' : ''}${aborted.length > 0 ? `, ${aborted.length} rule(s) ABORTED fail-closed: ${aborted.join(', ')}` : ''}.`);
  return { exitCode: aborted.length > 0 ? 2 : 0, deleted, aborted, rotated, freedBytes: freed };
}

async function mainCli() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'instance-root': { type: 'string', default: '/home/ievgen/paperclip-data/instances/default' },
      'backup-prefix': { type: 'string', default: 'paperclip' },
      'backup-budget-gib': { type: 'string', default: '3' },
      'backup-min-keep': { type: 'string', default: '2' },
      'log-budget-mib': { type: 'string', default: '256' },
      'log-tail-mib': { type: 'string', default: '64' },
      'runlog-age-days': { type: 'string', default: '14' },
      'runlog-budget-mib': { type: 'string', default: '1024' },
      'max-deletions': { type: 'string', default: '500' },
      'report-dir': { type: 'string', default: '/home/ievgen/paperclip-data/logs' },
    },
  });
  const num = (v, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { console.error(`REFUSED: ${label} must be a non-negative number, got ${v}`); process.exit(3); }
    return n;
  };
  const result = await gc({
    instanceRoot: values['instance-root'],
    apply: values.apply,
    backupPrefix: values['backup-prefix'],
    backupBudgetBytes: num(values['backup-budget-gib'], '--backup-budget-gib') * GIB,
    backupMinKeep: num(values['backup-min-keep'], '--backup-min-keep'),
    logBudgetBytes: num(values['log-budget-mib'], '--log-budget-mib') * MIB,
    logTailBytes: num(values['log-tail-mib'], '--log-tail-mib') * MIB,
    runLogMaxAgeDays: num(values['runlog-age-days'], '--runlog-age-days'),
    runLogBudgetBytes: num(values['runlog-budget-mib'], '--runlog-budget-mib') * MIB,
    maxDeletions: num(values['max-deletions'], '--max-deletions'),
    reportDir: values['report-dir'],
  });
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainCli().catch((e) => { console.error(e); process.exit(1); });
}
