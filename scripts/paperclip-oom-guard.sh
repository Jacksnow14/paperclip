#!/bin/bash
# paperclip-oom-guard — AUR-3924
#
# Purpose: change WHICH process the Linux OOM killer picks under memory pressure.
#
# Before this guard, every process on the box had oom_score_adj=0, so the kernel
# picked the largest RSS — which is the Paperclip control plane itself (~320 MB)
# or the embedded Postgres. Killing the control plane orphans every in-flight
# agent run ("Process lost -- server may have restarted"), those runs auto-retry,
# the retries spawn MORE `claude` children, and memory pressure increases. That
# is the self-amplifying loop described in AUR-3924.
#
# After this guard, the kernel prefers to kill a single `claude` agent child.
# One run fails instead of all of them, and the loop cannot amplify.
#
# Ordering (most protected -> most sacrificial):
#   -900  embedded Postgres (company database; losing it is a full outage)
#   -800  control-plane main pids (both units, until AUR-3931 retires the leftover)
#   +600  `claude` agent child processes (sacrificial, bounded blast radius)
#
# Reversible: `systemctl disable --now paperclip-oom-guard.timer` and the values
# decay naturally as processes restart. Nothing here restarts or stops any unit.

set -uo pipefail

set_adj() {
  local pid="$1" adj="$2"
  [[ "$pid" == "$$" ]] && return 0
  [[ -w "/proc/$pid/oom_score_adj" ]] || return 0
  echo "$adj" > "/proc/$pid/oom_score_adj" 2>/dev/null || true
}

# Only act on a pid whose /proc/<pid>/comm matches. pgrep -f alone also matches
# any shell that merely *mentions* the pattern (including this script's own
# subshells and an agent that greps for it), which would otherwise hand a
# `claude` process the -900 database protection.
comm_is() {
  [[ "$(cat "/proc/$1/comm" 2>/dev/null)" == "$2" ]]
}

# --- Protect the embedded Postgres (postmaster + every backend) ---------------
for pg in $(pgrep -f 'bin/postgres -D .*instances/default/db' 2>/dev/null); do
  comm_is "$pg" postgres || continue
  set_adj "$pg" -900
  for child in $(pgrep -P "$pg" 2>/dev/null); do
    comm_is "$child" postgres && set_adj "$child" -900
  done
done

# --- Protect the control-plane main pid --------------------------------------
# AUR-3931 (2026-07-25): the leftover system unit (:3210) that used to own
# Postgres in its cgroup has been RETIRED, and Postgres now lives in its own
# paperclip-db.service (OOMScoreAdjust=-900 in the unit, reinforced above).
# Only the canonical user unit (:3100) remains, so there is one pid to protect.
for unit_pid in \
  "$(runuser -u ievgen -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show paperclip.service -p MainPID --value 2>/dev/null)"
do
  [[ "${unit_pid:-0}" =~ ^[0-9]+$ ]] && [[ "$unit_pid" -gt 0 ]] || continue
  set_adj "$unit_pid" -800
  # the tsx/node worker child is the process that actually holds the heap
  for child in $(pgrep -P "$unit_pid" 2>/dev/null); do
    [[ "$(cat /proc/$child/comm 2>/dev/null)" == "node" ]] && set_adj "$child" -800
  done
done

# --- Make agent child processes the preferred OOM victims --------------------
for cp in $(pgrep -f '/\.local/bin/claude --print' 2>/dev/null); do
  comm_is "$cp" claude && set_adj "$cp" 600
done

exit 0
