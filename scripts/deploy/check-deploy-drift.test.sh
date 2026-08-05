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
  PAPERCLIP_HEALTH_URL="file://$HEALTH" \
  PAPERCLIP_DEPLOY_REMOTE="$REMOTE_REPO" \
  PAPERCLIP_DEPLOY_APP_ROOT="$APP" \
  PAPERCLIP_DRIFT_LOG="$LOG" \
  PAPERCLIP_DRIFT_ALERT_STATE="$STATE" \
  PAPERCLIP_DRIFT_NOTIFY="$NOTIFY" \
  PAPERCLIP_AUTO_DEPLOY_STATE="$AD_STATE" \
  PAPERCLIP_DRIFT_GH="$GH" \
  PAPERCLIP_DRIFT_REPO="owner/repo" \
  PAPERCLIP_DRIFT_MERGE_DEBT_RECHECK_DELAY_SEC=0 \
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

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "check-deploy-drift escalation: all cases passed"
  exit 0
fi
echo "check-deploy-drift escalation: $FAILURES case(s) failed"
exit 1
