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
