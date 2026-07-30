#!/usr/bin/env bash
# AUR-3993 guarded deploy — TICK form. Supersedes aur3993-guarded-deploy.sh
# (one-shot 8h loop) and aur4002-guarded-deploy.sh (hardcoded-sha rollback bomb).
#
# Why this shape: the previous watcher was a single long-lived bash process with
# MAX_WAIT=28800, then `exit 3` and a log line saying "re-arm to retry" — with no
# re-arm. Nothing re-fired it, and nothing alarmed when it expired. Precedent on
# this host: aur4003-finish-deploy-v2.service sat `failed` for five hours and
# nobody noticed. A delivery mechanism that can expire in silence is not a
# delivery mechanism. (CEO review on AUR-3993, 2026-07-25.)
#
# This script is a single idempotent TICK, driven by aur3993-deploy.timer
# (Persistent=true, every 60s). Re-arming is systemd's job, not a bash loop's.
# It self-disables the timer once the target is confirmed serving.
#
# Design rules, each earned from a bug that already fired here:
#  1. Resolve the target from the LIVE `current` symlink at restart time, never
#     from a hardcoded sha. Other agents run build-release.sh --activate
#     concurrently; a sha-equality assertion turns their successful deploy into
#     our false rollback. Corollary the CEO flagged as a free win: if AUR-4091
#     activates a newer release before our quiet window opens, it ships in the
#     SAME restart, with no re-arming and no second deploy.
#  2. Roll back only when the service is UNHEALTHY, never merely because the
#     serving sha is not the one we expected.
#  3. AUR-4087: never force a restart. No quiet window = no-op, retry next tick.
#     The gap this script closes is not the waiting; it is that the waiting had
#     no floor and no alarm.
#  4. A check that cannot fail is worse than no check. The old content probe
#     grepped for 'unresolvable', a string present in services/heartbeat.js in
#     EVERY release including guard-less ones — so it reported "guard present"
#     for a build with no guard. GUARD_MARKER below is a string that exists only
#     in the AUR-3996 guard.
#
# Must run OUTSIDE the paperclip.service cgroup — `systemctl --user restart` from
# inside an agent run kills the caller. The timer unit satisfies this.

set -uo pipefail

# Every external effect is an overridable seam so the rarely-taken paths (deadline
# alarm, rollback, disarm) can be exercised against fakes instead of shipped
# unrun. guarded-deploy-tick.test.sh drives all of them. Defaults are production.
HEALTH="${HEALTH:-http://127.0.0.1:3100/api/health}"
CURRENT_LINK="${CURRENT_LINK:-/opt/paperclip/app/current}"
RELEASES="${RELEASES:-/opt/paperclip/app/releases}"
CGROUP_PROCS="${CGROUP_PROCS:-/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/paperclip.service/cgroup.procs}"
STATE_DIR="${STATE_DIR:-/home/ievgen/paperclip-data/aur3993-deploy}"
LOG="${LOG:-/home/ievgen/paperclip-data/aur3993-guarded-deploy.log}"
NOTIFY="${NOTIFY:-/home/ievgen/bot/notify_founder.sh}"
RESTART_CMD="${RESTART_CMD:-systemctl --user restart paperclip.service}"
DISARM_CMD="${DISARM_CMD:-systemctl --user disable --now aur3993-deploy.timer}"
HEALTH_POLLS="${HEALTH_POLLS:-60}"
HEALTH_POLL_SLEEP="${HEALTH_POLL_SLEEP:-5}"
LOCK="$STATE_DIR/tick.lock"
ARM_STAMP="$STATE_DIR/armed_at"
STREAK_FILE="$STATE_DIR/quiet_streak"
ALERT_STAMP="$STATE_DIR/last_alert_at"

# Only the AUR-3996 capture guard emits this string. Present in 3f3f238a,
# absent from aaac1485. Verified both ways before this script was armed.
GUARD_MARKER='does not resolve to a real issue'

DEADLINE_SECS=${DEADLINE_SECS:-21600}      # 6h with no landing -> alarm
ALERT_COOLDOWN=${ALERT_COOLDOWN:-21600}    # then re-alarm at most every 6h
QUIET_NEEDED=2                             # consecutive quiet ticks before restart

mkdir -p "$STATE_DIR"
log() { echo "[$(date -Is)] $*" >>"$LOG"; }

# Serialize: a tick that is mid-restart holds this for up to ~5 minutes while the
# timer keeps firing every 60s. Without it, overlapping restarts race the symlink.
exec 9>"$LOCK"
flock -n 9 || exit 0

now_epoch() { date +%s; }
serving_sha() { curl -sf --max-time 10 "$HEALTH" 2>/dev/null | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p'; }
current_sha() {
  local d; d=$(readlink -f "$CURRENT_LINK" 2>/dev/null) || return 1
  sed -n 's/.*"sha": *"\([0-9a-f]*\)".*/\1/p' "$d/build-info.json" 2>/dev/null
}
# Count agent adapter processes in the service cgroup. The server itself and the
# run-server wrapper are excluded; everything else named claude/codex/node with an
# adapter-shaped cmdline is a live run we must not kill.
agent_runs() {
  local n=0 pid comm cmd
  [ -r "$CGROUP_PROCS" ] || { echo 0; return; }
  while read -r pid; do
    [ -z "$pid" ] && continue
    comm=$(cat "/proc/$pid/comm" 2>/dev/null || true)
    case "$comm" in claude|codex|node) ;; *) continue ;; esac
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *run-server.sh*|*server/dist*) ;;
      *claude*|*codex*) n=$((n+1)) ;;
    esac
  done <"$CGROUP_PROCS"
  echo "$n"
}
builds_running() { pgrep -f 'build-release\.sh' >/dev/null 2>&1 && echo 1 || echo 0; }

alert() {  # $1 = message. Rate-limited; never fires more than once per cooldown.
  local last=0
  [ -f "$ALERT_STAMP" ] && last=$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)
  if [ $(( $(now_epoch) - last )) -lt "$ALERT_COOLDOWN" ]; then return 0; fi
  now_epoch >"$ALERT_STAMP"
  log "ALERT: $1"
  [ -x "$NOTIFY" ] && "$NOTIFY" "$1" >>"$LOG" 2>&1
}

disarm() {  # landed -> stop polling forever
  log "=== disarming timer (target is serving)"
  $DISARM_CMD >>"$LOG" 2>&1
}

# Success must be announced too. A deploy that lands silently is the same missing
# signal as one that stalls silently — the AUR-3993 serving proof is owed to a
# human either way, and the agent that armed this is not awake to notice (its own
# run is one of the runs the quiet gate waits on, so it CANNOT be awake when this
# fires). Written to a file the next CTO heartbeat reads, and pushed to Telegram.
announce_landed() {  # $1 = sha now serving
  local body; body=$(curl -sf --max-time 10 "$HEALTH" 2>/dev/null || echo '{}')
  {
    echo "landed_at=$(date -Is)"
    echo "serving_sha=$1"
    echo "health=$body"
  } >"$STATE_DIR/landed"
  log "LANDED: $1 -- proof written to $STATE_DIR/landed"
  [ -x "$NOTIFY" ] && "$NOTIFY" "Paperclip deploy landed: now serving ${1:0:12}. AUR-3996 memory-capture guard is live. Post the /api/health proof on AUR-3993 to close it (proof in $STATE_DIR/landed)." >>"$LOG" 2>&1
}

[ -f "$ARM_STAMP" ] || now_epoch >"$ARM_STAMP"
armed_at=$(cat "$ARM_STAMP")

cur=$(current_sha); srv=$(serving_sha)

# --- terminal success -------------------------------------------------------
if [ -n "$cur" ] && [ "$cur" = "$srv" ]; then
  log "SERVING activated release ${cur:0:12}; nothing to do"
  [ -f "$STATE_DIR/landed" ] || announce_landed "$cur"
  disarm
  exit 0
fi

if [ -z "$cur" ]; then
  log "ERROR: cannot resolve current release sha from $CURRENT_LINK; skipping tick"
  exit 4
fi

# --- deadline alarm ---------------------------------------------------------
elapsed=$(( $(now_epoch) - armed_at ))
if [ "$elapsed" -ge "$DEADLINE_SECS" ]; then
  alert "SEV2 paperclip deploy stalled ${elapsed}s: activated ${cur:0:12} still not serving (live=${srv:0:12}). AUR-3996 memory-capture guard is inert until this lands. No quiet window found; deploy will NOT be forced (AUR-4087). See AUR-3993."
fi

# --- quiet gate -------------------------------------------------------------
runs=$(agent_runs); building=$(builds_running)
streak=0; [ -f "$STREAK_FILE" ] && streak=$(cat "$STREAK_FILE" 2>/dev/null || echo 0)

if [ "$runs" -ne 0 ] || [ "$building" -ne 0 ]; then
  [ "$streak" -ne 0 ] && log "quiet streak broken (runs=$runs builds=$building)"
  echo 0 >"$STREAK_FILE"
  log "waiting: $runs agent run(s), $building build(s) in flight (${elapsed}s since arm)"
  exit 0
fi

streak=$((streak+1))
echo "$streak" >"$STREAK_FILE"
log "quiet check ${streak}/${QUIET_NEEDED} (0 runs, 0 builds) after ${elapsed}s"
# Two consecutive quiet ticks: a single sample can land in the gap between one
# run finishing and the next being admitted.
[ "$streak" -lt "$QUIET_NEEDED" ] && exit 0

# --- deploy -----------------------------------------------------------------
TARGET=$(current_sha); PREV="$srv"
if [ -z "$TARGET" ]; then
  log "ERROR: cannot resolve current release sha; refusing to restart blind"
  exit 4
fi
log "target=${TARGET:0:12} (from live symlink)  previously-serving=${PREV:0:12}"

# Informational only — never a go/no-go. A missing marker means the guard did not
# make this build, which is worth shouting about, but is not a reason to leave a
# legitimately activated release undeployed.
if grep -rqsF "$GUARD_MARKER" "$(readlink -f "$CURRENT_LINK")/server/dist" 2>/dev/null; then
  log "content check: AUR-3996 guard marker present in target release"
else
  log "content check: WARNING — AUR-3996 guard marker NOT found in target release"
fi

log "restarting paperclip.service"
$RESTART_CMD
log "restart returned rc=$?"

ok=0
for i in $(seq 1 "$HEALTH_POLLS"); do
  sleep "$HEALTH_POLL_SLEEP"
  body=$(curl -sf --max-time 10 "$HEALTH" 2>/dev/null || true)
  case "$body" in *'"status":"ok"'*) ;; *) continue ;; esac
  now=$(echo "$body" | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p')
  if [ "$now" = "$TARGET" ]; then
    log "HEALTHY: serving target ${TARGET:0:12} after $((i*HEALTH_POLL_SLEEP))s -- $body"; ok=1; break
  fi
  # Healthy but on a different sha => another agent activated a newer release
  # between our resolve and our restart. That is a success, not a rollback.
  if [ -n "$now" ] && [ "$now" != "$PREV" ]; then
    log "HEALTHY on ${now:0:12} (newer than target ${TARGET:0:12}; concurrent activation) -- treating as success"
    ok=1; break
  fi
done

if [ "$ok" -eq 1 ]; then
  log "=== guarded deploy SUCCESS"
  announce_landed "$(serving_sha)"
  disarm
  exit 0
fi

log "ERROR: service not healthy on the new release after $((HEALTH_POLLS*HEALTH_POLL_SLEEP))s; rolling back to ${PREV:0:12}"
if [ -n "$PREV" ] && [ -d "$RELEASES/${PREV:0:12}" ]; then
  sudo -n ln -sfn "$RELEASES/${PREV:0:12}" "$CURRENT_LINK" && log "symlink rolled back" || log "ERROR: rollback flip FAILED"
  $RESTART_CMD
  for i in $(seq 1 24); do
    sleep "$HEALTH_POLL_SLEEP"
    if curl -sf --max-time 10 "$HEALTH" | grep -q '"status":"ok"'; then
      log "rollback healthy after $((i*HEALTH_POLL_SLEEP))s"
      log "=== guarded deploy ROLLED BACK (fix NOT live)"
      alert "SEV2 paperclip deploy FAILED and rolled back to ${PREV:0:12}. Release ${TARGET:0:12} would not come up healthy. AUR-3996 guard still inert. See AUR-3993."
      $DISARM_CMD >>"$LOG" 2>&1
      exit 1
    fi
  done
fi
log "=== CRITICAL: service unhealthy after rollback attempt -- manual intervention required"
alert "SEV2 paperclip CONTROL PLANE UNHEALTHY after failed deploy of ${TARGET:0:12} and failed rollback to ${PREV:0:12}. Manual intervention required on the host. See AUR-3993."
exit 2
