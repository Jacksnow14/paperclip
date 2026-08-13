#!/usr/bin/env bash
# AUR-5095: crash-loop failover for paperclip.service.
#
# Fired by systemd (OnFailure=) when paperclip.service exhausts its start-limit
# burst — i.e. the activated release failed N consecutive starts. On 2026-08-05
# a data-dependent 23505 in migration 0098 crash-looped the control plane 15
# times in 6 minutes; the limiter never bit because RestartSec (10s) >= the
# default StartLimitIntervalSec (10s), so the burst window could never fill.
# The paired drop-in (paperclip-crashloop-bound.conf) widens the window so the
# limiter actually bites; this unit is what makes that bound SAFE — without it,
# StartLimitAction=none would turn the bound into a permanent silent outage.
#
# What it does, in order:
#   1. serialize against auto-deploy.sh (same flock), then re-check the unit is
#      genuinely failed — a manual/spurious start of this unit must be inert;
#   2. mark the failed release with a `startup-failed` marker file INSIDE the
#      release dir (the property travels with the artifact) AND append its full
#      sha to the auto-deploy quarantine ledger (which the LIVE auto-deploy
#      already honors, so protection starts the moment this script first runs);
#   3. flip `current` back to the last release observed running (auto-deploy
#      state file), falling back to the `previous` symlink; a candidate is only
#      valid if its dir exists, differs from the failed release, and does not
#      itself carry a startup-failed marker — that finite ladder is what makes
#      re-entry terminate instead of flip-looping;
#   4. reset-failed + start the unit and health-gate the result by PROPERTY:
#      /api/health ok on any release that is NOT marked startup-failed (a
#      concurrent arm-flip may legitimately change `current` mid-gate);
#   5. notify: INFO when the fleet self-recovered (no founder action needed),
#      SEV2 only when the control plane is still down — and in that case write
#      the auto-deploy halt file so deploy automation stops touching a
#      production that needs a human.
#
# Never run this against a healthy service: it exits 0 without acting unless
# systemctl reports the unit failed.
#
# Hermetic-test surface: every path/command/threshold is env-overridable so
# crash-loop-failover.test.sh can drive a scratch app root and a scratch
# --user unit. Production defaults are the plain values.
set -uo pipefail

APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
UNIT=${PAPERCLIP_DEPLOY_UNIT:-paperclip.service}
HEALTH_URL=${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}
STATE_DIR=${PAPERCLIP_DEPLOY_STATE_DIR:-/var/lib/paperclip}
LOCK_FILE=${PAPERCLIP_DEPLOY_LOCK_FILE:-/var/lock/paperclip-deploy.lock}
LOG_FILE=${PAPERCLIP_FAILOVER_LOG:-/var/log/paperclip-failover.log}
NOTIFY=${PAPERCLIP_DEPLOY_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
# /api/health takes 1-10s under load and a cold boot replays startup work;
# 300s is deliberately far above auto-deploy's 120s post-restart gate.
HEALTH_TIMEOUT=${PAPERCLIP_FAILOVER_HEALTH_TIMEOUT_SEC:-300}
HEALTH_POLL=${PAPERCLIP_FAILOVER_HEALTH_POLL_SEC:-5}
# How long to wait for a mid-tick auto-deploy (its stage-2 restart + health
# gate can hold the lock for minutes). A wedged holder must not block outage
# recovery: on timeout we proceed without the lock, loudly.
LOCK_WAIT=${PAPERCLIP_FAILOVER_LOCK_WAIT_SEC:-300}
SUDO=${PAPERCLIP_DEPLOY_SUDO-sudo -n}

STATE_FILE=$STATE_DIR/auto-deploy.state
QUAR_FILE=$STATE_DIR/auto-deploy.quarantine
HALT_FILE=$STATE_DIR/auto-deploy.halt
PROOF_FILE=$STATE_DIR/failover.last

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE" 2>/dev/null || true
}

notify() { # $1=severity $2=text
  # Delivery failure is never swallowed (AUR-3930).
  if [[ -x "$NOTIFY" ]] && "$NOTIFY" "$1" "$2"; then
    log "escalated $1: $2"
  else
    log "ESCALATION FAILED to deliver via $NOTIFY ($1): $2"
  fi
}

run_priv() {
  if [[ -n "$SUDO" ]]; then $SUDO "$@"; else "$@"; fi
}

marker_path() { echo "$APP_ROOT/releases/$1/startup-failed"; }

release_full_sha() { # $1=sha12; falls back to the dir name if build-info is unreadable
  python3 -c "import json; print(json.load(open('$APP_ROOT/releases/$1/build-info.json'))['sha'])" 2>/dev/null || echo "$1"
}

# Sets H_STATUS + H_SHA from /api/health. Same probe as auto-deploy.sh.
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

# Atomic repoint of current, same idiom as auto-deploy.sh / build-release.sh.
repoint_current() { # $1=release dir name (sha12)
  run_priv ln -sfn "releases/$1" "$APP_ROOT/current.next" && \
  run_priv mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
}

halt_and_page() { # $1=halt reason  $2=SEV2 text
  echo "AUR-5095 crash-loop failover: $1 at $(date -u +%Y-%m-%dT%H:%M:%SZ); manual recovery required" > "$HALT_FILE" 2>/dev/null \
    || log "could not write halt file $HALT_FILE"
  notify SEV2 "$2"
  exit 1
}

# ================================================================================
log "=== crash-loop failover invoked (unit=$UNIT, app=$APP_ROOT) ==="
mkdir -p "$STATE_DIR" 2>/dev/null || true
[[ -d "$STATE_DIR" && -w "$STATE_DIR" ]] || { log "FATAL: state dir $STATE_DIR not writable"; exit 1; }

# Serialize with auto-deploy: if a tick is mid-rollback we wait for it, then
# judge the post-rollback state instead of racing it to the symlink.
exec 9>"$LOCK_FILE" || { log "FATAL: cannot open lock $LOCK_FILE"; exit 1; }
if ! flock -w "$LOCK_WAIT" 9; then
  log "WARNING: deploy lock still held after ${LOCK_WAIT}s — proceeding WITHOUT it (a wedged holder must not block outage recovery)"
fi

# If our own AUR-5095 halt is already present, a previous failover already paged
# — do not page again regardless of the unit's current state. This check MUST
# precede is-failed: during a restart cycle the unit may not yet be in "failed"
# state when OnFailure re-fires us, so waiting for is-failed would cause the
# script to exit with "not in failed state" instead of logging "SEV2 already sent".
if [[ -f "$HALT_FILE" ]] && grep -q "AUR-5095" "$HALT_FILE" 2>/dev/null; then
  log "refusing to act: halt file present from a previous failover ($(head -c 160 "$HALT_FILE" | tr '\n' ' ')) — SEV2 already sent"
  exit 1
fi

# Only act on a genuinely failed unit. OnFailure= implies it, but a manual
# `systemctl start paperclip-failover` against a healthy fleet must be a no-op.
if ! systemctl --user is-failed --quiet "$UNIT"; then
  if probe_health && [[ "$H_STATUS" == "ok" ]]; then
    log "no-op: $UNIT is not failed and /api/health is ok (sha=${H_SHA:0:12}) — nothing to fail over"
  else
    log "no-op: $UNIT is not in the failed state (a restart cycle may still be in progress) — refusing to act on a unit systemd has not given up on"
  fi
  exit 0
fi

failed_target=$(readlink "$APP_ROOT/current" 2>/dev/null || true)
FAILED12=${failed_target##*/}
if [[ -z "$FAILED12" || ! -d "$APP_ROOT/releases/$FAILED12" ]]; then
  halt_and_page "current symlink unreadable ('$failed_target')" \
    "$UNIT is DOWN (start-limit hit) and $APP_ROOT/current is unreadable ('$failed_target') — failover cannot identify the failed release. Manual recovery required. https://paperclip/AUR/issues/AUR-5095"
fi
failed_sha=$(release_full_sha "$FAILED12")
log "failed release: $FAILED12 (sha $failed_sha)"

if [[ -f "$HALT_FILE" ]]; then
  # Deploy automation already declared this production needs a human. Flipping
  # releases under a halt would fight whoever is recovering it. (Our own
  # AUR-5095 halt is handled early — before is-failed — so this path is only
  # reached when the halt was written by something else.)
  notify SEV2 "$UNIT is DOWN (start-limit hit on ${FAILED12}) while deploy automation is HALTED ($(head -c 120 "$HALT_FILE" | tr '\n' ' ')). Failover refuses to flip releases under a halt — manual recovery required. https://paperclip/AUR/issues/AUR-5095"
  exit 1
fi

# Quarantine the failed release BEFORE any recovery step, both ways:
#  - marker in the release dir: the property travels with the artifact, so any
#    future flip path (including one that never consults the ledger) can see it;
#  - full sha in the auto-deploy ledger: the LIVE auto-deploy already checks it,
#    so stage-1 stops re-arming this sha from the first firing, without waiting
#    for the marker-aware auto-deploy.sh to reach production.
m=$(marker_path "$FAILED12")
if [[ ! -e "$m" ]]; then
  printf 'startup-failed %s unit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$UNIT" | run_priv tee "$m" >/dev/null \
    || log "WARNING: could not write marker $m (quarantine ledger still applies)"
fi
if ! grep -q "^$failed_sha " "$QUAR_FILE" 2>/dev/null; then
  echo "$failed_sha startup-crash-loop $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$QUAR_FILE" \
    || log "WARNING: could not append to quarantine ledger $QUAR_FILE"
fi
log "quarantined $FAILED12: marker=$m + ledger entry ($QUAR_FILE)"

# Rollback target: the last release auto-deploy observed RUNNING (state file,
# refreshed every tick), then the `previous` symlink. `previous` alone is not
# enough: build-release.sh only maintains it on --activate, and auto-deploy's
# arm flips bypass that path, so it can lag several releases behind.
last_running=$(awk -F= '$1=="running_sha"{print $2}' "$STATE_FILE" 2>/dev/null)
prev_target=$(readlink "$APP_ROOT/previous" 2>/dev/null || true)
ROLL12=
for cand in "${last_running:0:12}" "${prev_target##*/}"; do
  [[ -n "$cand" && "$cand" != "-" && "$cand" != "none" ]] || continue
  [[ "$cand" != "$FAILED12" ]] || { log "candidate $cand rejected: it IS the failed release"; continue; }
  [[ -d "$APP_ROOT/releases/$cand" ]] || { log "candidate $cand rejected: not on disk"; continue; }
  [[ ! -e "$(marker_path "$cand")" ]] || { log "candidate $cand rejected: carries a startup-failed marker"; continue; }
  ROLL12=$cand
  break
done

if [[ -z "$ROLL12" ]]; then
  halt_and_page "no valid rollback target (last_running=${last_running:-none}, previous=${prev_target:-none})" \
    "$UNIT is DOWN: release ${FAILED12} exhausted its start limit and NO valid rollback target exists (last_running=${last_running:-none}, previous=${prev_target:-none} — gone, identical, or itself marked startup-failed). Control plane needs manual recovery; deploy automation halted. https://paperclip/AUR/issues/AUR-5095"
fi

log "failing over: current ${FAILED12} -> ${ROLL12}"
if ! repoint_current "$ROLL12"; then
  halt_and_page "repoint of current to releases/$ROLL12 failed" \
    "$UNIT is DOWN and the failover could NOT repoint $APP_ROOT/current to releases/$ROLL12 (sudo/filesystem failure). Control plane still down on ${FAILED12}; manual recovery required. https://paperclip/AUR/issues/AUR-5095"
fi

# The start-limit counter is what just declared the unit failed; clear it or
# the recovery start is itself refused.
systemctl --user reset-failed "$UNIT" 2>>"$LOG_FILE" || true
log "start counter reset; starting $UNIT"
systemctl --user start "$UNIT" 2>>"$LOG_FILE" || log "systemctl start returned nonzero (health gate decides)"
log "start dispatched; health-gating up to ${HEALTH_TIMEOUT}s"

# Gate by property, not identity: healthy on ANY release that is not marked
# startup-failed counts — auto-deploy may legitimately arm-flip `current`
# while we poll, and pwd -P pins what the running process actually serves.
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ok=0
while (( $(date +%s) < deadline )); do
  if probe_health && [[ "$H_STATUS" == "ok" && "$H_SHA" != "$failed_sha" && ! -e "$(marker_path "${H_SHA:0:12}")" ]]; then
    ok=1
    break
  fi
  # Bounded by HEALTH_TIMEOUT/HEALTH_POLL lines per incident; an outage
  # recovery log that shows each poll is worth the verbosity.
  log "health gate poll: status=$H_STATUS sha=${H_SHA:0:12}"
  sleep "$HEALTH_POLL"
done

if (( ok )); then
  RUN12=${H_SHA:0:12}
  printf 'recoveredAt=%s failed=%s restored=%s target=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FAILED12" "$RUN12" "$ROLL12" > "$PROOF_FILE" 2>/dev/null || true
  log "SUCCESS: control plane healthy on $RUN12 (failed $FAILED12 quarantined)"
  # Self-recovered outage: not a founder interrupt (fleet Telegram doctrine).
  notify INFO "$UNIT crash-looped on release ${FAILED12} (hit its start limit) and SELF-RECOVERED: rolled back to ${RUN12}, now healthy. Failed sha quarantined; auto-deploy will not re-arm it. No action needed. Detail: $LOG_FILE"
  exit 0
fi

halt_and_page "rollback to $ROLL12 did not come healthy within ${HEALTH_TIMEOUT}s" \
  "$UNIT is STILL DOWN after crash-loop failover: ${FAILED12} exhausted its start limit, rollback to ${ROLL12} did not pass /api/health within ${HEALTH_TIMEOUT}s. Deploy automation halted ($HALT_FILE); manual recovery required. https://paperclip/AUR/issues/AUR-5095"
