#!/usr/bin/env bash
# Regression coverage for check-mem-watch-alert.sh (AUR-4025 + AUR-4489).
#
# What this locks down: AUR-3924's sampler logged the 2026-07-25 16:02 UTC
# breach correctly the whole time -- the bug was that nothing read the log, so
# it woke no one. These cases assert the read-and-escalate path actually fires,
# stays quiet when healthy, rate-limits instead of paging every 5 minutes, and
# never swallows a delivery failure.
#
# AUR-4086: AUR-4056 fixed the sampler so it can no longer split a row across
# two physical lines, so the old "trust only the split-safe prefix" workaround
# is now dead weight that permanently locked this reader out of columns 10-18.
# Case 5 asserts the inverse of what it used to: a ragged row (one that
# doesn't match the header's column count) is real corruption post-fix and
# must error loudly, not be silently tolerated as a split write.
#
# AUR-4489 adds the owed-page cases: the 2026-07-29 11:52Z host OOM was
# detected but its page was refused by the fleet-wide send-rate guard and never
# retried -- the oom_5min trigger lives in exactly one sample, so the next tick
# saw a healthy row and the event was unrecoverable. The new cases prove:
# host-integrity breaches (oom/swap floor) bypass the guard via --override; a
# refused/failed page is persisted as a pending record and delivered by a later
# tick even after the breach left the latest sample; a deferred page exits 0;
# exhausted retries escalate via the un-refusable override path and exit 1.
#
# Hermetic: fixture log, stub notifier, no network, no systemd, no /var, and
# no shared /tmp paths (fallback files are redirected into the sandbox).
# Run: bash scripts/deploy/check-mem-watch-alert.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CHECK="$SCRIPT_DIR/check-mem-watch-alert.sh"
[[ -f "$CHECK" ]] || { echo "missing $CHECK" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

LOG="$TMP/mem-watch.log"
STATE="$TMP/alert-state"
PENDINGF="$TMP/alert-pending"
SINK="$TMP/alerts.txt"          # every notifier invocation (attempts)
DELIVERED="$TMP/delivered.txt"  # only invocations that were accepted
NOTIFY="$TMP/notify.sh"

# Stub notifier speaking notify_founder.sh's contract: rc 0 = sent,
# rc 1 = transport failure (NOTIFY_EXIT=1 forces it, even for --override),
# rc 2 = refused by the shared send-rate guard (NOTIFY_RATE_REFUSE=1 refuses
# every call EXCEPT --override ones -- the guard's real bypass semantics).
cat > "$NOTIFY" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NOTIFY_SINK"
if [[ "${NOTIFY_EXIT:-0}" != "0" ]]; then exit "$NOTIFY_EXIT"; fi
if [[ "${NOTIFY_RATE_REFUSE:-0}" == "1" && "$*" != *"--override"* ]]; then exit 2; fi
printf '%s\n' "$*" >> "$NOTIFY_DELIVERED"
exit 0
STUB
chmod +x "$NOTIFY"

HEADER="ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,cp_pid,cp_since,cp_oom_adj,release,cap_deployed"

run_check() {
  PAPERCLIP_MEM_WATCH_LOG="$LOG" \
  PAPERCLIP_MEM_WATCH_ALERT_STATE="${STATE_OVERRIDE:-$STATE}" \
  PAPERCLIP_MEM_WATCH_ALERT_STATE_FALLBACK="$TMP/state-fallback" \
  PAPERCLIP_MEM_WATCH_ALERT_PENDING="$PENDINGF" \
  PAPERCLIP_MEM_WATCH_ALERT_PENDING_FALLBACK="$TMP/pending-fallback" \
  PAPERCLIP_MEM_WATCH_ALERT_MAX_RETRIES="${MAXR:-8}" \
  PAPERCLIP_MEM_WATCH_NOTIFY="$NOTIFY" \
  PAPERCLIP_MEM_WATCH_ALERT_COOLDOWN_SEC="${COOLDOWN:-1800}" \
  NOTIFY_SINK="$SINK" \
  NOTIFY_DELIVERED="$DELIVERED" \
  NOTIFY_EXIT="${NOTIFY_EXIT:-0}" \
  NOTIFY_RATE_REFUSE="${NOTIFY_RATE_REFUSE:-0}" \
    bash "$CHECK" 2>&1
}

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

alerts()    { [[ -f "$SINK" ]] && wc -l < "$SINK" | tr -d ' ' || echo 0; }
delivered() { [[ -f "$DELIVERED" ]] && wc -l < "$DELIVERED" | tr -d ' ' || echo 0; }
reset() {
  : > "$SINK"; : > "$DELIVERED"
  rm -f "$STATE" "$PENDINGF" "$TMP/state-fallback" "$TMP/pending-fallback"
  unset NOTIFY_EXIT COOLDOWN NOTIFY_RATE_REFUSE MAXR STATE_OVERRIDE
}

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
#    mem_avail is an early warning, NOT host-integrity class: no --override.
#    First-attempt success must write success state and leave no pending record.
reset
printf '%s\n2026-07-25T16:25:39Z,917,6367,5598,2497,8095,9.55,0,14,4,4,3637,0,3752944,2026-07-25T16:06:23,-800,a99bd0d9375f,no\n' "$HEADER" > "$LOG"
out=$(run_check); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "SEV2" "$SINK" && grep -q "mem_avail_mb=917" "$SINK" \
   && ! grep -q -- "--override" "$SINK" && [[ ! -f "$PENDINGF" && -f "$STATE" ]]; then
  ok "mem_avail breach pages without --override; success writes state, no pending"
else
  fail "mem_avail breach pages without --override; success writes state, no pending" "rc=$rc alerts=$(alerts) pending=$([[ -f $PENDINGF ]] && cat "$PENDINGF") sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 3. Synthetic swap_free_mb breach pages -- host-integrity class, so the page
#    carries --override with a machine-readable reason (AUR-4489).
reset
printf '%s\n2026-07-25T21:00:00Z,5000,2000,6200,1800,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check)
if [[ "$(alerts)" == "1" ]] && grep -q "swap_free_mb=1800" "$SINK" \
   && grep -q -- "--override mem-watch-host-integrity:" "$SINK"; then
  ok "swap_free_mb breach (1800 < 2000) pages with host-integrity --override"
else
  fail "swap_free_mb breach (1800 < 2000) pages with host-integrity --override" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 4. Synthetic oom_5min breach pages -- host-integrity class, --override.
reset
printf '%s\n2026-07-25T21:05:00Z,5000,2000,2100,6000,8095,0.50,2,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(run_check)
if [[ "$(alerts)" == "1" ]] && grep -q "oom_5min=2" "$SINK" \
   && grep -q -- "--override mem-watch-host-integrity:" "$SINK"; then
  ok "oom_5min breach (2 > 0) pages with host-integrity --override"
else
  fail "oom_5min breach (2 > 0) pages with host-integrity --override" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 5. AUR-4086: post-AUR-4056 the sampler cannot emit a row narrower than its
#    own header, so a ragged row (the historical split-row shape: columns 10+
#    land on a following line starting with a bare "0", not a timestamp) is
#    real corruption. It must be a loud error and must NOT page -- the old
#    behavior of silently trusting the intact prefix and paging anyway is
#    exactly the workaround this issue removes.
reset
{
  printf '%s\n' "$HEADER"
  printf '2026-07-25T21:10:00Z,1200,6800,2100,6000,8095,0.50,0,0\n'
  printf '0,0,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n'
} > "$LOG"
out=$(run_check); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]] && grep -q "columns, expected" <<<"$out"; then
  ok "ragged (split-row-shaped) log line errors loudly instead of silently paging"
else
  fail "ragged (split-row-shaped) log line errors loudly instead of silently paging" "rc=$rc alerts=$(alerts) out=$out"
fi

# 6. Rate limiting: a still-breaching next sample within the cooldown window
#    does not re-page (alarm-fatigue guard, same lesson as AUR-3937) -- and a
#    cooldown-suppressed tick must NOT create a pending record (suppressed is
#    not deferred).
reset
COOLDOWN=1800
printf '%s\n2026-07-25T21:15:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
run_check >/dev/null
first=$(alerts)
printf '2026-07-25T21:20:00Z,1000,7000,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
run_check >/dev/null
second=$(alerts)
if [[ "$first" == "1" && "$second" == "1" && ! -f "$PENDINGF" ]]; then
  ok "cooldown prevents re-paging on the next tick and creates no pending record"
else
  fail "cooldown prevents re-paging on the next tick and creates no pending record" "first=$first second=$second pending=$([[ -f $PENDINGF ]] && cat "$PENDINGF")"
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

# 8. AUR-4489 core: a page that fails to deliver is DEFERRED, not lost. The
#    pending record is persisted, the unit exits 0 (deferred != failed), and a
#    later tick retries and delivers even though the breach is no longer in
#    the latest sample. Pending is cleared by the successful retry.
reset
printf '%s\n2026-07-25T21:35:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out1=$(NOTIFY_EXIT=1 run_check); rc1=$?
cond1=0
if [[ "$rc1" == "0" ]] && grep -q "ESCALATION DEFERRED" <<<"$out1" && [[ -f "$PENDINGF" ]] && [[ "$(delivered)" == "0" ]]; then
  cond1=1
fi
# breach leaves the latest sample entirely -- the owed page must survive that
printf '2026-07-25T21:40:00Z,4300,2800,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
out2=$(NOTIFY_EXIT=1 run_check); rc2=$?
cond2=0
if [[ "$rc2" == "0" ]] && grep -q "attempt 2/8" <<<"$out2" && [[ "$(delivered)" == "0" ]]; then
  cond2=1
fi
out3=$(run_check); rc3=$?
cond3=0
if [[ "$rc3" == "0" ]] && grep -q "delivered on retry 3" <<<"$out3" \
   && [[ "$(delivered)" == "1" && ! -f "$PENDINGF" && -f "$STATE" ]] \
   && grep -q "first detected at 2026-07-25T21:35:00Z" "$DELIVERED"; then
  cond3=1
fi
if [[ "$cond1$cond2$cond3" == "111" ]]; then
  ok "failed delivery defers (exit 0), persists pending, and a later tick delivers after the breach left the sample"
else
  fail "failed delivery defers (exit 0), persists pending, and a later tick delivers after the breach left the sample" "c1=$cond1 c2=$cond2 c3=$cond3 rc1=$rc1 rc2=$rc2 rc3=$rc3 out1=$out1 out2=$out2 out3=$out3 delivered=$(cat "$DELIVERED" 2>/dev/null)"
fi

# 9. An unwritable rate-limit state must never silence the page (only the
#    rate-limiting itself may degrade -- to the fallback path).
reset
printf '%s\n2026-07-25T21:41:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(STATE_OVERRIDE=/nonexistent-dir/state run_check)
if [[ "$(alerts)" == "1" && -f "$TMP/state-fallback" ]]; then
  ok "unwritable rate-limit state degrades to the fallback file, never to silence"
else
  fail "unwritable rate-limit state degrades to the fallback file, never to silence" "alerts=$(alerts) fallback=$([[ -f $TMP/state-fallback ]] && echo yes || echo no) out=$out"
fi

# 10. THE 2026-07-29 INCIDENT SHAPE (AUR-4489 defect #3): an oom_5min breach
#     while the fleet send-rate window is exhausted must page IMMEDIATELY via
#     --override -- a host OOM does not queue behind business nudges.
reset
printf '%s\n2026-07-29T11:52:28Z,5243,2500,3300,4793,8095,1.20,1,4,2,2,0,0,3557726,2026-07-29T10:00:00,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out=$(NOTIFY_RATE_REFUSE=1 run_check); rc=$?
if [[ "$rc" == "0" && "$(delivered)" == "1" && ! -f "$PENDINGF" ]] \
   && grep -q -- "--override mem-watch-host-integrity:oom_5min=1" "$DELIVERED"; then
  ok "oom breach during an exhausted rate window delivers first-attempt via --override (Jul-29 incident shape)"
else
  fail "oom breach during an exhausted rate window delivers first-attempt via --override (Jul-29 incident shape)" "rc=$rc delivered=$(delivered) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 11. A mem_avail-only breach stays subject to the rate guard (no override
#     widening): refused -> pending -> retried WITHOUT --override -> delivered
#     once the window clears, even though the breach left the latest sample.
reset
printf '%s\n2026-07-25T21:45:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out1=$(NOTIFY_RATE_REFUSE=1 run_check); rc1=$?
printf '2026-07-25T21:50:00Z,4300,2800,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
out2=$(NOTIFY_RATE_REFUSE=1 run_check); rc2=$?
out3=$(run_check); rc3=$?
if [[ "$rc1" == "0" && "$rc2" == "0" && "$rc3" == "0" && "$(delivered)" == "1" && ! -f "$PENDINGF" ]] \
   && grep -q "ESCALATION DEFERRED" <<<"$out1" \
   && ! grep -q -- "--override" "$SINK" \
   && grep -q "first detected at 2026-07-25T21:45:00Z" "$DELIVERED"; then
  ok "rate-refused mem_avail breach is persisted and delivered on a later tick, never via override"
else
  fail "rate-refused mem_avail breach is persisted and delivered on a later tick, never via override" "rc1=$rc1 rc2=$rc2 rc3=$rc3 delivered=$(delivered) sink=$(cat "$SINK" 2>/dev/null) out1=$out1 out2=$out2 out3=$out3"
fi

# 12. Exhausted retries flip to the un-refusable give-up path: after MAX_RETRIES
#     failed attempts the unit exits 1 (a page is owed and undeliverable), each
#     later tick attempts --override "mem-watch-retries-exhausted", the pending
#     record survives, and the moment the transport recovers -- even with the
#     rate window still jammed -- the page lands and the pending clears.
reset
printf '%s\n2026-07-25T22:00:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out1=$(NOTIFY_EXIT=1 MAXR=2 run_check); rc1=$?
out2=$(NOTIFY_EXIT=1 MAXR=2 run_check); rc2=$?
out3=$(NOTIFY_EXIT=1 MAXR=2 run_check); rc3=$?
out4=$(NOTIFY_RATE_REFUSE=1 MAXR=2 run_check); rc4=$?
if [[ "$rc1" == "0" && "$rc2" == "1" && "$rc3" == "1" && "$rc4" == "0" ]] \
   && grep -q "retries exhausted" <<<"$out2" \
   && grep -q -- "--override mem-watch-retries-exhausted:" "$SINK" \
   && [[ "$(delivered)" == "1" && ! -f "$PENDINGF" ]] \
   && grep -q "mem-watch-retries-exhausted" "$DELIVERED"; then
  ok "exhausted retries exit 1, keep the pending record, and the override give-up path delivers past a jammed rate window"
else
  fail "exhausted retries exit 1, keep the pending record, and the override give-up path delivers past a jammed rate window" "rc=$rc1/$rc2/$rc3/$rc4 delivered=$(delivered) pending=$([[ -f $PENDINGF ]] && cat "$PENDINGF") out2=$out2 out4=$out4 sink=$(cat "$SINK" 2>/dev/null)"
fi

# 13. Integrity upgrade: while a non-integrity page is pending behind a jammed
#     rate window, a NEW oom breach must not wait its turn -- it goes out NOW
#     via --override, and the delivered page covers (clears) the pending one.
reset
printf '%s\n2026-07-25T22:10:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out1=$(NOTIFY_RATE_REFUSE=1 run_check); rc1=$?
printf '2026-07-25T22:15:00Z,4300,2800,2100,6000,8095,0.50,1,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' >> "$LOG"
out2=$(NOTIFY_RATE_REFUSE=1 run_check); rc2=$?
if [[ "$rc1" == "0" && "$rc2" == "0" && "$(delivered)" == "1" && ! -f "$PENDINGF" ]] \
   && grep -q -- "--override mem-watch-host-integrity:oom_5min=1" "$DELIVERED"; then
  ok "a new oom breach behind a pending non-integrity page pages immediately via override and clears the pending"
else
  fail "a new oom breach behind a pending non-integrity page pages immediately via override and clears the pending" "rc1=$rc1 rc2=$rc2 delivered=$(delivered) pending=$([[ -f $PENDINGF ]] && cat "$PENDINGF") out1=$out1 out2=$out2 sink=$(cat "$SINK" 2>/dev/null)"
fi

# 14. AUR-6214: clear_pending() must converge even when the process lacks
#     write permission on the PENDING file's containing directory (the live
#     host shape: /var/log is root:syslog, the service's user is not in that
#     group, so `rm -f` fails to unlink -- silently, since nothing checked its
#     exit status). Reproduce that exact permission split: create the pending
#     file while the directory is still writable (how write_pending's initial
#     create succeeds in prod too), then lock the directory down and prove a
#     successful retry still converges to "no pending" via truncation, so the
#     next tick does not re-deliver the same stale record.
reset
LOCKED="$TMP/locked-pending-dir"
mkdir -p "$LOCKED"
PENDINGF="$LOCKED/alert-pending"
printf '%s\n2026-08-25T16:04:09Z,916,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-08-25T10:00:00,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
out1=$(NOTIFY_EXIT=1 run_check); rc1=$?
cond1=0
[[ "$rc1" == "0" ]] && [[ -f "$PENDINGF" ]] && [[ "$(delivered)" == "0" ]] && cond1=1
chmod 555 "$LOCKED"
out2=$(run_check); rc2=$?
cond2=0
if [[ "$rc2" == "0" ]] && grep -q "delivered on retry 2" <<<"$out2" && [[ "$(delivered)" == "1" ]]; then
  cond2=1
fi
# Directory is still locked (555): rm -f cannot unlink, so the file itself
# must still exist -- but truncated to zero bytes, which read_pending's `-s`
# check already treats as absent. This is what distinguishes "actually
# converged" from the pre-fix bug (same file, same stale attempts, forever).
cond3=0
if [[ -e "$PENDINGF" && ! -s "$PENDINGF" ]]; then cond3=1; fi
printf '2026-08-26T12:00:00Z,4300,2800,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-08-25T10:00:00,-800,d5c37635bb00,yes\n' >> "$LOG"
out3=$(run_check); rc3=$?
cond4=0
if [[ "$rc3" == "0" && "$(alerts)" == "2" && "$(delivered)" == "1" ]] && ! grep -q "delivered on retry" <<<"$out3"; then
  cond4=1
fi
chmod 755 "$LOCKED"
if [[ "$cond1$cond2$cond3$cond4" == "1111" ]]; then
  ok "clear_pending converges (truncates) when the pending dir is not writable, so a later healthy tick observes zero pending and does not re-send"
else
  fail "clear_pending converges (truncates) when the pending dir is not writable, so a later healthy tick observes zero pending and does not re-send" \
    "c1=$cond1 c2=$cond2 c3=$cond3 c4=$cond4 rc1=$rc1 rc2=$rc2 rc3=$rc3 pending_exists=$([[ -e $PENDINGF ]] && echo yes || echo no) pending_size=$([[ -e $PENDINGF ]] && wc -c < "$PENDINGF") out2=$out2 out3=$out3"
fi
PENDINGF="$TMP/alert-pending"

# 15. AUR-6214: a retry delivered via process_pending() must stamp STATE with
#     the wall-clock ts of the delivery, not the stale first_ts of the
#     original (possibly hours/days old) breach row -- otherwise STATE pairs
#     a stale row_ts with a fresh epoch (confirmed live on the host: state
#     read "2026-08-25T16:04:09Z\t<today's epoch>").
reset
printf '%s\n2026-07-25T21:35:00Z,900,7200,2100,6000,8095,0.50,0,4,2,2,0,0,3859857,2026-07-25T16:30:26,-800,d5c37635bb00,yes\n' "$HEADER" > "$LOG"
NOTIFY_EXIT=1 run_check >/dev/null
run_check >/dev/null
state_ts=$([[ -f "$STATE" ]] && cut -f1 "$STATE")
if [[ "$state_ts" != "2026-07-25T21:35:00Z" && "$state_ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  ok "a delivered retry stamps STATE with the current wall-clock ts, not the stale pending first_ts"
else
  fail "a delivered retry stamps STATE with the current wall-clock ts, not the stale pending first_ts" "state_ts=$state_ts state=$([[ -f "$STATE" ]] && cat "$STATE")"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "check-mem-watch-alert: all cases passed"
  exit 0
fi
echo "check-mem-watch-alert: $FAILURES case(s) failed"
exit 1
