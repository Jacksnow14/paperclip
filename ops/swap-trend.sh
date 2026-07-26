#!/usr/bin/env bash
# AUR-4058: evaluate the AUR-3924 close-condition clause
#   "swap flat-or-falling over >= Nh"
# against the canonical sampler series written by paperclip-mem-watch.timer.
#
# Usage: swap-trend.sh [hours]     (default 2, matching the AUR-3924 clause)
# Exit 0 = clause SATISFIED, 1 = NOT satisfied / insufficient data.
#
# Four confounds this MUST defend against, all of which have already produced
# wrong readings in this incident cluster:
#
#  1. Control-plane restart. A restart releases the old process's swapped-out
#     anon pages; in a used/free sample alone that is indistinguishable from
#     organic recovery. Only a window with a constant `cp_since` is valid.
#     (The 16:13 -> 20:03 "swap fell 2.4 GB" reading was exactly this.)
#
#  2. Release-build transients. A release build costs ~2.4 GB resident
#     (see AUR-4029) and briefly pushes swap up several hundred MB before it
#     drains. Sampling across one makes a recovering box look like a rising
#     one. Samples with build_rss_mb > 0 are excluded from the slope.
#
#  3. OOM kills (AUR-4119 defect 1). A kill both spikes swap during reclaim
#     and then releases several GB of anon pages on death. A window that opens
#     before the kill and closes after the drain reads as steeply RISING off
#     that spike alone (observed: +205.9 MB/h / 28.6h-to-exhaustion, fabricated
#     from a 2911 MB spike row, against a true clean-window slope of +52 MB/h).
#     Samples with a nonzero oom_5min are excluded from the slope the same way
#     build_rss_mb > 0 samples are.
#
#  4. Agent-concurrency steps (AUR-4119 defect 5). `agent_procs` swinging up
#     to the AUR-3929 cap (design ceiling 4) adds real anon-rss in a few
#     minutes -- a healthy fleet reaching its concurrency cap, not a leak. A
#     window straddling that step reads as RISING even while the true
#     clean-window slope is falling (observed: reported +94.8 MB/h / 62.6h off
#     a 1873->2161 MB step at agent_procs 1->4, against a true -22.4 MB/h flat
#     slope over the full window). agent_procs churns constantly under normal
#     load (0-4 every few minutes), so requiring it constant across the WHOLE
#     window -- the same trailing-run trim used for cp_since -- left the check
#     permanently INSUFFICIENT on live data. Instead, samples within a 15-minute
#     settle window after any step are dropped from the slope, leaving the
#     steady-state samples on both sides of a step in play.
#
# We do NOT run our own sampler: paperclip-mem-watch.timer (root, */5) is the
# single source of truth and already derives the artifact path from the running
# process cmdline.

set -uo pipefail

SRC=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
HOURS="${1:-2}"

[ -r "$SRC" ] || { echo "verdict=NO_DATA reason=cannot_read_$SRC"; exit 1; }

python3 - "$SRC" "$HOURS" <<'PY'
import sys
from datetime import datetime, timedelta

src, hours = sys.argv[1], float(sys.argv[2])
need = hours

rows = []
last_cp = None
header_cols = None
ragged_skipped = 0
with open(src) as fh:
    for line in fh:
        f = line.strip().split(",")
        if not f:
            continue
        if f[0] == "ts":
            # First header line seen defines the expected width. AUR-4056
            # fixed the sampler so it never emits a row narrower than its own
            # header (verified live 2026-07-25 21:00 UTC: 59/59 rows exactly
            # 18 cols), so a row that doesn't match this width post-fix is
            # corruption to count and skip, not an expected shape to fall
            # back around.
            if header_cols is None:
                header_cols = len(f)
            continue
        if header_cols is not None and len(f) != header_cols:
            ragged_skipped += 1
            continue
        try:
            t = datetime.strptime(f[0], "%Y-%m-%dT%H:%M:%SZ")
            swap_used, swap_free = int(f[3]), int(f[4])
            ooms = int(f[7])
        except Exception:
            ragged_skipped += 1
            continue
        agents = int(f[8]) if f[8].lstrip("-").isdigit() else None
        build_rss = int(f[11]) if f[11].isdigit() else 0
        cp_since = f[14] or None
        cap = f[17] or None
        if cp_since:
            last_cp = cp_since
        rows.append({"t": t, "used": swap_used, "free": swap_free, "ooms": ooms,
                     "agents": agents, "build": build_rss,
                     "cp": cp_since or last_cp, "cap": cap})

if not rows:
    print(f"verdict=NO_DATA reason=no_parseable_rows ragged_rows_skipped={ragged_skipped}"); sys.exit(1)

rows.sort(key=lambda r: r["t"])

# Confound 1: keep only the trailing run sharing one control-plane start.
cp_now = rows[-1]["cp"]
clean = []
for r in reversed(rows):
    if r["cp"] != cp_now:
        break
    clean.append(r)
clean.reverse()

span = (clean[-1]["t"] - clean[0]["t"]).total_seconds() / 3600.0
caps = {r["cap"] for r in clean if r["cap"]}
print(f"rows_total={len(rows)} clean_since_restart={len(clean)} span_h={span:.2f} "
      f"need_h={need:.2f} cp_since={cp_now} cap_deployed={'/'.join(sorted(caps)) or 'unknown'} "
      f"ragged_rows_skipped={ragged_skipped}")

if span < need:
    print(f"verdict=INSUFFICIENT reason=clean_window_{span:.2f}h_lt_{need}h"); sys.exit(1)

cutoff = clean[-1]["t"] - timedelta(hours=need)
win = [r for r in clean if r["t"] >= cutoff]

# Confound 4: agent_procs steps within `clean` settle within ~15 min (the AUR-3929
# cap swinging up/down is real fleet load, not a leak -- see fire 3: a 1->4 step
# added ~290 MB of anon in 10 min and made a 3h *falling* trend read as RISING).
# Mark the settle window after every step anywhere in `clean` (not just `win`),
# since a step just before the window boundary still contaminates its first
# samples.
SETTLE = timedelta(minutes=15)
step_zones = []
for prev, cur in zip(clean, clean[1:]):
    if prev["agents"] is not None and cur["agents"] is not None and prev["agents"] != cur["agents"]:
        step_zones.append((cur["t"], cur["t"] + SETTLE))

def in_step_zone(t):
    return any(start <= t <= end for start, end in step_zones)

# Confound 2: drop release-build transients. Confound 3: drop OOM-kill samples
# (a kill spikes swap during reclaim, then releases anon pages on death -- both
# read as slope, not steady state).
quiet = [r for r in win if r["build"] == 0 and r["ooms"] == 0 and not in_step_zone(r["t"])]
excluded_build = len([r for r in win if r["build"] != 0])
excluded_oom = len([r for r in win if r["ooms"] != 0])
excluded_step = len([r for r in win if r["build"] == 0 and r["ooms"] == 0 and in_step_zone(r["t"])])
if len(quiet) < 2:
    print(f"verdict=INSUFFICIENT reason=only_{len(quiet)}_quiet_samples"); sys.exit(1)

dt = (quiet[-1]["t"] - quiet[0]["t"]).total_seconds() / 3600.0

# Least-squares slope over every surviving sample, not a two-point diff off
# the endpoints. A step's settle zone is excluded above, but the endpoints
# alone are still one bad sample away from a residual confound (AUR-4119
# defect 5 follow-up: a settle-zone-filtered window still read RISING because
# its LAST point sat 10s outside the settle window). Regressing over all N
# quiet points instead of just the first/last is the "Do not judge the slope
# from two endpoints" rule this file already states, now actually enforced.
t0 = quiet[0]["t"]
xs = [(r["t"] - t0).total_seconds() / 3600.0 for r in quiet]
ys = [r["used"] for r in quiet]
n = len(xs)
xbar = sum(xs) / n
ybar = sum(ys) / n
sxx = sum((x - xbar) ** 2 for x in xs)
sxy = sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys))
rate = sxy / sxx if sxx > 0 else 0.0
free_now = quiet[-1]["free"]
oom = max(r["ooms"] for r in win)

print(f"window_samples={len(win)} build_samples_excluded={excluded_build} "
      f"oom_samples_excluded={excluded_oom} agent_step_samples_excluded={excluded_step} "
      f"swap_used_start_mb={quiet[0]['used']} swap_used_end_mb={quiet[-1]['used']} "
      f"rate_mb_per_h={rate:+.1f} swap_free_mb={free_now} oom_kills={oom}")

# +50 MB/h is within sampling noise on this box; above that it is genuinely rising.
if rate <= 50:
    print("verdict=SATISFIED clause=swap_flat_or_falling")
    sys.exit(0)

eta = free_now / rate
print(f"verdict=RISING rate_mb_per_h={rate:+.1f} projected_exhaustion_in_h={eta:.1f}")
sys.exit(1)
PY
