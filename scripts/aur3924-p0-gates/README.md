# AUR-3924 P0 close-condition gates

Three scripts that jointly decide whether the AUR-3924 P0 (host memory/OOM risk) may
close. `rule1.sh` is the conjunction; `swap-trend.sh` and `oom-clause3.sh` are two of
its four clauses (the other two — `cap_deployed` and AUR-4118 — are read directly by
`rule1.sh`, not separate scripts). `rule1.sh` resolves `swap-trend.sh` and
`oom-clause3.sh` as siblings in its own directory (`$OPS_DIR`, overridable via
`RULE1_OPS_DIR`), so **the three `.sh` files must stay together** if this directory is
ever restructured.

## Why tracked here (AUR-4515)

These scripts gate a real production decision (AUR-3924) and had accumulated six
undiffed, untested defects by hand across seven fires of AUR-4338 before this issue —
two of them introduced by a previous fire's own untracked fix. `/home/ievgen/paperclip-data`
itself is not a git repo. Rather than stand up a new standalone repo for host-ops
scripts, this puts them in the `paperclip` product repo under `scripts/`, following the
precedent already set for `scripts/paperclip-mem-watch.sh` (the other AUR-3924 input,
tracked since AUR-4025/AUR-4056/AUR-4086/AUR-4170) and the `scripts/deploy/install-*-timer.sh`
sync-script convention. A new repo would mean a second place to apply the fleet's git
safety doctrine, a second CI (or none), and no reuse of `scripts/run-shell-suites.sh`,
which already discovers and runs every `*.test.sh` under `scripts/` in CI (`ci.yml`,
AUR-4675). Reusing the existing tracked repo was strictly cheaper and gets these gates
CI coverage for free.

**Test suites use the `.test.sh` naming convention** (`swap-trend.test.sh`, not
`swap-trend-test.sh` as they were named on the live host) — `run-shell-suites.sh`
discovers `scripts/*.test.sh` and `scripts/**/*.test.sh` only. The live copies at
`/home/ievgen/paperclip-data/ops/` still use the old hyphenated names; that is a
naming difference between the two locations, not two different files.

## Running the suite

From a clean checkout:

```bash
bash scripts/aur3924-p0-gates/swap-trend.test.sh
bash scripts/aur3924-p0-gates/rule1.test.sh
bash scripts/aur3924-p0-gates/oom-clause3.test.sh
```

or via the full CI shell-suite runner (discovers these plus every other `*.test.sh`
under `scripts/`):

```bash
bash scripts/run-shell-suites.sh
```

This is already wired into CI (`.github/workflows/ci.yml` runs `run-shell-suites.sh`
on every push) — no additional wiring was needed for these three suites once they were
added under `scripts/` with `.test.sh` names.

`swap-trend.test.sh` originally defaulted `SCRIPT` to the live host path
(`/home/ievgen/paperclip-data/ops/swap-trend.sh`), which would have made it fail on a
CI runner or any other clean checkout. Fixed here to default to the sibling file in
this directory (same pattern `oom-clause3.test.sh` and `scripts/paperclip-mem-watch.test.sh`
already used); `SCRIPT=/path/to/deployed/copy` still overrides it if you want to test a
live copy specifically.

## Deploying a change

Unlike `paperclip-mem-watch.sh` (deployed to root-owned `/usr/local/sbin/` and run by a
systemd timer), these three scripts are read directly from
`/home/ievgen/paperclip-data/ops/` by an agent-run routine — there is no systemd unit
and no root ownership involved. The sync step is a plain, ievgen-owned copy:

```bash
cp scripts/aur3924-p0-gates/swap-trend.sh scripts/aur3924-p0-gates/rule1.sh scripts/aur3924-p0-gates/oom-clause3.sh \
   /home/ievgen/paperclip-data/ops/
chmod +x /home/ievgen/paperclip-data/ops/{swap-trend,rule1,oom-clause3}.sh
```

Run the test suite (above) and get it merged **before** copying — the live directory is
the delivery mechanism the routine reads from directly; there is no staging environment
between "copied" and "gating a live decision."

The live directory also still has `.bak-aur4338-fire*` snapshots predating this issue
(e.g. `swap-trend.sh.bak-aur4338-fire12`). Now that `git log` on this directory is the
durable history, those are redundant; left in place for now since deleting them is not
required by this issue's scope.

## Audit: other `ops/` scripts gating a decision

At the time of this audit, `/home/ievgen/paperclip-data/ops/` contains exactly these three
script families, and **all three already have a paired `*-test.sh` regression suite**
(swap-trend, rule1, oom-clause3 — the ones tracked here). No decision-gating script
under `ops/` currently lacks test coverage.

The broader `/home/ievgen/paperclip-data/` directory (outside `ops/`, out of scope for
AUR-4515) holds many more scripts that gate routine/alert decisions and are similarly
untracked — e.g. `aur5847-send-backstop.sh`, `aur6150-execution-review-gate-sweep.sh`,
`aur6154-reconcile-cadence.sh`, `aur6156-bounce-watchdog-cadence.sh`,
`aur5780-trigger-disarm-watchdog.sh`, `aur5527-pr-hygiene-dispatch.sh`,
`aur5370-pr-backlog-dispatch.sh`, `aur5431-drain-stale-retry-queue.sh`,
`aur5100-instance-gc.sh`, `aur5042-routine-staleness-sweep.sh`,
`aur4998-worktree-reaper.sh`, `aur4532-dark-lane-alert.sh`. Some already have a paired
`*.test.sh`/`.test.py` (e.g. `aur2684-rotate-sa-key.py` / `aur2684-rotation-watch.sh`),
most do not. That is a materially larger effort than this issue's stated scope
("Put `/home/ievgen/paperclip-data/ops/` under version control") and is tracked
separately rather than folded in here.

## Known drift: `/usr/local/sbin/paperclip-mem-watch-alert.sh`

Not part of this issue's scope to fix, but surfaced during the AUR-4515 audit: the live
deployed `/usr/local/sbin/paperclip-mem-watch-alert.sh` no longer matches the tracked
`scripts/deploy/check-mem-watch-alert.sh` in this repo. The repo version (post
AUR-4056/AUR-4086) removed the `SPLIT_SAFE_MAX_COL` restriction and replaced it with a
stricter loud-error-on-corrupt-row check; the live deployment still runs the older,
more conservative logic. `scripts/deploy/install-mem-watch-alert-timer.sh` already
exists to sync this — it was simply never re-run after the repo-side fix landed. Left
un-redeployed here deliberately: pushing a newer version of a live alert-decision script
is itself a decision-rule change, and AUR-4515 is explicitly scoped to *not* touch
AUR-3924 decision rules. Filing as a follow-up rather than actioning inline.
