#!/usr/bin/env bash
# AUR-4025 (supersedes AUR-4023): breach-triggered wake off the AUR-3924 host
# memory/OOM sampler at /var/log/paperclip-mem-watch.log.
#
# AUR-3924 had monitorNextCheckAt: null -- the sampler (paperclip-mem-watch.timer,
# every 5 min) was writing v4 rows the whole time but nothing read them, so the
# 2026-07-25 16:02 UTC breach (mem_avail_mb fell to 917 at 16:25:39Z) produced no
# wake. This closes that gap the same way AUR-3937 closed the deploy-drift gap:
# a systemd timer, independent of any agent run or heartbeat, that reads the log
# and escalates via notify_founder.sh -- the one channel proven to reach a human
# (AUR-3930) -- when a standing trigger trips:
#
#   oom_5min > 0        -- an OOM kill happened in the last 5 minutes
#   swap_free_mb < 2000  -- swap is close to exhausted
#   mem_avail_mb < 1500  -- available memory is critically low
#
# Deliberately does NOT touch paperclip-mem-watch.sh/.timer or its schema
# (AUR-4025 non-goal) and does NOT depend on the app release pipeline: it reads
# a plain log file and shells out to a host-level notifier, the same way
# paperclip-mem-watch.sh and paperclip-oom-guard.sh already run standalone from
# /usr/local/sbin rather than from an app release. A host monitor that depends on
# the thing it might need to alert about (a broken deploy) is not a monitor.
#
# Log format note: AUR-4056 fixed the sampler (deployed 2026-07-25 21:00 UTC) so
# it can no longer split a record across two physical lines; the sampler now
# refuses to emit a row that isn't exactly as wide as its own header. That makes
# a row whose field count doesn't match the header a real corruption signal
# (pre-AUR-4056 log history, truncated write, manual edit, etc.), not an
# expected shape to route around -- see the exact-width check below, which
# replaced the old column-position lockout (AUR-4086).
set -uo pipefail

LOG=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
STATE=${PAPERCLIP_MEM_WATCH_ALERT_STATE:-/var/log/paperclip-mem-watch-alert.state}
NOTIFY=${PAPERCLIP_MEM_WATCH_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
ALERT_COOLDOWN_SEC=${PAPERCLIP_MEM_WATCH_ALERT_COOLDOWN_SEC:-1800}
ISSUE_URL=${PAPERCLIP_MEM_WATCH_ISSUE_URL:-https://paperclip/AUR/issues/AUR-3924}
SWAP_FREE_MIN_MB=${PAPERCLIP_MEM_WATCH_SWAP_FREE_MIN_MB:-2000}
MEM_AVAIL_MIN_MB=${PAPERCLIP_MEM_WATCH_MEM_AVAIL_MIN_MB:-1500}

if [[ ! -r "$LOG" ]]; then
  echo "paperclip-mem-watch-alert: log not readable: $LOG" >&2
  exit 1
fi

header=$(head -n1 "$LOG")
IFS=',' read -r -a cols <<< "$header"
declare -A idx
for i in "${!cols[@]}"; do idx["${cols[$i]}"]=$((i + 1)); done
want_cols=${#cols[@]}
for want in ts mem_avail_mb swap_free_mb oom_5min; do
  if [[ -z "${idx[$want]:-}" ]]; then
    echo "paperclip-mem-watch-alert: log header missing column '$want': $header" >&2
    exit 1
  fi
done

last_row=$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z,' "$LOG" | tail -n1) || true
if [[ -z "$last_row" ]]; then
  echo "paperclip-mem-watch-alert: no data rows found in $LOG" >&2
  exit 0
fi

IFS=',' read -r -a fields <<< "$last_row"
if [[ "${#fields[@]}" -ne "$want_cols" ]]; then
  echo "paperclip-mem-watch-alert: row has ${#fields[@]} columns, header has ${want_cols} -- refusing to read a malformed row (AUR-4056 sampler never emits one, so this is corruption, not an expected shape): $last_row" >&2
  exit 1
fi
ts="${fields[$((idx[ts]-1))]:-}"
mem_avail="${fields[$((idx[mem_avail_mb]-1))]:-}"
swap_free="${fields[$((idx[swap_free_mb]-1))]:-}"
oom="${fields[$((idx[oom_5min]-1))]:-}"

if ! [[ "$mem_avail" =~ ^[0-9]+$ && "$swap_free" =~ ^[0-9]+$ && "$oom" =~ ^[0-9]+$ ]]; then
  echo "paperclip-mem-watch-alert: unparseable trigger fields in row: $last_row" >&2
  exit 1
fi

reasons=()
(( oom > 0 )) && reasons+=("oom_5min=$oom")
(( swap_free < SWAP_FREE_MIN_MB )) && reasons+=("swap_free_mb=${swap_free}<${SWAP_FREE_MIN_MB}")
(( mem_avail < MEM_AVAIL_MIN_MB )) && reasons+=("mem_avail_mb=${mem_avail}<${MEM_AVAIL_MIN_MB}")

echo "paperclip-mem-watch-alert: ts=$ts mem_avail_mb=$mem_avail swap_free_mb=$swap_free oom_5min=$oom breach=${#reasons[@]}"

if [[ ${#reasons[@]} -eq 0 ]]; then
  exit 0
fi

reason_str=$(IFS=,; echo "${reasons[*]}")

# Rate limiting. This is a durable early-warning channel, not a per-tick pager:
# a sustained breach must not re-page every 5 minutes (that is how a channel
# gets muted -- see AUR-3937's escalation gate for the same lesson). A *new*
# breaching sample (different ts) is still eligible once the cooldown clears;
# the exact-same already-alerted row is always suppressed regardless of cooldown
# (guards a retriggered/overlapping run reading the same last row twice).
last_alert_ts=""
last_alert_epoch=0
read_state() {
  local f=$1
  [[ -f "$f" ]] || return 1
  last_alert_ts=$(cut -f1 "$f" 2>/dev/null || true)
  last_alert_epoch=$(cut -f2 "$f" 2>/dev/null || echo 0)
  [[ "$last_alert_epoch" =~ ^[0-9]+$ ]] || last_alert_epoch=0
  return 0
}
FALLBACK_STATE=/tmp/paperclip-mem-watch-alert.state
read_state "$STATE" || read_state "$FALLBACK_STATE" || true

now_epoch=$(date -u +%s)
if [[ -n "$last_alert_ts" && "$ts" == "$last_alert_ts" ]]; then
  echo "paperclip-mem-watch-alert: already alerted for row ts=$ts, skipping" >&2
  exit 0
fi
if (( now_epoch - last_alert_epoch < ALERT_COOLDOWN_SEC )); then
  echo "paperclip-mem-watch-alert: cooldown active ($(( now_epoch - last_alert_epoch ))s < ${ALERT_COOLDOWN_SEC}s), skipping alert for ts=$ts (breach persists: $reason_str)" >&2
  exit 0
fi

text="Paperclip host-memory breach ($reason_str) at $ts. mem_avail_mb=$mem_avail swap_free_mb=$swap_free oom_5min=$oom. Source: $LOG. $ISSUE_URL"

if [[ -x "$NOTIFY" ]] && "$NOTIFY" SEV2 "$text"; then
  echo "paperclip-mem-watch-alert: escalated to founder (SEV2): $reason_str" >&2
  # Losing rate-limit state must never translate into losing the page (the page
  # already happened above); degrade to a writable fallback, same as
  # check-deploy-drift.sh's escalation gate.
  if ! printf '%s\t%s\n' "$ts" "$now_epoch" > "$STATE" 2>/dev/null; then
    if printf '%s\t%s\n' "$ts" "$now_epoch" > "$FALLBACK_STATE" 2>/dev/null; then
      echo "paperclip-mem-watch-alert: WARNING rate-limit state fell back to $FALLBACK_STATE ($STATE not writable)" >&2
    else
      echo "paperclip-mem-watch-alert: WARNING no writable rate-limit state ($STATE, $FALLBACK_STATE) -- may re-page sooner than the cooldown" >&2
    fi
  fi
else
  # Never swallow a delivery failure (AUR-3930): a missed page must be visible.
  echo "paperclip-mem-watch-alert: ESCALATION FAILED to deliver via $NOTIFY for breach ($reason_str) at ts=$ts" >&2
  exit 1
fi
