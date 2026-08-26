#!/bin/bash
# Regression suite for swap-trend.sh -- AUR-4338 fire 7.
#
# WHY THIS EXISTS. swap-trend.sh is one of four clauses gating the close condition
# of the AUR-3924 P0, and it accumulated six defects across seven fires of that
# watch, each found by hand and each "fixed" without a test that would have caught
# the next one. Fire 7 found the worst: under normal fleet concurrency the gate
# returned NO verdict at all -- including on a synthetic +200 MB/h leak -- because
# the 15-minute agent-step settle window swallowed every sample. A gate that
# cannot fire is as broken as one that fires wrongly, so both directions are
# asserted here.
#
# Run:  bash scripts/aur3924-p0-gates/swap-trend.test.sh
# Exit: 0 = all pass. Non-zero = a case regressed; do NOT trust the gate.
#
# AUR-4515: defaults to the sibling copy in this checkout so the suite runs
# green from a clean clone. Set SCRIPT to point at a deployed copy (e.g.
# /home/ievgen/paperclip-data/ops/swap-trend.sh) to test that instead.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT:-$HERE/swap-trend.sh}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

gen() { # gen <mode> <file>
  python3 - "$1" "$2" <<'PY'
import sys, datetime as dt, random
mode, out = sys.argv[1], sys.argv[2]
H = ("ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,"
     "oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,"
     "cp_pid,cp_since,cp_oom_adj,release,cap_deployed")
CP = "2026-07-26T12:07:46"
t0 = dt.datetime(2026, 7, 29, 16, 0, 0)
random.seed(7)
CHURN = [0, 1, 4, 3, 2, 4, 0, 3]
rows, n = [H], 300
for i in range(n):
    t = t0 + dt.timedelta(minutes=5 * i)
    hrs = 5 * i / 60.0
    ag, oom, build, swap, cp = 0, 0, 0, 2000, CP
    if mode == "leak_const":      # real leak, concurrency pinned
        ag, swap = 2, int(2000 + 200 * hrs)
    elif mode == "leak_churn":    # real leak UNDER churn -- the fail-blind case
        ag = CHURN[i % 8]; swap = int(2000 + 200 * hrs + 71 * ag)
    elif mode == "flat_churn":    # no leak, pure churn -- the false-RISING case
        ag = CHURN[i % 8]; swap = int(2000 + 71 * ag)
    elif mode == "slow_leak":     # +80 MB/h, just above the 50 MB/h noise floor
        ag = CHURN[i % 4]; swap = int(2000 + 80 * hrs + 71 * ag)
    elif mode == "falling":       # genuine recovery
        ag = CHURN[i % 8]; swap = max(int(6000 - 150 * hrs + 71 * ag), 200)
    elif mode == "noisy_short":   # high variance, no widening room -> undecidable
        if i >= 30: continue
        ag = CHURN[i % 4]; swap = int(2000 + 71 * ag + random.gauss(0, 220))
    elif mode == "all_oom":       # every sample confounded by a kill
        if i >= 30: continue
        ag, oom, swap = 2, 1, 2000 + 40 * i
    elif mode == "build_only":    # every sample inside a release build
        if i >= 30: continue
        ag, build, swap = 2, 1500, 2000 + 40 * i
    elif mode == "post_restart_step":
        # Confound 5, fire 8 live shape. The control plane restarted at t0, so all
        # of these samples share one cp_since and confound 1 lets every one of them
        # through. swap refills toward its pre-restart level over the first 45 min,
        # then is FLAT. 2.33h of data: pre-fix the 2h window contains the refill
        # and reports a confident RISING with an ETA (live: +155.8 MB/h, 38.9h);
        # post-fix the refill is excluded, leaving 1.58h usable, so the gate must
        # refuse to decide rather than alarm.
        if i >= 28: continue
        cp = f"{t0:%Y-%m-%dT%H:%M:%S}"
        swap = int(1700 + 467 * hrs) if hrs < 0.75 else 2050 + (i % 3) * 8
    elif mode == "leak_after_restart":
        # The discrimination control for confound 5. A GENUINE +200 MB/h leak that
        # begins at the restart, under churn. The warm-up exclusion must not blind
        # the gate to it -- a guard is only proven by a failing case AND a passing
        # one, and "excluded the transient" must never become "excluded the leak".
        if i >= 72: continue
        cp = f"{t0:%Y-%m-%dT%H:%M:%S}"
        ag = CHURN[i % 8]; swap = int(1700 + 200 * hrs + 71 * ag)
    elif mode == "plateau_after_leak":
        # The MIN_NEED clamp, in the direction that matters. A box that rose
        # +200 MB/h for 2h and has been flat for the last 30 min. The clause is
        # "flat-or-falling for at least 2h", so the answer is RISING. Fire 8 found
        # by mutation that WITHOUT the clamp, `swap-trend.sh 0.5` returns
        # SATISFIED/exit 0 on this exact series -- and exit 0 is the only thing
        # rule 1 clause 2 accepts, so a short window was a live path to disabling
        # this watch and closing the P0 on a filling box. Narrowing is now refused.
        if i >= 31: continue
        ag = CHURN[i % 8]
        swap = int(1700 + 200 * min(hrs, 2.0) + 71 * ag)
    elif mode == "falling_agent_ramp":
        # Defect 12, fire 12 LIVE shape. Swap falls while agent_procs ramps
        # MONOTONICALLY with time (live: 0 -> 4). agent_procs is then collinear
        # with time, so the fit cannot say whether swap fell because time passed
        # or because agents drained -- and it resolves the ambiguity by handing
        # the agent column a physically impossible NEGATIVE coefficient (live:
        # agent_coef_mb=-61.7). The time coefficient is not identified, but its
        # CI is narrow, so pre-fix the gate returned SATISFIED/exit 0 -- the only
        # value rule 1 clause 2 accepts. Mutation-proven below: delete the guard
        # and this exact series reads SATISFIED/exit 0 again.
        # NOTE on fixture construction: swap must be ANTI-correlated with the
        # agent ramp, not merely linear in time. A perfectly linear series is fit
        # exactly by the time column alone, so the agent column is handed 0.0 and
        # the guard never fires -- the first draft of this fixture made that
        # mistake and "passed" for the wrong reason. Here swap steps DOWN as
        # agent_procs steps UP, which is what the live 22:0x series looked like,
        # and that is what forces the impossible negative coefficient.
        if i >= 40: continue
        ag = min(4, i // 8)
        swap = int(2600 - 71 * ag - 5 * hrs + random.gauss(0, 12))
    elif mode == "build_tail_false_allclear":
        # Defect 15, fire 14 LIVE shape -- and the DANGEROUS direction.
        # `build_rss_mb > 0` is an instantaneous filter, but a build's swap
        # footprint outlives its process. Measured live: build ended 03:18Z, and
        # the next sample read build_rss_mb=0 with swap 1285 MB above baseline.
        #
        # Here a build finishes just BEFORE the 2h window opens, so its decaying
        # tail sits at the window's START while the box genuinely leaks at
        # +200 MB/h afterwards. A high-then-falling head followed by a real rise
        # fits as a NET FALL: pre-fix this returns SATISFIED/exit 0, the only
        # value rule 1 clause 2 accepts. That is a live path to closing the P0 on
        # a filling box -- the same shape as defect 8, reached through confound 2
        # instead of through the window argument.
        if i >= 30: continue
        ag = CHURN[i % 8]
        if i <= 4:                       # the build itself: already excluded pre-fix
            build, swap = 3000, int(4200 + 71 * ag)
        elif i <= 13:                    # the TAIL: build_rss_mb=0, swap still elevated
            swap = int(4000 - 216 * (i - 5) + 71 * ag)
        else:                            # genuine +200 MB/h leak from baseline
            swap = int(2000 + 200 * (hrs - 70 / 60.0) + 71 * ag)
    elif mode == "build_step_not_hidden":
        # The DISCRIMINATION CONTROL for defect 15, and the reason the cool-down is
        # safe where fire 7's settle window was not. Defect 7's rule: excluding a
        # transient is only wrong when it straddles two levels you KEEP. A build
        # normally returns to its pre-build level, so both kept sides sit at the
        # same level. But if a deploy causes a GENUINE permanent step up, the two
        # kept sides sit at DIFFERENT levels and the step must still be fitted as
        # slope. "Excluded the build tail" must never become "excluded the leak" --
        # exactly what `leak_after_restart` proves for confound 5.
        if i >= 30: continue
        ag = CHURN[i % 8]
        if 12 <= i <= 14:
            build, swap = 3000, int(4200 + 71 * ag)
        elif i < 12:
            swap = int(2000 + 71 * ag)
        else:
            swap = int(2800 + 71 * ag)   # permanently higher AFTER the build
    swap = max(swap, 0)
    rows.append(f"{t:%Y-%m-%dT%H:%M:%SZ},4000,3000,{swap},{8095-swap},8095,2.0,"
                f"{oom},{ag},{ag},4,{build},0,3510124,{cp},-800,abc123,yes")
open(out, "w").write("\n".join(rows) + "\n")
PY
}

check() { # check <mode> <expected_verdict> <expected_exit> <why>
  local mode=$1 want=$2 wantrc=$3 why=$4 f="$TMP/$1.log"
  gen "$mode" "$f"
  local out rc got
  out=$(PAPERCLIP_MEM_WATCH_LOG="$f" bash "$SCRIPT" 2 2>&1); rc=$?
  got=$(printf '%s\n' "$out" | sed -n 's/.*verdict=\([A-Z_]*\).*/\1/p' | tail -1)
  if [ "$got" = "$want" ] && [ "$rc" = "$wantrc" ]; then
    printf 'PASS  %-12s %-14s exit=%s  %s\n' "$mode" "$got" "$rc" "$why"; pass=$((pass+1))
  else
    printf 'FAIL  %-12s got %s/exit=%s, want %s/exit=%s  %s\n' \
      "$mode" "${got:-NONE}" "$rc" "$want" "$wantrc" "$why"
    printf '      %s\n' "$out"; fail=$((fail+1))
  fi
}

echo "=== swap-trend.sh regression suite ==="
echo "--- must DETECT a real rise (the gate must be able to fire) ---"
check leak_const  RISING        1 "+200 MB/h, concurrency pinned"
check leak_churn  RISING        1 "+200 MB/h UNDER churn -- pre-fix returned no verdict at all"
check slow_leak   RISING        1 "+80 MB/h, just above the 50 noise floor"
check leak_after_restart RISING 1 "+200 MB/h starting AT a restart -- warm-up exclusion must not blind the gate"
check plateau_after_leak RISING 1 "rose 2h then flat 30min -- unclamped, a 0.5h request read SATISFIED/exit 0"
echo "--- must NOT cry rise on a flat box (the fire-7 false positive) ---"
check flat_churn  SATISFIED     0 "0 MB/h + churn -- pre-fix read +151 MB/h, 'exhaustion in 37.7h'"
check falling     SATISFIED     0 "-150 MB/h genuine recovery"
echo "--- must refuse to guess rather than launder uncertainty into SATISFIED ---"
check noisy_short INDETERMINATE 1 "CI straddles the threshold, no widening room"
check all_oom     OOM_ACTIVE    2 "every sample confounded by an OOM kill"
check build_only  CONFOUNDED    1 "every sample inside a release build"
check post_restart_step INSUFFICIENT 1 "post-restart refill -- pre-fix read +155.8 MB/h, 'exhaustion in 38.9h'"
check falling_agent_ramp INDETERMINATE 1 "agent_procs monotone in time -> agent_coef<0, fit not identified"
check build_tail_false_allclear RISING 1 "build tail at window start hides a +200 MB/h leak -- pre-fix SATISFIED/exit 0"
check build_step_not_hidden     RISING 1 "permanent step UP across a build -- the cool-down must not swallow it"

# --- MUTATION PROOF for the defect-12 covariate guard ---------------------
# The check above only proves the guarded script says INDETERMINATE. It does NOT
# prove the guard is what made it say so -- the series might read INDETERMINATE
# for some unrelated reason, in which case the guard is decorative and the next
# fire would trust a clause it should not. So: delete the guard from a COPY and
# assert the same series flips to the dangerous verdict. Mutating a copy (rather
# than adding a disable-switch to the real script) keeps the production path with
# no fail-open toggle on it.
echo "--- mutation proof: the guard must be load-bearing, not decorative ---"
MUT="$TMP/swap-trend-mutant.sh"
sed 's/^    if used_agents and agent_coef < 0\.0:/    if False:/' "$SCRIPT" > "$MUT"
if ! grep -q "if False:" "$MUT"; then
  echo "FAIL  mutation   could not disable the guard -- the anchor line moved; fix this test"
  fail=$((fail+1))
else
  gen falling_agent_ramp "$TMP/mut.log"
  mout=$(PAPERCLIP_MEM_WATCH_LOG="$TMP/mut.log" bash "$MUT" 2 2>&1); mrc=$?
  mgot=$(printf '%s\n' "$mout" | sed -n 's/.*verdict=\([A-Z_]*\).*/\1/p' | tail -1)
  if [ "$mgot" = "SATISFIED" ] && [ "$mrc" = "0" ]; then
    printf 'PASS  %-12s %-14s exit=%s  %s\n' "mutation" "$mgot" "$mrc" \
      "guard removed -> SATISFIED/exit 0 returns; the guard is what blocks it"
    pass=$((pass+1))
  else
    printf 'FAIL  %-12s got %s/exit=%s, want SATISFIED/exit=0  %s\n' \
      "mutation" "${mgot:-NONE}" "$mrc" "guard is NOT load-bearing on this series"
    printf '      %s\n' "$mout"; fail=$((fail+1))
  fi
fi

# --- MUTATION PROOF for the defect-15 build cool-down ---------------------
# Same standard as the covariate guard above: prove the cool-down is what blocks
# the false all-clear, not some unrelated property of the fixture. Mutate a COPY
# back to the pre-fix behaviour (cool-down 0 = the old instantaneous filter) and
# assert the dangerous SATISFIED/exit 0 returns on the identical series.
echo "--- mutation proof: the build cool-down must be load-bearing ---"
MUT2="$TMP/swap-trend-mutant2.sh"
sed 's/^BUILD_COOLDOWN_MIN = 45\.0$/BUILD_COOLDOWN_MIN = 0.0/' "$SCRIPT" > "$MUT2"
if ! grep -q "^BUILD_COOLDOWN_MIN = 0\.0$" "$MUT2"; then
  echo "FAIL  mutation2  could not disable the cool-down -- the anchor line moved; fix this test"
  fail=$((fail+1))
else
  gen build_tail_false_allclear "$TMP/mut2.log"
  m2out=$(PAPERCLIP_MEM_WATCH_LOG="$TMP/mut2.log" bash "$MUT2" 2 2>&1); m2rc=$?
  m2got=$(printf '%s\n' "$m2out" | sed -n 's/.*verdict=\([A-Z_]*\).*/\1/p' | tail -1)
  if [ "$m2got" = "SATISFIED" ] && [ "$m2rc" = "0" ]; then
    printf 'PASS  %-12s %-14s exit=%s  %s\n' "mutation2" "$m2got" "$m2rc" \
      "cool-down removed -> SATISFIED/exit 0 on a +200 MB/h leak; the cool-down is what blocks it"
    pass=$((pass+1))
  else
    printf 'FAIL  %-12s got %s/exit=%s, want SATISFIED/exit=0  %s\n' \
      "mutation2" "${m2got:-NONE}" "$m2rc" "cool-down is NOT load-bearing on this series"
    printf '      %s\n' "$m2out"; fail=$((fail+1))
  fi
fi

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "ALL PASS -- gate discriminates in both directions."
