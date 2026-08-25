#!/usr/bin/env bash
# AUR-4338 fire 13 -- clause 3 of the AUR-3924 close condition, as a MECHANISM.
#
# Why this file exists (defect 13):
#   Clause 2 has been a mutation-proven script with a 13-case suite since fire 8.
#   Clause 3 -- the ONLY clause that caught the live failure at fires 12 and 13,
#   and the only one that reads an instrument this watch does not itself author --
#   was a hand-typed one-liner in prose with a hand-typed 6h window.
#   Fire 12 wrote "clause 3 cannot clear until AUR-5022 lands AND 24h pass with
#   zero CONSTRAINT_NONE kills" as PROSE. Fire 4/5's standing rule is that prose
#   caveats get rubber-stamped and only mechanical gates hold; fire 5 measured a
#   false positive that was correct on every measured clause because the last OOM
#   kill was about to age out of the rolling 6h window. That exact situation
#   recurs at 2026-08-06T03:31Z. This makes the 24h bar mechanical.
#
# Verdicts / exit codes (only exit 0 satisfies rule 1 clause 3):
#   CLEAN          exit 0  -- zero CONSTRAINT_NONE kills over the full clamped window
#   KILLS_PRESENT  exit 1  -- one or more global kills in window
#   UNKNOWN        exit 3  -- journal unreadable. A transport failure is NOT a
#                            negative result and must never read as a clean box
#                            (defect 2: `journalctl -k` as a non-adm user silently
#                            returns 0).
#
# Counting rule (defect 9, unchanged and NOT to be relaxed -- fire 12 standing rule):
#   count constraint=CONSTRAINT_NONE ONLY. Contained CONSTRAINT_MEMCG kills are
#   ~50-750 MB-class, are bounded by their own cgroup, and are the SUCCESS signal
#   of AUR-4536's per-run ceiling. Counting them would hold clause 3 at FAIL
#   forever and re-arm this self-terminating watch permanently.
#
# Transport rule (defects 3+4): `-k` restricts to the KERNEL transport. One line
#   per REAL kill -- immune to systemd's per-slice echo AND to app log lines that
#   merely quote the string "oom-kill:" (which has already inflated a true count
#   of 1 to 2 on this box, live).
#
# Usage: oom-clause3.sh [hours]      # hours is clamped UP to MIN_NEED_H, never down

set -uo pipefail

MIN_NEED_H="${OOM_C3_MIN_NEED_H:-24}"
req_h="${1:-24}"

# --- anti-narrowing clamp -------------------------------------------------
# Directly reuses fire 8's defect-8 rule, which is the same failure in a
# different clause: a window shorter than the clause cannot witness the clause,
# so an unsatisfied clause must be resolvable ONLY by waiting, never by asking
# for less. Widening is allowed; narrowing is impossible.
need_h="$req_h"
clamped_from=""
if awk -v a="$req_h" -v b="$MIN_NEED_H" 'BEGIN{exit !(a<b)}'; then
  need_h="$MIN_NEED_H"
  clamped_from="$req_h"
fi

now_epoch=$(date -u +%s)
since_epoch=$(awk -v n="$now_epoch" -v h="$need_h" 'BEGIN{printf "%d", n - h*3600}')

# short-unix gives epoch seconds as field 1: no timezone ambiguity, no year
# ambiguity (the default short format omits the year entirely), and the fixture
# path and the production path share one identical parse.
if [ -n "${OOM_C3_JOURNAL_FIXTURE:-}" ]; then
  if [ -r "$OOM_C3_JOURNAL_FIXTURE" ]; then
    raw=$(cat "$OOM_C3_JOURNAL_FIXTURE"); rc=0
  else
    raw=""; rc=1
  fi
else
  raw=$(sudo -n journalctl -k -o short-unix --since "@${since_epoch}" --no-pager 2>&1); rc=$?
fi

report_tail="window_h=${need_h}${clamped_from:+ need_clamped_from=$clamped_from} since_epoch=${since_epoch}"

if [ "$rc" -ne 0 ]; then
  echo "${report_tail} verdict=UNKNOWN reason=journal_unreadable"
  exit 3
fi

# The `ts>=since` predicate is redundant in production (journalctl already
# filtered) but is deliberately the SAME predicate in both modes, so the clamp
# is genuinely integrated rather than stubbed: the test exercises the real
# production clamp, not a copy of it.
read -r global all <<EOF
$(printf '%s\n' "$raw" | awk -v since="$since_epoch" '
  /oom-kill:/ {
    ts = $1 + 0
    if (ts >= since) {
      a++
      if ($0 ~ /constraint=CONSTRAINT_NONE/) g++
    }
  }
  END { printf "%d %d", g+0, a+0 }')
EOF

memcg=$(( all - global ))
echo "${report_tail} oom_global_CONSTRAINT_NONE=${global} oom_all_constraints=${all} oom_contained_MEMCG=${memcg}"

if [ "$global" -eq 0 ]; then
  echo "verdict=CLEAN clause=no_global_oom_kills_in_${need_h}h"
  exit 0
fi

echo "verdict=KILLS_PRESENT clause=FAIL global_kills=${global}_in_${need_h}h"
exit 1
