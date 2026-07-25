#!/bin/bash
# paperclip-unit-audit — AUR-3961/AUR-3952 — SCHEMA v1 (2026-07-25)
#
# Closes the blind spot that let polymarket-btc-5m-taker.service accumulate
# tens of thousands of restarts over ~3 months after its documented hard
# kill bar (2026-04-30) with nothing reporting it: `NRestarts` (and the
# single-episode counter systemd logs alongside each restart, "restart
# counter is at N") both reset to 0 whenever a unit is fully stopped,
# started, or replaced -- confirmed live on this box, where paperclip.service
# itself reset from a historical high-water mark of 13,742 down to 17 after
# a routine release swap earlier today. Neither value can be trusted as a
# cumulative history.
#
# What CANNOT be silently reset by a stop/start is the *count* of restart
# log lines still sitting in the retained journal -- a unit that thrashed
# 500 times last week and was quietly stopped today still has ~500 "Scheduled
# restart job" lines in the journal right now, even though its live NRestarts
# and its current single-episode counter both read 0. This script triggers
# on that count (journal_restart_line_count below), never on NRestarts.
# Caveat, visible not silent: journal retention on this box starts
# 2026-07-01 (ops/systemd/README.md) and journald rate-limiting under burst
# load can drop some lines -- both can only ever make the count an
# undercount, never a false zero the way NRestarts resetting does, which is
# the safe direction to be wrong in for a threshold check.
#
# Also flags the inverse blind spot named in AUR-3952: a unit that is
# enabled with Restart=always|on-failure but is currently inactive/failed.
# That combination means systemd is *supposed* to keep bringing it back --
# an unexpected rest means either it's failing to (re)start or something
# disabled the restart path without disabling the unit. Restart=no units
# (ordinary Ubuntu boot one-shots) are structurally excluded, not
# special-cased: they never match `Restart=always|on-failure` in the first
# place.
#
# Threshold is 100 (PAPERCLIP_UNIT_AUDIT_THRESHOLD below). On this box the
# highest healthy count measured during the AUR-3952 audit window was in
# the tens; the lowest unhealthy historical high-water mark was 13,742
# (paperclip.service -- out of scope for modification, IN scope for
# detection; AUR-3924 owns fixing it, this script only has to see it).
# Two-plus orders of magnitude of clearance, no tuning required.

set -uo pipefail

LOG=${PAPERCLIP_UNIT_AUDIT_LOG:-/var/log/paperclip-unit-audit.log}
STATE_DIR=${PAPERCLIP_UNIT_AUDIT_STATE_DIR:-/var/lib/paperclip-unit-audit}
NOTIFY=${PAPERCLIP_UNIT_AUDIT_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
THRESHOLD=${PAPERCLIP_UNIT_AUDIT_THRESHOLD:-100}
RATE_LIMIT_SECS=${PAPERCLIP_UNIT_AUDIT_RATE_LIMIT_SECS:-86400}
SELF_UNIT="paperclip-unit-audit.service"

HEADER="ts,scope,unit,nrestarts_live,journal_restart_line_count,unit_file_state,active_state,sub_state,restart_policy,flag_reason,alerted"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
now_epoch=$(date -u +%s)

mkdir -p "$STATE_DIR" 2>/dev/null

# Same discipline as paperclip-mem-watch.sh: a positional CSV where one
# stray newline or comma silently re-columns every field after it, and a
# reader can't tell a shifted field from a real one. Sanitise before the
# append, assert the width before it's written, refuse rather than corrupt.
csv_field() {
  local v=${1-}
  v=${v%%$'\n'*}
  v=${v//$'\r'/}
  v=${v//,/;}
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "${v:-NA}"
}

# Has this unit already alerted within the rate-limit window? State is one
# file per unit holding the epoch of the last alert -- deliberately not a
# shared log scan, so one unit's state can never suppress another's alert.
should_alert() {
  local key=$1
  local state_file="$STATE_DIR/${key}.last_alert"
  if [[ -f "$state_file" ]]; then
    local last
    last=$(cat "$state_file" 2>/dev/null)
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    if (( now_epoch - last < RATE_LIMIT_SECS )); then
      return 1
    fi
  fi
  return 0
}

record_alert() {
  local key=$1
  printf '%s\n' "$now_epoch" > "$STATE_DIR/${key}.last_alert" 2>/dev/null
}

# Count of "<unit>: Scheduled restart job, restart counter is at N." lines
# per unit, one full-journal pass per scope rather than 250+ per-unit
# journalctl calls.
#
# Deliberately NOT `journalctl -u <unit>`: for a unit that is itself a
# manager of child units (e.g. user@1000.service, the per-uid systemd
# --user session manager), `-u` filters on the *process's own* cgroup unit,
# but the process's log lines report on the child units it manages. That
# misattributes every child's restart-counter line to the manager unit --
# measured on this box: `journalctl -u user@1000.service` surfaced
# polymarket-btc-5m-taker.service's counter under user@1000.service, a unit
# whose own count is actually 0. Parsing the literal unit-name prefix out of
# the message text instead of trusting `-u` avoids that misattribution.
declare -A JOURNAL_LINE_COUNT=()

load_journal_counters() {
  local scope=$1
  JOURNAL_LINE_COUNT=()
  local -a jctl_cmd
  if [[ "$scope" == "user" ]]; then
    if [[ "$EUID" -eq 0 ]]; then
      jctl_cmd=(runuser -u ievgen -- env XDG_RUNTIME_DIR=/run/user/1000 journalctl --user --no-pager -o cat)
    else
      jctl_cmd=(journalctl --user --no-pager -o cat)
    fi
  else
    jctl_cmd=(journalctl --no-pager -o cat)
  fi

  local line u
  while IFS= read -r line; do
    if [[ "$line" =~ ^(.+):\ Scheduled\ restart\ job,\ restart\ counter\ is\ at\ [0-9]+\.$ ]]; then
      u="${BASH_REMATCH[1]}"
      JOURNAL_LINE_COUNT[$u]=$(( ${JOURNAL_LINE_COUNT[$u]:-0} + 1 ))
    fi
  done < <("${jctl_cmd[@]}" 2>/dev/null | grep -F 'Scheduled restart job, restart counter is at')
}

journal_restart_line_count() {
  local unit=$1
  echo "${JOURNAL_LINE_COUNT[$unit]:-0}"
}

audit_scope() {
  local scope=$1
  local -a systemctl_cmd
  if [[ "$scope" == "user" ]]; then
    # The installed timer runs this as root (like paperclip-mem-watch.sh);
    # a root process has no user session, so `systemctl --user` must be
    # routed through the target user's session explicitly. When run
    # directly as that user (manual testing) EUID is already non-zero and
    # the ambient session is used as-is.
    if [[ "$EUID" -eq 0 ]]; then
      systemctl_cmd=(runuser -u ievgen -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user)
    else
      systemctl_cmd=(systemctl --user)
    fi
  else
    systemctl_cmd=(systemctl)
  fi

  local units
  units=$("${systemctl_cmd[@]}" list-units --all --type=service --no-legend --plain --no-pager 2>/dev/null \
            | awk '{print $1}')

  load_journal_counters "$scope"

  local unit
  while IFS= read -r unit; do
    [[ -z "$unit" ]] && continue
    [[ "$unit" == "$SELF_UNIT" ]] && continue

    # `systemctl show -p A -p B ...` emits properties in systemd's own
    # canonical order, NOT the order given on the command line (confirmed:
    # `-p NRestarts -p UnitFileState -p ActiveState -p SubState -p Restart`
    # came back Restart, NRestarts, ActiveState, SubState, UnitFileState).
    # Parse by key=value, never by line position.
    local props nrestarts="" unit_file_state="" active_state="" sub_state="" restart_policy="" condition_result=""
    props=$("${systemctl_cmd[@]}" show "$unit" \
              -p NRestarts -p UnitFileState -p ActiveState -p SubState -p Restart -p ConditionResult \
              2>/dev/null)
    while IFS='=' read -r k v; do
      case "$k" in
        NRestarts) nrestarts=$v ;;
        UnitFileState) unit_file_state=$v ;;
        ActiveState) active_state=$v ;;
        SubState) sub_state=$v ;;
        Restart) restart_policy=$v ;;
        ConditionResult) condition_result=$v ;;
      esac
    done <<<"$props"

    local jcount
    jcount=$(journal_restart_line_count "$unit")
    [[ -n "$jcount" ]] || jcount=0

    local -a reasons=()
    if (( jcount >= THRESHOLD )); then
      reasons+=("journal_restart_line_count=${jcount}>=${THRESHOLD}")
    fi
    # ConditionResult=no means systemd never even attempted to start the
    # unit because a Condition= directive gated it off (e.g. lxd-agent.service
    # requires running inside an LXD container; thermald.service requires
    # specific hardware). Restart= is irrelevant to a unit that was never
    # started -- measured false positives on this exact box before this
    # exclusion existed. Only flag units systemd actually tried to keep
    # running.
    if [[ "$unit_file_state" == "enabled" && "$active_state" != "active" ]] \
         && [[ "$restart_policy" == "always" || "$restart_policy" == "on-failure" ]] \
         && [[ "$condition_result" != "no" ]]; then
      reasons+=("enabled_restart_policy_but_${active_state}")
    fi

    local flag_reason="" alerted="no"
    if (( ${#reasons[@]} > 0 )); then
      flag_reason=$(IFS=';'; echo "${reasons[*]}")
      local key="${scope}__${unit}"
      if should_alert "$key"; then
        local msg="paperclip-unit-audit: ${scope}/${unit} flagged (${flag_reason})"
        if "$NOTIFY" "$msg" >/dev/null 2>&1; then
          alerted="yes"
          record_alert "$key"
        else
          alerted="failed"
        fi
      else
        alerted="rate_limited"
      fi
    fi

    if [[ -n "$flag_reason" ]]; then
      local row=""
      for f in "$ts" "$scope" "$unit" "$nrestarts" "$jcount" "$unit_file_state" \
               "$active_state" "$sub_state" "$restart_policy" "$flag_reason" "$alerted"; do
        row+="${row:+,}$(csv_field "$f")"
      done

      local want_cols have_cols
      want_cols=$(awk -F, '{print NF}' <<<"$HEADER")
      have_cols=$(awk -F, '{print NF}' <<<"$row")
      if [[ "$have_cols" != "$want_cols" ]] || [[ "$row" == *$'\n'* ]]; then
        echo "paperclip-unit-audit: REFUSING malformed row (${have_cols} cols, want ${want_cols}): ${row}" >&2
        continue
      fi

      [[ -s "$LOG" ]] || echo "$HEADER" >> "$LOG"
      printf '%s\n' "$row" >> "$LOG"
    fi
  done <<<"$units"
}

audit_scope "system"
audit_scope "user"

if [[ -s "$LOG" ]]; then
  tail -n 5000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

exit 0
