#!/usr/bin/env bash
# AUR-4338 fire 13 -- regression suite for oom-clause3.sh (clause 3 of AUR-3924).
#
# Same bar as swap-trend.test.sh: the gate must be proven by a FAILING case and a
# PASSING case, and every guard must have a mutation control showing it is
# load-bearing rather than decorative. A filter that only ever suppresses is
# indistinguishable from a blinded counter (fire 9).
#
# Run: bash scripts/aur3924-p0-gates/oom-clause3.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/oom-clause3.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NOW=$(date -u +%s)
pass=0; fail=0

# journalctl -o short-unix line shape: "<epoch>.<usec> <host> kernel: <msg>"
kill_global() { # $1 = hours ago
  local ts; ts=$(awk -v n="$NOW" -v h="$1" 'BEGIN{printf "%d", n-h*3600}')
  echo "${ts}.123456 box kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/user.slice,task=python3,pid=460537,uid=1000"
  echo "${ts}.123999 box kernel: Out of memory: Killed process 460537 (python3) total-vm:14941560kB, anon-rss:6328104kB, oom_score_adj:0"
}
kill_memcg() { # $1 = hours ago
  local ts; ts=$(awk -v n="$NOW" -v h="$1" 'BEGIN{printf "%d", n-h*3600}')
  echo "${ts}.500000 box kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/user.slice/app.slice/run-u15486.scope,task=node,pid=1199290,uid=1000"
  echo "${ts}.500900 box kernel: Memory cgroup out of memory: Killed process 1199290 (node) total-vm:1084512kB, anon-rss:97092kB, oom_score_adj:600"
}

check() { # name  fixture  expect_verdict  expect_exit  note  [env assignments...]
  local name="$1" fx="$2" ev="$3" ee="$4" note="$5"; shift 5
  local out rc
  out=$(env "$@" OOM_C3_JOURNAL_FIXTURE="$fx" bash "$GATE" ${REQ_H:-} 2>&1); rc=$?
  local got; got=$(printf '%s\n' "$out" | sed -nE 's/.*verdict=([A-Z_]+).*/\1/p' | head -1)
  if [ "$got" = "$ev" ] && [ "$rc" = "$ee" ]; then
    printf '  PASS  %-22s %-14s exit=%s  %s\n' "$name" "$got" "$rc" "$note"; pass=$((pass+1))
  else
    printf '  FAIL  %-22s got %s/exit %s, want %s/exit %s  %s\n' "$name" "${got:-<none>}" "$rc" "$ev" "$ee" "$note"
    printf '        %s\n' "$out"; fail=$((fail+1))
  fi
}

echo "== 1. the gate must be able to FIRE (discrimination, not a blinded counter) =="
{ kill_global 2; } > "$TMP/one_global"
REQ_H="" check one_global_kill "$TMP/one_global" KILLS_PRESENT 1 "a real 6.3GB host-wide OOM 2h ago"

{ kill_global 2; kill_global 3; kill_memcg 1; } > "$TMP/mixed"
REQ_H="" check mixed_global_memcg "$TMP/mixed" KILLS_PRESENT 1 "2 global + 1 contained -> must fail on the global ones"

echo "== 2. contained cgroup kills must NOT gate the P0 (fire-9 filter, positive control) =="
: > "$TMP/clean"
REQ_H="" check clean_journal "$TMP/clean" CLEAN 0 "genuinely quiet box"

{ kill_memcg 1; kill_memcg 4; kill_memcg 9; } > "$TMP/memcg_only"
REQ_H="" check memcg_only "$TMP/memcg_only" CLEAN 0 "97MB contained kills = AUR-4536 ceiling WORKING, must not block close"

echo "== 3. a transport failure is NOT a clean box (defect 2) =="
REQ_H="" check journal_unreadable "$TMP/does-not-exist" UNKNOWN 3 "unreadable journal must never read as CLEAN/exit 0"

echo "== 4. THE LIVE CASE: kills aging out of a short window (fire-5 false positive) =="
# Tonight's shape: last global kill 21:30:56Z, evaluated at 03:31Z = 6.01h later.
{ kill_global 6.2; kill_global 7.2; kill_global 8.2; kill_global 9.2; } > "$TMP/aging_out"
REQ_H="" check aging_out_24h "$TMP/aging_out" KILLS_PRESENT 1 "4 kills 6.2-9.2h old -- the 24h clause still sees them"
REQ_H=1 check narrowing_refused "$TMP/aging_out" KILLS_PRESENT 1 "asking for 1h cannot manufacture a pass; clamped up to 24"

echo "== 5. mutation proof: the 24h bar is load-bearing, not decorative =="
# Weaken the clamp to the OLD prose window and the SAME fixture closes the P0.
# This is precisely the 2026-08-06T03:31Z false close this file was written to stop.
REQ_H=6 check mutation_6h_window "$TMP/aging_out" CLEAN 0 "clamp weakened to 6h -> CLEAN/exit 0 returns; the 24h bar is what blocks it" OOM_C3_MIN_NEED_H=6

echo
echo "passed=$pass failed=$fail"
if [ "$fail" -eq 0 ]; then
  echo "ALL PASS -- gate fires on real global kills, ignores contained ones, refuses to guess, and cannot be narrowed into a pass."
  exit 0
fi
echo "SUITE FAILED"
exit 1
