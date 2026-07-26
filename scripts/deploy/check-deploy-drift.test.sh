#!/usr/bin/env bash
# Regression coverage for the check-deploy-drift.sh escalation gate.
#
# The bug this locks down is not "the detector missed drift" — it detected drift
# correctly every 15 minutes for a full day. The bug is that it escalated to no
# one. These cases assert the two things that make it a control instead of noise:
#   1. sustained PROVENANCE drift (unknown artifact / armed-but-not-live) pages
#      the founder, and
#   2. the EXPECTED-state reasons do NOT page at the same threshold, because
#      paging on every merge is how a channel gets muted. Since AUR-4028 the
#      expected post-merge state is `awaiting-quiescence` (daemon alive, armed,
#      running > 0) at 12h, or `armed-restart-disabled` (restart half dark) at
#      24h; `behind-origin-master` now means the ARM automation is broken and
#      pages at 1h.
#
# Hermetic: fake git remote, file:// health document, stub notifier, fixture
# auto-deploy state file. No network, no systemd, no /var, no node.
# Run: bash scripts/deploy/check-deploy-drift.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CHECK="$SCRIPT_DIR/check-deploy-drift.sh"
[[ -x "$CHECK" || -f "$CHECK" ]] || { echo "missing $CHECK" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- fixtures --------------------------------------------------------------
REMOTE_REPO="$TMP/remote"
git init -q --initial-branch=master "$REMOTE_REPO"
git -C "$REMOTE_REPO" -c user.email=t@example.com -c user.name=t \
  commit -q --allow-empty -m "fixture master"
MASTER_SHA=$(git -C "$REMOTE_REPO" rev-parse HEAD)

APP="$TMP/app"
mkdir -p "$APP/current"
HEALTH="$TMP/health.json"
LOG="$TMP/drift.log"
STATE="$TMP/alert-state"
SINK="$TMP/alerts.txt"
NOTIFY="$TMP/notify.sh"

cat > "$NOTIFY" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NOTIFY_SINK"
exit "${NOTIFY_EXIT:-0}"
STUB
chmod +x "$NOTIFY"

set_activated() { printf '{"sha":"%s"}' "$1" > "$APP/current/build-info.json"; }
set_health_release() { printf '{"status":"ok","build":{"source":"release","sha":"%s"}}' "$1" > "$HEALTH"; }
set_health_unpinned() { printf '{"status":"ok"}' > "$HEALTH"; }

# Auto-deploy daemon state fixture (AUR-4028).
# $1=phase $2=armed_sha $3=running_count $4=tick_age_sec $5=waiting_age_sec
AD_STATE="$TMP/auto-deploy.state"
set_ad_state() {
  local now tick waiting
  now=$(date -u +%s)
  tick=$(date -u -d "@$(( now - $4 ))" +%Y-%m-%dT%H:%M:%SZ)
  waiting=$(date -u -d "@$(( now - ${5:-0} ))" +%Y-%m-%dT%H:%M:%SZ)
  cat > "$AD_STATE" <<EOF
last_tick=$tick
phase=$1
armed_sha=$2
running_sha=whatever
running_count=$3
queued_count=9
stale_discounted=-
waiting_since=$waiting
restart_enabled=0
note=-
EOF
}
clear_ad_state() { rm -f "$AD_STATE"; }

# Seed the trailing run of same-reason DRIFT lines the gate reads its
# sustained-duration from: $1 = reason, $2 = hours of sustained drift.
seed_log() {
  local reason=$1 hours=$2 now step i stamp
  now=$(date -u +%s)
  : > "$LOG"
  # one line every 15 minutes, oldest first, ending just before "now"
  step=900
  for (( i = hours * 3600; i > 0; i -= step )); do
    stamp=$(date -u -d "@$(( now - i ))" +%Y-%m-%dT%H:%M:%SZ)
    printf '%s running=abc activated=abc master=def status=DRIFT reason=%s\n' "$stamp" "$reason" >> "$LOG"
  done
}

run_check() {
  PAPERCLIP_HEALTH_URL="file://$HEALTH" \
  PAPERCLIP_DEPLOY_REMOTE="$REMOTE_REPO" \
  PAPERCLIP_DEPLOY_APP_ROOT="$APP" \
  PAPERCLIP_DRIFT_LOG="$LOG" \
  PAPERCLIP_DRIFT_ALERT_STATE="$STATE" \
  PAPERCLIP_DRIFT_NOTIFY="$NOTIFY" \
  PAPERCLIP_AUTO_DEPLOY_STATE="$AD_STATE" \
  NOTIFY_SINK="$SINK" \
  NOTIFY_EXIT="${NOTIFY_EXIT:-0}" \
    bash "$CHECK" 2>&1
}

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

alerts() { [[ -f "$SINK" ]] && wc -l < "$SINK" | tr -d ' ' || echo 0; }
reset()  { : > "$SINK"; : > "$STATE"; }

# --- cases -----------------------------------------------------------------

# 1. Production running an artifact of unknown provenance for 3h — the July 20
#    incident — must reach the founder.
reset; rm -f "$HEALTH"; set_activated "$MASTER_SHA"
seed_log "untracked-or-unreachable:unreachable" 3
out=$(run_check); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "SEV2" "$SINK"; then
  ok "sustained provenance drift (3h) pages the founder at SEV2"
else
  fail "sustained provenance drift (3h) pages the founder at SEV2" "alerts=$(alerts) rc=$rc out=$out"
fi
grep -q "untracked-or-unreachable" "$SINK" \
  && ok "page names the drift reason" \
  || fail "page names the drift reason" "sink=$(cat "$SINK")"

# 2. Same defect, only 30 minutes old: below threshold, stays quiet.
reset; rm -f "$HEALTH"
seed_log "untracked-or-unreachable:unreachable" 0
printf '%s running=abc activated=abc master=def status=DRIFT reason=untracked-or-unreachable:unreachable\n' \
  "$(date -u -d '@'"$(( $(date -u +%s) - 1800 ))" +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
out=$(run_check)
[[ "$(alerts)" == "0" ]] \
  && ok "provenance drift below 2h threshold stays quiet" \
  || fail "provenance drift below 2h threshold stays quiet" "alerts=$(alerts) out=$out"

# 3. RETUNED (AUR-4028): behind-origin-master now means the ARM automation is
#    broken — master moved and no release was even armed within a tick. 30 min
#    stays quiet (a build takes ~2.5 min, one tick can still be in flight)...
reset; clear_ad_state
set_health_release "0000000000000000000000000000000000000000"; set_activated "0000000000000000000000000000000000000000"
seed_log "behind-origin-master" 0
printf '%s running=abc activated=abc master=def status=DRIFT reason=behind-origin-master\n' \
  "$(date -u -d '@'"$(( $(date -u +%s) - 1800 ))" +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
out=$(run_check)
[[ "$(alerts)" == "0" ]] \
  && ok "behind-origin-master at 30min stays quiet" \
  || fail "behind-origin-master at 30min stays quiet" "alerts=$(alerts) out=$out"

# 4. ...but at 3h the arm automation is broken and it pages (1h threshold —
#    was 24h in the manual world; the expected-state grace moved to
#    awaiting-quiescence / armed-restart-disabled below).
reset
seed_log "behind-origin-master" 3
out=$(run_check)
[[ "$(alerts)" == "1" ]] \
  && ok "behind-origin-master sustained past 1h pages (arm automation broken)" \
  || fail "behind-origin-master sustained past 1h pages (arm automation broken)" "alerts=$(alerts) out=$out"

# 5. Rate limiting: a still-broken provenance state does not re-page every tick.
reset; rm -f "$HEALTH"; set_activated "$MASTER_SHA"
seed_log "untracked-or-unreachable:unreachable" 5
run_check >/dev/null
first=$(alerts)
run_check >/dev/null
second=$(alerts)
[[ "$first" == "1" && "$second" == "1" ]] \
  && ok "cooldown prevents re-paging on the next timer tick" \
  || fail "cooldown prevents re-paging on the next timer tick" "first=$first second=$second"

# 6. Fully converged production emits no drift, no page, and exits 0.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
seed_log "behind-origin-master" 30
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]]; then
  ok "converged deploy exits 0 and pages no one"
else
  fail "converged deploy exits 0 and pages no one" "rc=$rc alerts=$(alerts) out=$out"
fi

# 7. A page that fails to deliver must be loud, never swallowed (AUR-3930).
reset; rm -f "$HEALTH"; set_activated "$MASTER_SHA"
seed_log "untracked-or-unreachable:unreachable" 3
out=$(NOTIFY_EXIT=1 run_check); rc=$?
if grep -q "ESCALATION FAILED" <<<"$out" && [[ "$rc" == "1" ]]; then
  ok "undelivered page is reported loudly"
else
  fail "undelivered page is reported loudly" "rc=$rc out=$out"
fi

# 8. An unwritable rate-limit state file must NOT silently disable escalation.
#    Losing rate limiting is survivable; losing the page is the original bug.
reset; rm -f "$HEALTH" "/tmp/paperclip-deploy-drift.alert-state"; set_activated "$MASTER_SHA"
seed_log "untracked-or-unreachable:unreachable" 3
out=$(PAPERCLIP_DRIFT_ALERT_STATE=/nonexistent-dir/alert-state run_check)
if [[ "$(alerts)" == "1" ]]; then
  ok "unwritable alert state degrades to a page, never to silence"
else
  fail "unwritable alert state degrades to a page, never to silence" "alerts=$(alerts) out=$out"
fi
# ...and the fallback still rate-limits the next tick.
out=$(PAPERCLIP_DRIFT_ALERT_STATE=/nonexistent-dir/alert-state run_check)
[[ "$(alerts)" == "1" ]] \
  && ok "fallback rate-limit state suppresses the repeat tick" \
  || fail "fallback rate-limit state suppresses the repeat tick" "alerts=$(alerts) out=$out"
rm -f /tmp/paperclip-deploy-drift.alert-state

# --- AUR-4028: auto-deploy state file cases ---------------------------------
ARMED="1111111111111111111111111111111111111111"
RUNNING="2222222222222222222222222222222222222222"

# 9. THE NEW ALARM-FATIGUE GUARD. Armed + daemon alive + waiting on running>0
#    is the EXPECTED post-merge state (zero-running gaps reached 5.7h on the
#    day measured): reason must be awaiting-quiescence and 3h must NOT page.
reset; set_health_release "$RUNNING"; set_activated "$ARMED"
set_ad_state awaiting-quiescence "$ARMED" 4 60 $(( 3 * 3600 ))
seed_log "awaiting-quiescence" 3
out=$(run_check)
grep -q "reason=awaiting-quiescence" <<<"$out" \
  && ok "fresh daemon state waiting on running>0 reads as awaiting-quiescence" \
  || fail "fresh daemon state waiting on running>0 reads as awaiting-quiescence" "out=$out"
[[ "$(alerts)" == "0" ]] \
  && ok "awaiting-quiescence at 3h does NOT page (12h threshold — the fatigue guard)" \
  || fail "awaiting-quiescence at 3h does NOT page (12h threshold — the fatigue guard)" "alerts=$(alerts) out=$out"

# 10. ...but 13h of waiting is past the 12h threshold: page, and the text must
#     carry the running count and the wait duration.
reset
set_ad_state awaiting-quiescence "$ARMED" 4 60 $(( 13 * 3600 ))
seed_log "awaiting-quiescence" 13
out=$(run_check)
[[ "$(alerts)" == "1" ]] \
  && ok "awaiting-quiescence sustained past 12h pages" \
  || fail "awaiting-quiescence sustained past 12h pages" "alerts=$(alerts) out=$out"
grep -q "running=4" "$SINK" && grep -qE "waiting for [0-9.]+h" "$SINK" \
  && ok "quiescence page carries running count and wait duration" \
  || fail "quiescence page carries running count and wait duration" "sink=$(cat "$SINK")"

# 11. Restart half deliberately dark (the AUR-4028 landing state): reason is
#     armed-restart-disabled; quiet at 3h, pages at 25h (dark-armed, 24h).
reset
set_ad_state restart-disabled "$ARMED" 0 60 0
seed_log "armed-restart-disabled" 3
out=$(run_check)
grep -q "reason=armed-restart-disabled" <<<"$out" && [[ "$(alerts)" == "0" ]] \
  && ok "dark-armed (restart disabled) at 3h stays quiet" \
  || fail "dark-armed (restart disabled) at 3h stays quiet" "alerts=$(alerts) out=$out"
seed_log "armed-restart-disabled" 25
out=$(run_check)
[[ "$(alerts)" == "1" ]] \
  && ok "dark-armed sustained past 24h pages (deploy debt is still debt)" \
  || fail "dark-armed sustained past 24h pages (deploy debt is still debt)" "alerts=$(alerts) out=$out"

# 12. A STALE state file must NOT downgrade the page: armed-but-not-live with a
#     dead daemon is the sharp "timer dead or wedged" signal — provenance class,
#     pages at 3h. This is the "stale state file is itself the alarm" property.
reset
set_ad_state awaiting-quiescence "$ARMED" 4 $(( 2 * 3600 )) $(( 3 * 3600 ))
seed_log "armed-release-not-live" 3
out=$(run_check)
grep -q "reason=armed-release-not-live" <<<"$out" \
  && ok "stale daemon state keeps armed-release-not-live (automation-dead signal)" \
  || fail "stale daemon state keeps armed-release-not-live (automation-dead signal)" "out=$out"
[[ "$(alerts)" == "1" ]] \
  && ok "armed-but-not-live with dead daemon pages at provenance threshold" \
  || fail "armed-but-not-live with dead daemon pages at provenance threshold" "alerts=$(alerts) out=$out"

# 13. A fresh daemon that is NOT claiming to wait (phase=idle, wrong armed sha)
#     also keeps the provenance reason — the downgrade needs a consistent claim.
reset
set_ad_state idle "-" 0 60 0
out=$(run_check)
grep -q "reason=armed-release-not-live" <<<"$out" \
  && ok "fresh state without a waiting claim keeps armed-release-not-live" \
  || fail "fresh state without a waiting claim keeps armed-release-not-live" "out=$out"
clear_ad_state

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "check-deploy-drift escalation: all cases passed"
  exit 0
fi
echo "check-deploy-drift escalation: $FAILURES case(s) failed"
exit 1
