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
    // NOTE: `~/vps_upload/runs_ready` is NOT excluded here. Rule 6 below prunes
    // only `runs_ready` subdirs that lack `video_id.txt` (i.e. never-uploaded
    // stubs); uploaded deliverables keep the marker and are protected via
    // `excludeIfFile`. Listing the root here would suppress rule 6 entirely.
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
 * Board-approved prod-default activation overlay (AUR-1735).
 *
 * Sets `enabled=true` and the prod-approved `activeDirs` allowlist on top of the
 * baseline classification (`dirs` + `excludeAlways` are inherited from
 * AUR_1722_BASELINE so the curated rules stay the single source of truth).
 *
 * Applied at the call site only when the operator opts in (instance settings
 * carry an explicit policy OR the prod-default config switch is on). Never
 * forces baseline to `enabled=true` — CI/dev instances stay dormant.
 */
export const AUR_1722_PROD_ACTIVATION_ACTIVE_DIRS: string[] = [
  "~/vps_upload/runs_debug",
  "~/vps_upload/runs_debug_v2",
  "~/vps_upload/runs_debug_cto",
  "~/vps_upload/runs_debug_cto_v2",
  "~/vps_upload/runs_debug_cto_v2_explicit",
  "~/vps_upload/runs_debug_cto_uploadmeta",
  "~/vps_upload/__pycache__",
  "~/vps_upload/assets/bg/quarantine",
  "~/vps_upload/assets/bg/used 3 times",
  "~/vps_upload/assets/bg/used",
  "~/vps_upload/logs",
  "~/vps_upload/youtubedownloader/downloads",
  "~/vps_upload/runs",
  "~/vps_upload/runs_ready",
];

export const AUR_1722_PROD_ACTIVATION: ArtifactRetentionPolicy = {
  ...AUR_1722_BASELINE,
  enabled: true,
  activeDirs: AUR_1722_PROD_ACTIVATION_ACTIVE_DIRS,
};

function isDormantPolicy(p: ArtifactRetentionPolicy): boolean {
  return !p.enabled && p.activeDirs.length === 0;
}

export interface ResolveArtifactRetentionOptions {
  /**
   * When true, fall back to the AUR-1722 prod activation overlay if the
   * provided settings are still dormant defaults. Used to flip the prod
   * (default) instance into active mode without UI clicks. CI/dev instances
   * should leave this unset.
   */
  prodDefaultActivation?: boolean;
}

/**
 * Build the runtime artifact-retention config from instance settings.
 *
 * Resolution order:
 *   1. Operator-provided settings with any opt-in signal (enabled OR
 *      activeDirs populated) win — baseline classification fills any field
 *      the operator left empty.
 *   2. If settings are dormant defaults AND `prodDefaultActivation` is on, use
 *      the AUR-1722 prod activation overlay.
 *   3. Otherwise return the dormant baseline (CI/dev/fresh instances).
 *
 * Paths are `~`-expanded in all cases.
 */
export function resolveArtifactRetentionPolicy(
  settings?: ArtifactRetentionPolicy,
  options: ResolveArtifactRetentionOptions = {},
): ArtifactRetentionConfig {
  let source: ArtifactRetentionPolicy;
  if (settings && !isDormantPolicy(settings)) {
    source = {
      enabled: settings.enabled,
      dirs: settings.dirs.length > 0 ? settings.dirs : AUR_1722_BASELINE.dirs,
      excludeAlways:
        settings.excludeAlways.length > 0
          ? settings.excludeAlways
          : AUR_1722_BASELINE.excludeAlways,
      activeDirs: settings.activeDirs,
    };
  } else if (options.prodDefaultActivation) {
    source = AUR_1722_PROD_ACTIVATION;
  } else {
    source = AUR_1722_BASELINE;
  }
  return {
    enabled: source.enabled,
    dirs: source.dirs.map(expandRule),
    excludeAlways: source.excludeAlways.map(expandHome),
    activeDirs: source.activeDirs.map(expandHome),
  };
}
