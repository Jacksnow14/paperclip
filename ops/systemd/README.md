# unit-restart-inventory.csv

Snapshot taken 2026-07-25 during the [AUR-3952](/AUR/issues/AUR-3952) audit, covering all 252
systemd units on the box (both `system` scope and the `ievgen` `user` scope).

## Columns

- `nrestarts_live` — the live `systemctl show -p NRestarts` value at snapshot time.
- `journal_restart_events` / `journal_max_counter` — derived from `journalctl`, the
  running count of restart events and its high-water mark since journal retention
  began.
- `unit_file_state`, `active_state`, `sub_state`, `restart_policy` — as reported by
  `systemctl show`.
- `disposition` — filled only for units this audit or [AUR-3961](/AUR/issues/AUR-3961)
  took an action on or explicitly ruled out of scope; blank elsewhere.

## Caveats — read before trusting a "0" in this file

**Journal retention on this box starts 2026-07-01.** Any restart activity before that
date is unrecoverable; `journal_restart_events` and `journal_max_counter` are floors,
not full history, for any unit older than that.

**`nrestarts_live` (raw `NRestarts`) is untrustworthy on its own.** It resets to 0 on
every unit stop/start (not just on boot), so a unit can accumulate tens of thousands of
restarts over months and still read `NRestarts=0` at any given snapshot if it happens to
have been stopped since. This is precisely why both known offenders —
`polymarket-btc-5m-taker.service` (62,360 journal-derived restarts) and
`gbm-sidecar.service` — read `nrestarts_live=0` in this file: someone stopped them
before the snapshot was taken. The journal-derived counter is the one that cannot be
silently reset this way, which is why [`paperclip-unit-audit.sh`](../../scripts/paperclip-unit-audit.sh)
uses it as the trigger instead of `NRestarts`.

## Raw artifacts

The raw sweep and journal aggregation behind this CSV remain at
`/home/ievgen/paperclip-data/aur-3952/` (`unit_sweep_raw.txt`, `jmap.txt`) — not
committed, since they are box-local intermediate data, not a durable record.
