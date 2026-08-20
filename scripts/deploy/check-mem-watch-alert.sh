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
# Log format note: AUR-4056 (deployed/verified 2026-07-25 21:00 UTC) fixed the
# sampler to write each record atomically -- it can no longer split a row
# across two physical lines. AUR-4086 lifts the SPLIT_SAFE_MAX_COL freeze this
# reader carried while that bug was live (it refused to trust any column past
# the pre-split-fix "safe" prefix, which meant it could never read columns
# 10-18 -- including build_rss_mb, the sampler's own v4 header calls out as
# "the actual spike driver ... invisible in every prior schema"). Any header
# column can now be trusted; a row whose field count doesn't match the header
# is real corruption, not the old split-write race, and is a loud error below
# rather than a silent fallback.
#
# AUR-4489: the 2026-07-29 11:52Z host OOM was detected on the very next tick,
# but the page was refused by the fleet-wide send-rate guard and then dropped
# forever: the oom_5min trigger is nonzero for exactly one sample, success
# state is only written on delivery, and a failed send was just stderr + exit 1
# into a void. Three changes close that class:
#
#   1. An undelivered page is persisted as a pending record and retried on
#      every subsequent tick BEFORE the current row is evaluated. The retry
#      does not depend on the breach still being visible in the latest sample.
#   2. Retries are bounded (MAX_RETRIES ticks; 8 x 5 min covers the 30-min
#      send-rate window with slack). Once exhausted, the give-up escalation
#      runs with --override on every subsequent tick and the unit exits 1: at
#      that point the condition being escalated is the alert channel itself
#      failing for 40+ minutes, which is host-integrity class regardless of
#      the original trigger. The pending record is never deleted on failure,
#      only on delivery. Exit 1 now means "a page is owed and cannot be
#      delivered"; a deferred-but-retrying page exits 0.
#   3. First-attempt sends for host-integrity triggers (oom_5min > 0,
#      swap_free_mb floor) pass --override with a machine-readable reason: a
#      host OOM must not queue behind business nudges -- that is exactly what
#      the override path exists for. mem_avail_mb-only breaches are early
#      warnings, not integrity events, and stay subject to the shared rate
#      guard; if refused they take the pending/retry path instead of being
#      lost.
set -uo pipefail

LOG=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
STATE=${PAPERCLIP_MEM_WATCH_ALERT_STATE:-/var/log/paperclip-mem-watch-alert.state}
FALLBACK_STATE=${PAPERCLIP_MEM_WATCH_ALERT_STATE_FALLBACK:-/tmp/paperclip-mem-watch-alert.state}
PENDING=${PAPERCLIP_MEM_WATCH_ALERT_PENDING:-/var/log/paperclip-mem-watch-alert.pending}
FALLBACK_PENDING=${PAPERCLIP_MEM_WATCH_ALERT_PENDING_FALLBACK:-/tmp/paperclip-mem-watch-alert.pending}
NOTIFY=${PAPERCLIP_MEM_WATCH_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
ALERT_COOLDOWN_SEC=${PAPERCLIP_MEM_WATCH_ALERT_COOLDOWN_SEC:-1800}
MAX_RETRIES=${PAPERCLIP_MEM_WATCH_ALERT_MAX_RETRIES:-8}
ISSUE_URL=${PAPERCLIP_MEM_WATCH_ISSUE_URL:-https://paperclip/AUR/issues/AUR-3924}
SWAP_FREE_MIN_MB=${PAPERCLIP_MEM_WATCH_SWAP_FREE_MIN_MB:-2000}
MEM_AVAIL_MIN_MB=${PAPERCLIP_MEM_WATCH_MEM_AVAIL_MIN_MB:-1500}

now_epoch=$(date -u +%s)

# ── helpers ──────────────────────────────────────────────────────────────────

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

# Losing rate-limit state must never translate into losing the page (the page
# already happened by the time this is called); degrade to a writable fallback,
# same as check-deploy-drift.sh's escalation gate.
write_success_state() {
  local row_ts=$1
  if ! printf '%s\t%s\n' "$row_ts" "$now_epoch" > "$STATE" 2>/dev/null; then
    if printf '%s\t%s\n' "$row_ts" "$now_epoch" > "$FALLBACK_STATE" 2>/dev/null; then
      echo "paperclip-mem-watch-alert: WARNING rate-limit state fell back to $FALLBACK_STATE ($STATE not writable)" >&2
    else
      echo "paperclip-mem-watch-alert: WARNING no writable rate-limit state ($STATE, $FALLBACK_STATE) -- may re-page sooner than the cooldown" >&2
    fi
  fi
}

# AUR-4489 pending record: one line, tab-separated:
#   first_ts <TAB> reasons <TAB> attempts <TAB> override_flag(0|1)
# override_flag=1 means the pending breach includes a host-integrity class
# (oom_5min / swap floor) and retries may use --override.
pending_first_ts=""
pending_reasons=""
pending_attempts=0
pending_override=0
read_pending() {
  local f
  for f in "$PENDING" "$FALLBACK_PENDING"; do
    [[ -s "$f" ]] || continue
    IFS=$'\t' read -r pending_first_ts pending_reasons pending_attempts pending_override < "$f" || true
    if [[ -n "$pending_first_ts" && "$pending_attempts" =~ ^[0-9]+$ && "$pending_override" =~ ^[01]$ ]]; then
      return 0
    fi
    echo "paperclip-mem-watch-alert: WARNING corrupt pending record in $f -- moving aside to $f.corrupt" >&2
    mv -f "$f" "$f.corrupt" 2>/dev/null || true
    pending_first_ts=""; pending_reasons=""; pending_attempts=0; pending_override=0
  done
  return 1
}

write_pending() {
  local first_ts=$1 reasons=$2 attempts=$3 override=$4
  if printf '%s\t%s\t%s\t%s\n' "$first_ts" "$reasons" "$attempts" "$override" > "$PENDING" 2>/dev/null; then
    return 0
  fi
  if printf '%s\t%s\t%s\t%s\n' "$first_ts" "$reasons" "$attempts" "$override" > "$FALLBACK_PENDING" 2>/dev/null; then
    echo "paperclip-mem-watch-alert: WARNING pending record fell back to $FALLBACK_PENDING ($PENDING not writable)" >&2
    return 0
  fi
  return 1
}

clear_pending() {
  rm -f "$PENDING" "$FALLBACK_PENDING" 2>/dev/null || true
}

is_integrity() {
  # Which triggers qualify for --override (AUR-4489 scope pt. 3): an OOM kill
  # or a swap floor breach is a host-integrity event. mem_avail_mb is an early
  # warning and deliberately does NOT qualify.
  [[ "$1" == *oom_5min=* || "$1" == *swap_free_mb=* ]]
}

# attempt_send <message> <override_reason-or-empty>; returns the notifier's rc
# (0 sent, 1 delivery failure, 2 refused by policy/rate guard).
attempt_send() {
  local msg=$1 override=$2
  [[ -x "$NOTIFY" ]] || return 1
  if [[ -n "$override" ]]; then
    "$NOTIFY" --override "$override" SEV2 "$msg"
  else
    "$NOTIFY" SEV2 "$msg"
  fi
}

# Retry an owed page before the current row is evaluated. Returns:
#   0 -- nothing pending remains (none existed, or it was just delivered);
#   1 -- pending still owed, deferred to the next tick (caller exits 0);
#   2 -- pending exhausted and still undeliverable (caller exits 1).
process_pending() {
  read_pending || return 0
  local attempt_no=$(( pending_attempts + 1 ))
  local msg override rc
  msg="Paperclip host-memory breach ($pending_reasons) first detected at $pending_first_ts -- delivery was deferred (send-rate guard or transport failure), retry $attempt_no. Source: $LOG. $ISSUE_URL"
  override=""
  if (( attempt_no > MAX_RETRIES )); then
    # Past the bounded-retry window the failure being escalated is the alert
    # channel itself, not the original trigger, so this qualifies for
    # --override whatever the trigger class was.
    override="mem-watch-retries-exhausted:first_ts=${pending_first_ts}:attempt=${attempt_no}"
    msg="Paperclip host-memory breach ($pending_reasons) first detected at $pending_first_ts -- STILL UNDELIVERED after $pending_attempts attempts (~$(( pending_attempts * 5 )) min); the alert channel itself is failing. Source: $LOG. $ISSUE_URL"
  elif [[ "$pending_override" == "1" ]]; then
    override="mem-watch-host-integrity:${pending_reasons}:ts=${pending_first_ts}:retry=${attempt_no}"
  fi
  attempt_send "$msg" "$override"
  rc=$?
  if (( rc == 0 )); then
    echo "paperclip-mem-watch-alert: pending breach ($pending_reasons at $pending_first_ts) delivered on retry $attempt_no" >&2
    clear_pending
    write_success_state "$pending_first_ts"
    return 0
  fi
  pending_attempts=$attempt_no
  write_pending "$pending_first_ts" "$pending_reasons" "$pending_attempts" "$pending_override" \
    || echo "paperclip-mem-watch-alert: WARNING could not persist updated pending attempt count" >&2
  if (( pending_attempts >= MAX_RETRIES )); then
    echo "paperclip-mem-watch-alert: ESCALATION FAILED (rc=$rc): retries exhausted ($pending_attempts/$MAX_RETRIES) for breach ($pending_reasons) at ts=$pending_first_ts -- pending record kept; the --override give-up path will keep being attempted every tick" >&2
    return 2
  fi
  echo "paperclip-mem-watch-alert: ESCALATION DEFERRED (rc=$rc) for breach ($pending_reasons) at ts=$pending_first_ts -- attempt $pending_attempts/$MAX_RETRIES recorded, will retry next tick" >&2
  return 1
}

# ── owed-page retry runs FIRST, independent of the current sample ────────────
process_pending
pstatus=$?

if [[ ! -r "$LOG" ]]; then
  echo "paperclip-mem-watch-alert: log not readable: $LOG" >&2
  exit 1
fi

header=$(head -n1 "$LOG")
IFS=',' read -r -a cols <<< "$header"
declare -A idx
for i in "${!cols[@]}"; do idx["${cols[$i]}"]=$((i + 1)); done
for want in ts mem_avail_mb swap_free_mb oom_5min; do
  if [[ -z "${idx[$want]:-}" ]]; then
    echo "paperclip-mem-watch-alert: log header missing column '$want': $header" >&2
    exit 1
  fi
done

last_row=$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z,' "$LOG" | tail -n1) || true
if [[ -z "$last_row" ]]; then
  echo "paperclip-mem-watch-alert: no data rows found in $LOG" >&2
  (( pstatus == 2 )) && exit 1
  exit 0
fi

IFS=',' read -r -a fields <<< "$last_row"
if [[ ${#fields[@]} -ne ${#cols[@]} ]]; then
  # AUR-4056 fixed the sampler so it never emits a row narrower than its own
  # header; a mismatch here is real corruption, not the old split-write race,
  # and must be loud rather than silently tolerated (AUR-4086).
  echo "paperclip-mem-watch-alert: row has ${#fields[@]} columns, expected ${#cols[@]} (header: $header) -- treating as corrupt, not evaluating: $last_row" >&2
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
  (( pstatus == 2 )) && exit 1
  exit 0
fi

reason_str=$(IFS=,; echo "${reasons[*]}")
text="Paperclip host-memory breach ($reason_str) at $ts. mem_avail_mb=$mem_avail swap_free_mb=$swap_free oom_5min=$oom. Source: $LOG. $ISSUE_URL"

# A still-owed pending page covers the current breach: one channel, one topic,
# and a second same-class attempt this tick would hit the same refusal. The one
# exception is a NEW host-integrity breach appearing while a non-integrity page
# is pending -- that upgrade may bypass the rate guard right now.
if (( pstatus == 1 )); then
  if is_integrity "$reason_str" && [[ "$pending_override" == "0" ]]; then
    attempt_send "$text" "mem-watch-host-integrity:${reason_str}:ts=${ts}"
    rc=$?
    if (( rc == 0 )); then
      echo "paperclip-mem-watch-alert: escalated to founder (SEV2, host-integrity override): $reason_str" >&2
      clear_pending
      write_success_state "$ts"
      exit 0
    fi
    write_pending "$pending_first_ts" "${pending_reasons},escalated:${reason_str}" "$pending_attempts" 1 \
      || echo "paperclip-mem-watch-alert: WARNING could not persist pending integrity upgrade" >&2
    echo "paperclip-mem-watch-alert: ESCALATION DEFERRED (rc=$rc): host-integrity breach ($reason_str at ts=$ts) also undeliverable -- pending record upgraded to override class" >&2
    exit 0
  fi
  echo "paperclip-mem-watch-alert: current breach ($reason_str at ts=$ts) is covered by the pending record (first_ts=$pending_first_ts), no separate page" >&2
  exit 0
fi
if (( pstatus == 2 )); then
  echo "paperclip-mem-watch-alert: current breach ($reason_str at ts=$ts) remains covered by the EXHAUSTED pending record (first_ts=$pending_first_ts)" >&2
  exit 1
fi

# Rate limiting. This is a durable early-warning channel, not a per-tick pager:
# a sustained breach must not re-page every 5 minutes (that is how a channel
# gets muted -- see AUR-3937's escalation gate for the same lesson). A *new*
# breaching sample (different ts) is still eligible once the cooldown clears;
# the exact-same already-alerted row is always suppressed regardless of cooldown
# (guards a retriggered/overlapping run reading the same last row twice).
read_state "$STATE" || read_state "$FALLBACK_STATE" || true

if [[ -n "$last_alert_ts" && "$ts" == "$last_alert_ts" ]]; then
  echo "paperclip-mem-watch-alert: already alerted for row ts=$ts, skipping" >&2
  exit 0
fi
if (( now_epoch - last_alert_epoch < ALERT_COOLDOWN_SEC )); then
  echo "paperclip-mem-watch-alert: cooldown active ($(( now_epoch - last_alert_epoch ))s < ${ALERT_COOLDOWN_SEC}s), skipping alert for ts=$ts (breach persists: $reason_str)" >&2
  exit 0
fi

override_reason=""
if is_integrity "$reason_str"; then
  override_reason="mem-watch-host-integrity:${reason_str}:ts=${ts}"
fi

attempt_send "$text" "$override_reason"
rc=$?
if (( rc == 0 )); then
  echo "paperclip-mem-watch-alert: escalated to founder (SEV2${override_reason:+, host-integrity override}): $reason_str" >&2
  # A delivered page covers anything that was owed; never leave a stale
  # pending record behind a successful send.
  clear_pending
  write_success_state "$ts"
  exit 0
fi

# AUR-4489: delivery refused (rc=2) or failed (rc=1) -- persist the owed page
# and retry next tick instead of dropping it. Deferred is not failed: exit 0.
pending_class=0
is_integrity "$reason_str" && pending_class=1
if write_pending "$ts" "$reason_str" 1 "$pending_class"; then
  echo "paperclip-mem-watch-alert: ESCALATION DEFERRED (rc=$rc) via $NOTIFY for breach ($reason_str) at ts=$ts -- pending recorded (attempt 1/$MAX_RETRIES), will retry next tick" >&2
  exit 0
fi

# No durable pending anywhere: the old loud failure is all that is left.
# Never swallow a delivery failure (AUR-3930): a missed page must be visible.
echo "paperclip-mem-watch-alert: ESCALATION FAILED (rc=$rc) to deliver via $NOTIFY for breach ($reason_str) at ts=$ts AND no writable pending record -- page may be lost" >&2
exit 1
