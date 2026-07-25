#!/usr/bin/env bash
# Regression coverage for the release-retention entry point in
# prune-releases.sh (AUR-4042, rebased onto release-guard.sh / AUR-4134).
#
# The bugs this locks down:
#   - a naive "delete everything but the N newest" prune can orphan the
#     running release if $APP_ROOT/current is missing/dangling (every release
#     looks prune-eligible), or race a concurrent deploy into deleting its
#     freshly-staged release. Both must fail CLOSED — skip and warn loudly,
#     never delete the wrong thing. Cases (a)-(d).
#   - the AUR-4127 incident itself: a live process keeps executing from a
#     release after `--activate` moves `current` off it, and enough newer
#     builds pile up that a current-only rank pushes the running release past
#     the keep budget. This script no longer decides that on its own — it
#     delegates to release-guard.sh's running/current/previous protected set —
#     so case (e) drives a REAL background process to prove the composition
#     (this script's lock + release-guard.sh's /proc guard) actually holds,
#     not just that each half was tested in isolation.
#
# Hermetic: drives prune-releases.sh against a temporary fake $APP_ROOT, with
# PAPERCLIP_DEPLOY_RM overridden to a plain `rm -rf` so no sudo is needed.
# Never touches /opt/paperclip/app. Run: bash scripts/deploy/prune-releases.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PRUNE="$SCRIPT_DIR/prune-releases.sh"
[[ -x "$PRUNE" || -f "$PRUNE" ]] || { echo "missing $PRUNE" >&2; exit 1; }

# Never let a bug in the guard reach a real rm -rf from the test suite.
export PAPERCLIP_DEPLOY_RM="rm -rf"

TMP=$(mktemp -d)
PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

# --- fixtures ----------------------------------------------------------------
APP="$TMP/app"

# mk_release <sha> <age-seconds-ago>: create a release dir with a controlled
# mtime so `ls -1t` ranks them deterministically (newest first).
mk_release() {
  local sha=$1 age=$2
  mkdir -p "$APP/releases/$sha"
  touch -d "@$(( $(date -u +%s) - age ))" "$APP/releases/$sha"
}

set_current() { ln -sfn "releases/$1" "$APP/current"; }

reset_app() {
  rm -rf "$APP"
  mkdir -p "$APP/releases"
}

releases_left() { find "$APP/releases" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort; }

run_prune() {
  PAPERCLIP_DEPLOY_APP_ROOT="$APP" KEEP_ROLLBACKS="${KEEP_ROLLBACKS:-1}" \
    bash "$PRUNE" 2>&1
}

# Start a real process whose cwd is inside the given release, so the /proc
# detection in release-guard.sh is exercised for real, not mocked. Sets
# RUN_FROM_PID rather than printing it — the background sleep must NOT be
# started inside a $(...) command substitution, since it would inherit that
# subshell's stdout pipe and hold it open (hanging the read) long after the
# substitution itself returns.
RUN_FROM_PID=""
run_from() {
  local dir=$1
  ( cd "$dir" && exec sleep 300 ) &
  RUN_FROM_PID=$!
  PIDS+=("$RUN_FROM_PID")
  local _i
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    if [[ "$(readlink -f "/proc/$RUN_FROM_PID/cwd" 2>/dev/null)" == "$(readlink -f "$dir")" ]]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

# --- case (a): 4 releases + valid current prunes down to current+1 ----------
reset_app
mk_release r1-current 100
mk_release r2-newest-rollback 200
mk_release r3-old 300
mk_release r4-oldest 400
set_current r1-current
out=$(run_prune)
left=$(releases_left)
if [[ "$left" == $'r1-current\nr2-newest-rollback' ]]; then
  ok "4 releases + valid current prunes down to current+1, keeping the most recent rollback"
else
  fail "4 releases + valid current prunes down to current+1" "left=[$left] out=$out"
fi

# --- case (b): dangling/missing current prunes nothing ----------------------
reset_app
mk_release r1 100
mk_release r2 200
mk_release r3 300
# no `current` symlink at all
out=$(run_prune)
left=$(releases_left)
if [[ "$left" == $'r1\nr2\nr3' ]] && grep -qi "WARNING" <<<"$out"; then
  ok "missing current prunes nothing and warns loudly"
else
  fail "missing current prunes nothing and warns loudly" "left=[$left] out=$out"
fi

reset_app
mk_release r1 100
mk_release r2 200
ln -sfn "releases/does-not-exist" "$APP/current"
out=$(run_prune)
left=$(releases_left)
if [[ "$left" == $'r1\nr2' ]] && grep -qi "WARNING" <<<"$out"; then
  ok "dangling current prunes nothing and warns loudly"
else
  fail "dangling current prunes nothing and warns loudly" "left=[$left] out=$out"
fi

# --- case (c): the just-built release survives when not yet activated ------
# No argv special-case any more (that was #115's own protected set, deleted
# in the rebase): the just-built release is always the newest directory, so
# it's always the first, in-budget entry once ranked among non-protected
# releases. Assert the BEHAVIOUR — survives while an older non-protected
# release does not — not a parameter that no longer exists.
reset_app
mk_release r1-current 500
set_current r1-current
mk_release r2-just-built 0
mk_release r3-old 600
mk_release r4-older 700
out=$(run_prune)
left=$(releases_left)
if grep -qx "r2-just-built" <<<"$left" && ! grep -qx "r3-old" <<<"$left" && ! grep -qx "r4-older" <<<"$left"; then
  ok "just-built release survives pruning when not yet activated (newest-first, within budget)"
else
  fail "just-built release survives pruning when not yet activated" "left=[$left] out=$out"
fi

# --- case (d): lock held by another process prunes nothing ------------------
reset_app
mk_release r1-current 100
mk_release r2 200
mk_release r3 300
set_current r1-current
exec 200>"$APP/.prune.lock"
flock -n 200 || { fail "lock setup" "could not acquire test-side lock"; }
out=$(run_prune)
left=$(releases_left)
flock -u 200
exec 200>&-
if [[ "$left" == $'r1-current\nr2\nr3' ]] && grep -qi "NOTICE" <<<"$out"; then
  ok "lock held by another process prunes nothing"
else
  fail "lock held by another process prunes nothing" "left=[$left] out=$out"
fi

# --- case (e): concurrent prune with a live process --------------------------
# The composition case neither #115 nor #127 tested alone: reproduces the
# AUR-4127 incident shape (a live process still executing from a release
# after `--activate` moved `current` off it, with newer non-running builds
# stacked on top so a current-only rank would push it past budget), WITH this
# script's own lock uncontended. Asserts both halves at once: the running
# release survives (release-guard.sh's /proc guard, exercised through this
# entry point rather than in isolation), and a real prune still happened
# (r-stale2 is gone) — proving survival isn't just "the lock made us skip
# everything". This can and does go red: reverting prune-releases.sh to
# resolve the protected set itself instead of delegating to
# release-guard.sh's assert_deletable (i.e. the pre-rebase #115 behaviour)
# deletes r-running here, because a current-only/mtime rank has no concept of
# "still running" — verified manually against the pre-rebase script.
reset_app
running_dir="$APP/releases/r-running"
mkdir -p "$running_dir"
touch -d "@$(( $(date -u +%s) - 500 ))" "$running_dir"
run_from "$running_dir" || fail "case (e) setup" "could not start a live process in r-running"
mk_release r-new-current 0
set_current r-new-current
mk_release r-stale1 100
mk_release r-stale2 200
out=$(run_prune)
left=$(releases_left)
if [[ -n "$RUN_FROM_PID" ]]; then kill "$RUN_FROM_PID" 2>/dev/null; fi
if grep -qx "r-running" <<<"$left" && grep -qx "r-new-current" <<<"$left" && ! grep -qx "r-stale2" <<<"$left"; then
  ok "concurrent prune with a live process: running release survives, and the uncontended lock still let pruning proceed"
else
  fail "concurrent prune with a live process" "left=[$left] out=$out"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "prune-releases: all cases passed"
  exit 0
fi
echo "prune-releases: $FAILURES case(s) failed"
exit 1
