import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRetentionPolicy } from "@paperclipai/shared";
import {
  AUR_1722_BASELINE,
  AUR_1722_PROD_ACTIVATION,
  AUR_1722_PROD_ACTIVATION_ACTIVE_DIRS,
  resolveArtifactRetentionPolicy,
} from "./artifact-retention-config.js";
import {
  runArtifactRetention,
  scanArtifactDir,
  selectPrunableEntries,
} from "./artifact-retention.js";

const DORMANT: ArtifactRetentionPolicy = {
  enabled: false,
  dirs: [],
  excludeAlways: [],
  activeDirs: [],
};

describe("resolveArtifactRetentionPolicy", () => {
  it("returns dormant baseline when settings are undefined (CI/dev default)", () => {
    const cfg = resolveArtifactRetentionPolicy();
    expect(cfg.enabled).toBe(false);
    expect(cfg.activeDirs).toEqual([]);
    // Curated dirs from baseline still included for reporting purposes.
    expect(cfg.dirs.length).toBe(AUR_1722_BASELINE.dirs.length);
  });

  it("returns dormant baseline when settings are explicit dormant defaults", () => {
    const cfg = resolveArtifactRetentionPolicy(DORMANT);
    expect(cfg.enabled).toBe(false);
    expect(cfg.activeDirs).toEqual([]);
  });

  it("applies prod-default activation overlay when settings are dormant and switch is on", () => {
    const cfg = resolveArtifactRetentionPolicy(DORMANT, { prodDefaultActivation: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.activeDirs.length).toBe(AUR_1722_PROD_ACTIVATION_ACTIVE_DIRS.length);
    expect(cfg.dirs.length).toBe(AUR_1722_BASELINE.dirs.length);
  });

  it("operator-provided enabled=true wins over prod-default switch", () => {
    const operator: ArtifactRetentionPolicy = {
      enabled: true,
      dirs: [],
      excludeAlways: [],
      activeDirs: ["~/custom/path"],
    };
    const cfg = resolveArtifactRetentionPolicy(operator, { prodDefaultActivation: true });
    expect(cfg.enabled).toBe(true);
    // Operator's activeDirs preserved (expanded), not overwritten by prod overlay.
    expect(cfg.activeDirs).toHaveLength(1);
    // Baseline dirs fill in since operator didn't provide any.
    expect(cfg.dirs.length).toBe(AUR_1722_BASELINE.dirs.length);
  });

  it("treats activeDirs-only setting (enabled=false but activeDirs populated) as opt-in", () => {
    const operator: ArtifactRetentionPolicy = {
      enabled: false,
      dirs: [],
      excludeAlways: [],
      activeDirs: ["~/some/dir"],
    };
    const cfg = resolveArtifactRetentionPolicy(operator);
    // enabled honored verbatim, but settings are no longer "dormant defaults"
    // so the baseline fills the classification rather than the prod overlay.
    expect(cfg.enabled).toBe(false);
    expect(cfg.activeDirs).toHaveLength(1);
  });

  it("does NOT include runs_ready in excludeAlways (dead-rule fix)", () => {
    expect(
      AUR_1722_BASELINE.excludeAlways.some((p) => p.endsWith("/runs_ready") || p === "~/vps_upload/runs_ready"),
    ).toBe(false);
  });

  it("AUR_1722_PROD_ACTIVATION inherits the baseline classification", () => {
    expect(AUR_1722_PROD_ACTIVATION.dirs).toBe(AUR_1722_BASELINE.dirs);
    expect(AUR_1722_PROD_ACTIVATION.excludeAlways).toBe(AUR_1722_BASELINE.excludeAlways);
    expect(AUR_1722_PROD_ACTIVATION.enabled).toBe(true);
    expect(AUR_1722_PROD_ACTIVATION.activeDirs.length).toBeGreaterThan(0);
  });
});

describe("runs_ready dead-rule (AUR-1735)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runs-ready-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes runs_ready subdirs WITHOUT video_id.txt and keeps those WITH it", () => {
    const dir = join(root, "runs_ready");
    mkdirSync(dir);
    const uploaded = join(dir, "20260530_uploaded");
    mkdirSync(uploaded);
    writeFileSync(join(uploaded, "video_id.txt"), "vid-123");
    const stub = join(dir, "20260530_stub");
    mkdirSync(stub);
    writeFileSync(join(stub, "metadata.json"), "{}");

    const rule = AUR_1722_BASELINE.dirs.find((r) => r.path.endsWith("/runs_ready"));
    expect(rule, "baseline must include the runs_ready rule").toBeTruthy();
    const ruleWithLocalPath = { ...rule!, path: dir };
    const entries = scanArtifactDir(ruleWithLocalPath);
    const selected = selectPrunableEntries(ruleWithLocalPath, entries);
    expect(selected.map((e) => e.name).sort()).toEqual(["20260530_stub"]);
  });

  it("runArtifactRetention with baseline classification + active runs_ready prunes the stub", () => {
    const dir = join(root, "runs_ready");
    mkdirSync(dir);
    const stub = join(dir, "stub_a");
    mkdirSync(stub);
    const uploaded = join(dir, "uploaded_b");
    mkdirSync(uploaded);
    writeFileSync(join(uploaded, "video_id.txt"), "vid");

    const ruleTemplate = AUR_1722_BASELINE.dirs.find((r) => r.path.endsWith("/runs_ready"))!;
    const cfg = {
      enabled: true,
      dirs: [{ ...ruleTemplate, path: dir }],
      excludeAlways: [],
      activeDirs: [dir],
    };
    const report = runArtifactRetention(cfg, { dryRun: false });
    expect(report.dirs[0]!.mode).toBe("active");
    expect(report.dirs[0]!.prunedEntries).toBe(1);
    expect(report.dirs[0]!.selectedNames).toEqual(["stub_a"]);
  });
});
