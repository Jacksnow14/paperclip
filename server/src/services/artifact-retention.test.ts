import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactDirRule,
  type ArtifactRetentionConfig,
  runArtifactRetention,
  scanArtifactDir,
  selectPrunableEntries,
} from "./artifact-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function ageFile(path: string, daysAgo: number) {
  const t = (Date.now() - daysAgo * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

function makeFile(path: string, contents = "x", daysAgo = 0): string {
  writeFileSync(path, contents);
  if (daysAgo > 0) ageFile(path, daysAgo);
  return path;
}

function makeDir(path: string, daysAgo = 0): string {
  mkdirSync(path, { recursive: true });
  if (daysAgo > 0) ageFile(path, daysAgo);
  return path;
}

describe("artifact-retention", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "artifact-retention-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("selectPrunableEntries — age cap", () => {
    it("selects entries older than maxAgeDays", () => {
      const dir = join(root, "runs");
      mkdirSync(dir);
      const young = makeDir(join(dir, "fresh"), 1);
      makeDir(join(dir, "stale"), 10);
      const rule: ArtifactDirRule = { path: dir, kind: "run_output", shape: "subdir", maxAgeDays: 7 };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      expect(selected.map((e) => e.name)).toEqual(["stale"]);
      expect(selected.every((e) => e.fullPath !== young)).toBe(true);
    });

    it("maxAgeDays=0 selects everything eligible immediately", () => {
      const dir = join(root, "debug");
      mkdirSync(dir);
      makeDir(join(dir, "a"), 1);
      makeDir(join(dir, "b"), 0);
      const rule: ArtifactDirRule = { path: dir, kind: "debug", shape: "subdir", maxAgeDays: 0 };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      expect(selected.map((e) => e.name).sort()).toEqual(["a", "b"]);
    });
  });

  describe("selectPrunableEntries — count cap", () => {
    it("keeps the newest maxCount entries; selects the rest", () => {
      const dir = join(root, "runs");
      mkdirSync(dir);
      for (let i = 0; i < 5; i++) makeDir(join(dir, `r${i}`), i); // r0=now, r4=4d-old
      const rule: ArtifactDirRule = { path: dir, kind: "run_output", shape: "subdir", maxCount: 2 };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      // r0, r1 kept; r2, r3, r4 selected
      expect(selected.map((e) => e.name).sort()).toEqual(["r2", "r3", "r4"]);
    });
  });

  describe("selectPrunableEntries — byte cap", () => {
    it("drops oldest until kept-total falls under maxBytes", () => {
      const dir = join(root, "logs");
      mkdirSync(dir);
      const big = "x".repeat(1000);
      makeFile(join(dir, "old.log"), big, 5);
      makeFile(join(dir, "mid.log"), big, 2);
      makeFile(join(dir, "new.log"), big, 0);
      const rule: ArtifactDirRule = {
        path: dir,
        kind: "log",
        shape: "file",
        pattern: "*.log",
        maxBytes: 1500, // can keep at most one file
      };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      // newest kept; oldest two go
      expect(selected.map((e) => e.name).sort()).toEqual(["mid.log", "old.log"]);
    });
  });

  describe("deliverable conditions", () => {
    it("excludeIfFile keeps entries with the marker file (e.g. video_id.txt for uploaded runs)", () => {
      const dir = join(root, "runs_ready");
      mkdirSync(dir);
      // Uploaded run — has video_id.txt, must not be pruned (age after creating child)
      const uploaded = makeDir(join(dir, "20260119_done"));
      makeFile(join(uploaded, "video_id.txt"), "abc123");
      ageFile(uploaded, 200);
      // Stub run — no video_id.txt, freely prunable
      makeDir(join(dir, "20260420_stub"), 0);
      const rule: ArtifactDirRule = {
        path: dir,
        kind: "deliverable_with_floor",
        shape: "subdir",
        maxAgeDays: 0,
        excludeIfFile: "video_id.txt",
      };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      expect(selected.map((e) => e.name)).toEqual(["20260420_stub"]);
    });

    it("requireFile only selects entries that contain the marker (e.g. short.mp4 for completed runs)", () => {
      const dir = join(root, "runs");
      mkdirSync(dir);
      // Completed run — has short.mp4 in subtree. Age dir AFTER creating child file
      // (writing a child bumps the parent dir's mtime).
      const done = makeDir(join(dir, "20260530_done"));
      makeFile(join(done, "short.mp4"), "mp4");
      ageFile(done, 10);
      // Failed run — no short.mp4
      makeDir(join(dir, "20260530_fail"), 10);
      const rule: ArtifactDirRule = {
        path: dir,
        kind: "run_output",
        shape: "subdir",
        maxAgeDays: 7,
        requireFile: "short.mp4",
      };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      expect(selected.map((e) => e.name)).toEqual(["20260530_done"]);
    });

    it("requirePairedSiblings gates downloads on segment existence", () => {
      const downloads = join(root, "downloads");
      const bg = join(root, "bg");
      mkdirSync(downloads);
      mkdirSync(bg);
      // Paired download — has 2 matching segments
      makeFile(join(downloads, "yt_AAA.mkv"), "video", 30);
      makeFile(join(bg, "yt_AAA_seg_001.mp4"), "seg");
      makeFile(join(bg, "yt_AAA_seg_002.mp4"), "seg");
      // Unpaired download — segmentation never ran
      makeFile(join(downloads, "yt_BBB.mkv"), "video", 30);

      const rule: ArtifactDirRule = {
        path: downloads,
        kind: "cache",
        shape: "file",
        maxAgeDays: 14,
        requirePairedSiblings: { dir: bg, pattern: "{basename}_seg_*.mp4", minCount: 1 },
      };
      const entries = scanArtifactDir(rule);
      const selected = selectPrunableEntries(rule, entries);
      expect(selected.map((e) => e.name)).toEqual(["yt_AAA.mkv"]);
    });
  });

  describe("runArtifactRetention — safety gates (HARD)", () => {
    it("default dryRun=true does NOT delete even when active", () => {
      const dir = join(root, "debug");
      mkdirSync(dir);
      const stale = makeDir(join(dir, "old"), 30);
      const rule: ArtifactDirRule = { path: dir, kind: "debug", shape: "subdir", maxAgeDays: 7 };
      const config: ArtifactRetentionConfig = {
        enabled: true,
        dirs: [rule],
        excludeAlways: [],
        activeDirs: [dir], // listed, but dryRun defaults to true
      };
      const report = runArtifactRetention(config);
      expect(report.dirs[0]!.mode).toBe("dry_run");
      expect(report.dirs[0]!.prunableEntries).toBe(1);
      expect(report.dirs[0]!.prunedEntries).toBe(0);
      expect(report.totalReclaimedBytes).toBe(0);
      expect(existsSync(stale)).toBe(true);
    });

    it("dryRun=false but path NOT in activeDirs keeps stays dry-run (hard gate)", () => {
      const dir = join(root, "debug");
      mkdirSync(dir);
      const stale = makeDir(join(dir, "old"), 30);
      const rule: ArtifactDirRule = { path: dir, kind: "debug", shape: "subdir", maxAgeDays: 7 };
      const config: ArtifactRetentionConfig = {
        enabled: true,
        dirs: [rule],
        excludeAlways: [],
        activeDirs: [], // empty → no path may delete
      };
      const report = runArtifactRetention(config, { dryRun: false });
      expect(report.dirs[0]!.mode).toBe("dry_run");
      expect(report.dirs[0]!.prunedEntries).toBe(0);
      expect(existsSync(stale)).toBe(true);
    });

    it("excludeAlways skips a path even when also listed as active", () => {
      const dir = join(root, "deliverables");
      mkdirSync(dir);
      const keep = makeDir(join(dir, "important"), 100);
      const rule: ArtifactDirRule = {
        path: dir,
        kind: "run_output",
        shape: "subdir",
        maxAgeDays: 1,
      };
      const config: ArtifactRetentionConfig = {
        enabled: true,
        dirs: [rule],
        excludeAlways: [dir],
        activeDirs: [dir],
      };
      const report = runArtifactRetention(config, { dryRun: false });
      expect(report.dirs[0]!.mode).toBe("skipped_excluded");
      expect(existsSync(keep)).toBe(true);
    });

    it("active deletion runs ONLY when dryRun=false AND path in activeDirs", () => {
      const dir = join(root, "debug");
      mkdirSync(dir);
      const stale = makeDir(join(dir, "old"), 30);
      const rule: ArtifactDirRule = { path: dir, kind: "debug", shape: "subdir", maxAgeDays: 7 };
      const config: ArtifactRetentionConfig = {
        enabled: true,
        dirs: [rule],
        excludeAlways: [],
        activeDirs: [dir],
      };
      const report = runArtifactRetention(config, { dryRun: false });
      expect(report.dirs[0]!.mode).toBe("active");
      expect(report.dirs[0]!.prunedEntries).toBe(1);
      expect(existsSync(stale)).toBe(false);
    });

    it("pressureOnly rules report footprint but skip pruning when no disk pressure", () => {
      const dir = join(root, "target");
      mkdirSync(dir);
      const stale = makeDir(join(dir, "build"));
      makeFile(resolve(stale, "x"), "y");
      ageFile(stale, 30);
      const rule: ArtifactDirRule = {
        path: dir,
        kind: "build_artifact",
        shape: "subdir",
        maxAgeDays: 7,
        pressureOnly: true,
      };
      const config: ArtifactRetentionConfig = {
        enabled: true,
        dirs: [rule],
        excludeAlways: [],
        activeDirs: [dir],
      };
      // No pressure → skipped
      let report = runArtifactRetention(config, { dryRun: false, diskPressureActive: false });
      expect(report.dirs[0]!.mode).toBe("skipped_pressure");
      expect(report.dirs[0]!.totalEntries).toBe(1); // still reports footprint
      expect(existsSync(stale)).toBe(true);

      // With pressure → active prune
      report = runArtifactRetention(config, { dryRun: false, diskPressureActive: true });
      expect(report.dirs[0]!.mode).toBe("active");
      expect(report.dirs[0]!.prunedEntries).toBe(1);
      expect(existsSync(stale)).toBe(false);
    });

    it("enabled=false short-circuits — no scan, no delete", () => {
      const dir = join(root, "debug");
      mkdirSync(dir);
      const stale = makeDir(join(dir, "old"), 30);
      const rule: ArtifactDirRule = { path: dir, kind: "debug", shape: "subdir", maxAgeDays: 7 };
      const config: ArtifactRetentionConfig = {
        enabled: false,
        dirs: [rule],
        excludeAlways: [],
        activeDirs: [dir],
      };
      const report = runArtifactRetention(config, { dryRun: false });
      expect(report.dirs).toEqual([]);
      expect(existsSync(stale)).toBe(true);
    });
  });

  describe("scanArtifactDir", () => {
    it("returns empty array for a missing dir without throwing", () => {
      const rule: ArtifactDirRule = {
        path: join(root, "does-not-exist"),
        kind: "cache",
        shape: "file",
      };
      expect(scanArtifactDir(rule)).toEqual([]);
    });

    it("filters by pattern", () => {
      const dir = join(root, "logs");
      mkdirSync(dir);
      makeFile(join(dir, "a.log"));
      makeFile(join(dir, "b.txt"));
      const rule: ArtifactDirRule = { path: dir, kind: "log", shape: "file", pattern: "*.log" };
      const entries = scanArtifactDir(rule);
      expect(entries.map((e) => e.name)).toEqual(["a.log"]);
    });
  });
});
