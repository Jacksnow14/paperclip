# Backup Retention Policy

Paperclip performs automatic database backups on a configurable interval (default: hourly). Without a count/size cap, hourly backups accumulate fast — 7 days × 24 backups/day = 168 dumps at ~130 MiB each can fill a disk. The tiered retention policy keeps the directory self-bounding.

## Retention Tiers

Pruning runs after every backup, newest-first, in this order:

| Tier | Rule | Default | Env override |
|------|------|---------|--------------|
| **Hourly** | Keep the N newest backups unconditionally | 48 | `PAPERCLIP_DB_BACKUP_HOURLY_COUNT` |
| **Daily** | From remaining backups within `dailyDays`, keep one per calendar day | 7 days | Instance Settings UI |
| **Weekly** | From remaining, keep one per ISO week within `weeklyWeeks` | 4 weeks | Instance Settings UI |
| **Monthly** | From remaining, keep one per calendar month within `monthlyMonths` | 1 month | Instance Settings UI |
| **Byte cap** | After tier selection, if total kept size exceeds `maxBytes`, delete oldest kept first | 8 GiB | `PAPERCLIP_DB_BACKUP_MAX_BYTES` |
| **Delete** | Everything else is deleted | — | — |

**Under hourly cadence:** the directory self-bounds to roughly `hourlyCount + dailyDays + weeklyWeeks + monthlyMonths` files — on defaults that is ~48 + 7 + 4 + 1 ≈ 60 files instead of 168.

**The newest backup is never deleted** by the byte cap (the eviction loop stops when only 1 file remains).

## Disk Guardrail

A background monitor checks disk usage every 60 seconds using `statfsSync` on the backup directory.

| Threshold | Action |
|-----------|--------|
| >= 80% (warn) | Logs a warning; no operational change |
| >= 90% (act) | Logs an error; **throttles non-critical run admission** (critical-priority issues keep running); creates a CEO alert issue (deduped: at most 1 per hour) |

Once disk usage drops below 90%, the throttle is automatically lifted.

## Daily Health Report

When the heartbeat scheduler is enabled, a health report issue is created once per day (24-hour interval) with:

- Disk usage %
- Free disk space (GiB)
- Backup directory size (MiB) and file count
- Child process count

This appears in the board as a `done`-status issue assigned to the CEO.

## Tuning

### Via Instance Settings UI

Navigate to **Settings > General > Backup Retention** to adjust `dailyDays`, `weeklyWeeks`, `monthlyMonths`, `hourlyCount`, and `maxBytes`. Changes take effect at the next backup cycle without restart.

### Via Environment Variables

For server-side overrides that survive settings resets:

```bash
# Keep 24 hourly backups instead of the default 48
PAPERCLIP_DB_BACKUP_HOURLY_COUNT=24

# Hard cap at 4 GiB (4,294,967,296 bytes)
PAPERCLIP_DB_BACKUP_MAX_BYTES=4294967296
```

Environment variables take precedence over instance settings.

## Invariants

1. **Newest backup always survives** — the byte cap never evicts the most recent file.
2. **At least 1 backup always kept** — even if a single file exceeds the byte cap, it is never deleted.
3. **Critical work keeps running** — the disk pressure gate only sheds non-critical and lower priority run admission; issues with `priority: critical` are always admitted.
4. **No silent truncation** — the byte cap logs every evicted filename, before/after footprint, and the cap limit.

## Artifact Retention (AUR-1722)

Project work-product trees (run outputs, caches, build artifacts, rotating pools, logs) are retained alongside backups under the same disk guardrail. Implemented in `server/src/services/artifact-retention.ts`.

### Configuration shape

Per-directory rules live under `instanceSettings.general.artifactRetention`:

```jsonc
{
  "enabled": false,                       // ships dormant; flip true once paths are approved
  "excludeAlways": ["~/vps_upload/runs_ready", "~/vps_upload/assets/channels", ...],
  "activeDirs": [],                       // HARD GATE: empty = dry-run for every dir
  "dirs": [
    {
      "path": "~/vps_upload/runs",
      "kind": "run_output",
      "shape": "subdir",
      "maxAgeDays": 7,
      "requireFile": "short.mp4"          // only completed runs are candidates
    },
    {
      "path": "~/vps_upload/youtubedownloader/downloads",
      "kind": "cache",
      "shape": "file",
      "maxAgeDays": 14,
      "requirePairedSiblings": {          // only prune if segments exist in assets/bg
        "dir": "~/vps_upload/assets/bg",
        "pattern": "{basename}_seg_*.mp4",
        "minCount": 1
      }
    }
  ]
}
```

The AUR-1722 baseline (encoded in `server/src/services/artifact-retention-config.ts`, sourced from the Content Manager classification on AUR-1726) is used when settings.dirs is empty.

### Selection rules

Per-rule, in order:

1. **Runtime gates** — `requireFile`, `excludeIfFile`, and `requirePairedSiblings` decide *eligibility*. An ineligible entry can never be pruned.
2. **Age cap** — entries older than `maxAgeDays` (or all entries if `maxAgeDays: 0`).
3. **Count cap** — keep the newest `maxCount`; older eligible entries are candidates.
4. **Byte cap** — keep newest under `maxBytes`; oldest eligible candidates drop until under.

Entries are reported newest-first; selection deletes oldest-first.

### Safety gates (HARD requirements per board)

- **Default mode is dry-run**: `runArtifactRetention(config)` with no options reports what it *would* prune; it deletes nothing.
- **Active deletion requires three conditions ALL true**: `enabled: true`, `dryRun: false`, AND the dir's path is listed in `activeDirs`. A path missing from `activeDirs` stays dry-run even on disk pressure.
- **`excludeAlways` is the override** — a path listed here is skipped even if listed in both `dirs` and `activeDirs`.
- **`pressureOnly` rules** only act when `diskPressureActive=true` (≥ act threshold).
- **Disabled by default** — `enabled: false` short-circuits before scanning. Hosts without these dirs see zero behavior change.

### Integration points

- **Daily health report** includes a per-in-scope-directory footprint table and the total dry-run reclaimable estimate.
- **Disk pressure (≥ act threshold)** triggers an artifact-retention pass after backup pruning. Active deletion happens only for paths explicitly in `activeDirs`; everything else is logged as "would prune".

### Approval workflow

1. Operator (or board) reviews the daily health report's artifact section.
2. For paths that look safe to delete, the operator adds them to `instanceSettings.general.artifactRetention.activeDirs` and flips `enabled: true`.
3. The next pressure pass actively deletes only those approved paths.

This is the gate the AUR-1722 board demanded: *"Wire a request_board_approval (or surface to CTO for sign-off) before flipping any artifact dir to active pruning."*
