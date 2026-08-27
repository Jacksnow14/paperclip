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
#   3. (AUR-4661) `merge-debt` — origin/master static while >=3 open PRs are
#      CLEAN — fires on a replay of the 07-26..07-29 freeze, goes silent when
#      either leg is mutated, and NEVER reads GitHub's lazy all-UNKNOWN
#      mergeable_state as "zero CLEAN" (cases 14-19).
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

# Hermetic `gh` stub for the merge-debt leg (AUR-4661). Fixture protocol (env):
#   FAKE_TIP_DATE     ISO-8601 committer date returned for the commits/{sha}
#                     call (unset/empty = the call fails)
#   FAKE_PR_DIR       directory with one file per open PR: pr_<n> holds the
#                     mergeable_state to return, one line per poke, last line
#                     repeating once exhausted — this models the lazy compute
#                     (first poke "unknown", second poke the real state).
#                     Poke counts land in .pokes_<n> so tests can assert the
#                     two-pass property.
#   FAKE_PR_LIST_FAIL non-empty = the open-PR list call exits 1
GH="$TMP/gh"
cat > "$GH" <<'STUB'
#!/usr/bin/env bash
set -u
case "$*" in
  *"/commits/"*)
    [[ -n "${FAKE_TIP_DATE:-}" ]] || exit 1
    printf '%s\n' "$FAKE_TIP_DATE" ;;
  *"pulls?state=open"*)
    [[ -z "${FAKE_PR_LIST_FAIL:-}" ]] || exit 1
    for f in "${FAKE_PR_DIR:?}"/pr_*; do
      [[ -e "$f" ]] || continue
      printf '%s\n' "${f##*/pr_}"
    done ;;
  *"pulls/"*)
    # NB: must go through a scalar — ${*##pattern} strips EACH arg, not "$*".
    s="$*"; n=${s##*pulls/}; n=${n%% *}
    cnt=$(( $(cat "${FAKE_PR_DIR:?}/.pokes_$n" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$cnt" > "$FAKE_PR_DIR/.pokes_$n"
    v=$(sed -n "${cnt}p" "$FAKE_PR_DIR/pr_$n")
    [[ -n "$v" ]] || v=$(tail -n1 "$FAKE_PR_DIR/pr_$n")
    printf '%s\n' "$v" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$GH"
mkdir -p "$TMP/prs-none"

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
  PAPERCLIP_HEALTH_URL="${TEST_HEALTH_URL:-file://$HEALTH}" \
  PAPERCLIP_HEALTH_PROBE_TIMEOUT_SEC="${TEST_PROBE_TIMEOUT:-1}" \
  PAPERCLIP_HEALTH_PROBE_RETRIES="${TEST_PROBE_RETRIES:-2}" \
  PAPERCLIP_HEALTH_PROBE_BACKOFF_SEC="${TEST_PROBE_BACKOFF:-0}" \
  PAPERCLIP_DRIFT_LAST_KNOWN_RUNNING_FILE="${TEST_LAST_KNOWN_FILE:-$TMP/last-known-running}" \
  PAPERCLIP_DEPLOY_REMOTE="$REMOTE_REPO" \
  PAPERCLIP_DEPLOY_APP_ROOT="$APP" \
  PAPERCLIP_DRIFT_LOG="$LOG" \
  PAPERCLIP_DRIFT_ALERT_STATE="$STATE" \
  PAPERCLIP_DRIFT_NOTIFY="$NOTIFY" \
  PAPERCLIP_AUTO_DEPLOY_STATE="$AD_STATE" \
  PAPERCLIP_DRIFT_GH="$GH" \
  PAPERCLIP_DRIFT_REPO="owner/repo" \
  PAPERCLIP_DRIFT_MERGE_DEBT_RECHECK_DELAY_SEC=0 \
  PAPERCLIP_DRIFT_CHECKOUTS="${PAPERCLIP_DRIFT_CHECKOUTS-}" \
  PAPERCLIP_DRIFT_CHECKOUT_REFRESH="${PAPERCLIP_DRIFT_CHECKOUT_REFRESH-}" \
  PAPERCLIP_DRIFT_UNITS="${PAPERCLIP_DRIFT_UNITS-}" \
  PAPERCLIP_DRIFT_TIMERS="${PAPERCLIP_DRIFT_TIMERS-}" \
  PAPERCLIP_DRIFT_SCRIPTS="${PAPERCLIP_DRIFT_SCRIPTS-}" \
  PAPERCLIP_DRIFT_SYSTEMCTL="${PAPERCLIP_DRIFT_SYSTEMCTL-}" \
  PAPERCLIP_DRIFT_TIMER_THRESHOLD_SEC="${PAPERCLIP_DRIFT_TIMER_THRESHOLD_SEC-}" \
  FAKE_SYSTEMCTL_DIR="${FAKE_SYSTEMCTL_DIR-}" \
  FAKE_TIP_DATE="${FAKE_TIP_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
  FAKE_PR_DIR="${FAKE_PR_DIR:-$TMP/prs-none}" \
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

# 4b. (AUR-5355) deploy-debt is fleet-internal noise the founder cannot act on
#     directly — it must escalate at INFO (logged, never delivered), not SEV2.
if grep -q "^INFO " "$SINK" && ! grep -q "^SEV2 " "$SINK"; then
  ok "deploy-debt (behind-origin-master) escalates at INFO, not SEV2"
else
  fail "deploy-debt (behind-origin-master) escalates at INFO, not SEV2" "sink=$(cat "$SINK" 2>/dev/null)"
fi

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

# --- AUR-4661: merge-debt cases ---------------------------------------------
STALE_TIP=$(date -u -d "@$(( $(date -u +%s) - 3 * 86400 ))" +%Y-%m-%dT%H:%M:%SZ)

# 14. THE AUR-4509 REPLAY — the control that reproduces the defect. Production
#     converged with master, master tip 3 days old, 4 open PRs whose
#     mergeable_state is UNKNOWN on the first poke (the lazy-compute trap) and
#     only resolves on the second to 3 clean + 1 blocked. Must fire merge-debt
#     and page. An implementation that counts off the list endpoint — or off a
#     single poke pass — sees 0 CLEAN and fails this case (AC2 discriminator).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
seed_log "merge-debt" 3
PRD="$TMP/prs-replay"; mkdir -p "$PRD"
printf 'unknown\nclean\n'   > "$PRD/pr_101"
printf 'unknown\nclean\n'   > "$PRD/pr_102"
printf 'unknown\nclean\n'   > "$PRD/pr_103"
printf 'unknown\nblocked\n' > "$PRD/pr_104"
out=$(FAKE_TIP_DATE="$STALE_TIP" FAKE_PR_DIR="$PRD" run_check); rc=$?
grep -q "status=DRIFT reason=merge-debt " <<<"$out" && [[ "$rc" == "1" ]] \
  && ok "static master + 3 CLEAN behind lazy UNKNOWNs fires merge-debt" \
  || fail "static master + 3 CLEAN behind lazy UNKNOWNs fires merge-debt" "rc=$rc out=$out"
[[ "$(alerts)" == "1" ]] && grep -q "merge debt" "$SINK" && grep -q "3 open PRs" "$SINK" \
  && ok "sustained merge-debt (3h) pages the founder naming the CLEAN count" \
  || fail "sustained merge-debt (3h) pages the founder naming the CLEAN count" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null)"
pokes_ok=1
for n in 101 102 103 104; do
  [[ "$(cat "$PRD/.pokes_$n" 2>/dev/null)" == "2" ]] || pokes_ok=0
done
[[ "$pokes_ok" == "1" ]] \
  && ok "every lazy-UNKNOWN PR was poked exactly twice (two-pass property)" \
  || fail "every lazy-UNKNOWN PR was poked exactly twice (two-pass property)" "pokes=$(ls "$PRD"/.pokes_* 2>/dev/null | while read -r f; do printf '%s=%s ' "${f##*/}" "$(cat "$f")"; done)"

# 15. Leg A mutated (AC3): the SAME clean pile but master moved 1h ago — must
#     go silent, and the per-PR sweep must not even run (cost gate: a healthy
#     tick is one API call).
reset
seed_log "merge-debt" 3
PRD2="$TMP/prs-fresh"; mkdir -p "$PRD2"
printf 'clean\n' > "$PRD2/pr_201"; printf 'clean\n' > "$PRD2/pr_202"; printf 'clean\n' > "$PRD2/pr_203"
FRESH_TIP=$(date -u -d "@$(( $(date -u +%s) - 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
out=$(FAKE_TIP_DATE="$FRESH_TIP" FAKE_PR_DIR="$PRD2" run_check); rc=$?
[[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "status=ok" <<<"$out" \
  && ok "master moving silences merge-debt (leg A mutation)" \
  || fail "master moving silences merge-debt (leg A mutation)" "rc=$rc alerts=$(alerts) out=$out"
ls "$PRD2"/.pokes_* >/dev/null 2>&1 \
  && fail "fresh master skips the per-PR sweep entirely (cost gate)" "pokes=$(ls "$PRD2"/.pokes_*)" \
  || ok "fresh master skips the per-PR sweep entirely (cost gate)"

# 16. Leg B mutated (AC3): master static 3 days but only 2 CLEAN (< M=3), the
#     rest RESOLVED as not-mergeable — a real measurement of "not enough
#     ready", so it stays ok and silent.
reset
seed_log "merge-debt" 3
PRD3="$TMP/prs-below"; mkdir -p "$PRD3"
printf 'clean\n'   > "$PRD3/pr_301"; printf 'clean\n' > "$PRD3/pr_302"
printf 'blocked\n' > "$PRD3/pr_303"; printf 'dirty\n' > "$PRD3/pr_304"
out=$(FAKE_TIP_DATE="$STALE_TIP" FAKE_PR_DIR="$PRD3" run_check); rc=$?
[[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "status=ok" <<<"$out" && grep -q "clean=2" <<<"$out" \
  && ok "CLEAN below M silences merge-debt but the count is measured (leg B mutation)" \
  || fail "CLEAN below M silences merge-debt but the count is measured (leg B mutation)" "rc=$rc alerts=$(alerts) out=$out"

# 17. THE AC2 TRAP ITSELF: every PR still UNKNOWN after BOTH poke passes must
#     NOT be read as zero CLEAN / ok — that is a transport failure, and it is
#     reported as unmeasurable (loud in the log, breaks any DRIFT run).
reset
seed_log "merge-debt" 3
PRD4="$TMP/prs-unknown"; mkdir -p "$PRD4"
for n in 401 402 403 404; do printf 'unknown\nunknown\n' > "$PRD4/pr_$n"; done
out=$(FAKE_TIP_DATE="$STALE_TIP" FAKE_PR_DIR="$PRD4" run_check); rc=$?
if grep -q "reason=merge-debt-unmeasurable:pr-state" <<<"$out" && ! grep -q "status=ok" <<<"$out"; then
  ok "all-UNKNOWN after two passes reads unmeasurable, never a silent ok"
else
  fail "all-UNKNOWN after two passes reads unmeasurable, never a silent ok" "rc=$rc out=$out"
fi
[[ "$(cat "$PRD4/.pokes_401" 2>/dev/null)" == "2" ]] \
  && ok "unresolved PRs still get the second poke pass before giving up" \
  || fail "unresolved PRs still get the second poke pass before giving up" "pokes_401=$(cat "$PRD4/.pokes_401" 2>/dev/null)"

# 18. Precedence: a deploy-class drift wins and the PR sweep never runs — the
#     merge-debt leg only grades a converged pipeline.
reset; clear_ad_state
set_health_release "0000000000000000000000000000000000000000"; set_activated "0000000000000000000000000000000000000000"
seed_log "behind-origin-master" 0
PRD5="$TMP/prs-precedence"; mkdir -p "$PRD5"
printf 'clean\n' > "$PRD5/pr_501"; printf 'clean\n' > "$PRD5/pr_502"; printf 'clean\n' > "$PRD5/pr_503"
out=$(FAKE_TIP_DATE="$STALE_TIP" FAKE_PR_DIR="$PRD5" run_check); rc=$?
if grep -q "reason=behind-origin-master" <<<"$out" && ! ls "$PRD5"/.pokes_* >/dev/null 2>&1; then
  ok "deploy-class drift takes precedence and skips the PR sweep"
else
  fail "deploy-class drift takes precedence and skips the PR sweep" "out=$out pokes=$(ls "$PRD5"/.pokes_* 2>/dev/null)"
fi

# 19. Graded, not instant: the conjunction holding on the FIRST tick fires the
#     DRIFT line (the log run starts) but does not page until 2h sustained.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$LOG"
PRD6="$TMP/prs-first-tick"; mkdir -p "$PRD6"
printf 'clean\n' > "$PRD6/pr_601"; printf 'clean\n' > "$PRD6/pr_602"; printf 'clean\n' > "$PRD6/pr_603"
out=$(FAKE_TIP_DATE="$STALE_TIP" FAKE_PR_DIR="$PRD6" run_check); rc=$?
if grep -q "status=DRIFT reason=merge-debt " <<<"$out" && [[ "$rc" == "1" && "$(alerts)" == "0" ]] \
   && grep -q "not escalating" <<<"$out"; then
  ok "first-tick merge-debt fires the line but waits out the 2h sustain gate"
else
  fail "first-tick merge-debt fires the line but waits out the 2h sustain gate" "rc=$rc alerts=$(alerts) out=$out"
fi

# --- checkout-drift axis (AUR-4227) -----------------------------------------
# A routine can run fine and still execute stale, already-fixed code because the
# checkout it `cd`s into never advanced past an old commit (AUR-4187). These
# cases cover the axis that walks configured checkouts independently of the
# primary running-server check. The axis is OPT-IN: with the default empty
# PAPERCLIP_DRIFT_CHECKOUTS it does nothing (case 25).

CO_REMOTE="$TMP/co-remote"
git init -q --initial-branch=main "$CO_REMOTE"
git -C "$CO_REMOTE" -c user.email=t@example.com -c user.name=t \
  commit -q --allow-empty -m "checkout fixture: initial"
CO_LOCAL="$TMP/co-local"
git clone -q "$CO_REMOTE" "$CO_LOCAL"
CO_LOCAL_SHA=$(git -C "$CO_LOCAL" rev-parse HEAD)

CO_LOG="$LOG.checkout-fixture"
CO_STATE="$STATE.checkout-fixture"

run_check_co() {
  PAPERCLIP_DRIFT_CHECKOUTS="fixture:$CO_LOCAL:main" run_check
}

# 20. A checkout that is current (HEAD == origin/main) reports ok and pages no one.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
rm -f "$CO_LOG" "$CO_STATE"
out=$(run_check_co); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "checkout=fixture .*status=ok" <<<"$out"; then
  ok "current checkout reports ok and exits 0"
else
  fail "current checkout reports ok and exits 0" "rc=$rc alerts=$(alerts) out=$out"
fi

# 21. A checkout left behind origin/main for 3h is checkout-debt: below the 24h
#     threshold, so it drifts (nonzero exit) but does not yet page. The fixture
#     tree is made DIRTY here: since AUR-4984 a clean behind checkout self-heals
#     (cases 26+), so the sustained-escalation path below is exactly the
#     dirty-checkout population that still alarms in production.
git -C "$CO_REMOTE" -c user.email=t@example.com -c user.name=t \
  commit -q --allow-empty -m "checkout fixture: advances past local"
echo "uncommitted work another agent owns" > "$CO_LOCAL/wip.txt"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$CO_LOG"; : > "$CO_STATE"
now=$(date -u +%s)
stamp=$(date -u -d "@$(( now - 3 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s checkout=fixture local=%s remote=deadbeefdead status=DRIFT reason=checkout-behind:fixture\n' \
  "$stamp" "${CO_LOCAL_SHA:0:12}" >> "$CO_LOG"
out=$(run_check_co); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]]; then
  ok "checkout behind origin/main for 3h drifts but does not page (graded policy)"
else
  fail "checkout behind origin/main for 3h drifts but does not page (graded policy)" "rc=$rc alerts=$(alerts) out=$out"
fi

# 22. ...but left behind for 30h, it pages, naming the checkout label.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$CO_LOG"; : > "$CO_STATE"
stamp=$(date -u -d "@$(( now - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s checkout=fixture local=%s remote=deadbeefdead status=DRIFT reason=checkout-behind:fixture\n' \
  "$stamp" "${CO_LOCAL_SHA:0:12}" >> "$CO_LOG"
out=$(run_check_co); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "checkout-behind:fixture" "$SINK"; then
  ok "checkout behind origin/main for 30h pages, naming the checkout"
else
  fail "checkout behind origin/main for 30h pages, naming the checkout" "rc=$rc alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 22b. (AUR-5355) checkout-debt is fleet-internal noise the founder cannot act
#      on directly — it must escalate at INFO (logged, never delivered), not SEV2.
if grep -q "^INFO .*checkout-behind:fixture" "$SINK" && ! grep -q "^SEV2 " "$SINK"; then
  ok "checkout-debt (checkout-behind) escalates at INFO, not SEV2"
else
  fail "checkout-debt (checkout-behind) escalates at INFO, not SEV2" "sink=$(cat "$SINK" 2>/dev/null)"
fi

# 23. A checkout drift's sustained-duration clock is isolated from the primary
#     axis's own log: a primary-axis DRIFT in the same run must not reset (or be
#     reset by) the checkout's independently-tracked streak.
reset; rm -f "$HEALTH"; set_activated "$MASTER_SHA"
seed_log "untracked-or-unreachable:unreachable" 3
: > "$CO_LOG"; : > "$CO_STATE"
stamp=$(date -u -d "@$(( now - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s checkout=fixture local=%s remote=deadbeefdead status=DRIFT reason=checkout-behind:fixture\n' \
  "$stamp" "${CO_LOCAL_SHA:0:12}" >> "$CO_LOG"
out=$(run_check_co); rc=$?
if [[ "$(alerts)" == "2" ]] && grep -q "SEV2" "$SINK" && grep -q "checkout-behind:fixture" "$SINK" \
   && grep -q "untracked-or-unreachable" "$SINK"; then
  ok "primary-axis drift and checkout drift page independently in the same run"
else
  fail "primary-axis drift and checkout drift page independently in the same run" "alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi

# 24. A missing/unreachable checkout is skipped, not alarmed — this axis reports
#     what it can prove, not what it cannot reach.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(PAPERCLIP_DRIFT_CHECKOUTS="ghost:$TMP/does-not-exist:main" run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "not present on this host, skipping" <<<"$out"; then
  ok "missing checkout is skipped, not alarmed"
else
  fail "missing checkout is skipped, not alarmed" "rc=$rc alerts=$(alerts) out=$out"
fi

# 25. Feature off by default: no PAPERCLIP_DRIFT_CHECKOUTS, no checkout lines,
#     exit still 0 on a converged deploy — the axis must be opt-in because a
#     wrong default (e.g. a live checkout that deliberately sits on a
#     non-master branch) would perpetually page.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && ! grep -q "checkout=" <<<"$out"; then
  ok "empty checkout list disables the axis entirely"
else
  fail "empty checkout list disables the axis entirely" "rc=$rc alerts=$(alerts) out=$out"
fi

# --- AUR-4984: checkout self-healing refresher -------------------------------
# The axis above DETECTS a behind checkout; these cases lock down the inline
# refresher that HEALS the clean ones. Contract: only a clean, strictly-behind
# tree is ever touched, the only primitive is `merge --ff-only` (never reset,
# never checkout — paperclip-shared backs ~100 worktrees), and every checkout
# line carries a refresh= field, whose absence means the refresher is dead.

# One fresh fixture pair per case so states cannot leak between cases.
mk_co() {
  git init -q --initial-branch=main "$TMP/$1-remote"
  git -C "$TMP/$1-remote" -c user.email=t@example.com -c user.name=t \
    commit -q --allow-empty -m "base"
  git clone -q "$TMP/$1-remote" "$TMP/$1"
}
advance_remote() {
  git -C "$TMP/$1-remote" -c user.email=t@example.com -c user.name=t \
    commit -q --allow-empty -m "upstream advance"
}
co_head()     { git -C "$TMP/$1" rev-parse HEAD; }
remote_head() { git -C "$TMP/$1-remote" rev-parse HEAD; }

# 26. THE HEAL. Clean + strictly behind: fast-forwarded in place, reports ok,
#     and pages NO ONE even with a 30h seeded DRIFT backlog — the alarm is
#     silenced by fixing the condition, not by suppressing the page.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
mk_co ff26; advance_remote ff26
before=$(co_head ff26); want=$(remote_head ff26)
: > "$LOG.checkout-ff26"; : > "$STATE.checkout-ff26"
stamp=$(date -u -d "@$(( $(date -u +%s) - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s checkout=ff26 local=%s remote=%s status=DRIFT reason=checkout-behind:ff26\n' \
  "$stamp" "${before:0:12}" "${want:0:12}" >> "$LOG.checkout-ff26"
out=$(PAPERCLIP_DRIFT_CHECKOUTS="ff26:$TMP/ff26:main" run_check); rc=$?
after=$(co_head ff26)
if [[ "$before" != "$want" && "$after" == "$want" && "$rc" == "0" && "$(alerts)" == "0" ]] \
   && grep -q "checkout=ff26 local=${want:0:12} .*status=ok reason=- refresh=ff" <<<"$out"; then
  ok "clean behind checkout heals: refresh=ff, post-merge sha logged, ok, zero pages"
else
  fail "clean behind checkout heals: refresh=ff, post-merge sha logged, ok, zero pages" \
    "rc=$rc alerts=$(alerts) before=$before after=$after want=$want out=$out"
fi

# 27. Never touch a dirty tree (AUR-4187/AUR-4541). Behind + dirty: HEAD
#     pinned, the dirty content byte-identical, still DRIFT — and 30h
#     sustained still pages, because a dirty behind tree needs a human
#     decision, not silence.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co dirty27; advance_remote dirty27
echo "unmerged agent work" > "$TMP/dirty27/wip.txt"
before=$(co_head dirty27); sum_before=$(sha256sum "$TMP/dirty27/wip.txt")
: > "$LOG.checkout-dirty27"; : > "$STATE.checkout-dirty27"
stamp=$(date -u -d "@$(( $(date -u +%s) - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s checkout=dirty27 local=%s remote=deadbeefdead status=DRIFT reason=checkout-behind:dirty27\n' \
  "$stamp" "${before:0:12}" >> "$LOG.checkout-dirty27"
out=$(PAPERCLIP_DRIFT_CHECKOUTS="dirty27:$TMP/dirty27:main" run_check); rc=$?
after=$(co_head dirty27); sum_after=$(sha256sum "$TMP/dirty27/wip.txt")
if [[ "$after" == "$before" && "$sum_after" == "$sum_before" && "$rc" == "1" && "$(alerts)" == "1" ]] \
   && grep -q "checkout=dirty27 .*status=DRIFT reason=checkout-behind:dirty27 refresh=skipped-dirty" <<<"$out" \
   && grep -q "checkout-behind:dirty27" "$SINK"; then
  ok "dirty behind checkout: untouched, refresh=skipped-dirty, still DRIFT, still pages at threshold"
else
  fail "dirty behind checkout: untouched, refresh=skipped-dirty, still DRIFT, still pages at threshold" \
    "rc=$rc alerts=$(alerts) before=$before after=$after sums=$sum_before/$sum_after out=$out"
fi

# 28. Diverged (a local commit upstream does not have): only a true ancestor
#     advance may be fast-forwarded. HEAD pinned, DRIFT.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co div28; advance_remote div28
git -C "$TMP/div28" -c user.email=t@example.com -c user.name=t \
  commit -q --allow-empty -m "local-only commit"
before=$(co_head div28)
out=$(PAPERCLIP_DRIFT_CHECKOUTS="div28:$TMP/div28:main" run_check); rc=$?
after=$(co_head div28)
if [[ "$after" == "$before" && "$rc" == "1" ]] \
   && grep -q "checkout=div28 .*status=DRIFT reason=checkout-behind:div28 refresh=skipped-diverged" <<<"$out"; then
  ok "diverged checkout is never fast-forwarded: refresh=skipped-diverged, HEAD pinned, DRIFT"
else
  fail "diverged checkout is never fast-forwarded: refresh=skipped-diverged, HEAD pinned, DRIFT" \
    "rc=$rc before=$before after=$after out=$out"
fi

# 29. Already current: refresh=noop-current and no merge is attempted at all —
#     the reflog stays exactly as the clone left it.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co cur29
reflog_before=$(git -C "$TMP/cur29" reflog | wc -l)
out=$(PAPERCLIP_DRIFT_CHECKOUTS="cur29:$TMP/cur29:main" run_check); rc=$?
reflog_after=$(git -C "$TMP/cur29" reflog | wc -l)
if [[ "$rc" == "0" && "$reflog_after" == "$reflog_before" ]] \
   && grep -q "checkout=cur29 .*status=ok reason=- refresh=noop-current" <<<"$out"; then
  ok "current checkout: refresh=noop-current, no merge attempted (reflog untouched)"
else
  fail "current checkout: refresh=noop-current, no merge attempted (reflog untouched)" \
    "rc=$rc reflog=$reflog_before/$reflog_after out=$out"
fi

# 30. Detached HEAD, clean, behind — interop-bridge-runtime is live in this
#     state today. Must not crash; a detached ancestor advance is still a pure
#     fast-forward (no branch ref involved), so it heals like any other.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co det30; git -C "$TMP/det30" checkout -q --detach HEAD; advance_remote det30
want=$(remote_head det30)
out=$(PAPERCLIP_DRIFT_CHECKOUTS="det30:$TMP/det30:main" run_check); rc=$?
after=$(co_head det30)
if [[ "$rc" == "0" && "$after" == "$want" ]] \
   && grep -q "checkout=det30 local=${want:0:12} .*status=ok reason=- refresh=ff" <<<"$out"; then
  ok "detached clean behind checkout heals without crashing (refresh=ff on detached HEAD)"
else
  fail "detached clean behind checkout heals without crashing (refresh=ff on detached HEAD)" \
    "rc=$rc after=$after want=$want out=$out"
fi

# 31. Kill switch: PAPERCLIP_DRIFT_CHECKOUT_REFRESH=0 restores detect-only
#     behaviour — refresh=disabled, HEAD pinned, DRIFT still reported.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co kill31; advance_remote kill31
before=$(co_head kill31)
out=$(PAPERCLIP_DRIFT_CHECKOUT_REFRESH=0 \
      PAPERCLIP_DRIFT_CHECKOUTS="kill31:$TMP/kill31:main" run_check); rc=$?
after=$(co_head kill31)
if [[ "$after" == "$before" && "$rc" == "1" ]] \
   && grep -q "checkout=kill31 .*status=DRIFT reason=checkout-behind:kill31 refresh=disabled" <<<"$out"; then
  ok "refresher kill switch: refresh=disabled, HEAD pinned, DRIFT still reported"
else
  fail "refresher kill switch: refresh=disabled, HEAD pinned, DRIFT still reported" \
    "rc=$rc before=$before after=$after out=$out"
fi

# 32. Scope containment: an unwatched sibling checkout adjacent to a watched
#     one — same remote, equally behind — is neither refreshed nor logged.
#     The refresher structurally cannot leave the watch list.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co watched32
git clone -q "$TMP/watched32-remote" "$TMP/watched32-sibling"
advance_remote watched32
sib_before=$(git -C "$TMP/watched32-sibling" rev-parse HEAD)
want=$(remote_head watched32)
out=$(PAPERCLIP_DRIFT_CHECKOUTS="watched32:$TMP/watched32:main" run_check); rc=$?
sib_after=$(git -C "$TMP/watched32-sibling" rev-parse HEAD)
if [[ "$(co_head watched32)" == "$want" && "$sib_after" == "$sib_before" && "$sib_after" != "$want" ]] \
   && ! grep -q "sibling" <<<"$out"; then
  ok "unwatched sibling checkout is neither refreshed nor logged"
else
  fail "unwatched sibling checkout is neither refreshed nor logged" \
    "rc=$rc sib=$sib_before/$sib_after want=$want out=$out"
fi

# 33. The liveness contract: EVERY emitted checkout= line carries a refresh=
#     field, across heal/skip/noop outcomes in one run — a line without one
#     is the signal that the refresher is dead.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
mk_co all33a; advance_remote all33a                     # heals: ff
mk_co all33b; advance_remote all33b
echo wip > "$TMP/all33b/wip.txt"                        # skips: dirty
mk_co all33c                                            # already current
out=$(PAPERCLIP_DRIFT_CHECKOUTS="all33a:$TMP/all33a:main
all33b:$TMP/all33b:main
all33c:$TMP/all33c:main" run_check); rc=$?
lines=$(grep -c "checkout=" <<<"$out")
bare=$(grep "checkout=" <<<"$out" | grep -vc "refresh=")
if [[ "$lines" == "3" && "$bare" == "0" ]]; then
  ok "all 3 checkout lines carry a refresh= field (absence = refresher dead)"
else
  fail "all 3 checkout lines carry a refresh= field (absence = refresher dead)" \
    "lines=$lines bare=$bare out=$out"
fi

# --- unit-drift axis (AUR-5648, follow-up to AUR-5647) ----------------------
# No deploy path re-runs the systemd installer scripts, so an installed unit
# can silently keep an old copy while the active release's own copy (never
# origin/master) has already moved on. These cases prove the axis both FIRES
# on a genuinely stale/missing installed artifact and PASSES on a current one
# — a check that can never return STALE is exactly the bug being fixed. The
# axis is OPT-IN, same reasoning as PAPERCLIP_DRIFT_CHECKOUTS (case 39 below).

UNIT_REL_DIR="$APP/current/scripts/deploy/systemd"
mkdir -p "$UNIT_REL_DIR"
printf 'release copy content\n' > "$UNIT_REL_DIR/fixture.service"
UNIT_INSTALLED="$TMP/installed-fixture.service"
UN_LOG="$LOG.unit-fixture"
UN_STATE="$STATE.unit-fixture"

run_check_unit() {
  PAPERCLIP_DRIFT_UNITS="fixture:fixture.service:$UNIT_INSTALLED:system" run_check
}

# 34. PASS: installed copy byte-identical to the active release's own copy
#     reports ok and pages no one.
printf 'release copy content\n' > "$UNIT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
rm -f "$UN_LOG" "$UN_STATE"
out=$(run_check_unit); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "unit=fixture level=system .*status=ok" <<<"$out"; then
  ok "unit content matching the active release reports ok and exits 0"
else
  fail "unit content matching the active release reports ok and exits 0" "rc=$rc alerts=$(alerts) out=$out"
fi

# 35. FIRE (below threshold): installed copy diverges from the active
#     release's copy. Seeded at 3h — below the 24h unit-debt threshold, so it
#     drifts (nonzero exit) but does not yet page.
printf 'HAND-EDITED content, never reinstalled\n' > "$UNIT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$UN_LOG"; : > "$UN_STATE"
now=$(date -u +%s)
stamp=$(date -u -d "@$(( now - 3 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s unit=fixture level=system installed=%s status=DRIFT reason=unit-behind:fixture\n' \
  "$stamp" "$UNIT_INSTALLED" >> "$UN_LOG"
out=$(run_check_unit); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]] && grep -q "reason=unit-behind:fixture" <<<"$out"; then
  ok "unit content behind the active release for 3h drifts but does not page"
else
  fail "unit content behind the active release for 3h drifts but does not page" "rc=$rc alerts=$(alerts) out=$out"
fi

# 36. FIRE (sustained past threshold): left behind for 30h, it pages, naming
#     the unit, at INFO severity (AUR-5355 posture: same fleet-internal debt
#     character as checkout-debt/deploy-debt, not a founder-actionable page).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$UN_LOG"; : > "$UN_STATE"
stamp=$(date -u -d "@$(( now - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s unit=fixture level=system installed=%s status=DRIFT reason=unit-behind:fixture\n' \
  "$stamp" "$UNIT_INSTALLED" >> "$UN_LOG"
out=$(run_check_unit); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "unit-behind:fixture" "$SINK"; then
  ok "unit content behind the active release for 30h pages, naming the unit"
else
  fail "unit content behind the active release for 30h pages, naming the unit" "rc=$rc alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi
if grep -q "^INFO .*unit-behind:fixture" "$SINK" && ! grep -q "^SEV2 " "$SINK"; then
  ok "unit-debt (unit-behind) escalates at INFO, not SEV2"
else
  fail "unit-debt (unit-behind) escalates at INFO, not SEV2" "sink=$(cat "$SINK" 2>/dev/null)"
fi

# 37. FIRE (missing): the installed artifact is absent entirely — a real
#     MISSING status, not a skip, since the manifest names a definitive
#     expected location.
rm -f "$UNIT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$UN_LOG"; : > "$UN_STATE"
out=$(run_check_unit); rc=$?
if [[ "$rc" == "1" ]] && grep -q "unit=fixture level=system .*status=DRIFT reason=unit-missing:fixture" <<<"$out"; then
  ok "missing installed unit reports unit-missing, not a skip"
else
  fail "missing installed unit reports unit-missing, not a skip" "rc=$rc out=$out"
fi

# 38. A manifest line whose active-release source copy does not exist is
#     reported and skipped (not alarmed) — nothing to prove drift against, the
#     same posture as an unreachable checkout (case 24).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(PAPERCLIP_DRIFT_UNITS="ghost:does-not-exist.service:$TMP/whatever:system" run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "active release copy .*does-not-exist.service not found, skipping" <<<"$out"; then
  ok "missing active-release source copy is skipped, not alarmed"
else
  fail "missing active-release source copy is skipped, not alarmed" "rc=$rc alerts=$(alerts) out=$out"
fi

# 39. Feature off by default: no PAPERCLIP_DRIFT_UNITS, no unit lines, exit
#     still 0 on a converged deploy — opt-in for the same reason as
#     PAPERCLIP_DRIFT_CHECKOUTS (case 25).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && ! grep -q "unit=" <<<"$out"; then
  ok "empty unit list disables the axis entirely"
else
  fail "empty unit list disables the axis entirely" "rc=$rc alerts=$(alerts) out=$out"
fi

# --- timer-liveness axis (AUR-5885, follow-up to AUR-5866) ------------------
# Every axis above answers "is the right code on disk / running" — none of
# them can see a timer/service pair that is simply DEAD. AUR-5866 found
# paperclip-pr-review.timer disabled and its service failed for 13 days while
# unit-drift's own on-disk copy matched the release every tick. These cases
# prove the axis both FIRES on a genuinely disabled timer + failed service and
# PASSES on an enabled timer + successful recent service (acceptance
# criteria) — a check that can never return STALE is exactly the bug being
# fixed (artifact-provenance doctrine). Hermetic `systemctl` stub below reads
# `show <unit> -p PROP...` requests from fixture files, one per unit, holding
# `PROP=value` lines — no real systemd anywhere in this run.
#
# Fixture protocol (env):
#   FAKE_SYSTEMCTL_DIR   directory with one file per unit; `PROP=value` lines
#                        answer `systemctl show <unit> -p PROP1 -p PROP2`.
#                        A missing file models `systemctl show` failing
#                        outright (unit doesn't exist / systemd unreachable).
SYSTEMCTL="$TMP/systemctl"
cat > "$SYSTEMCTL" <<'STUB'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == "show" ]] || exit 1
shift
unit=$1; shift
props=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) props+=("$2"); shift 2 ;;
    *) shift ;;
  esac
done
fixture="${FAKE_SYSTEMCTL_DIR:?}/$unit"
[[ -f "$fixture" ]] || exit 1
for p in "${props[@]}"; do
  sed -n "s/^${p}=//p" "$fixture"
done
STUB
chmod +x "$SYSTEMCTL"

TL_DIR="$TMP/systemctl-fixtures"
mkdir -p "$TL_DIR"
set_tl_timer() { # $1=unit $2=UnitFileState $3=ActiveState
  printf 'UnitFileState=%s\nActiveState=%s\n' "$2" "$3" > "$TL_DIR/$1"
}
set_tl_service() { # $1=unit $2=Result $3=age_seconds_since_last_exit
  local ts
  ts=$(date -u -d "@$(( $(date -u +%s) - $3 ))" '+%a %Y-%m-%d %H:%M:%S UTC')
  printf 'Result=%s\nExecMainExitTimestamp=%s\n' "$2" "$ts" > "$TL_DIR/$1"
}
# A single old-timestamped line already sets the gate's sustained-since clock
# (same property cases 21/22 rely on for the checkout axis) — no need to
# replay a whole trailing run.
tl_seed_at() { # $1=reason $2=seconds-ago
  local stamp
  stamp=$(date -u -d "@$(( $(date -u +%s) - $2 ))" +%Y-%m-%dT%H:%M:%SZ)
  printf '%s timer=fixture status=DRIFT reason=%s\n' "$stamp" "$1" >> "$TL_LOG"
}

TL_LOG="$LOG.timer-fixture"
TL_STATE="$STATE.timer-fixture"

run_check_tl() {
  PAPERCLIP_DRIFT_TIMERS="fixture:tl.timer:tl.service:5400" \
  PAPERCLIP_DRIFT_SYSTEMCTL="$SYSTEMCTL" \
  FAKE_SYSTEMCTL_DIR="$TL_DIR" \
    run_check
}

# 40. PASS: enabled/active timer + a service that succeeded a minute ago
#     reports ok and pages no one.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
rm -f "$TL_LOG" "$TL_STATE"
set_tl_timer tl.timer enabled active
set_tl_service tl.service success 60
out=$(run_check_tl); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "timer=fixture .*status=ok" <<<"$out"; then
  ok "enabled timer + recently-successful service reports ok and exits 0"
else
  fail "enabled timer + recently-successful service reports ok and exits 0" "rc=$rc alerts=$(alerts) out=$out"
fi

# 41. FIRE (below threshold): disabled timer + failed service, sustained 30min
#     — below the 90min threshold, so it drifts (nonzero exit) but does not
#     yet page. Also proves precedence: disabled wins over service-failed.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
set_tl_timer tl.timer disabled inactive
set_tl_service tl.service failed 60
: > "$TL_LOG"; : > "$TL_STATE"
tl_seed_at "timer-disabled:fixture" 1800
out=$(run_check_tl); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]] && grep -q "reason=timer-disabled:fixture" <<<"$out"; then
  ok "disabled timer + failed service at 30min drifts but does not yet page (90min threshold)"
else
  fail "disabled timer + failed service at 30min drifts but does not yet page (90min threshold)" "rc=$rc alerts=$(alerts) out=$out"
fi

# 42. FIRE (sustained past threshold, THE ACCEPTANCE-CRITERIA CASE): the same
#     disabled timer + failed service, sustained 100min, pages — and at SEV2,
#     the same "automation is silently dead" class as provenance/dark-armed,
#     not INFO-graded fleet debt.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$TL_LOG"; : > "$TL_STATE"
tl_seed_at "timer-disabled:fixture" 6000
out=$(run_check_tl); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "timer-disabled:fixture" "$SINK"; then
  ok "disabled timer + failed service sustained past 90min pages, naming the timer"
else
  fail "disabled timer + failed service sustained past 90min pages, naming the timer" "rc=$rc alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi
if grep -q "^SEV2 .*timer-disabled:fixture" "$SINK" && ! grep -q "^INFO " "$SINK"; then
  ok "timer-liveness (timer-disabled) escalates at SEV2, not INFO (silent-dead-unit class)"
else
  fail "timer-liveness (timer-disabled) escalates at SEV2, not INFO (silent-dead-unit class)" "sink=$(cat "$SINK" 2>/dev/null)"
fi

# 43. FIRE (service-failed only): timer itself enabled/active, but the paired
#     service's last run Result != success — pages with reason
#     timer-service-failed, distinct from timer-disabled.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
set_tl_timer tl.timer enabled active
set_tl_service tl.service failed 60
: > "$TL_LOG"; : > "$TL_STATE"
tl_seed_at "timer-service-failed:fixture" 6000
out=$(run_check_tl); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "reason=timer-service-failed:fixture" <<<"$out" \
   && grep -q "timer-service-failed:fixture" "$SINK"; then
  ok "enabled timer with a failed service last-run pages, reason=timer-service-failed"
else
  fail "enabled timer with a failed service last-run pages, reason=timer-service-failed" "rc=$rc alerts=$(alerts) out=$out"
fi

# 44. FIRE (service-stale only): timer healthy, service Result=success, but
#     the last successful completion is older than this target's configured
#     max_staleness (5400s here) — pages with reason timer-service-stale.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
set_tl_timer tl.timer enabled active
set_tl_service tl.service success $(( 3 * 3600 ))
: > "$TL_LOG"; : > "$TL_STATE"
tl_seed_at "timer-service-stale:fixture" 6000
out=$(run_check_tl); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "reason=timer-service-stale:fixture" <<<"$out" \
   && grep -q "timer-service-stale:fixture" "$SINK"; then
  ok "enabled timer whose service last succeeded beyond max_staleness pages, reason=timer-service-stale"
else
  fail "enabled timer whose service last succeeded beyond max_staleness pages, reason=timer-service-stale" "rc=$rc alerts=$(alerts) out=$out"
fi

# 45. A systemctl call that fails outright (unit unreachable/nonexistent) is
#     skipped, not alarmed — this axis reports what it can prove, same
#     posture as an unreachable checkout (case 24) / missing unit source
#     (case 38).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
rm -f "$TL_DIR/tl.timer" "$TL_DIR/tl.service"
out=$(run_check_tl); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "systemctl show failed, skipping" <<<"$out"; then
  ok "systemctl unreachable for a watched timer is skipped, not alarmed"
else
  fail "systemctl unreachable for a watched timer is skipped, not alarmed" "rc=$rc alerts=$(alerts) out=$out"
fi

# 46. Feature off by default: no PAPERCLIP_DRIFT_TIMERS, no timer lines, exit
#     still 0 on a converged deploy — opt-in for the same reason as
#     PAPERCLIP_DRIFT_CHECKOUTS/PAPERCLIP_DRIFT_UNITS (cases 25/39). This is
#     the exact shape of the AUR-4187 "shipped dark" bug one axis over: a
#     wrong hardcoded default here would either perpetually page on hosts
#     without the pr-review unit, or (worse) silently watch nothing.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && ! grep -q "timer=" <<<"$out"; then
  ok "empty timer list disables the axis entirely"
else
  fail "empty timer list disables the axis entirely" "rc=$rc alerts=$(alerts) out=$out"
fi

# --- AUR-5093: probe timeout vs refusal grading -----------------------------
# The bug: a single 10s curl budget read a genuinely healthy prod as
# unreachable ~25% of the time under load, and a bare timeout used to be
# indistinguishable from a genuine refusal — both landed on the same
# outage-shaped "untracked-or-unreachable:unreachable" reason with
# running=none. These cases prove the split: a timeout (curl exit 28) grades
# as status=UNKNOWN reason=health-slow with running=unknown, never escalates,
# and carries the last known running sha/age forward; a genuine refusal (curl
# exit 7, nothing listening) is UNCHANGED — still status=DRIFT
# reason=untracked-or-unreachable:unreachable, running=none.

hang_pid=""
start_hang_server() { # $1=port — accepts connections and never responds
  local port=$1
  python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $port))
s.listen(5)
conns = []
while True:
    conn, _ = s.accept()
    conns.append(conn)  # keep the ref alive: never respond, never close
" &
  hang_pid=$!
  for _ in $(seq 1 30); do
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3>&-; return 0; }
    sleep 0.1
  done
  echo "FATAL: hang server on port $port never came up" >&2; exit 1
}
stop_hang_server() {
  [[ -n "$hang_pid" ]] && kill "$hang_pid" 2>/dev/null
  wait "$hang_pid" 2>/dev/null || true
  hang_pid=""
}

HANG_PORT=$(( 24000 + RANDOM % 5000 ))

# 47a. A converged tick over the real (fast) health fixture seeds the
#      last-known-running file from a genuine success, not a hand-written one.
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
rm -f "$TMP/last-known-running"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && -s "$TMP/last-known-running" ]] && grep -q "^$MASTER_SHA " "$TMP/last-known-running"; then
  ok "47a: a converged tick seeds the last-known-running file"
else
  fail "47a: a converged tick seeds the last-known-running file" "rc=$rc file=$(cat "$TMP/last-known-running" 2>/dev/null)"
fi

# 47b. The health endpoint now times out (server accepts but never responds).
#      Must NOT read as an outage: status=UNKNOWN reason=health-slow,
#      running=unknown (never none), and it must not page.
start_hang_server "$HANG_PORT"
reset
out=$(TEST_HEALTH_URL="http://127.0.0.1:$HANG_PORT/api/health" run_check); rc=$?
stop_hang_server
if grep -q "status=UNKNOWN reason=health-slow" <<<"$out" && grep -q "running=unknown" <<<"$out"; then
  ok "47b: a timed-out probe grades UNKNOWN/health-slow, running=unknown — not an outage"
else
  fail "47b: a timed-out probe grades UNKNOWN/health-slow, running=unknown — not an outage" "rc=$rc out=$out"
fi
if [[ "$rc" == "0" && "$(alerts)" == "0" ]]; then
  ok "47c: health-slow never escalates (unclassified reason, same posture as remote-unreachable)"
else
  fail "47c: health-slow never escalates (unclassified reason, same posture as remote-unreachable)" "rc=$rc alerts=$(alerts)"
fi
if grep -qE "last_known=${MASTER_SHA:0:12} last_known_age_s=[0-9]+" <<<"$out"; then
  ok "47d: last known running sha/age carried forward instead of running=none"
else
  fail "47d: last known running sha/age carried forward instead of running=none" "out=$out"
fi

# 48. Genuine refusal (nothing listening on the port — curl exit 7) is
#     UNCHANGED: still status=DRIFT reason=untracked-or-unreachable:unreachable,
#     running=none — the timeout grading above must not soften a real outage.
REFUSED_PORT=$(( 29000 + RANDOM % 5000 ))
reset; set_activated "$MASTER_SHA"
out=$(TEST_HEALTH_URL="http://127.0.0.1:$REFUSED_PORT/api/health" run_check); rc=$?
if grep -q "status=DRIFT reason=untracked-or-unreachable:unreachable" <<<"$out" && grep -q "running=none" <<<"$out"; then
  ok "48: a genuinely refused connection still reports unreachable, running=none (unchanged)"
else
  fail "48: a genuinely refused connection still reports unreachable, running=none (unchanged)" "rc=$rc out=$out"
fi

# --- script-drift axis (AUR-6177, follow-up to AUR-4692/AUR-5648) ----------
# Standalone /usr/local/sbin monitor scripts run independent of the app
# release pipeline, so unit-drift's own installer-artifact compare never
# touches them — AUR-4692 found paperclip-mem-watch-alert.sh itself stale
# with no detector watching it, and paperclip-oom-guard.sh had no repo
# canonical source at all. These cases mirror the unit-drift axis cases
# above (34-39): FIRE on a genuinely stale/missing installed script, PASS on
# a current one, and confirm the axis is opt-in.

SCRIPT_SRC_REL="scripts/paperclip-fixture-guard.sh"
SCRIPT_REL_DIR="$APP/current/scripts"
mkdir -p "$SCRIPT_REL_DIR"
printf 'release copy content\n' > "$APP/current/$SCRIPT_SRC_REL"
SCRIPT_INSTALLED="$TMP/installed-fixture-guard.sh"
SD_LOG="$LOG.script-fixture"
SD_STATE="$STATE.script-fixture"

run_check_script() {
  PAPERCLIP_DRIFT_SCRIPTS="fixture:$SCRIPT_SRC_REL:$SCRIPT_INSTALLED" run_check
}

# 47. PASS: installed copy byte-identical to the active release's own copy
#     reports ok and pages no one.
printf 'release copy content\n' > "$SCRIPT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"; clear_ad_state
rm -f "$SD_LOG" "$SD_STATE"
out=$(run_check_script); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "script=fixture .*status=ok" <<<"$out"; then
  ok "script content matching the active release reports ok and exits 0"
else
  fail "script content matching the active release reports ok and exits 0" "rc=$rc alerts=$(alerts) out=$out"
fi

# 48. FIRE (below threshold): installed copy diverges from the active
#     release's copy. Seeded at 3h — below the 24h script-debt threshold, so
#     it drifts (nonzero exit) but does not yet page.
printf 'HAND-EDITED content, never reinstalled\n' > "$SCRIPT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$SD_LOG"; : > "$SD_STATE"
now=$(date -u +%s)
stamp=$(date -u -d "@$(( now - 3 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s script=fixture installed=%s status=DRIFT reason=script-behind:fixture\n' \
  "$stamp" "$SCRIPT_INSTALLED" >> "$SD_LOG"
out=$(run_check_script); rc=$?
if [[ "$rc" == "1" && "$(alerts)" == "0" ]] && grep -q "reason=script-behind:fixture" <<<"$out"; then
  ok "script content behind the active release for 3h drifts but does not page"
else
  fail "script content behind the active release for 3h drifts but does not page" "rc=$rc alerts=$(alerts) out=$out"
fi

# 49. FIRE (sustained past threshold): left behind for 30h, it pages, naming
#     the script, at INFO severity (AUR-5355 posture: same fleet-internal
#     debt character as unit-debt/checkout-debt, not a founder-actionable
#     page).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$SD_LOG"; : > "$SD_STATE"
stamp=$(date -u -d "@$(( now - 30 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '%s script=fixture installed=%s status=DRIFT reason=script-behind:fixture\n' \
  "$stamp" "$SCRIPT_INSTALLED" >> "$SD_LOG"
out=$(run_check_script); rc=$?
if [[ "$(alerts)" == "1" ]] && grep -q "script-behind:fixture" "$SINK"; then
  ok "script content behind the active release for 30h pages, naming the script"
else
  fail "script content behind the active release for 30h pages, naming the script" "rc=$rc alerts=$(alerts) sink=$(cat "$SINK" 2>/dev/null) out=$out"
fi
if grep -q "^INFO .*script-behind:fixture" "$SINK" && ! grep -q "^SEV2 " "$SINK"; then
  ok "script-debt (script-behind) escalates at INFO, not SEV2"
else
  fail "script-debt (script-behind) escalates at INFO, not SEV2" "sink=$(cat "$SINK" 2>/dev/null)"
fi

# 50. FIRE (missing): the installed script is absent entirely — a real
#     MISSING status, not a skip, since the manifest names a definitive
#     expected location.
rm -f "$SCRIPT_INSTALLED"
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
: > "$SD_LOG"; : > "$SD_STATE"
out=$(run_check_script); rc=$?
if [[ "$rc" == "1" ]] && grep -q "script=fixture .*status=DRIFT reason=script-missing:fixture" <<<"$out"; then
  ok "missing installed script reports script-missing, not a skip"
else
  fail "missing installed script reports script-missing, not a skip" "rc=$rc out=$out"
fi

# 51. A manifest line whose active-release source copy does not exist is
#     reported and skipped (not alarmed) — nothing to prove drift against,
#     same posture as an unreachable checkout (case 24) / missing unit
#     source (case 38).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(PAPERCLIP_DRIFT_SCRIPTS="ghost:scripts/does-not-exist.sh:$TMP/whatever" run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && grep -q "active release copy .*does-not-exist.sh not found, skipping" <<<"$out"; then
  ok "missing active-release source copy is skipped, not alarmed"
else
  fail "missing active-release source copy is skipped, not alarmed" "rc=$rc alerts=$(alerts) out=$out"
fi

# 52. Feature off by default: no PAPERCLIP_DRIFT_SCRIPTS, no script lines,
#     exit still 0 on a converged deploy — opt-in for the same reason as
#     PAPERCLIP_DRIFT_CHECKOUTS/UNITS/TIMERS (cases 25/39/46).
reset; set_health_release "$MASTER_SHA"; set_activated "$MASTER_SHA"
out=$(run_check); rc=$?
if [[ "$rc" == "0" && "$(alerts)" == "0" ]] && ! grep -q "script=" <<<"$out"; then
  ok "empty script list disables the axis entirely"
else
  fail "empty script list disables the axis entirely" "rc=$rc alerts=$(alerts) out=$out"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "check-deploy-drift escalation: all cases passed"
  exit 0
fi
echo "check-deploy-drift escalation: $FAILURES case(s) failed"
exit 1
