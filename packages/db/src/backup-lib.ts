import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  /** Max backups kept in the hourly/short tier; older ones fall into daily-per-day bucketing. Default 6. */
  hourlyCount?: number;
  /**
   * Hard footprint cap in bytes; 0 = unlimited. Default 8 GiB. A backstop, not
   * the primary bound: when exceeded, eviction is tier-aware (hourly bulk goes
   * first) so daily/weekly/monthly restore points survive cap pressure.
   */
  maxBytes?: number;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
  /**
   * Duplicate-producer spacing guard: refuse to dump (throwing
   * BackupProducerConflictError with reason "recent_backup") when the newest
   * existing backup is younger than this. Scheduled producers should pass
   * slightly less than their interval; manual/CLI callers should omit it.
   */
  minIntervalMs?: number;
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
  prunedBytes: number;
};

export type PruneBackupsResult = {
  prunedCount: number;
  prunedBytes: number;
  keptCount: number;
  keptBytes: number;
};

export type BackupProducerConflictReason = "lock_held" | "recent_backup";

/**
 * Thrown when a backup is refused because another producer appears active:
 * either a live cross-process lock is held, or a fresh dump already exists
 * inside the caller's minimum spacing window (AUR-4035: two schedulers were
 * silently doubling backup volume).
 */
export class BackupProducerConflictError extends Error {
  readonly reason: BackupProducerConflictReason;

  constructor(reason: BackupProducerConflictReason, message: string) {
    super(message);
    this.name = "BackupProducerConflictError";
    this.reason = reason;
  }
}

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
};

type SequenceDefinition = {
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: "YES" | "NO";
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
};

type TableDefinition = {
  schema_name: string;
  tablename: string;
};

type ExtensionDefinition = {
  extension_name: string;
  schema_name: string;
};

const DEFAULT_BACKUP_WRITE_BUFFER_BYTES = 1024 * 1024;
const BACKUP_DATA_CURSOR_ROWS = 100;
const BACKUP_CLI_STDERR_BYTES = 64 * 1024;
const BACKUP_BREAKPOINT_DETECT_BYTES = 64 * 1024;

const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO week key for grouping backups by calendar week (ISO 8601).
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

const PRUNE_DEFAULT_HOURLY_COUNT = 6;
const PRUNE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
// Emergency (disk-pressure) overlay: hourly bulk collapses to the newest few,
// byte backstop halves. Daily/weekly/monthly anchors are preserved by the
// tier-aware cap eviction, so DR coverage survives an emergency prune.
const EMERGENCY_PRUNE_HOURLY_COUNT = 2;
const EMERGENCY_PRUNE_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

const EMPTY_PRUNE_RESULT: PruneBackupsResult = { prunedCount: 0, prunedBytes: 0, keptCount: 0, keptBytes: 0 };

function resolveEffectiveRetention(retention: BackupRetentionPolicy): { hourlyCount: number; maxBytes: number } {
  const rawHourlyCount = retention.hourlyCount ?? PRUNE_DEFAULT_HOURLY_COUNT;
  const rawMaxBytes = retention.maxBytes ?? PRUNE_DEFAULT_MAX_BYTES;
  // Env overrides win over stored settings
  const envMaxBytes = process.env.PAPERCLIP_DB_BACKUP_MAX_BYTES ? parseInt(process.env.PAPERCLIP_DB_BACKUP_MAX_BYTES, 10) : NaN;
  const envHourlyCount = process.env.PAPERCLIP_DB_BACKUP_HOURLY_COUNT ? parseInt(process.env.PAPERCLIP_DB_BACKUP_HOURLY_COUNT, 10) : NaN;
  return {
    maxBytes: !isNaN(envMaxBytes) && envMaxBytes >= 0 ? envMaxBytes : rawMaxBytes,
    hourlyCount: Math.max(1, !isNaN(envHourlyCount) && envHourlyCount > 0 ? envHourlyCount : rawHourlyCount),
  };
}

/**
 * @internal exported for unit testing
 * Tiered backup pruning:
 * 1. Hourly/short tier: keep the newest `hourlyCount` backups unconditionally (default 6)
 * 2. Daily tier: for backups within `dailyDays` not in hourly tier, keep newest per calendar day
 * 3. Weekly tier: keep the NEWEST backup per calendar week for `weeklyWeeks` weeks
 * 4. Monthly tier: keep the NEWEST backup per calendar month for `monthlyMonths` months
 * 5. Hard byte cap: if total kept footprint > `maxBytes`, evict in ascending
 *    DR-value order — hourly oldest-first, then daily/weekly/monthly newest-first —
 *    so the oldest restore point per tier survives cap pressure. (AUR-4035: the
 *    previous oldest-first eviction deleted exactly the daily/weekly/monthly
 *    anchors, silently collapsing DR coverage to the hourly window.)
 * 6. Everything else is deleted
 *
 * Under hourly cadence the directory self-bounds to roughly hourlyCount + dailyDays +
 * weeklyWeeks + monthlyMonths instead of 24×dailyDays.
 */
export function pruneOldBackups(backupDir: string, retention: BackupRetentionPolicy, filenamePrefix: string): PruneBackupsResult {
  if (!existsSync(backupDir)) return { ...EMPTY_PRUNE_RESULT };

  const { hourlyCount: effectiveHourlyCount, maxBytes: effectiveMaxBytes } = resolveEffectiveRetention(retention);

  const now = Date.now();
  const dailyCutoff = now - Math.max(1, retention.dailyDays) * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - Math.max(1, retention.weeklyWeeks) * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = now - Math.max(1, retention.monthlyMonths) * 30 * 24 * 60 * 60 * 1000;

  type BackupEntry = { name: string; fullPath: string; mtimeMs: number; sizeBytes: number };
  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    entries.push({ name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
  }

  // Sort newest first so tier buckets always claim the freshest representative
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const kept = new Set<string>();
  type Tier = "hourly" | "daily" | "weekly" | "monthly";
  const tierOf = new Map<string, Tier>();

  // Tier 1: hourly — newest effectiveHourlyCount dumps unconditionally kept
  for (let i = 0; i < Math.min(effectiveHourlyCount, entries.length); i++) {
    kept.add(entries[i]!.fullPath);
    tierOf.set(entries[i]!.fullPath, "hourly");
  }

  // Tier 2: daily — within dailyDays, keep one per calendar day
  const dayBuckets = new Set<string>();
  for (const entry of entries) {
    if (kept.has(entry.fullPath)) continue;
    if (entry.mtimeMs < dailyCutoff) continue;
    const key = dayKey(new Date(entry.mtimeMs));
    if (!dayBuckets.has(key)) {
      dayBuckets.add(key);
      kept.add(entry.fullPath);
      tierOf.set(entry.fullPath, "daily");
    }
  }

  // Tier 3: weekly — within weeklyWeeks but outside dailyDays, newest per ISO week
  const weekBuckets = new Set<string>();
  for (const entry of entries) {
    if (kept.has(entry.fullPath)) continue;
    if (entry.mtimeMs >= dailyCutoff) continue;
    if (entry.mtimeMs < weeklyCutoff) continue;
    const key = isoWeekKey(new Date(entry.mtimeMs));
    if (!weekBuckets.has(key)) {
      weekBuckets.add(key);
      kept.add(entry.fullPath);
      tierOf.set(entry.fullPath, "weekly");
    }
  }

  // Tier 4: monthly — within monthlyMonths but outside weeklyWeeks, newest per month
  const monthBuckets = new Set<string>();
  for (const entry of entries) {
    if (kept.has(entry.fullPath)) continue;
    if (entry.mtimeMs >= weeklyCutoff) continue;
    if (entry.mtimeMs < monthlyCutoff) continue;
    const key = monthKey(new Date(entry.mtimeMs));
    if (!monthBuckets.has(key)) {
      monthBuckets.add(key);
      kept.add(entry.fullPath);
      tierOf.set(entry.fullPath, "monthly");
    }
  }

  // Tier 5: hard byte cap — evict in ascending DR value until under cap.
  // Hourly dumps are near-duplicates of their neighbors, so the hourly tier is
  // drained first (oldest-first: the oldest hourly is closest to daily
  // coverage). Within daily/weekly/monthly the NEWEST is evicted first: it is
  // the one closest to the coverage of the tier above it, while the oldest
  // carries the tier's unique reach-back. The newest dump overall always
  // survives (restore-latest floor).
  if (effectiveMaxBytes > 0) {
    const keptEntries = entries.filter((e) => kept.has(e.fullPath)); // newest first
    let totalBytes = keptEntries.reduce((sum, e) => sum + e.sizeBytes, 0);
    if (totalBytes > effectiveMaxBytes) {
      const beforeBytes = totalBytes;
      const newestPath = keptEntries[0]?.fullPath;
      const inTier = (tier: Tier) => keptEntries.filter((e) => tierOf.get(e.fullPath) === tier);
      const evictionOrder = [
        ...inTier("hourly").reverse(),
        ...inTier("daily"),
        ...inTier("weekly"),
        ...inTier("monthly"),
      ];
      const evicted: string[] = [];
      for (const entry of evictionOrder) {
        if (kept.size <= 1) break;
        if (totalBytes <= effectiveMaxBytes) break;
        if (entry.fullPath === newestPath) continue;
        kept.delete(entry.fullPath);
        evicted.push(entry.name);
        totalBytes -= entry.sizeBytes;
      }
      if (evicted.length > 0) {
        console.warn(
          `[backup] Byte cap enforced: dropped ${evicted.length} dump(s) (before=${formatBytes(beforeBytes)}, after=${formatBytes(totalBytes)}, cap=${formatBytes(effectiveMaxBytes)}): ${evicted.join(", ")}`,
        );
      }
    }
  }

  const toDelete = entries.filter((e) => !kept.has(e.fullPath));
  for (const entry of toDelete) {
    unlinkSync(entry.fullPath);
  }

  const keptFinal = entries.filter((e) => kept.has(e.fullPath));
  return {
    prunedCount: toDelete.length,
    prunedBytes: toDelete.reduce((sum, e) => sum + e.sizeBytes, 0),
    keptCount: keptFinal.length,
    keptBytes: keptFinal.reduce((sum, e) => sum + e.sizeBytes, 0),
  };
}

/**
 * Disk-pressure prune: applies the normal retention ladder with an emergency
 * overlay (hourly tier collapsed to the newest {@link EMERGENCY_PRUNE_HOURLY_COUNT},
 * byte backstop tightened to {@link EMERGENCY_PRUNE_MAX_BYTES}). Because cap
 * eviction is tier-aware, daily/weekly/monthly restore points survive; only the
 * hourly bulk — the near-duplicate mass that actually drives footprint — is
 * released. Returns measured bytes freed so callers can report truthfully
 * (AUR-4035 defect 3: the old "emergency pruning triggered" alert did nothing).
 */
export function emergencyPruneBackups(
  backupDir: string,
  retention: BackupRetentionPolicy,
  filenamePrefix = "paperclip",
): PruneBackupsResult {
  const base = resolveEffectiveRetention(retention);
  return pruneOldBackups(
    backupDir,
    {
      ...retention,
      hourlyCount: Math.min(base.hourlyCount, EMERGENCY_PRUNE_HOURLY_COUNT),
      maxBytes: base.maxBytes > 0 ? Math.min(base.maxBytes, EMERGENCY_PRUNE_MAX_BYTES) : EMERGENCY_PRUNE_MAX_BYTES,
    },
    filenamePrefix,
  );
}

/**
 * Age in ms of the newest backup file in `backupDir` matching the prefix, or
 * null when none exists. Used as a cross-producer spacing guard: a scheduled
 * backup is redundant when any producer has already dumped recently.
 */
export function getNewestBackupAgeMs(backupDir: string, filenamePrefix = "paperclip", nowMs = Date.now()): number | null {
  if (!existsSync(backupDir)) return null;
  let newestMtimeMs: number | null = null;
  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    try {
      const stat = statSync(resolve(backupDir, name));
      if (newestMtimeMs === null || stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    } catch {
      // raced deletion — skip
    }
  }
  return newestMtimeMs === null ? null : Math.max(0, nowMs - newestMtimeMs);
}

// A dump takes ~1 minute; a lock this old belongs to a crashed producer.
const BACKUP_LOCK_STALE_MS = 60 * 60 * 1000;

// In-flight dumps are staged in a dotfile subdirectory of backupDir so pruneOldBackups'
// readdir scan (which only matches `${filenamePrefix}-*.sql(.gz)` entries, never dotfiles)
// can never see — let alone evict — a dump that isn't finished yet (AUR-4644). The
// completed artifact is renameSync'd into backupDir atomically as the very last step.
function inflightStagingDir(backupDir: string, filenamePrefix: string): string {
  return resolve(backupDir, `.${filenamePrefix}-inflight`);
}

// Sweeps staging leftovers from a producer that crashed mid-dump, using the same
// staleness bar as the producer lock so an orphaned partial file doesn't accumulate
// forever in a location pruneOldBackups can't reach.
function sweepStaleStagingFiles(stagingDir: string, staleMs = BACKUP_LOCK_STALE_MS): void {
  if (!existsSync(stagingDir)) return;
  const now = Date.now();
  for (const name of readdirSync(stagingDir)) {
    const fullPath = resolve(stagingDir, name);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > staleMs) unlinkSync(fullPath);
    } catch {
      // raced deletion — skip
    }
  }
}

function backupProducerLockPath(backupDir: string, filenamePrefix: string): string {
  return resolve(backupDir, `.${filenamePrefix}-backup.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process producer lock. The server's in-flight boolean only guards one
 * process; AUR-4035 defect 2 was a second server process doubling backup
 * volume for months. Returns a release function. A held lock from a live pid
 * throws BackupProducerConflictError; stale locks (dead pid, or older than
 * BACKUP_LOCK_STALE_MS when unreadable) are broken.
 */
function acquireBackupProducerLock(backupDir: string, filenamePrefix: string): () => void {
  const lockPath = backupProducerLockPath(backupDir, filenamePrefix);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone — nothing to release
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let holderPid: number | null = null;
      let lockAgeMs = 0;
      try {
        const stat = statSync(lockPath);
        lockAgeMs = Date.now() - stat.mtimeMs;
        const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof parsed?.pid === "number") holderPid = parsed.pid;
      } catch {
        // unreadable or raced away — stale determination falls back to age only
      }

      const stale =
        lockAgeMs > BACKUP_LOCK_STALE_MS ||
        (holderPid !== null && holderPid !== process.pid && !isPidAlive(holderPid));
      if (!stale) {
        throw new BackupProducerConflictError(
          "lock_held",
          `another backup producer holds ${lockPath}${holderPid !== null ? ` (pid ${holderPid})` : ""}`,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // raced with the holder's own release — retry loop handles it
      }
    }
  }

  throw new BackupProducerConflictError("lock_held", `could not acquire ${lockPath} after breaking a stale lock`);
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatSqlLiteral(value: string): string {
  const sanitized = value.replace(/\u0000/g, "");
  let tag = "$paperclip$";
  while (sanitized.includes(tag)) {
    tag = `$paperclip_${Math.random().toString(36).slice(2, 8)}$`;
  }
  return `${tag}${sanitized}${tag}`;
}

function normalizeTableNameSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeTableSelector)
      .filter((value) => value.length > 0),
  );
}

function normalizeTableSelector(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.includes(".") ? trimmed : tableKey("public", trimmed);
}

function normalizeNullifyColumnMap(values: Record<string, string[]> | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!values) return out;
  for (const [tableName, columns] of Object.entries(values)) {
    const normalizedTable = normalizeTableSelector(tableName);
    if (normalizedTable.length === 0) continue;
    const normalizedColumns = new Set(
      columns
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    );
    if (normalizedColumns.size > 0) {
      out.set(normalizedTable, normalizedColumns);
    }
  }
  return out;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function nonSystemSchemaPredicate(identifier: string): string {
  // PostgreSQL reserves pg_ prefixes for system schemas, including temp/toast variants.
  return `${identifier} <> 'information_schema'
    AND ${identifier} NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function hasBackupTransforms(opts: RunDatabaseBackupOptions): boolean {
  return (opts.excludeTables?.length ?? 0) > 0 ||
    Object.keys(opts.nullifyColumns ?? {}).length > 0;
}

function formatSqlValue(rawValue: unknown, columnName: string | undefined, nullifiedColumns: Set<string>): string {
  const val = columnName && nullifiedColumns.has(columnName) ? null : rawValue;
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return formatSqlLiteral(val.toISOString());
  if (typeof val === "object") return formatSqlLiteral(JSON.stringify(val));
  return formatSqlLiteral(String(val));
}

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) {
    throw new Error("pg_dump did not expose stdout");
  }

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin),
  ]);
}

async function restoreWithPsql(opts: RunDatabaseRestoreOptions, connectTimeout: number): Promise<void> {
  const psqlBin = process.env.PAPERCLIP_PSQL_PATH || "psql";
  const child = spawn(
    psqlBin,
    [
      `--dbname=${opts.connectionString}`,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connectTimeout),
      },
    },
  );

  if (!child.stdin) {
    throw new Error("psql did not expose stdin");
  }

  const input = opts.backupFile.endsWith(".gz")
    ? createReadStream(opts.backupFile).pipe(createGunzip())
    : createReadStream(opts.backupFile);

  await Promise.all([
    pipeline(input, child.stdin),
    waitForChildExit(child, psqlBin),
  ]);
}

async function hasStatementBreakpoints(backupFile: string): Promise<boolean> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  let text = "";

  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (Buffer.byteLength(text, "utf8") >= BACKUP_BREAKPOINT_DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

const COPY_FROM_STDIN_RE = /^COPY\s.+FROM\s+stdin;\s*$/i;
const COPY_END_SENTINEL = "\\.";

/**
 * Statement-by-statement restore of a breakpoint-delimited Paperclip dump.
 * COPY blocks are streamed through the driver's copy-in channel: production
 * dumps carry table data as `COPY ... FROM stdin;` + inline rows, which cannot
 * be executed as a plain SQL statement (AUR-4035 DoD 4 exposed this — the JS
 * fallback previously errored on the first data row, leaving hosts without a
 * psql binary unable to restore their own backups).
 */
async function runJavascriptRestore(sql: postgres.Sql, backupFile: string): Promise<void> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  stream.setEncoding("utf8");
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let statementLines: string[] = [];
  let copyWritable: (NodeJS.WritableStream & { destroyed?: boolean }) | null = null;
  let copyError: unknown = null;

  const flushStatement = () => {
    const statement = statementLines.join("\n").trim();
    statementLines = [];
    return statement;
  };

  const writeCopyLine = async (line: string) => {
    if (copyError) throw copyError;
    const target = copyWritable!;
    if (!target.write(`${line}\n`)) {
      await new Promise<void>((resolveDrain, rejectDrain) => {
        const onDrain = () => {
          target.off("error", onError);
          resolveDrain();
        };
        const onError = (err: unknown) => {
          target.off("drain", onDrain);
          rejectDrain(err as Error);
        };
        target.once("drain", onDrain);
        target.once("error", onError);
      });
    }
  };

  const finishCopy = async () => {
    const target = copyWritable!;
    copyWritable = null;
    if (copyError) throw copyError;
    await new Promise<void>((resolveEnd, rejectEnd) => {
      target.once("error", (err: unknown) => rejectEnd(err as Error));
      target.end(() => resolveEnd());
    });
  };

  try {
    for await (const line of reader) {
      if (copyWritable) {
        if (line === COPY_END_SENTINEL) {
          await finishCopy();
        } else {
          await writeCopyLine(line);
        }
        continue;
      }

      if (line === STATEMENT_BREAKPOINT) {
        const statement = flushStatement();
        if (statement.length > 0) {
          await sql.unsafe(statement).execute();
        }
        continue;
      }

      statementLines.push(line);

      if (COPY_FROM_STDIN_RE.test(line)) {
        const copyCommand = flushStatement();
        const writable = await sql.unsafe(copyCommand).writable();
        copyError = null;
        writable.once("error", (err: unknown) => {
          copyError = err;
        });
        copyWritable = writable;
      }
    }

    if (copyWritable) {
      // Truncated dump: COPY block never terminated
      await finishCopy();
      throw new Error("backup file ended inside an unterminated COPY block");
    }

    const trailingStatement = flushStatement();
    if (trailingStatement.length > 0) {
      await sql.unsafe(trailingStatement).execute();
    }
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
}

export function createBufferedTextFileWriter(filePath: string, maxBufferedBytes = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
  const filePromise = openFile(filePath, "w");
  const flushThreshold = Math.max(1, Math.trunc(maxBufferedBytes));
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let firstChunk = true;
  let closed = false;
  let pendingWrite = Promise.resolve();

  const writeChunk = async (chunk: string | Buffer): Promise<void> => {
    const file = await filePromise;
    if (typeof chunk === "string") {
      await file.write(chunk, null, "utf8");
    } else {
      await file.write(chunk);
    }
  };

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const linesToWrite = bufferedLines;
    bufferedLines = [];
    bufferedBytes = 0;
    const chunkBody = linesToWrite.join("\n");
    const chunk = firstChunk ? chunkBody : `\n${chunkBody}`;
    firstChunk = false;
    pendingWrite = pendingWrite.then(() => writeChunk(chunk));
  };

  return {
    emit(line: string) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bufferedBytes >= flushThreshold) {
        flushBufferedLines();
      }
    },
    async drain() {
      if (closed) {
        throw new Error(`Cannot drain closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      await pendingWrite;
    },
    async writeRaw(chunk: string | Buffer) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      firstChunk = false;
      pendingWrite = pendingWrite.then(() => writeChunk(chunk));
      await pendingWrite;
    },
    async close() {
      if (closed) return;
      closed = true;
      flushBufferedLines();
      await pendingWrite;
      const file = await filePromise;
      await file.close();
    },
    async abort() {
      if (closed) return;
      closed = true;
      bufferedLines = [];
      bufferedBytes = 0;
      await pendingWrite.catch(() => {});
      await filePromise.then((file) => file.close()).catch(() => {});
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original backup failure if temporary file cleanup also fails.
        }
      }
    },
  };
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retention = opts.retention;
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const backupEngine = opts.backupEngine ?? "auto";
  const canUsePgDump = !hasBackupTransforms(opts);
  const excludedTableNames = normalizeTableNameSet(opts.excludeTables);
  const nullifiedColumnsByTable = normalizeNullifyColumnMap(opts.nullifyColumns);
  mkdirSync(opts.backupDir, { recursive: true });
  const stagingDir = inflightStagingDir(opts.backupDir, filenamePrefix);
  mkdirSync(stagingDir, { recursive: true });
  sweepStaleStagingFiles(stagingDir);

  // Producer guards run before any client or file is created.
  if (opts.minIntervalMs !== undefined && opts.minIntervalMs > 0) {
    const newestAgeMs = getNewestBackupAgeMs(opts.backupDir, filenamePrefix);
    if (newestAgeMs !== null && newestAgeMs < opts.minIntervalMs) {
      throw new BackupProducerConflictError(
        "recent_backup",
        `newest backup is ${Math.round(newestAgeMs / 1000)}s old (< min spacing ${Math.round(opts.minIntervalMs / 1000)}s) — another producer likely dumped already`,
      );
    }
  }
  const releaseProducerLock = acquireBackupProducerLock(opts.backupDir, filenamePrefix);

  let sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
  let sqlClosed = false;
  const closeSql = async () => {
    if (sqlClosed) return;
    sqlClosed = true;
    await sql.end();
  };
  const stagingSqlFile = resolve(stagingDir, `${filenamePrefix}-${timestamp()}.sql`);
  const stagingGzFile = `${stagingSqlFile}.gz`;
  const finalGzFile = resolve(opts.backupDir, basename(stagingGzFile));
  const writer = createBufferedTextFileWriter(stagingSqlFile);

  try {
    if (backupEngine === "pg_dump" || (backupEngine === "auto" && canUsePgDump)) {
      await sql`SELECT 1`;
      try {
        await closeSql();
        await runPgDumpBackup({
          connectionString: opts.connectionString,
          backupFile: stagingGzFile,
          connectTimeout,
        });
        await writer.abort();
        renameSync(stagingGzFile, finalGzFile);
        const sizeBytes = statSync(finalGzFile).size;
        const pruneResult = pruneOldBackups(opts.backupDir, retention, filenamePrefix);
        return {
          backupFile: finalGzFile,
          sizeBytes,
          prunedCount: pruneResult.prunedCount,
          prunedBytes: pruneResult.prunedBytes,
        };
      } catch (error) {
        if (existsSync(stagingGzFile)) {
          try { unlinkSync(stagingGzFile); } catch { /* ignore */ }
        }
        if (backupEngine === "pg_dump") {
          throw error;
        }
        sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        sqlClosed = false;
      }
    }

    await sql`SELECT 1`;

    const emit = (line: string) => writer.emit(line);
    const emitStatement = (statement: string) => {
      emit(statement);
      emit(STATEMENT_BREAKPOINT);
    };
    const emitStatementBoundary = () => {
      emit(STATEMENT_BREAKPOINT);
    };

    emit("-- Paperclip database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emitStatement("BEGIN;");
    emitStatement("SET LOCAL session_replication_role = replica;");
    emitStatement("SET LOCAL client_min_messages = warning;");
    emit("");

    const allTables = await sql<TableDefinition[]>`
      SELECT table_schema AS schema_name, table_name AS tablename
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND ${sql.unsafe(nonSystemSchemaPredicate("table_schema"))}
      ORDER BY table_schema, table_name
    `;
    const tables = allTables;
    const includedTableNames = new Set(tables.map(({ schema_name, tablename }) => tableKey(schema_name, tablename)));
    const includedSchemas = new Set(tables.map(({ schema_name }) => schema_name));

    // Get all enums
    const enums = await sql<{ schema_name: string; typname: string; labels: string[] }[]>`
      SELECT n.nspname AS schema_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname
    `;
    for (const e of enums) includedSchemas.add(e.schema_name);

    const allSequences = await sql<SequenceDefinition[]>`
      SELECT
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.minimum_value,
        s.maximum_value,
        s.increment,
        s.cycle_option,
        tblns.nspname AS owner_schema,
        tbl.relname AS owner_table,
        attr.attname AS owner_column
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema
      LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
      LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
      LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
      LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("s.sequence_schema"))}
      ORDER BY s.sequence_schema, s.sequence_name
    `;
    const sequences = allSequences.filter(
      (seq) => !seq.owner_table || includedTableNames.has(tableKey(seq.owner_schema ?? "public", seq.owner_table)),
    );

    const schemas = new Set<string>(includedSchemas);
    for (const seq of sequences) schemas.add(seq.sequence_schema);
    const extraSchemas = [...schemas].filter((schemaName) => schemaName !== "public");
    if (extraSchemas.length > 0) {
      emit("-- Schemas");
      for (const schemaName of extraSchemas) {
        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`);
      }
      emit("");
    }

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emitStatement(`CREATE TYPE ${quoteQualifiedName(e.schema_name, e.typname)} AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const extensions = await sql<ExtensionDefinition[]>`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql'
      ORDER BY e.extname
    `;
    if (extensions.length > 0) {
      emit("-- Extensions");
      for (const extension of extensions) {
        emitStatement(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.extension_name)} WITH SCHEMA ${quoteIdentifier(extension.schema_name)};`,
        );
      }
      emit("");
    }

    if (sequences.length > 0) {
      emit("-- Sequences");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        emitStatement(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName} CASCADE;`);
        emitStatement(
          `CREATE SEQUENCE ${qualifiedSequenceName} AS ${seq.data_type} INCREMENT BY ${seq.increment} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value} START WITH ${seq.start_value}${seq.cycle_option === "YES" ? " CYCLE" : " NO CYCLE"};`,
        );
      }
      emit("");
    }

    // Get full CREATE TABLE DDL via column info
    for (const { schema_name, tablename } of tables) {
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const columns = await sql<{
        column_name: string;
        data_type: string;
        udt_schema: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]>`
        SELECT column_name, data_type, udt_schema, udt_name, is_nullable, column_default,
               character_maximum_length, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;

      emit(`-- Table: ${schema_name}.${tablename}`);
      emitStatement(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE;`);

      const colDefs: string[] = [];
      for (const col of columns) {
        let typeStr: string;
        if (col.data_type === "USER-DEFINED") {
          typeStr = quoteQualifiedName(col.udt_schema, col.udt_name);
        } else if (col.data_type === "ARRAY") {
          const elementType = col.udt_name.replace(/^_/, "");
          typeStr = col.udt_schema === "pg_catalog"
            ? `${elementType}[]`
            : `${quoteQualifiedName(col.udt_schema, elementType)}[]`;
        } else if (col.data_type === "character varying") {
          typeStr = col.character_maximum_length
            ? `varchar(${col.character_maximum_length})`
            : "varchar";
        } else if (col.data_type === "numeric" && col.numeric_precision != null) {
          typeStr =
            col.numeric_scale != null
              ? `numeric(${col.numeric_precision}, ${col.numeric_scale})`
              : `numeric(${col.numeric_precision})`;
        } else {
          typeStr = col.data_type;
        }

        let def = `  "${col.column_name}" ${typeStr}`;
        if (col.column_default != null) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === "NO") def += " NOT NULL";
        colDefs.push(def);
      }

      // Primary key
      const pk = await sql<{ constraint_name: string; column_names: string[] }[]>`
        SELECT c.conname AS constraint_name,
               array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE n.nspname = ${schema_name} AND t.relname = ${tablename} AND c.contype = 'p'
        GROUP BY c.conname
      `;
      for (const p of pk) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        colDefs.push(`  CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols})`);
      }

      emit(`CREATE TABLE ${qualifiedTableName} (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emitStatementBoundary();
      emit("");
    }

    const ownedSequences = sequences.filter((seq) => seq.owner_table && seq.owner_column);
    if (ownedSequences.length > 0) {
      emit("-- Sequence ownership");
      for (const seq of ownedSequences) {
        emitStatement(
          `ALTER SEQUENCE ${quoteQualifiedName(seq.sequence_schema, seq.sequence_name)} OWNED BY ${quoteQualifiedName(seq.owner_schema ?? "public", seq.owner_table!)}.${quoteIdentifier(seq.owner_column!)};`,
        );
      }
      emit("");
    }

    // Foreign keys (after all tables created)
    const allForeignKeys = await sql<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      update_rule: string;
      delete_rule: string;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        srcn.nspname AS source_schema,
        src.relname AS source_table,
        array_agg(sa.attname ORDER BY array_position(c.conkey, sa.attnum)) AS source_columns,
        tgtn.nspname AS target_schema,
        tgt.relname AS target_table,
        array_agg(ta.attname ORDER BY array_position(c.confkey, ta.attnum)) AS target_columns,
        CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
        CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = ANY(c.conkey)
      JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = ANY(c.confkey)
      WHERE c.contype = 'f'
        AND ${sql.unsafe(nonSystemSchemaPredicate("srcn.nspname"))}
      GROUP BY c.conname, srcn.nspname, src.relname, tgtn.nspname, tgt.relname, c.confupdtype, c.confdeltype
      ORDER BY srcn.nspname, src.relname, c.conname
    `;
    const fks = allForeignKeys.filter(
      (fk) => includedTableNames.has(tableKey(fk.source_schema, fk.source_table))
        && includedTableNames.has(tableKey(fk.target_schema, fk.target_table)),
    );

    if (fks.length > 0) {
      emit("-- Foreign keys");
      for (const fk of fks) {
        const srcCols = fk.source_columns.map((c) => `"${c}"`).join(", ");
        const tgtCols = fk.target_columns.map((c) => `"${c}"`).join(", ");
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(fk.source_schema, fk.source_table)} ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY (${srcCols}) REFERENCES ${quoteQualifiedName(fk.target_schema, fk.target_table)} (${tgtCols}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`,
        );
      }
      emit("");
    }

    // Unique constraints
    const allUniqueConstraints = await sql<{
      constraint_name: string;
      schema_name: string;
      tablename: string;
      column_names: string[];
    }[]>`
      SELECT c.conname AS constraint_name,
             n.nspname AS schema_name,
             t.relname AS tablename,
             array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'u'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY c.conname, n.nspname, t.relname
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const uniques = allUniqueConstraints.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (uniques.length > 0) {
      emit("-- Unique constraints");
      for (const u of uniques) {
        const cols = u.column_names.map((c) => `"${c}"`).join(", ");
        emitStatement(`ALTER TABLE ${quoteQualifiedName(u.schema_name, u.tablename)} ADD CONSTRAINT "${u.constraint_name}" UNIQUE (${cols});`);
      }
      emit("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const allIndexes = await sql<{ schema_name: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname AS schema_name, tablename, indexdef
      FROM pg_indexes
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("schemaname"))}
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = pg_indexes.schemaname
        )
      ORDER BY schemaname, tablename, indexname
    `;
    const indexes = allIndexes.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (indexes.length > 0) {
      emit("-- Indexes");
      for (const idx of indexes) {
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }

    // Dump data for each table
    for (const { schema_name, tablename } of tables) {
      const currentTableKey = tableKey(schema_name, tablename);
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const count = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${qualifiedTableName}`);
      if (excludedTableNames.has(currentTableKey) || (count[0]?.n ?? 0) === 0) continue;

      // Get column info for this table
      const cols = await sql<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${schema_name}.${tablename} (${count[0]!.n} rows)`);

      const nullifiedColumns = nullifiedColumnsByTable.get(currentTableKey) ?? new Set<string>();
      if (backupEngine !== "javascript" && nullifiedColumns.size === 0) {
        emit(`COPY ${qualifiedTableName} (${colNames}) FROM stdin;`);
        await writer.writeRaw("\n");
        const copySql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        try {
          const copyStream = await copySql
            .unsafe(`COPY ${qualifiedTableName} (${colNames}) TO STDOUT`)
            .readable();
          for await (const chunk of copyStream) {
            await writer.writeRaw(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
        } finally {
          await copySql.end();
        }
        await writer.writeRaw("\\.\n");
        emitStatementBoundary();
        emit("");
        continue;
      }

      const rowCursor = sql
        .unsafe(`SELECT * FROM ${qualifiedTableName}`)
        .values()
        .cursor(BACKUP_DATA_CURSOR_ROWS) as AsyncIterable<unknown[][]>;
      for await (const rows of rowCursor) {
        for (const row of rows) {
          const values = row.map((rawValue, index) =>
            formatSqlValue(rawValue, cols[index]?.column_name, nullifiedColumns),
          );
          emitStatement(`INSERT INTO ${qualifiedTableName} (${colNames}) VALUES (${values.join(", ")});`);
        }
        await writer.drain();
      }
      emit("");
    }

    // Sequence values
    if (sequences.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        const val = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
          `SELECT last_value::text, is_called FROM ${qualifiedSequenceName}`,
        );
        const skipSequenceValue =
          seq.owner_table !== null
            && excludedTableNames.has(seq.owner_table);
        if (val[0] && !skipSequenceValue) {
          emitStatement(`SELECT setval('${qualifiedSequenceName.replaceAll("'", "''")}', ${val[0].last_value}, ${val[0].is_called ? "true" : "false"});`);
        }
      }
      emit("");
    }

    emitStatement("COMMIT;");
    emit("");

    await writer.close();

    // Compress the SQL file with gzip, still fully within the staging dir
    const sqlReadStream = createReadStream(stagingSqlFile);
    const gzWriteStream = createWriteStream(stagingGzFile);
    await pipeline(sqlReadStream, createGzip(), gzWriteStream);
    unlinkSync(stagingSqlFile);

    // Atomic rename is the only moment the dump becomes visible to pruneOldBackups.
    renameSync(stagingGzFile, finalGzFile);
    const sizeBytes = statSync(finalGzFile).size;
    const pruneResult = pruneOldBackups(opts.backupDir, retention, filenamePrefix);

    return {
      backupFile: finalGzFile,
      sizeBytes,
      prunedCount: pruneResult.prunedCount,
      prunedBytes: pruneResult.prunedBytes,
    };
  } catch (error) {
    await writer.abort();
    if (existsSync(stagingGzFile)) {
      try { unlinkSync(stagingGzFile); } catch { /* ignore */ }
    }
    if (existsSync(stagingSqlFile)) {
      try { unlinkSync(stagingSqlFile); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    releaseProducerLock();
    await closeSql();
  }
}

export async function runDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<void> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  try {
    await restoreWithPsql(opts, connectTimeout);
    return;
  } catch (error) {
    if (!(await hasStatementBreakpoints(opts.backupFile))) {
      throw new Error(
        `Failed to restore ${basename(opts.backupFile)} with psql: ${sanitizeRestoreErrorMessage(error)}`,
      );
    }
  }

  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    await sql`SELECT 1`;
    await runJavascriptRestore(sql, opts.backupFile);
  } catch (error) {
    const statementPreview = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).query === "string"
      ? String((error as Record<string, unknown>).query)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("--"))
      : null;
    throw new Error(
      `Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(error)}${statementPreview ? ` [statement: ${statementPreview.slice(0, 120)}]` : ""}`,
    );
  } finally {
    await sql.end();
  }
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0
    ? `; pruned ${result.prunedCount} old backup(s), freed ${formatBytes(result.prunedBytes)}`
    : "";
  return `${result.backupFile} (${size}${pruned})`;
}
