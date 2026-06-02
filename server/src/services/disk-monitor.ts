import { statfsSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../middleware/logger.js";

export interface DiskStats {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface BackupDirStats {
  totalSizeBytes: number;
  fileCount: number;
}

export interface DiskMonitorThresholds {
  warnPercent: number; // default 80
  actPercent: number;  // default 90
}

export interface DiskCheckResult {
  diskStats: DiskStats;
  backupDirStats: BackupDirStats;
  childProcessCount: number;
  thresholds: DiskMonitorThresholds;
  warning: boolean;
  act: boolean;
}

const DEFAULT_THRESHOLDS: DiskMonitorThresholds = {
  warnPercent: 80,
  actPercent: 90,
};

// Module-level pressure state — process-global, lifted when disk recovers
let _diskPressureActive = false;
let _lastAlertMs = 0;
const ALERT_DEDUP_MS = 60 * 60 * 1000; // suppress duplicate CEO alerts for 1 h

export function isDiskPressureActive(): boolean {
  return _diskPressureActive;
}

export function setDiskPressureActive(active: boolean): void {
  _diskPressureActive = active;
}

export function getDiskStats(dir: string): DiskStats {
  const fs = statfsSync(dir);
  const totalBytes = fs.blocks * fs.bsize;
  const freeBytes = fs.bfree * fs.bsize;
  const usedBytes = totalBytes - freeBytes;
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return { totalBytes, freeBytes, usedBytes, usedPercent };
}

export function getBackupDirStats(backupDir: string, filenamePrefix = "paperclip"): BackupDirStats {
  if (!existsSync(backupDir)) return { totalSizeBytes: 0, fileCount: 0 };
  let totalSizeBytes = 0;
  let fileCount = 0;
  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    try {
      const stat = statSync(resolve(backupDir, name));
      totalSizeBytes += stat.size;
      fileCount++;
    } catch {
      // skip unreadable entries
    }
  }
  return { totalSizeBytes, fileCount };
}

/** Estimate child + zombie process count via /proc on Linux. */
export function getChildProcessCount(): number {
  try {
    const pid = process.pid;
    let count = 0;
    const procDir = "/proc";
    if (!existsSync(procDir)) return 0;
    for (const entry of readdirSync(procDir)) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const statusPath = resolve(procDir, entry, "status");
        const content = readFileSync(statusPath, "utf8");
        const ppidMatch = /^PPid:\s+(\d+)/m.exec(content);
        if (ppidMatch && parseInt(ppidMatch[1]!, 10) === pid) {
          count++;
        }
      } catch {
        // ignore unreadable proc entries
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function checkDisk(
  dir: string,
  backupDir: string,
  thresholds: DiskMonitorThresholds = DEFAULT_THRESHOLDS,
): DiskCheckResult {
  const diskStats = getDiskStats(dir);
  const backupDirStats = getBackupDirStats(backupDir);
  const childProcessCount = getChildProcessCount();
  const warning = diskStats.usedPercent >= thresholds.warnPercent;
  const act = diskStats.usedPercent >= thresholds.actPercent;
  return { diskStats, backupDirStats, childProcessCount, thresholds, warning, act };
}

export function formatDiskReport(result: DiskCheckResult): string {
  const { diskStats, backupDirStats, childProcessCount } = result;
  const freeGb = (diskStats.freeBytes / (1024 ** 3)).toFixed(2);
  const backupMb = (backupDirStats.totalSizeBytes / (1024 ** 2)).toFixed(1);
  return [
    `disk=${diskStats.usedPercent.toFixed(1)}% used`,
    `free=${freeGb}GiB`,
    `backup-dir=${backupMb}MiB (${backupDirStats.fileCount} files)`,
    `child-procs=${childProcessCount}`,
  ].join(", ");
}

/**
 * Check disk pressure, update module state, and log. Returns the check result.
 * Call periodically (e.g. every 60 s) from server startup code.
 */
export function updateDiskPressure(
  dir: string,
  backupDir: string,
  thresholds: DiskMonitorThresholds = DEFAULT_THRESHOLDS,
): DiskCheckResult {
  let result: DiskCheckResult;
  try {
    result = checkDisk(dir, backupDir, thresholds);
  } catch (err) {
    logger.warn({ err }, "disk-monitor: failed to read disk stats");
    return {
      diskStats: { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0 },
      backupDirStats: { totalSizeBytes: 0, fileCount: 0 },
      childProcessCount: 0,
      thresholds,
      warning: false,
      act: false,
    };
  }

  if (result.act) {
    logger.error(
      { usedPercent: result.diskStats.usedPercent, report: formatDiskReport(result) },
      "disk-monitor: CRITICAL disk usage >= act threshold — throttling non-critical run admission",
    );
    _diskPressureActive = true;
  } else {
    if (_diskPressureActive) {
      logger.info("disk-monitor: disk usage recovered below act threshold — lifting run throttle");
    }
    _diskPressureActive = false;
    if (result.warning) {
      logger.warn(
        { usedPercent: result.diskStats.usedPercent, report: formatDiskReport(result) },
        "disk-monitor: disk usage >= warn threshold",
      );
    }
  }

  return result;
}

/** Returns true if a CEO alert should fire (deduped: at most once per ALERT_DEDUP_MS). */
export function shouldFireCeoAlert(): boolean {
  const now = Date.now();
  if (now - _lastAlertMs < ALERT_DEDUP_MS) return false;
  _lastAlertMs = now;
  return true;
}
