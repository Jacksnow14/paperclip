#!/usr/bin/env bash
# AUR-4058: evaluate the AUR-3924 close-condition clause
#   "swap flat-or-falling over >= Nh"
# against the canonical sampler series written by paperclip-mem-watch.timer.
#
# Usage: swap-trend.sh [hours]     (default 2, matching the AUR-3924 clause)
# Exit 0 = clause SATISFIED. Exit 1 = NOT satisfied (RISING/INSUFFICIENT/
# CONFOUNDED/NO_DATA). Exit 2 = OOM_ACTIVE -- escalate immediately; see below.
#
# Five confounds this MUST defend against, all of which have already produced
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
#     CTO review follow-up: excluding oom samples from the SLOPE is correct,
#     but under CONTINUOUS kills -- the actual exhaustion scenario this watch
#     exists for -- every sample in the window gets excluded, `quiet` empties,
#     and the script used to fall through to the same `verdict=INSUFFICIENT`
#     a genuine lack of data produces. Pre-fix that read `RISING +200 MB/h`;
#     post-exclusion-only-fix it silently read "insufficient data" instead of
#     escalating. Continuous OOM kills during the window now short-circuit to
#     a distinct `verdict=OOM_ACTIVE` (exit 2) before the quiet-sample guard,
#     carrying the unfiltered (confound-included) slope so an operator can see
#     the raw signal the exclusion is hiding. A non-OOM confound (build/step)
#     that likewise swallows every quiet sample reports `verdict=CONFOUNDED`
#     instead of `INSUFFICIENT`, again with the unfiltered slope, so "no data
#     was collected" and "data was collected but is all confounded" are never
#     conflated.
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
#  5. Post-restart warm-up (AUR-4338 fire 8). Confound 1 excludes samples from
#     BEFORE a control-plane restart, but a restart is not only a discontinuity --
#     it has an AFTERMATH, and that aftermath lands INSIDE the "clean" window. The
#     new process starts with its anon pages evicted, then swap refills toward the
#     new steady state over roughly the next 40 minutes. Measured live at fire 8:
#     restart at 00:37Z, swap_used fell 1902 -> 1866 over 25 min, stepped +211 MB
#     in 10 min, then sat flat at 2006-2077 for the following 46 min. Fitting a
#     line through that flat-step-flat shape reported `RISING +155.8 MB/h,
#     ci95=[+112.6,+199.1], projected exhaustion in 38.9h` on a box whose swap was
#     merely returning to the ~2040 MB it had held before the restart. This is the
#     fire-7 failure in a new costume: a LEVEL SHIFT fitted as a SLOPE.
#     agent_procs cannot absorb it -- it was 0 for 17 of the 18 post-restart
#     samples, so the covariate is near-constant and its coefficient (-14.5 MB)
#     is fitted off a single varying point.
#
#     Samples within WARMUP_MIN of cp_since are therefore dropped. Unlike the
#     retired agent_procs settle window this is SAFE, and that distinction is the
#     whole reason fire 7's "do not reintroduce a settle window" rule does not
#     forbid it: the agent_procs step left steady-state samples at DIFFERENT
#     LEVELS on BOTH sides of the excluded zone, so the level difference survived
#     the exclusion and re-emerged as slope. A restart has no surviving pre-side
#     at all -- confound 1 already discarded it wholesale -- so excluding the
#     warm-up leaves only same-level post-warm-up samples. Excluding a transient
#     is only wrong when it straddles two levels you keep.
#
#     Direction of this failure, stated honestly: it fabricates a false ALARM
#     (RISING on a healthy box), never a false all-clear, so it could not have
#     disabled this watch or closed the P0. It is fixed because two of the seven
#     previous fires burned their whole budget decomposing this exact phantom.
#
# The `hours` argument is CLAMPED UP to MIN_NEED (2.0), the AUR-3924 clause under
# test. Fire 8 obtained the false RISING above only by asking for a 1h window to
# "get a reading" after the honest 2h call returned INSUFFICIENT. A window shorter
# than the clause cannot witness the clause, so narrowing it is never a valid way
# to resolve an INSUFFICIENT -- it is a bypass. Widening is sound and is already
# automatic; narrowing is now impossible.
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

# Confound 5 / bypass guard: the clause under test is "flat-or-falling for at
# least 2h". A shorter window cannot witness it, so an INSUFFICIENT can only ever
# be resolved by WAITING, never by asking for less. Clamp up, and say so.
MIN_NEED = 2.0
WARMUP_MIN = 45          # minutes of post-restart swap refill excluded from the slope

# Confound 2b / defect 15 (fire 14). `build_rss_mb > 0` is an INSTANTANEOUS filter:
# it excludes the build while its process is resident, but a release build's swap
# footprint outlives the process. Measured live this fire: build ran 03:13-03:18Z
# peaking at 3122 MB rss, and the very next sample (03:23:47Z) read
# `build_rss_mb=0, swap_used=3388` against a pre-build baseline of 2103 -- ~1285 MB
# of build artifact ADMITTED as a quiet sample.
#
# Constant chosen from data, not guessed. Over all 92 build episodes in the
# sampler history, recovery time to baseline scales with the excursion: episodes
# whose peak exceeded baseline by >500 MB took a median ~18 min and up to 157 min
# (4628 MB build) to return. 45 min covers ~83% of them and reuses WARMUP_MIN's
# number so there is one settle constant on this box, not two.
#
# Why this is NOT the settle window fire 7 retired: defect 7's rule is that
# "excluding a transient is only wrong when it straddles two levels you KEEP".
# The retired agent_procs window straddled two genuinely different steady-state
# levels (idle vs the cap), so the level difference survived the exclusion and
# re-emerged as slope. A build returns to its PRE-BUILD level -- verified across
# the same 92 episodes -- so both kept sides sit at the same level and excluding
# the middle removes an excursion rather than hiding a step. A build that is
# followed by a genuine permanent step UP is still fitted as slope by the two kept
# sides, which is the correct answer, and `build_step_not_hidden` proves it.
#
# Deliberately a plain constant with NO environment override. The suite proves it
# is load-bearing by mutating a COPY (sed on the line below), the same way fire 12
# proved the covariate guard -- so the production path carries no fail-open switch
# that a later fire could set to reach a verdict.
BUILD_COOLDOWN_MIN = 45.0
need = max(hours, MIN_NEED)
clamped = need != hours

rows = []
last_cp = None
with open(src) as fh:
    for line in fh:
        f = line.strip().split(",")
        if not f or f[0] == "ts" or len(f) < 8:
            continue
        try:
            t = datetime.strptime(f[0], "%Y-%m-%dT%H:%M:%SZ")
            swap_used, swap_free = int(f[3]), int(f[4])
            ooms = int(f[7])
        except Exception:
            continue
        # Ragged rows: idle samples (0 agent procs) truncate after field 8.
        agents = int(f[8]) if len(f) > 8 and f[8].lstrip("-").isdigit() else None
        build_rss = int(f[11]) if len(f) > 11 and f[11].isdigit() else 0
        cp_since = f[14] if len(f) > 14 else None
        cap = f[17] if len(f) > 17 else None
        if cp_since:
            last_cp = cp_since
        rows.append({"t": t, "used": swap_used, "free": swap_free, "ooms": ooms,
                     "agents": agents, "build": build_rss,
                     "cp": cp_since or last_cp, "cap": cap})

if not rows:
    print("verdict=NO_DATA reason=no_parseable_rows"); sys.exit(1)

rows.sort(key=lambda r: r["t"])

# Confound 2b: mark each sample that lies within BUILD_COOLDOWN_MIN of the END of
# a build episode. Marked over the WHOLE series, before any windowing, because the
# dangerous case is a build that finished just BEFORE the window opens: its
# elevated tail then sits at the window's start and drags the fitted slope DOWN,
# which is the false-ALL-CLEAR direction (`build_tail_false_allclear` proves it).
# Marking only inside the window would miss exactly that case.
for r in rows:
    r["build_tail"] = False
_i = 0
while _i < len(rows):
    if rows[_i]["build"] > 0:
        _j = _i
        while _j + 1 < len(rows) and rows[_j + 1]["build"] > 0:
            _j += 1
        _cut = rows[_j]["t"] + timedelta(minutes=BUILD_COOLDOWN_MIN)
        for _k in range(_j + 1, len(rows)):
            if rows[_k]["t"] > _cut:
                break
            rows[_k]["build_tail"] = True
        _i = _j + 1
    else:
        _i += 1

# Confound 1: keep only the trailing run sharing one control-plane start.
cp_now = rows[-1]["cp"]
clean = []
for r in reversed(rows):
    if r["cp"] != cp_now:
        break
    clean.append(r)
clean.reverse()

caps = {r["cap"] for r in clean if r["cap"]}

# Confound 5: drop the post-restart refill transient. `clean` is already limited to
# the trailing run sharing one cp_since, so there is no pre-restart side left for a
# level difference to survive on -- see the header for why that makes this
# exclusion safe where the retired agent_procs settle window was not.
warm_cut = None
for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
    try:
        warm_cut = datetime.strptime(cp_now, fmt) + timedelta(minutes=WARMUP_MIN)
        break
    except (ValueError, TypeError):
        continue
if warm_cut is None:
    # Unparseable cp_since: fall back to the first clean sample as t=0 rather than
    # silently skipping the guard. Failing closed beats failing open.
    warm_cut = clean[0]["t"] + timedelta(minutes=WARMUP_MIN)
warm = [r for r in clean if r["t"] >= warm_cut]
excluded_warmup = len(clean) - len(warm)

raw_span = (clean[-1]["t"] - clean[0]["t"]).total_seconds() / 3600.0
span = (warm[-1]["t"] - warm[0]["t"]).total_seconds() / 3600.0 if len(warm) >= 2 else 0.0
print(f"rows_total={len(rows)} clean_since_restart={len(clean)} raw_span_h={raw_span:.2f} "
      f"warmup_samples_excluded={excluded_warmup} usable_span_h={span:.2f} "
      f"need_h={need:.2f}{' need_clamped_from=' + f'{hours:.2f}' if clamped else ''} "
      f"cp_since={cp_now} cap_deployed={'/'.join(sorted(caps)) or 'unknown'}")

clean = warm
if len(clean) < 2 or span < need:
    print(f"verdict=INSUFFICIENT "
          f"reason=usable_window_{span:.2f}h_lt_{need}h_after_{WARMUP_MIN}min_post_restart_warmup")
    sys.exit(1)

cutoff = clean[-1]["t"] - timedelta(hours=need)
win = [r for r in clean if r["t"] >= cutoff]

# Confound 4 (AUR-4338 fire 7 -- REPLACES the 15-minute settle window).
#
# The settle window installed at fire 4 modelled the agent_procs confound as a
# TRANSIENT. It is not: it is a persistent LEVEL SHIFT. Each concurrent agent run
# holds ~70 MB of swapped-out anon at current load, so an idle box sits at the
# swap floor (~1971 MB median, agent=0) and a box at the AUR-3929 cap of 4 sits
# ~280 MB higher (~2344 MB median). Excluding 15 minutes after the step removes
# the ramp but leaves that level difference standing on both sides of the
# excluded zone. A window that opens on an idle box and closes on a saturated one
# therefore reads as slope -- measured live at fire 7: +151.0 MB/h over 2h,
# "projected exhaustion in 37.7h", on a box that was flat.
#
# It also STARVED the fit. Dropping every sample inside a settle zone left 9 of
# 24 samples in the 2h window, and 9 points with SE +/-76.4 MB/h cannot tell
# +1 MB/h from +300 MB/h. Fire 3 predicted exactly this compounding failure:
# "defect 2 can hold the trend term at exit 1 while swap falls ... together they
# can prevent this self-terminating watch from EVER terminating."
#
# Fix: keep every quiet sample and put agent_procs in the model as a COVARIATE,
# then read the time coefficient with the concurrency level held constant.
# Proof that this is the right model (fire 7, live series):
#     window   time-only        time | agent held      agent_coef
#       2h     + 57.5 +/-61.2   + 9.2 +/-62.5          +70.1 MB
#       3h     +128.2 +/-27.1   + 6.4 +/-42.0          +68.7 MB
#       4h     + 94.7 +/-15.5   - 2.1 +/-23.6          +71.3 MB
#       6h     + 32.4 +/- 9.4   + 2.2 +/- 7.7          +56.7 MB
#      12h     -  3.3 +/- 4.6   - 3.2 +/- 4.2          +39.3 MB
#      72h     +  6.0 +/- 0.2   + 5.9 +/- 0.2          +17.8 MB
# The time-only column swings +128 -> -3 across windows of the SAME series; that
# internal inconsistency is the signature of an unmodelled covariate. The
# controlled column agrees everywhere (-3..+14). Do not reintroduce a settle
# window, and do not judge this slope without holding agent_procs.
#
# Ragged idle rows truncate after field 8 (see the parser above); those ARE the
# 0-agent-procs samples, so None maps to 0 rather than being dropped.
def agents_of(r):
    return r["agents"] if r["agents"] is not None else 0

# Confound 2: drop release-build transients. Confound 3: drop OOM-kill samples
# (a kill spikes swap during reclaim, then releases anon pages on death -- both
# read as slope, not steady state).
quiet = [r for r in win if r["build"] == 0 and r["ooms"] == 0 and not r.get("build_tail")]
excluded_build = len([r for r in win if r["build"] != 0])
excluded_build_tail = len([r for r in win if r["build"] == 0 and r.get("build_tail")])
excluded_oom = len([r for r in win if r["ooms"] != 0])
excluded_step = 0  # retired at fire 7: agent_procs is a covariate, not an exclusion
oom = max((r["ooms"] for r in win), default=0)

# Least-squares slope over every surviving sample, not a two-point diff off
# the endpoints. A step's settle zone is excluded above, but the endpoints
# alone are still one bad sample away from a residual confound (AUR-4119
# defect 5 follow-up: a settle-zone-filtered window still read RISING because
# its LAST point sat 10s outside the settle window). Regressing over all N
# quiet points instead of just the first/last is the "Do not judge the slope
# from two endpoints" rule this file already states, now actually enforced.
#
# fire 7: the fit now holds agent_procs constant and returns the STANDARD ERROR of
# the time coefficient, because a point estimate alone cannot support a verdict.
# regress() returns (rate_mb_per_h, standard_error, agent_coef_mb) or None.
def regress(rs):
    if len(rs) < 4:
        return None
    t0 = rs[0]["t"]
    xs = [(r["t"] - t0).total_seconds() / 3600.0 for r in rs]
    ys = [float(r["used"]) for r in rs]
    ags = [float(agents_of(r)) for r in rs]
    n = len(xs)
    # Design matrix [1, t, agent_procs]; drop the agent column if it never varies
    # (a constant covariate is collinear with the intercept and un-invertible).
    use_agents = len(set(ags)) > 1
    X = [[1.0, xs[i]] + ([ags[i]] if use_agents else []) for i in range(n)]
    k = len(X[0])
    if n - k < 2:
        return None
    # Solve (X'X) b = X'y and invert X'X, both by Gauss-Jordan on the same matrix.
    XtX = [[sum(X[i][a] * X[i][b] for i in range(n)) for b in range(k)] for a in range(k)]
    Xty = [sum(X[i][a] * ys[i] for i in range(n)) for a in range(k)]
    M = [XtX[a][:] + [1.0 if c == a else 0.0 for c in range(k)] + [Xty[a]] for a in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            return None
        d = M[c][c]
        M[c] = [v / d for v in M[c]]
        for r in range(k):
            if r != c and M[r][c] != 0.0:
                f = M[r][c]
                M[r] = [v - f * w for v, w in zip(M[r], M[c])]
    beta = [M[a][2 * k] for a in range(k)]
    inv = [[M[a][k + b] for b in range(k)] for a in range(k)]
    resid = [ys[i] - sum(beta[a] * X[i][a] for a in range(k)) for i in range(n)]
    s2 = sum(v * v for v in resid) / (n - k)
    var = s2 * inv[1][1]
    se = var ** 0.5 if var > 0 else 0.0
    return beta[1], se, (beta[2] if use_agents else 0.0), use_agents

if len(quiet) < 4:
    # The confound exclusion above is correct for the slope but, taken alone,
    # cannot distinguish "no data was collected" from "data was collected but
    # every sample is confounded" -- and continuous OOM kills are exactly the
    # exhaustion scenario this watch exists to catch. Escalate distinctly
    # rather than falling through to the same INSUFFICIENT a genuine data gap
    # produces, and surface the unfiltered slope so the raw signal isn't lost.
    raw_fit = regress(win)
    raw_str = f"{raw_fit[0]:+.1f}" if raw_fit is not None else "NA"
    if excluded_oom > 0:
        print(f"verdict=OOM_ACTIVE oom_kills={oom} window_samples={len(win)} "
              f"oom_samples_excluded={excluded_oom} unfiltered_rate_mb_per_h={raw_str} "
              f"reason=oom_confound_swallowed_all_quiet_samples")
        sys.exit(2)
    if excluded_build > 0 or excluded_build_tail > 0:
        print(f"verdict=CONFOUNDED window_samples={len(win)} "
              f"build_samples_excluded={excluded_build} "
              f"build_tail_samples_excluded={excluded_build_tail} "
              f"unfiltered_rate_mb_per_h={raw_str} reason=build_confound_swallowed_all_quiet_samples")
        sys.exit(1)
    print(f"verdict=INSUFFICIENT reason=only_{len(quiet)}_quiet_samples"); sys.exit(1)

# +50 MB/h is within sampling noise on this box; above that it is genuinely rising.
NOISE = 50.0

# fire 7: decide on the 95% CI of the time coefficient, never on the point estimate.
# The old code compared a bare `rate` to NOISE, so a fit that could not distinguish
# +1 from +300 MB/h (2h window: +151.0 +/- 76.4) still produced a confident
# "RISING ... exhaustion in 37.7h". Both errors this gate can make are now named:
#   CI entirely <= NOISE -> SATISFIED  (proven flat-or-falling)
#   CI entirely >  NOISE -> RISING     (proven rising)
#   CI straddling NOISE  -> undecidable at this window; WIDEN and retry.
# Widening is sound because the clause under test is "flat-or-falling for AT LEAST
# `need` hours" -- a longer window still witnesses the requested one. If no window
# up to the full clean span is decisive we exit 1 with INDETERMINATE. That is
# deliberately NOT exit 0: "cannot prove rising" must never be laundered into
# "proven flat", which is the direction that would let this watch disable itself
# and close a P0 on a box that is actually filling.
def decide(rs):
    fit = regress(rs)
    if fit is None:
        return None
    rate, se, agent_coef, used_agents = fit
    lo, hi = rate - 1.96 * se, rate + 1.96 * se
    # fire 12, defect 12: refuse a fit whose agent coefficient is NEGATIVE.
    #
    # A concurrent agent run can only HOLD swap (~+70 MB each, which is why the
    # fixtures model +71); it cannot hand swap back. A fitted agent_coef < 0 is
    # therefore physically impossible, and it means one specific thing: inside
    # this window agent_procs moved MONOTONICALLY WITH TIME (fire 12 live: 0 ->
    # 4), so the design matrix cannot separate "swap fell as time passed" from
    # "swap fell as agents drained". The split between the two columns is then
    # decided by noise, and the time coefficient -- the only number this gate
    # reads -- is not identified. Its CI is a CI of an arbitrary split, so a
    # narrow CI is not evidence of anything.
    #
    # Why this is not merely cosmetic: fire 11 saw agent_coef_mb=-61.7 alongside
    # INDETERMINATE and it was harmless, so the guard was specified but never
    # built. Fire 12 saw agent_coef_mb=-61.7 alongside SATISFIED/exit 0 -- and
    # exit 0 is the ONLY value rule 1 clause 2 accepts. An unidentified fit was
    # one clause away from disabling this watch and closing the AUR-3924 P0.
    # A specified probe is not a validated probe.
    #
    # Direction of the guard: it can only move a verdict INTO INDETERMINATE,
    # never out of one, so it cannot manufacture a false all-clear -- the sole
    # direction that matters here. Its cost is the opposite risk: if every
    # window shows a monotone agent ramp the gate never returns exit 0 and the
    # watch cannot self-terminate. That is fail-SAFE (the watch stays open), and
    # the widening loop below is the designed escape -- a longer window normally
    # contains ordinary non-monotone churn, which identifies the covariate again.
    if used_agents and agent_coef < 0.0:
        return ("INDETERMINATE", rate, se, lo, hi, agent_coef, rs,
                "covariate_not_identified_agent_coef_mb_negative")
    if hi <= NOISE:
        return ("SATISFIED", rate, se, lo, hi, agent_coef, rs, "")
    if lo > NOISE:
        return ("RISING", rate, se, lo, hi, agent_coef, rs, "")
    return ("INDETERMINATE", rate, se, lo, hi, agent_coef, rs, "")

candidates = sorted({need, need * 1.5, need * 2, 4.0, 6.0, 12.0, 24.0, span})
attempts = []
chosen = None
for h in candidates:
    if h < need or h > span + 1e-9:
        continue
    cut = clean[-1]["t"] - timedelta(hours=h)
    rs = [r for r in clean if r["t"] >= cut and r["build"] == 0 and r["ooms"] == 0
          and not r.get("build_tail")]
    d = decide(rs)
    if d is None:
        continue
    attempts.append((h, d))
    if d[0] != "INDETERMINATE":
        chosen = (h, d)
        break

if chosen is None:
    if attempts:
        h, d = attempts[-1]
        _, rate, se, lo, hi, agent_coef, rs, why = d
        print(f"window_samples={len(rs)} widened_to_h={h:.2f} rate_mb_per_h={rate:+.1f} "
              f"stderr_mb_per_h={se:.1f} ci95=[{lo:+.1f},{hi:+.1f}] agent_coef_mb={agent_coef:+.1f} "
              f"swap_free_mb={rs[-1]['free']} oom_kills={oom}")
        # Report WHICH refusal this is: a straddling CI is resolved by waiting for
        # more data, an unidentified covariate is resolved by a window in which
        # agent_procs is not monotone in time. Collapsing both into one reason
        # string would hide the distinction that tells the operator what to do.
        if why:
            print(f"verdict=INDETERMINATE reason={why}_at_every_window_up_to_{h:.2f}h")
        else:
            print(f"verdict=INDETERMINATE reason=ci_straddles_{NOISE:.0f}_at_every_window_up_to_{h:.2f}h")
    else:
        print(f"verdict=INSUFFICIENT reason=no_window_up_to_{span:.2f}h_had_enough_quiet_samples")
    sys.exit(1)

h, (verdict, rate, se, lo, hi, agent_coef, rs, why) = chosen
free_now = rs[-1]["free"]
print(f"window_samples={len(rs)} decided_at_h={h:.2f} build_samples_excluded={excluded_build} "
      f"build_tail_samples_excluded={excluded_build_tail} "
      f"oom_samples_excluded={excluded_oom} "
      f"swap_used_start_mb={rs[0]['used']} swap_used_end_mb={rs[-1]['used']} "
      f"rate_mb_per_h={rate:+.1f} stderr_mb_per_h={se:.1f} ci95=[{lo:+.1f},{hi:+.1f}] "
      f"agent_coef_mb={agent_coef:+.1f} swap_free_mb={free_now} oom_kills={oom}")

if verdict == "SATISFIED":
    print(f"verdict=SATISFIED clause=swap_flat_or_falling ci95_upper={hi:+.1f}_le_{NOISE:.0f}")
    sys.exit(0)

eta = free_now / rate if rate > 0 else float("inf")
print(f"verdict=RISING rate_mb_per_h={rate:+.1f} ci95_lower={lo:+.1f}_gt_{NOISE:.0f} "
      f"projected_exhaustion_in_h={eta:.1f}")
sys.exit(1)
PY
