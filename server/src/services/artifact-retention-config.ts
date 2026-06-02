import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ArtifactRetentionDirRule, ArtifactRetentionPolicy } from "@paperclipai/shared";
import type { ArtifactDirRule, ArtifactRetentionConfig } from "./artifact-retention.js";

const HOME = homedir();

function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return resolve(HOME, p.slice(2));
  return p;
}

/**
 * Default AUR-1722 artifact-retention baseline. Encodes the Content Manager
 * classification from AUR-1726 directly.
 *
 * IMPORTANT: `activeDirs` is intentionally empty. Every rule is evaluated and
 * reported but no path is deleted until the dry-run output is reviewed and
 * specific paths are added to `activeDirs` by board/CTO approval (per the
 * AUR-1722 hard safety gate).
 *
 * Default `enabled=false` means the policy ships dormant; an instance with no
 * matching paths (e.g. CI, developer laptops) sees zero behavior change.
 * Operators flip `enabled=true` once the policy is approved for their host.
 */
export const AUR_1722_BASELINE: ArtifactRetentionPolicy = {
  enabled: false,
  excludeAlways: [
    "~/vps_upload/runs_ready",
    "~/vps_upload/deliverables",
    "~/vps_upload/assets/channels",
    "~/vps_upload/assets/videos",
    "~/vps_upload/assets/bg/templates",
    "~/vps_upload/Poppins",
    "~/vps_upload/scripts",
    "~/vps_upload/tests",
    "~/vps_upload/plans",
    "~/vps_upload/config",
    "~/vps_upload/docs",
    "~/vps_upload/agents",
    "~/vps_upload/reservoir",
    "~/vps_upload/replacement_pipeline",
    "~/vps_upload/higgsfield_pipeline",
    "~/vps_upload/reports",
    "~/vps_upload/youtubedownloader/bin",
  ],
  activeDirs: [],
  dirs: [
    // 1. yt-dl downloads cache — re-downloadable, gated on segments existing
    {
      path: "~/vps_upload/youtubedownloader/downloads",
      kind: "cache",
      shape: "file",
      maxAgeDays: 14,
      requirePairedSiblings: {
        dir: "~/vps_upload/assets/bg",
        pattern: "{basename}_seg_*.mp4",
        minCount: 1,
      },
    },
    // 2. spent-clip pool (max_uses=1 enforced upstream)
    {
      path: "~/vps_upload/assets/bg/used",
      kind: "rotating_pool",
      shape: "file",
      maxAgeDays: 30,
    },
    // 3. legacy max_uses=3 dir + quarantine — clean any time
    {
      path: "~/vps_upload/assets/bg/used 3 times",
      kind: "rotating_pool",
      shape: "file",
      maxAgeDays: 0,
    },
    {
      path: "~/vps_upload/assets/bg/quarantine",
      kind: "rotating_pool",
      shape: "file",
      maxAgeDays: 0,
    },
    // 4. completed run dirs — 7d after a run has `short.mp4`
    {
      path: "~/vps_upload/runs",
      kind: "run_output",
      shape: "subdir",
      maxAgeDays: 7,
      requireFile: "short.mp4",
    },
    // 5. failed runs — 3d for runs that never reached `short.mp4`
    {
      path: "~/vps_upload/runs",
      kind: "run_output",
      shape: "subdir",
      maxAgeDays: 3,
      excludeIfFile: "short.mp4",
    },
    // 6. runs_ready stubs (no video_id.txt = never uploaded)
    {
      path: "~/vps_upload/runs_ready",
      kind: "deliverable_with_floor",
      shape: "subdir",
      maxAgeDays: 0,
      excludeIfFile: "video_id.txt",
    },
    // 7. runs_debug* — all stale, clean any time
    { path: "~/vps_upload/runs_debug", kind: "debug", shape: "subdir", maxAgeDays: 0 },
    { path: "~/vps_upload/runs_debug_v2", kind: "debug", shape: "subdir", maxAgeDays: 0 },
    { path: "~/vps_upload/runs_debug_cto", kind: "debug", shape: "subdir", maxAgeDays: 0 },
    { path: "~/vps_upload/runs_debug_cto_v2", kind: "debug", shape: "subdir", maxAgeDays: 0 },
    {
      path: "~/vps_upload/runs_debug_cto_v2_explicit",
      kind: "debug",
      shape: "subdir",
      maxAgeDays: 0,
    },
    {
      path: "~/vps_upload/runs_debug_cto_uploadmeta",
      kind: "debug",
      shape: "subdir",
      maxAgeDays: 0,
    },
    // 8. logs — 1 GiB cap (size-based rotation)
    {
      path: "~/vps_upload/logs",
      kind: "log",
      shape: "file",
      maxBytes: 1024 * 1024 * 1024,
    },
    // 9. __pycache__ — fully regenerable, clean any time
    {
      path: "~/vps_upload/__pycache__",
      kind: "build_artifact",
      shape: "subdir",
      maxAgeDays: 0,
    },
  ],
};

function expandRule(rule: ArtifactRetentionDirRule): ArtifactDirRule {
  return {
    ...rule,
    path: expandHome(rule.path),
    requirePairedSiblings: rule.requirePairedSiblings
      ? { ...rule.requirePairedSiblings, dir: expandHome(rule.requirePairedSiblings.dir) }
      : undefined,
  };
}

/**
 * Build the runtime artifact-retention config from instance settings, applying
 * `~`-expansion to all paths and falling back to the AUR-1722 baseline when no
 * dirs are configured.
 */
export function resolveArtifactRetentionPolicy(
  settings?: ArtifactRetentionPolicy,
): ArtifactRetentionConfig {
  const source = settings && settings.dirs.length > 0 ? settings : AUR_1722_BASELINE;
  return {
    enabled: source.enabled,
    dirs: source.dirs.map(expandRule),
    excludeAlways: source.excludeAlways.map(expandHome),
    activeDirs: source.activeDirs.map(expandHome),
  };
}
