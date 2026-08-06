#!/usr/bin/env bash
# AUR-4028: auto-deploy tick. One script, two stages, one lock.
#
#   Stage 1 (arm, enabled on landing): if origin/master moved past the activated
#   release, build it via safe-deploy.sh --build-only (AUR-4029: preflight +
#   cgroup-bounded, watchdogged build — an unattended 10-minute builder is
#   exactly the caller that must not run an unbounded 3.6 GB compile), then
#   atomically flip `current` here. Restarts nothing. Direct
#   build-release.sh --activate is refused since AUR-4155; the flip idiom below
#   is the same one safe-deploy.sh uses. Guarded by a memory preflight
#   (this box OOMs, see AUR-3924) and a 3-strikes-per-SHA quarantine so a
#   broken master tip cannot trigger a 3 GB build attempt every 10 minutes
#   forever. A safe-deploy PREFLIGHT/WATCHDOG refusal is a busy box, not a bad
#   SHA: it is never counted as a strike, only retried next tick.
#
#   Stage 2 (make it live, DISABLED by default: PAPERCLIP_AUTO_RESTART_ENABLED=0):
#   when the running SHA differs from the activated SHA, wait for quiescence
#   (running == 0 across two consecutive samples, queued deliberately ignored —
#   see AUR-4020: a queued run has no child process and is picked up after boot),
#   capture the rollback target from the RUNNING sha before touching anything,
#   restart paperclip.service, health-gate the result, and roll back + quarantine
#   the new SHA on failure. If the rollback itself does not come healthy: SEV2,
#   write a halt file, and stop touching production.
#
# Quiescence asks the control-plane DB directly (query-active-runs.mjs).
# /api/health cannot answer it in this deployment: the run-count block is gated
# behind PAPERCLIP_DEV_SERVER_STATUS_FILE, which is unset on the live server.
#
# State: every tick writes a world-readable state file consumed by
# check-deploy-drift.sh. A STALE state file is itself the "automation is dead"
# signal — deliberate: the daemon's death is detected by the same mechanism that
# reports its normal operation, not by a second watchdog that could also die.
#
# Hermetic-test surface: every path, command, and threshold below is
# env-overridable so auto-deploy.test.sh can drive a scratch app root and a
# scratch --user unit. Production defaults are the plain values.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

# AUR-4134 deletion guard (assert_deletable + PAPERCLIP_DEPLOY_RM): the only
# sanctioned way to remove a release directory. Sourceable, no side effects.
# shellcheck source=scripts/deploy/release-guard.sh
source "$HERE/release-guard.sh"

APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
REMOTE=${PAPERCLIP_DEPLOY_REMOTE:-https://github.com/Jacksnow14/paperclip.git}
HEALTH_URL=${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}
UNIT=${PAPERCLIP_DEPLOY_UNIT:-paperclip.service}
STATE_DIR=${PAPERCLIP_DEPLOY_STATE_DIR:-/var/lib/paperclip}
LOCK_FILE=${PAPERCLIP_DEPLOY_LOCK_FILE:-/var/lock/paperclip-deploy.lock}
LOG_FILE=${PAPERCLIP_AUTO_DEPLOY_LOG:-/var/log/paperclip-auto-deploy.log}
NOTIFY=${PAPERCLIP_DEPLOY_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
BUILD_CMD=${PAPERCLIP_DEPLOY_BUILD_CMD:-$HERE/safe-deploy.sh}
# How long a tick lets safe-deploy's preflight wait for a quiet box. Short on
# purpose: a refused tick is a no-strike skip and the timer retries in 10 min.
ARM_PREFLIGHT_WAIT=${PAPERCLIP_DEPLOY_ARM_PREFLIGHT_WAIT_SEC:-60}
RUN_COUNTS_CMD=${PAPERCLIP_DEPLOY_RUN_COUNTS_CMD:-${PAPERCLIP_DEPLOY_NODE:-/usr/bin/node} $HERE/query-active-runs.mjs}
# AUR-5019: pre-flip migration gate. Replays the candidate's pending migrations
# against a scratch DB seeded from a live-data snapshot, via the candidate's own
# applier. Runs between "release built" and the `current` flip — both arm paths
# (fresh build and flip-only resume) pass through it. PAPERCLIP_MIGRATION_GATE_ENABLED=0
# is the break-glass.
MIGRATION_GATE_CMD=${PAPERCLIP_DEPLOY_MIGRATION_GATE_CMD:-${PAPERCLIP_DEPLOY_NODE:-/usr/bin/node} $HERE/migration-gate.mjs}
MIGRATION_GATE_ENABLED=${PAPERCLIP_MIGRATION_GATE_ENABLED:-1}
# AUR-5019 review R3: an infra-failing gate silently stops every deploy, and
# the deploy is the thing that would ship the fix. No strike per failure (not
# a property of the SHA), but after this many CONSECUTIVE infra refusals the
# tick pages SEV2 — and keeps paging at each further multiple while the streak
# lasts. Separate ledger from build failures; a working gate resets it.
GATE_INFRA_ALERT_TICKS=${PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS:-6}
MEM_FLOOR_MB=${PAPERCLIP_DEPLOY_MEM_FLOOR_MB:-2500}
RESTART_ENABLED=${PAPERCLIP_AUTO_RESTART_ENABLED:-0}
ROLLBACK_ENABLED=${PAPERCLIP_AUTO_ROLLBACK_ENABLED:-1}
QUIESCE_INTERVAL=${PAPERCLIP_DEPLOY_QUIESCE_INTERVAL_SEC:-30}
HEALTH_TIMEOUT=${PAPERCLIP_DEPLOY_HEALTH_TIMEOUT_SEC:-120}
HEALTH_POLL=${PAPERCLIP_DEPLOY_HEALTH_POLL_SEC:-3}
MAX_BUILD_FAILURES=${PAPERCLIP_DEPLOY_MAX_BUILD_FAILURES:-3}
# ${VAR-default} (not :-) so tests can set SUDO= to run unprivileged on
# user-owned scratch roots.
SUDO=${PAPERCLIP_DEPLOY_SUDO-sudo -n}

STATE_FILE=$STATE_DIR/auto-deploy.state
QUAR_FILE=$STATE_DIR/auto-deploy.quarantine
FAIL_FILE=$STATE_DIR/auto-deploy.build-failures
HALT_FILE=$STATE_DIR/auto-deploy.halt
BUILD_OUT=$STATE_DIR/auto-deploy.last-build.out
GATE_OUT=$STATE_DIR/auto-deploy.last-migration-gate.out
GATE_FAIL_FILE=$STATE_DIR/auto-deploy.gate-infra-failures

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE" 2>/dev/null || true
}

notify() { # $1=severity $2=text
  # Delivery failure is never swallowed (AUR-3930): a missed page must be
  # visible in the journal and the log file.
  if [[ -x "$NOTIFY" ]] && "$NOTIFY" "$1" "$2"; then
    log "escalated $1: $2"
  else
    log "ESCALATION FAILED to deliver via $NOTIFY ($1): $2"
  fi
}

run_priv() {
  if [[ -n "$SUDO" ]]; then $SUDO "$@"; else "$@"; fi
}

# --- state file --------------------------------------------------------------
# Written every tick, world-readable, read by check-deploy-drift.sh. Keys:
#   last_tick, phase, armed_sha, running_sha, running_count, queued_count,
#   stale_discounted, waiting_since, restart_enabled, note
PHASE=idle ARMED_SHA=- RUNNING_SHA_S=- RUNNING_COUNT=- QUEUED_COUNT=-
STALE_NAMED=- WAITING_SINCE=- NOTE=-

write_state() {
  local tmp
  tmp=$(mktemp "${STATE_FILE}.XXXXXX" 2>/dev/null) || return 0
  cat > "$tmp" <<EOF
last_tick=$(date -u +%Y-%m-%dT%H:%M:%SZ)
phase=$PHASE
armed_sha=$ARMED_SHA
running_sha=$RUNNING_SHA_S
running_count=$RUNNING_COUNT
queued_count=$QUEUED_COUNT
stale_discounted=$STALE_NAMED
waiting_since=$WAITING_SINCE
restart_enabled=$RESTART_ENABLED
note=$NOTE
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATE_FILE"
}

PREV_PHASE=- PREV_ARMED=- PREV_WAITING=-
read_prev_state() {
  [[ -r "$STATE_FILE" ]] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      phase) PREV_PHASE=$v ;;
      armed_sha) PREV_ARMED=$v ;;
      waiting_since) PREV_WAITING=$v ;;
    esac
  done < "$STATE_FILE"
}

# --- quarantine + build-failure ledger ----------------------------------------
quarantined() { [[ -f "$QUAR_FILE" ]] && grep -q "^$1 " "$QUAR_FILE"; }
quarantine() { # $1=sha $2=reason
  echo "$1 $2 $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$QUAR_FILE"
  log "quarantined $1 ($2)"
}
fail_count() { [[ -f "$FAIL_FILE" ]] && awk -v s="$1" '$1==s{print $2; f=1} END{if(!f)print 0}' "$FAIL_FILE" || echo 0; }
set_fail_count() { # $1=sha $2=count
  local tmp
  tmp=$(mktemp "${FAIL_FILE}.XXXXXX" 2>/dev/null) || return 0
  [[ -f "$FAIL_FILE" ]] && grep -v "^$1 " "$FAIL_FILE" > "$tmp" 2>/dev/null
  [[ "$2" -gt 0 ]] && echo "$1 $2" >> "$tmp"
  mv -f "$tmp" "$FAIL_FILE"
}

# --- probes --------------------------------------------------------------------
read_activated_sha() {
  python3 -c "import json; print(json.load(open('$APP_ROOT/current/build-info.json'))['sha'])" 2>/dev/null || echo none
}

# Sets H_STATUS + H_SHA from /api/health. "none"/"none" when unreachable.
probe_health() {
  local body
  H_STATUS=none H_SHA=none
  body=$(curl -sf -m 10 -H "Accept: application/json" "$HEALTH_URL" 2>/dev/null || true)
  [[ -n "$body" ]] || return 1
  read -r H_STATUS H_SHA < <(printf '%s' "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("status") or "none", (d.get("build") or {}).get("sha") or "none")
' 2>/dev/null || echo "unparseable none")
  [[ "$H_SHA" != "none" ]]
}

# Sets RUN_N (fresh running), QUEUE_N, STALE_IDS from the control-plane DB (or
# the injected test stub). Stale running rows are DISCOUNTED from RUN_N by the
# helper and NAMED here, never silently swallowed.
probe_runs() {
  local body
  RUN_N= QUEUE_N= STALE_IDS=-
  body=$($RUN_COUNTS_CMD 2>>"$LOG_FILE") || return 1
  read -r RUN_N QUEUE_N STALE_IDS < <(printf '%s' "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
stale = d.get("staleRunning") or []
names = ",".join("%s(%ss)" % (s.get("id", "?"), s.get("ageSec", "?")) for s in stale) or "-"
print(d.get("running", ""), d.get("queued", 0), names)
' 2>/dev/null)
  [[ -n "$RUN_N" ]]
}

# Waits up to HEALTH_TIMEOUT for /api/health to report status=ok AND the
# intended sha. Both conditions: a healthy server running the WRONG sha is a
# failed deploy, not a healthy one.
health_gate() { # $1=intended sha
  local deadline
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if probe_health && [[ "$H_STATUS" == "ok" && "$H_SHA" == "$1" ]]; then
      return 0
    fi
    sleep "$HEALTH_POLL"
  done
  return 1
}

# Atomic repoint of current, same pattern as build-release.sh --activate.
repoint_current() { # $1=release dir name (sha12)
  run_priv ln -sfn "releases/$1" "$APP_ROOT/current.next" && \
  run_priv mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
}

# ================================================================================
mkdir -p "$STATE_DIR" 2>/dev/null || true
[[ -d "$STATE_DIR" && -w "$STATE_DIR" ]] || { log "FATAL: state dir $STATE_DIR not writable"; exit 1; }

# One lock across both stages: never build while restarting, never restart
# mid-build. A tick that finds the lock held (a build from the previous tick is
# still running) skips silently and lets the next tick retry.
exec 9>"$LOCK_FILE" || { log "FATAL: cannot open lock $LOCK_FILE"; exit 1; }
if ! flock -n 9; then
  log "tick skipped: deploy lock held (build or restart in progress)"
  exit 0
fi

read_prev_state

if [[ -f "$HALT_FILE" ]]; then
  PHASE=halted NOTE="halt file present: $(head -c 200 "$HALT_FILE" 2>/dev/null | tr '\n' ' ')"
  write_state
  log "HALTED: $NOTE — remove $HALT_FILE after manual recovery"
  exit 1
fi

# --- Stage 1: arm ---------------------------------------------------------------
master_sha=$(git ls-remote "$REMOTE" refs/heads/master 2>/dev/null | cut -f1)
[[ -n "$master_sha" ]] || master_sha=unknown
activated_sha=$(read_activated_sha)

if [[ "$master_sha" == "unknown" ]]; then
  log "arm skipped: remote $REMOTE unreachable"
elif [[ "$master_sha" == "$activated_sha" ]]; then
  : # nothing to arm
elif quarantined "$master_sha"; then
  log "arm skipped: master $master_sha is quarantined ($(grep "^$master_sha " "$QUAR_FILE" | head -1))"
else
  mem_avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  if (( mem_avail_mb < MEM_FLOOR_MB )); then
    # An auto-deploy that OOMs the box to ship a commit is a worse defect than
    # the one it fixes (AUR-3924). Skip, say so, retry next tick.
    PHASE=arm-skipped-low-memory ARMED_SHA=- NOTE="MemAvailable=${mem_avail_mb}MB < floor ${MEM_FLOOR_MB}MB for $master_sha"
    write_state
    log "arm skipped: $NOTE"
  else
    rel12=${master_sha:0:12}
    release_dir="$APP_ROOT/releases/$rel12"
    built_sha=$(python3 -c "import json; print(json.load(open('$release_dir/build-info.json'))['sha'])" 2>/dev/null || echo none)
    arm_built=0 arm_blocked=0 gate_refused=0
    if [[ "$built_sha" == "$master_sha" ]]; then
      # build-release.sh writes build-info.json LAST, after its own artifact
      # asserts, so a matching sha means a complete build is already on disk —
      # e.g. a previous tick that died between build and flip. Flip only.
      log "arming $master_sha: release $rel12 already built — flip only"
      arm_built=1
    else
      if [[ -e "$release_dir" ]]; then
        # A leftover dir WITHOUT a matching build-info.json is a partial build
        # (died mid-clone/compile); build-release.sh refuses to reuse it. Clear
        # it under the AUR-4134 guard — never a running/current/previous
        # release. If the guard refuses, skip the doomed build (it would only
        # burn a quarantine strike on an infra condition).
        if assert_deletable "$APP_ROOT" "$release_dir" 2>>"$LOG_FILE"; then
          log "arming $master_sha: clearing partial release dir $rel12 first"
          $PAPERCLIP_DEPLOY_RM "$release_dir"
        else
          arm_blocked=1
          PHASE=arm-blocked-partial-release ARMED_SHA=$master_sha NOTE="releases/$rel12 incomplete but protected (running/current/previous?) — not deleting"
          write_state
          log "arm blocked: $NOTE"
        fi
      fi
      if (( ! arm_blocked )); then
        PHASE=building ARMED_SHA=$master_sha NOTE=-
        write_state
        log "arming $master_sha (activated=$activated_sha, MemAvailable=${mem_avail_mb}MB)"
        # safe-deploy.sh --build-only (AUR-4029): preflight + cgroup-bounded,
        # watchdogged build. Direct build-release.sh --activate is refused
        # since AUR-4155; the flip is ours, below, after the build succeeds.
        t0=$(date +%s)
        if PAPERCLIP_DEPLOY_PREFLIGHT_WAIT_SEC=$ARM_PREFLIGHT_WAIT \
             $BUILD_CMD --ref "$master_sha" --build-only > "$BUILD_OUT" 2>&1; then
          t1=$(date +%s)
          arm_built=1
          log "built $rel12 in $(( t1 - t0 ))s (build wall time)"
        fi
        cat "$BUILD_OUT" >> "$LOG_FILE" 2>/dev/null || true
      fi
    fi
    if (( arm_built )) && [[ "$MIGRATION_GATE_ENABLED" == "1" ]]; then
      # AUR-5019: the gate stands between a complete build and the flip. Exit 2
      # means the replay ABORTED — a property of this SHA against today's live
      # data, the exact class that crash-looped production on 2026-08-05 (0098,
      # 0099): quarantine immediately (retrying adds no information) and page.
      # Any other nonzero is the gate itself failing — not a property of the
      # SHA: fail closed (no flip), no strike, retry next tick.
      gate_rc=0
      $MIGRATION_GATE_CMD --release "$release_dir" > "$GATE_OUT" 2>&1 || gate_rc=$?
      cat "$GATE_OUT" >> "$LOG_FILE" 2>/dev/null || true
      if (( gate_rc == 2 )); then
        gate_refused=1
        rm -f "$GATE_FAIL_FILE"   # the gate RAN — its own channel is healthy
        quarantine "$master_sha" migration-gate-blocked
        PHASE=arm-blocked-migration-gate ARMED_SHA=$master_sha NOTE="migration gate BLOCKED (replay aborted) — see $GATE_OUT"
        write_state
        log "arm BLOCKED by migration gate: $(tail -2 "$GATE_OUT" 2>/dev/null | tr '\n' ' ')"
        notify SEV2 "auto-deploy migration gate BLOCKED ${master_sha:0:12}: a pending migration aborts when replayed against a live-data snapshot — deploying it would crash-loop boot (AUR-5019). SHA quarantined; production unaffected (still on ${activated_sha:0:12}). Detail: $GATE_OUT"
      elif (( gate_rc != 0 )); then
        gate_refused=1
        gate_fails=$(( $(cat "$GATE_FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$gate_fails" > "$GATE_FAIL_FILE"
        PHASE=arm-gate-infra-failed ARMED_SHA=$master_sha NOTE="migration gate could not run (exit $gate_rc, consecutive $gate_fails) — failing closed, no flip; see $GATE_OUT"
        write_state
        log "arm deferred: migration gate infra failure (exit $gate_rc, consecutive $gate_fails/$GATE_INFRA_ALERT_TICKS) — no strike, retry next tick"
        if (( GATE_INFRA_ALERT_TICKS > 0 && gate_fails % GATE_INFRA_ALERT_TICKS == 0 )); then
          # A channel that cannot report its own failure is more dangerous than
          # one that is loudly broken: without this page the fleet learns the
          # deploy pipeline is dead from the 24h dark-armed drift threshold.
          notify SEV2 "auto-deploy migration gate INFRA-FAILING: $gate_fails consecutive ticks could not run the gate (latest exit $gate_rc). Deploys are failing closed — nothing arms until the gate runs again, including the fix for whatever broke it. Not a bad SHA (no quarantine). Detail: $GATE_OUT. https://paperclip/AUR/issues/AUR-5019"
        fi
      else
        rm -f "$GATE_FAIL_FILE"
        log "migration gate PASS for $rel12: $(tail -1 "$GATE_OUT" 2>/dev/null)"
      fi
    fi
    if (( arm_built && ! gate_refused )) && [[ -e "$APP_ROOT/releases/$rel12/startup-failed" ]]; then
      # AUR-5095 property gate: this exact release dir already failed startup
      # (the crash-loop failover marked it). Never flip `current` into it
      # again, even if the sha ledger above was lost or rotated — the marker
      # travels with the artifact, so a flip loop cannot outrun it. Re-seed
      # the ledger from the marker so stage 1 stops re-building it too.
      quarantined "$master_sha" || quarantine "$master_sha" startup-failed-marker
      PHASE=arm-refused-startup-failed ARMED_SHA=$master_sha NOTE="releases/$rel12 carries a startup-failed marker (crash-loop failover)"
      write_state
      log "arm REFUSED: $NOTE"
    elif (( arm_built && ! gate_refused )); then
      if repoint_current "$rel12"; then
        set_fail_count "$master_sha" 0
        activated_sha=$(read_activated_sha)
        log "armed $activated_sha (current -> releases/$rel12)"
      else
        # Infra failure, not a property of the SHA: no strike. The next tick
        # finds the complete release on disk and retries the flip alone.
        PHASE=arm-flip-failed ARMED_SHA=$master_sha NOTE="repoint of current to releases/$rel12 failed"
        write_state
        log "arm flip FAILED: $NOTE"
      fi
    elif (( gate_refused )); then
      # The gate already wrote its phase, state, and (for BLOCK) the quarantine
      # entry + SEV2 above. Crucially this branch keeps a gate refusal out of
      # the build-failure strike ledger below: the build was fine.
      :
    elif (( ! arm_blocked )); then
      if grep -qE 'preflight did not clear within|WATCHDOG: mem_avail' "$BUILD_OUT" 2>/dev/null; then
        # safe-deploy refused for resources (busy box) or its watchdog stopped
        # the build to protect the host. Not a property of the SHA: no strike,
        # retry next tick.
        PHASE=arm-skipped-preflight ARMED_SHA=- NOTE="safe-deploy preflight/watchdog refused for $master_sha (box busy)"
        write_state
        log "arm skipped: $NOTE — detail in $BUILD_OUT"
      else
        n=$(( $(fail_count "$master_sha") + 1 ))
        set_fail_count "$master_sha" "$n"
        log "auto-arm-build-failed: build failed ($n/$MAX_BUILD_FAILURES) for $master_sha — see $BUILD_OUT"
        if (( n >= MAX_BUILD_FAILURES )); then
          quarantine "$master_sha" auto-arm-build-failed
          notify SEV2 "auto-arm-build-failed: $MAX_BUILD_FAILURES consecutive release builds of master $master_sha failed; SHA quarantined, auto-deploy will NOT retry it. Production unaffected (still on $activated_sha). Fix master or the builder, then remove the line from $QUAR_FILE. https://paperclip/AUR/issues/AUR-4028"
        fi
        PHASE=build-failed ARMED_SHA=$master_sha NOTE="failures=$n/$MAX_BUILD_FAILURES"
        write_state
      fi
    fi
  fi
fi

# --- Stage 2: make it live -------------------------------------------------------
if ! probe_health; then
  PHASE=health-unreachable ARMED_SHA=$activated_sha NOTE="cannot determine running sha via $HEALTH_URL"
  write_state
  log "stage 2 skipped: $NOTE (the drift detector owns alerting for an unreachable server)"
  exit 0
fi
running_sha=$H_SHA
RUNNING_SHA_S=$running_sha

if [[ "$running_sha" == "$activated_sha" ]]; then
  # Keep an arm outcome from THIS tick (skip/fail/blocked) visible in the
  # state file instead of flattening it to idle — the drift detector's
  # behind-origin-master alert carries auto=<phase>, and "idle" there would
  # hide exactly why master is not getting armed.
  [[ "$PHASE" == "idle" ]] && { ARMED_SHA=- NOTE=-; }
  WAITING_SINCE=-
  write_state
  log "in sync: running == activated == ${running_sha:0:12} (phase=$PHASE)"
  exit 0
fi

if [[ "$RESTART_ENABLED" != "1" ]]; then
  # Landing state for AUR-4028: arm-only. AUR-4032 flips the flag.
  PHASE=restart-disabled ARMED_SHA=$activated_sha WAITING_SINCE=- NOTE="PAPERCLIP_AUTO_RESTART_ENABLED=0"
  write_state
  log "armed ${activated_sha:0:12}, running ${running_sha:0:12}: restart disabled by flag — waiting for AUR-4032 to arm"
  exit 0
fi

if quarantined "$activated_sha" || [[ -e "$APP_ROOT/releases/${activated_sha:0:12}/startup-failed" ]]; then
  # Second clause is the AUR-5095 property gate: a release the crash-loop
  # failover marked startup-failed must never be restarted into, even if the
  # sha ledger was lost — the marker travels with the artifact.
  PHASE=armed-sha-quarantined ARMED_SHA=$activated_sha NOTE="refusing to restart into quarantined/startup-failed $activated_sha"
  write_state
  log "REFUSING restart: activated sha $activated_sha is quarantined or marked startup-failed"
  exit 1
fi

# Rollback target BEFORE restarting, derived from the RUNNING sha — `current`
# already points at the new release by now. build-release.sh prunes to
# active + 2, so this directory can legitimately be gone; discovering that
# AFTER taking production down is not a rollback path.
rollback12=${running_sha:0:12}
if [[ ! -d "$APP_ROOT/releases/$rollback12" ]]; then
  PHASE=refused-missing-rollback-target ARMED_SHA=$activated_sha NOTE="releases/$rollback12 absent on disk"
  write_state
  log "REFUSING restart: rollback target releases/$rollback12 (the running sha) is not on disk"
  notify SEV2 "auto-deploy REFUSED to restart paperclip: rollback target releases/$rollback12 is gone (pruned?). Armed ${activated_sha:0:12} stays not-live; production untouched on ${running_sha:0:12}. Manual deploy or restore the release dir. https://paperclip/AUR/issues/AUR-4028"
  exit 1
fi

# Quiescence: running == 0 across two consecutive samples >= QUIESCE_INTERVAL
# apart. Queued NEVER blocks (AUR-4020 measurement): a queued run has no child
# process; the row is picked up after boot. Stale running rows (helper bound,
# default 2 h) do not block either, and are NAMED when discounted.
sample=1
while true; do
  if ! probe_runs; then
    PHASE=quiescence-probe-failed ARMED_SHA=$activated_sha NOTE="run-count probe failed: $RUN_COUNTS_CMD"
    write_state
    log "stage 2 aborted: cannot count running runs (probe failed) — refusing to restart blind"
    exit 1
  fi
  RUNNING_COUNT=$RUN_N QUEUED_COUNT=$QUEUE_N STALE_NAMED=$STALE_IDS
  [[ "$STALE_IDS" != "-" ]] && log "stale running rows discounted from quiescence gate: $STALE_IDS"
  if (( RUN_N > 0 )); then
    if [[ "$PREV_PHASE" == "awaiting-quiescence" && "$PREV_ARMED" == "$activated_sha" && "$PREV_WAITING" != "-" ]]; then
      WAITING_SINCE=$PREV_WAITING
    else
      WAITING_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    fi
    PHASE=awaiting-quiescence ARMED_SHA=$activated_sha NOTE="sample $sample: running=$RUN_N > 0"
    write_state
    log "awaiting quiescence for ${activated_sha:0:12}: running=$RUN_N queued=$QUEUE_N (queued does not block) since $WAITING_SINCE"
    exit 0
  fi
  (( sample >= 2 )) && break
  sample=2
  sleep "$QUIESCE_INTERVAL"
done

log "quiescent: running=0 across 2 samples ${QUIESCE_INTERVAL}s apart (queued=$QUEUE_N, ignored) — restarting $UNIT: ${running_sha:0:12} -> ${activated_sha:0:12}"
PHASE=restarting ARMED_SHA=$activated_sha WAITING_SINCE=- NOTE="rollback target releases/$rollback12"
write_state
systemctl --user restart "$UNIT" 2>>"$LOG_FILE" || log "systemctl restart returned nonzero (health gate decides)"

if health_gate "$activated_sha"; then
  PHASE=idle ARMED_SHA=- RUNNING_SHA_S=$activated_sha NOTE="deployed ${activated_sha:0:12}"
  write_state
  log "deploy live: ${activated_sha:0:12} healthy on $HEALTH_URL"
  exit 0
fi

log "health gate FAILED: ${activated_sha:0:12} not healthy within ${HEALTH_TIMEOUT}s"

if [[ "$ROLLBACK_ENABLED" != "1" ]]; then
  # Test-suite negative control ONLY. Production never runs with this off.
  PHASE=restart-failed-rollback-disabled ARMED_SHA=$activated_sha NOTE="PAPERCLIP_AUTO_ROLLBACK_ENABLED=0"
  write_state
  log "rollback DISABLED by flag; leaving $UNIT as-is (broken)"
  notify SEV2 "auto-deploy: new release ${activated_sha:0:12} failed its health gate and auto-rollback is disabled — production may be down on $UNIT. https://paperclip/AUR/issues/AUR-4028"
  exit 1
fi

# Quarantine BEFORE anything else: even if the rollback below fails, Stage 1
# must never re-arm this SHA — without this, auto-deploy flaps good/bad every
# 10 minutes and the auto-rollback becomes the outage.
quarantine "$activated_sha" failed-health-gate

log "rolling back: repointing current -> releases/$rollback12 and restarting"
PHASE=rolling-back ARMED_SHA=$activated_sha NOTE="bad=${activated_sha:0:12} target=$rollback12"
write_state
repoint_current "$rollback12" || log "repoint_current failed (health gate decides)"
systemctl --user restart "$UNIT" 2>>"$LOG_FILE" || log "systemctl restart returned nonzero (health gate decides)"

if health_gate "$running_sha"; then
  PHASE=rolled-back ARMED_SHA=- RUNNING_SHA_S=$running_sha NOTE="bad=${activated_sha:0:12} quarantined; restored=$rollback12"
  write_state
  log "rollback healthy: production restored on ${running_sha:0:12}; ${activated_sha:0:12} quarantined"
  notify SEV2 "auto-deploy ROLLED BACK: ${activated_sha:0:12} failed its health gate after restart; production restored on ${running_sha:0:12}. Bad SHA quarantined — master needs a fix before auto-deploy will ship again. https://paperclip/AUR/issues/AUR-4028"
  exit 1
fi

# Rollback did not come healthy: SEV2 immediately, then STOP TOUCHING IT.
# Automation that keeps retrying into a down production is worse than
# automation that stops and shouts.
echo "rollback to $rollback12 failed health gate at $(date -u +%Y-%m-%dT%H:%M:%SZ); manual recovery required (AUR-4028)" > "$HALT_FILE"
PHASE=rollback-failed ARMED_SHA=$activated_sha NOTE="HALTED: rollback to $rollback12 did not come healthy"
write_state
log "ROLLBACK FAILED: $rollback12 not healthy within ${HEALTH_TIMEOUT}s — auto-deploy HALTED ($HALT_FILE)"
notify SEV2 "auto-deploy ROLLBACK FAILED: production did not come healthy on ${running_sha:0:12} after rolling back from ${activated_sha:0:12}. $UNIT may be DOWN. Auto-deploy has HALTED itself (remove $HALT_FILE after manual recovery). https://paperclip/AUR/issues/AUR-4028"
exit 1
