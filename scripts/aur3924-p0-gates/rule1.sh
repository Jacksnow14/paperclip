#!/usr/bin/env bash
# AUR-4338 fire 14 -- rule 1 of the AUR-3924 close condition, as a MECHANISM.
#
# Why this file exists (defect 14):
#   Rule 1 is a CONJUNCTION: "cap_deployed=yes AND swap-trend exit 0 AND
#   oom-clause3 exit 0 AND AUR-4118 done". Since fire 13 each individual clause
#   is a mutation-proven script with a suite. The CONJUNCTION was still prose --
#   "re-check all four clauses from scratch" -- and fires 4, 5, 12 and 13 all
#   established that prose caveats get rubber-stamped and only mechanical gates
#   hold.
#
#   Fire 14 measured why that matters. Clause 2 read SATISFIED/exit 0 at fire 13
#   and INDETERMINATE/exit 1 at fire 14 -- inside the SAME cp_since epoch, with
#   no restart between them, on a superset of the same data. A clause pass is a
#   SNAPSHOT, not a durable property. Clause 3 clears at ~2026-08-06T21:31Z, and
#   the fire that sees it clear will be strongly tempted to carry fire 13's
#   clause-2 SATISFIED forward rather than re-measure. That is precisely the
#   fire-5 shape: a close that is "correct on every recorded clause" while the
#   box's actual state was never jointly witnessed.
#
#   This script makes the conjunction unforgeable: it re-measures all four
#   clauses itself, live, in one invocation.
#
#   CORRECTED at fire 15: this header used to claim there is "NO way to inject
#   or override a clause verdict from outside". That was false -- RULE1_MEM_LOG,
#   RULE1_SWAP_TREND, RULE1_OOM_C3, RULE1_API_BASE and RULE1_CLAUSE4_FIXTURE are
#   all seams, and the suite requires them. A prose claim of unforgeability is
#   exactly the kind of caveat fires 4/5/12/13 proved gets rubber-stamped, so it
#   is replaced by a mechanism: every run prints `overrides_active=`, and only a
#   run printing `overrides_active=none` may be cited as authorising a close.
#
# Verdicts / exit codes (only exit 0 authorises rule 1):
#   RULE1_MET      exit 0  -- all four clauses measured green in THIS invocation
#   RULE1_NOT_MET  exit 1  -- at least one clause measured red
#   UNKNOWN        exit 3  -- a clause could not be measured (API/transport
#                            failure, missing sub-gate, or a control-plane
#                            restart mid-measurement). A failure to measure is
#                            NOT a pass. Ported verbatim from defect 2, where
#                            `journalctl -k` returning 0 for a permissions
#                            reason was indistinguishable from a clean box.
#
# Epoch guard (confound 1, applied to the conjunction itself):
#   cp_since is read BEFORE and AFTER the clause sweep. A control-plane restart
#   mid-sweep means the four readings do not describe one box-state, so the
#   conjunction is refused rather than reported. Same reasoning that forbids
#   fitting a swap slope across a restart.
#
# Usage: rule1.sh            # no arguments: a window cannot be requested here,
#                            # because narrowing is what fires 8 and 13 forbade.

set -uo pipefail

OPS_DIR="${RULE1_OPS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
MEM_LOG="${RULE1_MEM_LOG:-/var/log/paperclip-mem-watch.log}"
SWAP_TREND="${RULE1_SWAP_TREND:-$OPS_DIR/swap-trend.sh}"
OOM_C3="${RULE1_OOM_C3:-$OPS_DIR/oom-clause3.sh}"
API_BASE="${RULE1_API_BASE:-http://127.0.0.1:3100}"
COMPANY_ID="${RULE1_COMPANY_ID:-b26d3647-3e6c-4a28-9c25-e9315696484d}"
CLAUSE4_ISSUE="${RULE1_CLAUSE4_ISSUE:-AUR-4118}"

measured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

read_cp_since() { awk -F, 'END{print $15}' "$MEM_LOG" 2>/dev/null; }

cp_before=$(read_cp_since)
if [ -z "$cp_before" ]; then
  echo "measured_at=$measured_at"
  echo "verdict=UNKNOWN reason=sampler_log_unreadable path=$MEM_LOG"
  exit 3
fi

# --- clause 1: cap_deployed -------------------------------------------------
# Read the sampler's own column. Never hand-roll the grep (defect 1), and never
# index from anywhere but $NF -- defect 9 showed that adding a column would
# silently break this read.
c1_raw=$(awk -F, 'END{print $NF}' "$MEM_LOG" 2>/dev/null)
if [ "$c1_raw" = "yes" ]; then c1="PASS"; elif [ "$c1_raw" = "no" ]; then c1="FAIL"; else c1="UNKNOWN"; fi

# --- clause 2: swap trend ---------------------------------------------------
if [ ! -x "$SWAP_TREND" ]; then
  c2="UNKNOWN"; c2_detail="gate_missing:$SWAP_TREND"; c2_exit=127
else
  c2_out=$("$SWAP_TREND" 2 2>&1); c2_exit=$?
  c2_detail=$(printf '%s\n' "$c2_out" | grep -oE 'verdict=[A-Z_]+' | head -1)
  c2_detail="${c2_detail:-no_verdict_emitted}"
  if [ "$c2_exit" -eq 0 ]; then c2="PASS"; else c2="FAIL"; fi
fi

# --- clause 3: global OOM kills --------------------------------------------
if [ ! -x "$OOM_C3" ]; then
  c3="UNKNOWN"; c3_detail="gate_missing:$OOM_C3"; c3_exit=127
else
  c3_out=$("$OOM_C3" 24 2>&1); c3_exit=$?
  c3_detail=$(printf '%s\n' "$c3_out" | grep -oE 'verdict=[A-Z_]+' | head -1)
  c3_detail="${c3_detail:-no_verdict_emitted}"
  # exit 3 is the gate's own UNKNOWN (journal unreadable) and must propagate as
  # UNKNOWN, not as a plain FAIL -- a transport failure is not a measurement.
  if [ "$c3_exit" -eq 0 ]; then c3="PASS"; elif [ "$c3_exit" -eq 3 ]; then c3="UNKNOWN"; else c3="FAIL"; fi
fi

# --- clause 4: AUR-4118 done ------------------------------------------------
# Checked against the API, never inferred (fire 5 made this a hard gate). A
# transport failure here is UNKNOWN, for the same reason as clause 3: "I could
# not reach the board" must never read as "the blocker is done".
#
# Defect 16 (fire 15). This read used the LIST route with --max-time 20. On
# 2026-08-06T09:0xZ, under load avg 16.6, the list route measured 78.3 / 84.3 /
# 81.7 / 90.2 / 81.6 s and the single-issue route 44.4 / 43.5 / 43.6 s, so the
# 20 s budget could not be met by either and clause 4 returned TRANSPORT_FAIL ->
# UNKNOWN -> exit 3 on a box where AUR-4118 was in fact `done`.
#
# That is fail-CLOSED, and therefore not a false all-clear. It is the OTHER
# failure mode, and it is the one this whole file exists to prevent: a clause
# that cannot be satisfied means rule 1 can never return exit 0, so this
# "self-terminating" watch fires forever. That is defect 1's shape exactly
# (a guessed dist path that pinned cap_symbols=0 for a PATH reason).
#
#   route    single-issue GET. Half the latency of the list route AND immune to
#            two list-route hazards: the q= filter's semantics, and the 1000-row
#            page cap -- a clause-4 issue outside the returned page fell through
#            to the same TRANSPORT_FAIL as a dead socket, conflating "not in the
#            page I asked for" with "could not reach the board".
#   timeout  120 s, ~2.7x the measured single-issue maximum of 44.4 s.
#   retries  3 attempts, so one slow spell cannot manufacture an UNKNOWN, while
#            a genuinely dead board still fails closed inside a bounded 360 s.
#
# The direction that matters: every failure mode below still maps to UNKNOWN.
# Widening the budget cannot turn a red clause green -- it can only stop a green
# clause reading as unmeasurable. Plain constants, no env override, per fire
# 14's BUILD_COOLDOWN precedent: the suite mutates a COPY, so the production
# path carries no fail-open switch a later fire could set to reach a verdict.
CLAUSE4_TIMEOUT_S=120
CLAUSE4_ATTEMPTS=3
if [ -n "${RULE1_CLAUSE4_FIXTURE:-}" ]; then
  c4_status="$RULE1_CLAUSE4_FIXTURE"
else
  c4_status=""
  c4_try=0
  while [ "$c4_try" -lt "$CLAUSE4_ATTEMPTS" ]; do
    c4_try=$((c4_try+1))
    c4_status=$(curl -s --max-time "$CLAUSE4_TIMEOUT_S" \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY:-}" \
      "$API_BASE/api/issues/$CLAUSE4_ISSUE" 2>/dev/null \
      | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('TRANSPORT_FAIL'); sys.exit(0)
if not isinstance(d,dict) or d.get('identifier')!='$CLAUSE4_ISSUE':
    print('NOT_FOUND'); sys.exit(0)
print(d.get('status') or 'NOT_FOUND')
" 2>/dev/null)
    c4_status="${c4_status:-TRANSPORT_FAIL}"
    [ "$c4_status" != "TRANSPORT_FAIL" ] && break
  done
fi
c4_status="${c4_status:-TRANSPORT_FAIL}"
if [ "$c4_status" = "done" ]; then c4="PASS"
elif [ "$c4_status" = "TRANSPORT_FAIL" ] || [ "$c4_status" = "NOT_FOUND" ]; then c4="UNKNOWN"
else c4="FAIL"; fi

# --- epoch guard ------------------------------------------------------------
cp_after=$(read_cp_since)

# --- seam disclosure (fire 15) ----------------------------------------------
# The header used to claim there is "NO way to inject or override a clause
# verdict from outside". That was prose, and it was false: RULE1_MEM_LOG,
# RULE1_SWAP_TREND, RULE1_OOM_C3, RULE1_API_BASE and RULE1_CLAUSE4_FIXTURE are
# all live seams -- the suite needs them, so they cannot simply be removed.
# Rather than let a prose claim stand in for a mechanism (fires 4/5/12/13), a
# run now DECLARES which of its clause inputs were substituted. A verdict quoted
# with overrides_active=none is a live measurement; anything else is a rehearsal
# and must never be cited as authorising a close.
overrides=""
for _v in RULE1_OPS_DIR RULE1_MEM_LOG RULE1_SWAP_TREND RULE1_OOM_C3 \
          RULE1_API_BASE RULE1_COMPANY_ID RULE1_CLAUSE4_ISSUE RULE1_CLAUSE4_FIXTURE; do
  [ -n "${!_v:-}" ] && overrides="${overrides:+$overrides,}$_v"
done
echo "overrides_active=${overrides:-none}"
[ -n "$overrides" ] && echo "WARNING=not_a_live_invocation_clause_inputs_are_substituted"

echo "measured_at=$measured_at cp_since_before=$cp_before cp_since_after=$cp_after"
echo "clause1_cap_deployed=$c1 ($c1_raw)"
echo "clause2_swap_trend=$c2 ($c2_detail, exit=$c2_exit)"
echo "clause3_oom_global=$c3 ($c3_detail, exit=$c3_exit)"
echo "clause4_${CLAUSE4_ISSUE}_done=$c4 ($c4_status)"

if [ "$cp_before" != "$cp_after" ]; then
  echo "verdict=UNKNOWN reason=control_plane_restarted_mid_sweep_readings_do_not_describe_one_box_state"
  exit 3
fi

for v in "$c1" "$c2" "$c3" "$c4"; do
  if [ "$v" = "UNKNOWN" ]; then
    echo "verdict=UNKNOWN reason=a_clause_could_not_be_measured_failure_to_measure_is_not_a_pass"
    exit 3
  fi
done

for v in "$c1" "$c2" "$c3" "$c4"; do
  if [ "$v" != "PASS" ]; then
    echo "verdict=RULE1_NOT_MET reason=at_least_one_clause_red_in_this_invocation"
    exit 1
  fi
done

echo "verdict=RULE1_MET reason=all_four_clauses_measured_green_in_one_live_invocation"
exit 0
