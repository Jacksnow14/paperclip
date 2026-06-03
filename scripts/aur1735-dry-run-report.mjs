#!/usr/bin/env node
// AUR-1735 dry-run evidence: run the AUR-1722 prod-activation policy in
// dryRun=true mode against the real prod dirs and print the per-dir selection
// + totalReclaimableBytes. Read-only; never deletes.

// Run with: `node --import tsx scripts/aur1735-dry-run-report.mjs`
// (or from server/: `node --import tsx ../scripts/aur1735-dry-run-report.mjs`).

const { resolveArtifactRetentionPolicy } = await import(
  "../server/src/services/artifact-retention-config.ts"
);
const { runArtifactRetention, formatArtifactRetentionReport } = await import(
  "../server/src/services/artifact-retention.ts"
);

const cfg = resolveArtifactRetentionPolicy(undefined, { prodDefaultActivation: true });

console.log("Resolved config:");
console.log("  enabled:", cfg.enabled);
console.log("  activeDirs:", cfg.activeDirs);
console.log("  excludeAlways:", cfg.excludeAlways);
console.log();

const report = runArtifactRetention(cfg, { dryRun: true, diskPressureActive: false });
console.log("Per-dir report:");
console.log(formatArtifactRetentionReport(report));
console.log();
console.log("totalReclaimableBytes:", report.totalReclaimableBytes);
console.log(
  "totalReclaimableBytes (MiB):",
  (report.totalReclaimableBytes / (1024 * 1024)).toFixed(1),
);
console.log(
  "totalReclaimableBytes (GiB):",
  (report.totalReclaimableBytes / (1024 ** 3)).toFixed(2),
);
