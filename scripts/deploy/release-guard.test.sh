#!/usr/bin/env bash
# AUR-4134 regression coverage for the release-deletion guard.
#
# The bug being locked down (AUR-4127): build-release.sh's prune deleted the
# release production was executing from, because its only protection was
# `readlink -f "$path" == "$CURRENT_TARGET"` and the script deliberately never
# restarts the service — so `current` and "what is running" are different
# releases for the whole activate->restart window.
#
# There are TWO kill paths and a test covering only one is not enough:
#   1. --activate flips current off the running release and prunes in the same
#      invocation (the 25 Jul incident).
#   2. During an already-open window, two ordinary builds with NO --activate
#      also push the running release into the reap zone.
# Case 2 is why a test written against the earlier "three builds without a
# restart" model would have passed green without reproducing the bug at all.
#
# These tests spawn REAL processes with cwd inside a temp release tree, so the
# actual /proc detection is under test rather than a mock.
#
# Hermetic: temp dirs only, no sudo, no systemd, no network, no /opt.
# Run: bash scripts/deploy/release-guard.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# Never let a bug in the guard reach a real rm -rf from the test suite.
export PAPERCLIP_DEPLOY_RM="rm -rf"
# shellcheck source=scripts/deploy/release-guard.sh
source "$SCRIPT_DIR/release-guard.sh"

TMP=$(mktemp -d)
PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# Build a fake APP_ROOT. Release dirs are created oldest-first with distinct
# mtimes so `ls -1t` ordering is deterministic.
make_app() {
  local app=$1; shift
  local name
  mkdir -p "$app/releases"
  for name in "$@"; do
    mkdir -p "$app/releases/$name"
    touch -d "$(date -u -d "@$((1700000000 + ${#name} ))" +%Y-%m-%dT%H:%M:%S)" "$app/releases/$name" 2>/dev/null || true
    sleep 0.02
    touch "$app/releases/$name"
    sleep 0.02
  done
}

activate() { ln -sfn "releases/$2" "$1/current"; }
set_previous() { ln -sfn "releases/$2" "$1/previous"; }

# Start a real process whose cwd is inside the given release.
run_from() {
  local dir=$1
  ( cd "$dir" && exec sleep 300 ) &
  local pid=$!
  PIDS+=("$pid")
  # Wait for the kernel to publish the cwd link.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$(readlink -f "$dir")" ]] && return 0
    sleep 0.05
  done
  return 1
}

echo "== detection =="
APP="$TMP/detect"
make_app "$APP" R
run_from "$APP/releases/R" || { echo "could not start fixture process" >&2; exit 1; }
check "detects the release a live process runs from" \
  "$(detect_running_releases "$APP")" "R"

echo
echo "== kill path 1: --activate demotes the running release (the 25 Jul incident) =="
# R is running. Two stale un-activated builds are newer. Then N is built and
# activated: current moves off R, and under the OLD loop R lands at KEPT=3.
APP="$TMP/path1"
make_app "$APP" R S1 S2 N
run_from "$APP/releases/R" || exit 1
activate "$APP" N
set_previous "$APP" R
prune_releases "$APP" 2 > "$TMP/path1.log" 2>&1
check "running release R survives --activate prune" \
  "$( [[ -d "$APP/releases/R" ]] && echo present || echo GONE )" "present"
check "current release N survives" \
  "$( [[ -d "$APP/releases/N" ]] && echo present || echo GONE )" "present"
check "invariant holds after prune" \
  "$(assert_running_releases_intact "$APP" >/dev/null 2>&1 && echo ok || echo violated)" "ok"

echo
echo "== kill path 2: open window, NO --activate anywhere =="
# current already points at N (a previous activate), R is still running, and
# two ordinary builds M and P land with no --activate. Under the old loop:
# P=1, M=2, R=3 -> deleted. No --activate involved at any point.
APP="$TMP/path2"
make_app "$APP" R N M P
run_from "$APP/releases/R" || exit 1
activate "$APP" N
prune_releases "$APP" 2 > "$TMP/path2.log" 2>&1
check "running release R survives un-activated builds" \
  "$( [[ -d "$APP/releases/R" ]] && echo present || echo GONE )" "present"
check "invariant holds after prune" \
  "$(assert_running_releases_intact "$APP" >/dev/null 2>&1 && echo ok || echo violated)" "ok"

echo
echo "== retention still reaps genuinely idle releases =="
# Nothing running. current=N, previous=R. Idle A,B,C beyond the keep budget
# must still be collected, or the guard has just disabled retention.
APP="$TMP/retain"
make_app "$APP" A B C D N
activate "$APP" N
set_previous "$APP" A
prune_releases "$APP" 2 > "$TMP/retain.log" 2>&1
check "protected current kept" "$( [[ -d "$APP/releases/N" ]] && echo present || echo GONE )" "present"
check "protected previous kept" "$( [[ -d "$APP/releases/A" ]] && echo present || echo GONE )" "present"
check "2 newest idle kept (D)" "$( [[ -d "$APP/releases/D" ]] && echo present || echo GONE )" "present"
check "2 newest idle kept (C)" "$( [[ -d "$APP/releases/C" ]] && echo present || echo GONE )" "present"
check "oldest idle beyond budget reaped (B)" "$( [[ -d "$APP/releases/B" ]] && echo present || echo GONE )" "GONE"

echo
echo "== --force path =="
APP="$TMP/force"
make_app "$APP" R
run_from "$APP/releases/R" || exit 1
assert_deletable "$APP" "$APP/releases/R" > "$TMP/force.log" 2>&1
check "assert_deletable refuses the running release" "$?" "1"
check "refusal names the reason" \
  "$(grep -qi 'live process is executing' "$TMP/force.log" && echo yes || echo no)" "yes"
check "running release still on disk after refusal" \
  "$( [[ -d "$APP/releases/R" ]] && echo present || echo GONE )" "present"

APP="$TMP/force-idle"
make_app "$APP" IDLE
assert_deletable "$APP" "$APP/releases/IDLE" >/dev/null 2>&1
check "assert_deletable permits an idle release" "$?" "0"

echo
echo "== structural refusals =="
APP="$TMP/struct"
make_app "$APP" R
assert_deletable "$APP" "/etc" >/dev/null 2>&1
check "refuses a path outside releases/" "$?" "1"
assert_deletable "$APP" "$APP/releases" >/dev/null 2>&1
check "refuses releases/ itself" "$?" "1"
assert_deletable "$APP" "$APP/releases/R/sub" >/dev/null 2>&1
check "refuses a nested path" "$?" "1"

echo
echo "== invariant catches a deletion the protected set missed =="
APP="$TMP/invariant"
make_app "$APP" R
run_from "$APP/releases/R" || exit 1
rm -rf "$APP/releases/R"          # simulate any unenumerated kill path
assert_running_releases_intact "$APP" >/dev/null 2>&1
check "invariant fails when a running release vanishes" "$?" "1"

echo
echo "== survives the caller's strict mode =="
# build-release.sh runs under `set -euo pipefail`. Processes exit between
# globbing /proc and reading their entries all the time, and an unreadable
# /proc/<pid>/cmdline redirect under -e would abort a deploy mid-flight. This
# suite otherwise runs without -e, so without this case that gap is invisible.
APP="$TMP/strict"
make_app "$APP" R N
run_from "$APP/releases/R" || exit 1
activate "$APP" N
strict_out=$(
  set -euo pipefail
  source "$SCRIPT_DIR/release-guard.sh"
  PAPERCLIP_DEPLOY_RM="rm -rf"
  detect_running_releases "$APP" >/dev/null
  prune_releases "$APP" 2 >/dev/null
  assert_running_releases_intact "$APP" >/dev/null
  echo survived
) 2>&1
check "guard completes under set -euo pipefail" "$strict_out" "survived"
check "running release intact under strict mode" \
  "$( [[ -d "$APP/releases/R" ]] && echo present || echo GONE )" "present"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
