import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { logger } from "../middleware/logger.js";

/**
 * Artifact retention extends the AUR-1713 disk guardrail to per-directory
 * work-product trees (run outputs, caches, build artifacts, rotating pools, logs).
 *
 * Hard safety rules:
 *   - Default mode is `dry_run`: rules are evaluated and reported but NOTHING is deleted.
 *   - Active deletion requires the directory path to be listed in `activeDirs` AND
 *     `dryRun` to be false on the call.
 *   - `excludeAlways` paths are always skipped; protective override.
 *   - The rule's own deliverable conditions (requireFile / excludeIfFile /
 *     requirePairedSiblings) gate selection before age/count/byte caps apply.
 */

export type ArtifactDirKind =
  | "cache"            // re-downloadable working set (e.g. yt-dl downloads)
  | "run_output"       // per-run intermediate output dirs
  | "debug"            // ad-hoc debug captures
  | "rotating_pool"    // spent-clip pool (assets/bg/used)
  | "log"              // rotatable log files
  | "build_artifact"   // compiler / bundler output (target/, .next/, etc.)
  | "deliverable_with_floor"; // keep at least N days, then rotatable

export type ArtifactEntryShape = "subdir" | "file";

export interface RequirePairedSiblings {
  /** Directory to scan for siblings. */
  dir: string;
  /** Glob-ish pattern; `{basename}` is substituted with the candidate's basename without extension. */
  pattern: string;
  /** Minimum sibling count required for the candidate to be prunable. */
  minCount: number;
}

export interface ArtifactDirRule {
  /** Absolute path to the directory. `~` is expanded by the caller. */
  path: string;
  kind: ArtifactDirKind;
  /** Treat each entry as a subdir or a loose file. */
  shape: ArtifactEntryShape;
  /** Optional filename filter (substring or simple "*.ext" glob). */
  pattern?: string;
  /** Age window in days; entries older than this are candidates. 0 means "any age". */
  maxAgeDays?: number;
  /** Count cap; if there are more than this many entries, oldest above the cap are candidates. */
  maxCount?: number;
  /** Hard byte cap for the entire dir; oldest entries dropped until under cap. */
  maxBytes?: number;
  /** Only act when disk pressure is currently active (act-threshold). */
  pressureOnly?: boolean;
  /** Candidate must contain this file in its tree (subdir shape only). */
  requireFile?: string;
  /** Candidate must NOT contain this file in its tree (subdir shape only). */
  excludeIfFile?: string;
  /** Runtime gate: candidate is only prunable if N matching siblings already exist elsewhere. */
  requirePairedSiblings?: RequirePairedSiblings;
}

export interface ArtifactRetentionConfig {
  enabled: boolean;
  dirs: ArtifactDirRule[];
  /** Path prefixes that are NEVER eligible regardless of any rule. */
  excludeAlways: string[];
  /**
   * Explicit allowlist of paths where active deletion is permitted. Paths not
   * listed here are evaluated and reported but never deleted, even when
   * `dryRun=false`. This is the board-approval gate (HARD requirement).
   */
  activeDirs: string[];
}

export const DEFAULT_ARTIFACT_RETENTION: ArtifactRetentionConfig = {
  enabled: false,
  dirs: [],
  excludeAlways: [],
  activeDirs: [],
};

export interface ArtifactEntry {
  fullPath: string;
  name: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ArtifactDirReport {
  path: string;
  kind: ArtifactDirKind;
  totalBytes: number;
  totalEntries: number;
  prunableEntries: number;
  prunableBytes: number;
  prunedEntries: number;       // 0 unless active
  prunedBytes: number;         // 0 unless active
  mode: "active" | "dry_run" | "skipped_disabled" | "skipped_missing" | "skipped_excluded" | "skipped_pressure";
  ruleSummary: string;
  selectedNames: string[];     // names of entries selected for pruning (capped to 10 for log brevity)
}

export interface ArtifactRetentionReport {
  generatedAt: string;
  dirs: ArtifactDirReport[];
  totalReclaimableBytes: number;
  totalReclaimedBytes: number;
}

export interface RunArtifactRetentionOptions {
  /** When true (default), only report — do not delete. */
  dryRun?: boolean;
  /** When true, the disk guardrail is currently in pressure (>= act threshold). */
  diskPressureActive?: boolean;
}

const GIB = 1024 ** 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  return `${(bytes / GIB).toFixed(2)}GiB`;
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith("*.")) {
    return name.endsWith(pattern.slice(1));
  }
  return name.includes(pattern);
}

function isExcludedByPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/** Recursive size — used only for subdir shape. Bounded by `maxDepth` to keep cheap. */
function dirSizeBytes(dir: string, maxDepth = 6): number {
  let total = 0;
  const stack: Array<{ p: string; d: number }> = [{ p: dir, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = resolve(p, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (d < maxDepth) stack.push({ p: full, d: d + 1 });
      } else {
        total += st.size;
      }
    }
  }
  return total;
}

function containsFile(dir: string, filename: string, maxDepth = 4): boolean {
  const stack: Array<{ p: string; d: number }> = [{ p: dir, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === filename) return true;
      if (d < maxDepth) {
        const full = resolve(p, name);
        try {
          if (statSync(full).isDirectory()) stack.push({ p: full, d: d + 1 });
        } catch {
          // ignore
        }
      }
    }
  }
  return false;
}

function pairedSiblingsSatisfied(entry: ArtifactEntry, rule: RequirePairedSiblings): boolean {
  let entries: string[];
  try {
    entries = readdirSync(rule.dir);
  } catch {
    return false;
  }
  const stem = basename(entry.name).replace(/\.[^.]+$/, "");
  const needle = rule.pattern.replace(/\{basename\}/g, stem);
  // Simple wildcard: support trailing `*` and `*` inside the string.
  const regex = new RegExp(
    "^" +
      needle
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  let count = 0;
  for (const name of entries) {
    if (regex.test(name)) {
      count++;
      if (count >= rule.minCount) return true;
    }
  }
  return false;
}

export function scanArtifactDir(rule: ArtifactDirRule): ArtifactEntry[] {
  if (!existsSync(rule.path)) return [];
  const entries: ArtifactEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(rule.path);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!matchesPattern(name, rule.pattern)) continue;
    const fullPath = resolve(rule.path, name);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (rule.shape === "subdir" && !st.isDirectory()) continue;
    if (rule.shape === "file" && !st.isFile()) continue;
    const sizeBytes = rule.shape === "subdir" ? dirSizeBytes(fullPath) : st.size;
    entries.push({ fullPath, name, mtimeMs: st.mtimeMs, sizeBytes });
  }
  // Newest first
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/**
 * Select prunable entries for a rule. Returns the entries to delete (oldest first).
 * Pure function over the supplied entries — does no IO except runtime-condition checks
 * (requireFile / excludeIfFile / requirePairedSiblings).
 */
export function selectPrunableEntries(
  rule: ArtifactDirRule,
  entries: ArtifactEntry[],
  now: number = Date.now(),
): ArtifactEntry[] {
  // Apply runtime conditions: an entry is only ELIGIBLE for pruning if its gates pass.
  const eligible: ArtifactEntry[] = [];
  for (const entry of entries) {
    if (rule.requireFile && rule.shape === "subdir") {
      if (!containsFile(entry.fullPath, rule.requireFile)) continue;
    }
    if (rule.excludeIfFile && rule.shape === "subdir") {
      if (containsFile(entry.fullPath, rule.excludeIfFile)) continue;
    }
    if (rule.requirePairedSiblings) {
      if (!pairedSiblingsSatisfied(entry, rule.requirePairedSiblings)) continue;
    }
    eligible.push(entry);
  }

  // Eligible sorted newest-first (carry over from scan).
  const oldestFirst = [...eligible].reverse();

  const selected = new Set<string>();

  // Rule 1: age cap — anything older than the cutoff is selected.
  if (typeof rule.maxAgeDays === "number" && rule.maxAgeDays > 0) {
    const cutoff = now - rule.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const e of oldestFirst) {
      if (e.mtimeMs < cutoff) selected.add(e.fullPath);
    }
  } else if (rule.maxAgeDays === 0) {
    // 0d = clean-now for all eligible
    for (const e of eligible) selected.add(e.fullPath);
  }

  // Rule 2: count cap — keep the newest `maxCount`; anything beyond is selected.
  if (typeof rule.maxCount === "number" && rule.maxCount >= 0) {
    const sortedNewestFirst = eligible; // already sorted newest first via scan
    for (let i = rule.maxCount; i < sortedNewestFirst.length; i++) {
      selected.add(sortedNewestFirst[i]!.fullPath);
    }
  }

  // Rule 3: byte cap — keep newest under the cap; drop oldest until under.
  if (typeof rule.maxBytes === "number" && rule.maxBytes > 0) {
    let keptBytes = eligible
      .filter((e) => !selected.has(e.fullPath))
      .reduce((s, e) => s + e.sizeBytes, 0);
    if (keptBytes > rule.maxBytes) {
      for (const e of oldestFirst) {
        if (keptBytes <= rule.maxBytes) break;
        if (selected.has(e.fullPath)) continue;
        selected.add(e.fullPath);
        keptBytes -= e.sizeBytes;
      }
    }
  }

  return oldestFirst.filter((e) => selected.has(e.fullPath));
}

function ruleSummary(rule: ArtifactDirRule): string {
  const parts: string[] = [rule.kind];
  if (rule.maxAgeDays != null) parts.push(`maxAge=${rule.maxAgeDays}d`);
  if (rule.maxCount != null) parts.push(`maxCount=${rule.maxCount}`);
  if (rule.maxBytes != null) parts.push(`maxBytes=${formatBytes(rule.maxBytes)}`);
  if (rule.pressureOnly) parts.push("pressureOnly");
  if (rule.requireFile) parts.push(`requires:${rule.requireFile}`);
  if (rule.excludeIfFile) parts.push(`excludes:${rule.excludeIfFile}`);
  if (rule.requirePairedSiblings) {
    parts.push(`paired:${rule.requirePairedSiblings.pattern}>=${rule.requirePairedSiblings.minCount}`);
  }
  return parts.join(" ");
}

function deleteEntry(entry: ArtifactEntry, shape: ArtifactEntryShape): void {
  if (shape === "subdir") {
    rmSync(entry.fullPath, { recursive: true, force: true });
  } else {
    unlinkSync(entry.fullPath);
  }
}

export function runArtifactRetention(
  config: ArtifactRetentionConfig,
  options: RunArtifactRetentionOptions = {},
): ArtifactRetentionReport {
  const dryRun = options.dryRun !== false; // default to dry-run for safety
  const diskPressureActive = options.diskPressureActive === true;
  const generatedAt = new Date().toISOString();
  const dirReports: ArtifactDirReport[] = [];

  if (!config.enabled) {
    return { generatedAt, dirs: dirReports, totalReclaimableBytes: 0, totalReclaimedBytes: 0 };
  }

  for (const rule of config.dirs) {
    const base: ArtifactDirReport = {
      path: rule.path,
      kind: rule.kind,
      totalBytes: 0,
      totalEntries: 0,
      prunableEntries: 0,
      prunableBytes: 0,
      prunedEntries: 0,
      prunedBytes: 0,
      mode: "dry_run",
      ruleSummary: ruleSummary(rule),
      selectedNames: [],
    };

    if (isExcludedByPrefix(rule.path, config.excludeAlways)) {
      dirReports.push({ ...base, mode: "skipped_excluded" });
      continue;
    }

    if (rule.pressureOnly && !diskPressureActive) {
      // Still report footprint, just don't prune.
      const entries = scanArtifactDir(rule);
      base.totalEntries = entries.length;
      base.totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
      dirReports.push({ ...base, mode: "skipped_pressure" });
      continue;
    }

    if (!existsSync(rule.path)) {
      dirReports.push({ ...base, mode: "skipped_missing" });
      continue;
    }

    const entries = scanArtifactDir(rule);
    base.totalEntries = entries.length;
    base.totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);

    const candidates = selectPrunableEntries(rule, entries);
    base.prunableEntries = candidates.length;
    base.prunableBytes = candidates.reduce((s, e) => s + e.sizeBytes, 0);
    base.selectedNames = candidates.slice(0, 10).map((e) => e.name);

    const canActivelyDelete =
      !dryRun && config.activeDirs.includes(rule.path) && candidates.length > 0;

    if (canActivelyDelete) {
      let prunedBytes = 0;
      let prunedEntries = 0;
      for (const c of candidates) {
        try {
          deleteEntry(c, rule.shape);
          prunedBytes += c.sizeBytes;
          prunedEntries++;
        } catch (err) {
          logger.warn(
            { err, path: c.fullPath },
            "artifact-retention: delete failed; continuing",
          );
        }
      }
      base.prunedEntries = prunedEntries;
      base.prunedBytes = prunedBytes;
      base.mode = "active";
    } else {
      base.mode = "dry_run";
    }

    dirReports.push(base);
  }

  const totalReclaimableBytes = dirReports.reduce((s, d) => s + d.prunableBytes, 0);
  const totalReclaimedBytes = dirReports.reduce((s, d) => s + d.prunedBytes, 0);

  return { generatedAt, dirs: dirReports, totalReclaimableBytes, totalReclaimedBytes };
}

export function formatArtifactRetentionReport(report: ArtifactRetentionReport): string {
  if (report.dirs.length === 0) return "artifact-retention: disabled";
  const lines: string[] = [];
  for (const d of report.dirs) {
    const mode = d.mode;
    const totals = `${formatBytes(d.totalBytes)} (${d.totalEntries})`;
    if (mode === "skipped_excluded" || mode === "skipped_missing" || mode === "skipped_pressure") {
      lines.push(`  ${d.path}: ${mode}`);
      continue;
    }
    const action = mode === "active"
      ? `pruned ${d.prunedEntries} (${formatBytes(d.prunedBytes)})`
      : `would prune ${d.prunableEntries} (${formatBytes(d.prunableBytes)}) [dry-run]`;
    lines.push(`  ${d.path}: total=${totals} ${action} | ${d.ruleSummary}`);
  }
  lines.push(
    `  TOTAL reclaimable=${formatBytes(report.totalReclaimableBytes)} reclaimed=${formatBytes(report.totalReclaimedBytes)}`,
  );
  return lines.join("\n");
}
