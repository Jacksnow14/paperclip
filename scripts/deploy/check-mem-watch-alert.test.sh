#!/usr/bin/env bash
# Regression coverage for check-mem-watch-alert.sh (AUR-4025).
#
# What this locks down: AUR-3924's sampler logged the 2026-07-25 16:02 UTC
# breach correctly the whole time -- the bug was that nothing read the log, so
# it woke no one. These cases assert the read-and-escalate path actually fires,
# stays quiet when healthy, loudly refuses a malformed (non-header-width) row
# instead of reading through it (AUR-4086, post AUR-4056 sampler fix), rate-
# limits instead of paging every 5 minutes, and never swallows a delivery
# failure.
#
# Hermetic: fixture log, stub notifier, no network, no systemd, no /var.
# Run: bash scripts/deploy/check-mem-watch-alert.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CHECK="$SCRIPT_DIR/check-mem-watch-alert.sh"
[[ -f "$CHECK" ]] || { echo "missing $CHECK" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

LOG="$TMP/mem-watch.log"
STATE="$TMP/alert-state"
SINK="$TMP/alerts.txt"
NOTIFY="$TMP/notify.sh"

cat > "$NOTIFY" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NOTIFY_SINK"
exit "${NOTIFY_EXIT:-0}"
STUB
chmod +x "$NOTIFY"

HEADER="ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,cp_pid,cp_since,cp_oom_adj,release,cap_deployed"

run_check() {
  PAPERCLIP_MEM_WATCH_LOG="$LOG" \
  PAPERCLIP_MEM_WATCH_ALERT_STATE="$STATE" \
  PAPERCLIP_MEM_WATCH_NOTIFY="$NOTIFY" \
  PAPERCLIP_MEM_WATCH_ALERT_COOLDOWN_SEC="${COOLDOWN:-1800}" \
  NOTIFY_SINK="$SINK" \
  NOTIFY_EXIT="${NOTIFY_EXIT:-0}" \
    bash "$CHECK" 2>&1
}

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

alerts() { [[ -f "$SINK" ]] && wc -l < "$SINK" | tr -d ' ' || echo 0; }
reset()  { : > "$SINK"; rm -f "$STATE" /tmp/paperclip-mem-watch-alert.state; unset NOTIFY_EXIT COOLDOWN; }

# --- cases -------------------------------------------------------------------

# 1. A healthy row (well clear of all three thresholds) pages no one and exits 0.
reset
printf '%s\n2026-07-25T20:04:00Z,4281,2805,2135,5960,8095,0.98,0,4,2,3,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]]; then
  ok "healthy row exits 0 and pages no one"
else
  fail "healthy row exits 0 and pages no one" "rc=$rc alerts=$(alerts) out=$out"
fi

# 2. Real historical breach row from the live log (2026-07-25T16:25:39Z,
#    mem_avail_mb=917 < 1500) pages the founder at SEV2 and names the reason.
reset
printf '%s\n2026-07-25T16:25:39Z,917,6367,5598,2497,8095,9.55,0,14,4,4,3637,0,3752944,2026-07-25T16:06:23,-800,a99bd0d9375f,no\n' "$HEADER" > "$LOG"
out=$(run_check); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "SEV2" "$SINK" && grep -q "mem_avail_mb=917" "$SINK"; then
  ok "real historical mem_avail_mb breach (917 < 1500) pages the founder"
else
  fail "real historical mem_avail_mb breach (917 < 1500) pages the founder" "rc=$rc alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 3. Synthetic swap_free_mb breach pages.
reset
printf '%s\n2026-07-25T21:00:00Z,5000,2000,6200,1800,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check)
if [[ "$(alerts)" == "1" ]] && grep -q "swap_free_mb=1800" "$SINK"; then
  ok "swap_free_mb breach (1800 < 2000) pages the founder"
else
  fail "swap_free_mb breach (1800 < 2000) pages the founder" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 4. Synthetic oom_5min breach pages.
reset
printf '%s\n2026-07-25T21:05:00Z,5000,2000,2100,6000,8095,0.50,2,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check)
if [[ "$(alerts)" == "1" ]] && grep -q "oom_5min=2" "$SINK"; then
  ok "oom_5min breach (2 > 0) pages the founder"
else
  fail "oom_5min breach (2 > 0) pages the founder" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 5. A malformed row that is short of the header width (e.g. the pre-AUR-4056
#    split-row defect, where columns 10+ land on a following line starting
#    with a bare "0") is now refused loudly and pages no one -- the sampler
#    guarantees an 18-column row or none at all, so a short row means real
#    corruption, not an expected shape to route around (AUR-4086).
reset
{
  printf '%s\n' "$HEADER"
  printf '2026-07-25T21:10:00Z,1200,6800,2100,6000,8095,0.50,0,0\n'
  printf '0,0,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n'
} > "$LOG"
out=$(run_check); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]] && grep -q "columns, header has" <<<"$out"; then
  ok "malformed (short) row is refused loudly, not read through"
else
  fail "malformed (short) row is refused loudly, not read through" "rc=$rc alerts=$(alerts) out=$out"
fi

# 5b. A well-formed row is still read correctly regardless of where its trigger
#     columns land -- this asserts there is no positional lockout left.
reset
printf '%s\n2026-07-25T21:12:00Z,1200,6800,2100,6000,8095,0.50,0,4,2,2,3637,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check)
if [[ "$(alerts)" == "1" ]] && grep -q "mem_avail_mb=1200" "$SINK"; then
  ok "breach on a full 18-column row is detected (build_rss_mb no longer blocks the reader)"
else
  fail "breach on a full 18-column row is detected (build_rss_mb no longer blocks the reader)" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 6. Rate limiting: a still-breaching next sample within the cooldown window
#    does not re-page (alarm-fatigue guard, same lesson as AUR-3937).
reset
COOLDOWN=1800
printf '%s\n2026-07-25T21:15:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
run_check >/dev/null
first=$(alerts)
printf '2026-07-25T21:20:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
run_check >/dev/null
second=$(alerts)
if [[ "$first" == "1" && "$second" == "1" ]]; then
  ok "cooldown prevents re-paging on the next timer tick while still breaching"
else
  fail "cooldown prevents re-paging on the next timer tick while still breaching" "first=$first second=$second"
fi
unset COOLDOWN

# 7. ...but a genuinely new breaching sample once the cooldown clears does page.
reset
COOLDOWN=0
printf '%s\n2026-07-25T21:25:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
run_check >/dev/null
first=$(alerts)
printf '2026-07-25T21:30:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
run_check >/dev/null
second=$(alerts)
if [[ "$first" == "1" && "$second" == "2" ]]; then
  ok "a new breaching sample pages again once the cooldown clears"
else
  fail "a new breaching sample pages again once the cooldown clears" "first=$first second=$second"
fi
unset COOLDOWN

# 8. A page that fails to deliver is reported loudly (AUR-3930), never swallowed.
reset
printf '%s\n2026-07-25T21:35:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(NOTIFY_EXIT=1 run_check); rc=$?
if grep -q "ESCALATION FAILED" <<<"$out" && [[ "$rc" == "1" ]]; then
  ok "undelivered page is reported loudly, not swallowed"
else
  fail "undelivered page is reported loudly, not swallowed" "rc=$rc out=$out"
fi

# 9. An unwritable rate-limit state must never silence the page (only the
#    rate-limiting itself may degrade).
reset
printf '%s\n2026-07-25T21:40:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(PAPERCLIP_MEM_WATCH_ALERT_STATE=/nonexistent-dir/state run_check)
if [[ "$(alerts)" == "1" ]]; then
  ok "unwritable rate-limit state degrades to a page, never to silence"
else
  fail "unwritable rate-limit state degrades to a page, never to silence" "alerts=$(alerts) out=$out"
fi
rm -f /tmp/paperclip-mem-watch-alert.state

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "check-mem-watch-alert: all cases passed"
  exit 0
fi
echo "check-mem-watch-alert: $FAILURES case(s) failed"
exit 1
