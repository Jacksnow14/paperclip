#!/usr/bin/env bash
# AUR-4029: deploy-safety gate around scripts/deploy/build-release.sh.
#
# The release build is the largest single memory consumer on this box: measured
# 3637 MB peak RSS at 16:25Z on 2026-07-25, driving mem_avail to 917 MB while 14
# agents were resident. That is bigger than the entire agent fleet at its
# ceiling, and the AUR-3929 concurrency cap cannot bound it -- the cap governs
# agent runs, not the compiler. Worse, the deploy that *installs* the cap runs
# before the cap is in effect.
#
# This script makes the build a bounded, observed, abortable operation:
#
#   1. preflight  refuse to start below a live mem_avail floor (not a 5-min-old
#                 sample), with no build already resident and no recent OOM.
#   2. build      inside a systemd scope with MemoryHigh/MemoryMax/MemorySwapMax
#                 so the kernel throttles and then kills *the build* rather than
#                 choosing a victim from the agent fleet or the control plane.
#                 Niced so it loses CPU contests too.
#   3. watchdog   samples live mem_avail during the build and stops the scope if
#                 it breaches the abort floor. Bounded is not enough on its own:
#                 the cgroup caps the build's share, the watchdog caps the box's
#                 exposure to everything else moving at the same time.
#   4. verify     artifact checks, then wait for build_rss to drain to 0 before
#                 any restart -- never restart the control plane while a build is
#                 still resident (CEO, AUR-4029).
#   5. activate   symlink flip + restart, separate from the build and fast.
#   6. confirm    grep the sampler for release + cap_deployed. The grep is the
#                 verification, not the drift status (CTO, AUR-4008).
#   7. rollback   automatic if the new release does not come up, or if oom_5min
#                 goes non-zero inside the post-activation watch window.
#
# Usage:
#   scripts/deploy/safe-deploy.sh [--ref <git-ref>] [--build-only] [--activate]
#                                 [--expect-cap] [--watch-min N] [--yes]
#   scripts/deploy/safe-deploy.sh --rollback
#
#   --build-only  produce and verify the artifact, do not touch `current`.
#   --activate    flip `current` and restart paperclip.service, then confirm.
#   --expect-cap  after activation require cap_deployed=yes, else roll back.
#   --rollback    flip `current` back to the previous release and restart.
#
# Related: AUR-3924 (incident), AUR-3937 (release layout), AUR-3929 (the cap),
# AUR-4023 (do not rebuild the sampler -- this script only reads it).
set -euo pipefail

APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
REPO=${PAPERCLIP_DEPLOY_SRC_REPO:-/home/ievgen/paperclip}
SAMPLER_LOG=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
PREV_LINK="$APP_ROOT/previous"
STATE_DIR=${PAPERCLIP_DEPLOY_STATE_DIR:-/var/lib/paperclip-deploy}

# --- tunables, all justified in docs/runbooks/deploy-safety-gate.md ----------
# Live mem_avail required before the build is allowed to start.
FLOOR_MB=${PAPERCLIP_DEPLOY_FLOOR_MB:-2500}
# Live mem_avail at which an in-flight build is killed.
ABORT_FLOOR_MB=${PAPERCLIP_DEPLOY_ABORT_FLOOR_MB:-700}
# cgroup bounds on the build itself. MemoryHigh is deliberately well below what
# the build wants: the 19:51Z exercise showed it absorbs throttling cheaply
# (memory.events high=4185, max=0, oom_kill=0, still finished in 3m25s), so
# trading a little build time for host headroom is free. Measured trough with
# MemoryHigh=2560M was 878 MB; 2048M yields earlier and widens that margin.
BUILD_MEM_HIGH=${PAPERCLIP_DEPLOY_BUILD_MEM_HIGH:-2048M}
BUILD_MEM_MAX=${PAPERCLIP_DEPLOY_BUILD_MEM_MAX:-3584M}
BUILD_SWAP_MAX=${PAPERCLIP_DEPLOY_BUILD_SWAP_MAX:-6G}
# Max agent runs resident before we agree to start a build.
QUIESCE_MAX_PROCS=${PAPERCLIP_DEPLOY_QUIESCE_MAX_PROCS:-6}
# How long preflight will wait for the box to reach a safe state.
PREFLIGHT_WAIT_SEC=${PAPERCLIP_DEPLOY_PREFLIGHT_WAIT_SEC:-900}
WATCH_MIN=15

REF=origin/master
MODE=""
EXPECT_CAP=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --build-only) MODE=build; shift ;;
    --activate) MODE=activate; shift ;;
    --rollback) MODE=rollback; shift ;;
    --expect-cap) EXPECT_CAP=1; shift ;;
    --watch-min) WATCH_MIN="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { echo "one of --build-only / --activate / --rollback is required" >&2; exit 2; }

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[%s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

avail_mb()  { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }
agent_procs() { pgrep -c -f '(^|/)claude( |$)' 2>/dev/null || true; }

# Last well-formed sampler record. The sampler occasionally splits a record
# across two lines (concurrent appends); rather than "fixing" the sampler
# (AUR-4023 says do not), we simply ignore malformed records and read the most
# recent complete one. Field order is the sampler's own header.
sampler_field() { # $1 = 1-based column index
  awk -F, -v col="$1" '
    /^20[0-9][0-9]-/ && NF == 18 { v = $col }
    END { print v }
  ' "$SAMPLER_LOG" 2>/dev/null
}
sampler_oom5()    { sampler_field 8; }
sampler_buildrss(){ sampler_field 12; }
sampler_release() { sampler_field 17; }
sampler_cap()     { sampler_field 18; }

# --------------------------------------------------------------------------
# rollback
# --------------------------------------------------------------------------
do_rollback() {
  [[ -L "$PREV_LINK" ]] || die "no $PREV_LINK recorded -- cannot roll back automatically"
  local prev; prev=$(readlink "$PREV_LINK")
  [[ -d "$APP_ROOT/$prev" ]] || die "previous release $prev is gone -- cannot roll back"
  log "ROLLBACK -> $prev"
  sudo ln -sfn "$prev" "$APP_ROOT/current.next"
  sudo mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
  systemctl --user restart paperclip.service
  sleep 10
  systemctl --user is-active --quiet paperclip.service \
    && log "rollback complete, control plane active on $prev" \
    || die "rollback restart FAILED -- manual intervention required"
}

if [[ "$MODE" == rollback ]]; then
  do_rollback
  exit 0
fi

# --------------------------------------------------------------------------
# 1. preflight
# --------------------------------------------------------------------------
log "=== preflight ==="
git -C "$REPO" fetch --quiet origin
SHA=$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")
SHA12=${SHA:0:12}
CURRENT_TARGET=$(readlink "$APP_ROOT/current" 2>/dev/null || true)   # releases/<sha12>
log "target release : $SHA12 ($REF)"
log "current release: ${CURRENT_TARGET#releases/}"

# Guard the footgun in build-release.sh: --force on the *active* release does
# `sudo rm -rf` on the directory production is currently executing from.
if [[ "$CURRENT_TARGET" == "releases/$SHA12" ]]; then
  die "$SHA12 is the currently-active release; rebuilding it in place would rm -rf running production code. Deploy a different ref, or stop the service first."
fi

deadline=$(( $(date +%s) + PREFLIGHT_WAIT_SEC ))
while :; do
  a=$(avail_mb); p=$(agent_procs); b=$(sampler_buildrss); o=$(sampler_oom5)
  reasons=()
  [[ "$a" -ge "$FLOOR_MB" ]] || reasons+=("mem_avail ${a}MB < floor ${FLOOR_MB}MB")
  [[ "${p:-0}" -le "$QUIESCE_MAX_PROCS" ]] || reasons+=("agent_procs ${p} > ${QUIESCE_MAX_PROCS}")
  [[ "${b:-0}" -eq 0 ]] || reasons+=("a build is already resident (build_rss ${b}MB)")
  [[ "${o:-0}" -eq 0 ]] || reasons+=("recent OOM kills (oom_5min ${o})")
  if [[ ${#reasons[@]} -eq 0 ]]; then
    log "preflight OK: mem_avail=${a}MB agent_procs=${p} build_rss=0 oom_5min=0"
    break
  fi
  [[ $(date +%s) -lt $deadline ]] || die "preflight did not clear within ${PREFLIGHT_WAIT_SEC}s: ${reasons[*]}"
  log "waiting: ${reasons[*]}"
  sleep 30
done

# --------------------------------------------------------------------------
# 2+3. bounded build, with a live-memory watchdog
# --------------------------------------------------------------------------
SCOPE="paperclip-release-build-$SHA12"
log "=== build $SHA12 (MemoryHigh=$BUILD_MEM_HIGH MemoryMax=$BUILD_MEM_MAX nice=10) ==="

watchdog() {
  local low="$1" scope="$2"
  while sleep 5; do
    systemctl --user is-active --quiet "$scope.scope" 2>/dev/null || return 0
    local a; a=$(avail_mb)
    if [[ "$a" -lt "$low" ]]; then
      printf '[%s] WATCHDOG: mem_avail %sMB < %sMB -- stopping build scope\n' \
        "$(date -u +%H:%M:%SZ)" "$a" "$low" >&2
      systemctl --user stop "$scope.scope" 2>/dev/null || true
      return 1
    fi
  done
}

watchdog "$ABORT_FLOOR_MB" "$SCOPE" &
WATCHDOG_PID=$!
cleanup() {
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
}
trap cleanup EXIT

BUILD_RC=0
# Future-proof the wrapper-owned activate path: build-release refuses direct
# `--activate` unless the call is explicitly marked gated or break-glass.
PAPERCLIP_DEPLOY_GATED=1 systemd-run --user --scope --unit "$SCOPE" --nice=10 --quiet \
  -p MemoryHigh="$BUILD_MEM_HIGH" \
  -p MemoryMax="$BUILD_MEM_MAX" \
  -p MemorySwapMax="$BUILD_SWAP_MAX" \
  -p CPUWeight=20 \
  -- "$REPO/scripts/deploy/build-release.sh" --ref "$SHA" || BUILD_RC=$?

cleanup; trap - EXIT

if [[ "$BUILD_RC" -ne 0 ]]; then
  log "build exited $BUILD_RC"
  log "post-build mem_avail=$(avail_mb)MB oom_5min=$(sampler_oom5)"
  die "build failed or was stopped by the watchdog -- 'current' untouched, production unchanged"
fi

# --------------------------------------------------------------------------
# 4. verify artifact, then wait for the build to drain out of memory
# --------------------------------------------------------------------------
RELEASE="$APP_ROOT/releases/$SHA12"
for f in server/dist/index.js server/node_modules/tsx/dist/loader.mjs ui/dist/index.html build-info.json; do
  [[ -f "$RELEASE/$f" ]] || die "artifact incomplete: missing $f"
done
log "artifact verified: $RELEASE"
log "post-build mem_avail=$(avail_mb)MB"

if [[ "$MODE" == build ]]; then
  log "=== build-only: done. 'current' still -> ${CURRENT_TARGET#releases/} ==="
  cap_flag=""; [[ "$EXPECT_CAP" -eq 1 ]] && cap_flag=" --expect-cap"
  log "to activate: $0 --ref $SHA --activate${cap_flag}"
  exit 0
fi

log "waiting for build to drain out of memory before restarting the control plane"
for _ in $(seq 1 60); do
  b=$(sampler_buildrss); [[ "${b:-0}" -eq 0 ]] && break
  log "build_rss=${b}MB, waiting"; sleep 30
done

# --------------------------------------------------------------------------
# 5. activate
# --------------------------------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "activate $SHA12 and restart the control plane? [y/N] " ans
  [[ "$ans" == y || "$ans" == Y ]] || die "aborted by operator"
fi

sudo install -d -m 755 "$STATE_DIR"
sudo ln -sfn "$CURRENT_TARGET" "$PREV_LINK"          # rollback anchor
log "=== activate $SHA12 (previous: ${CURRENT_TARGET#releases/}) ==="
sudo ln -sfn "releases/$SHA12" "$APP_ROOT/current.next"
sudo mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
systemctl --user restart paperclip.service

# --------------------------------------------------------------------------
# 6. confirm via the sampler (the grep, not the drift status)
# --------------------------------------------------------------------------
log "waiting for the sampler to observe the new release"
ok=0
for _ in $(seq 1 24); do   # sampler ticks every 5 min; allow ~12 min
  sleep 30
  systemctl --user is-active --quiet paperclip.service || { log "control plane not active"; do_rollback; exit 1; }
  r=$(sampler_release)
  if [[ "$r" == "$SHA12" ]]; then ok=1; break; fi
  log "sampler still reports release=$r"
done
[[ "$ok" -eq 1 ]] || { log "sampler never observed $SHA12"; do_rollback; exit 1; }

if [[ "$EXPECT_CAP" -eq 1 && "$(sampler_cap)" != yes ]]; then
  log "cap_deployed=$(sampler_cap) after activating $SHA12 -- expected yes"
  do_rollback; exit 1
fi
log "confirmed: release=$SHA12 cap_deployed=$(sampler_cap)"

# --------------------------------------------------------------------------
# 7. post-activation watch
# --------------------------------------------------------------------------
log "=== watching ${WATCH_MIN}m for OOM kills ==="
watch_deadline=$(( $(date +%s) + WATCH_MIN * 60 ))
while [[ $(date +%s) -lt $watch_deadline ]]; do
  sleep 60
  o=$(sampler_oom5)
  if [[ "${o:-0}" -ne 0 ]]; then
    log "oom_5min=$o within the watch window -- rolling back"
    do_rollback; exit 1
  fi
done

log "=== deploy complete: $SHA12, oom_5min=0 across ${WATCH_MIN}m, mem_avail=$(avail_mb)MB ==="
