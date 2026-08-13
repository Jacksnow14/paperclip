#!/usr/bin/env bash
# AUR-5095: behavioural probes for the crash-loop bound + failover.
#
# The verification bar (artifact-provenance doctrine): a guard is proven only
# by one FIRING case and one PASSING case, both against real systemd
# semantics — a scratch `systemd --user` unit wearing the SAME structure as
# production (Restart=on-failure, RestartSec < StartLimitIntervalSec/Burst,
# OnFailure= wired to the real crash-loop-failover.sh), never a stubbed
# function. The real paperclip.service is NEVER touched; unit names embed $$.
#
# Cases:
#   A FIRE — broken release crash-loops, retries stop at StartLimitBurst,
#     failover flips `current` back, service comes healthy on the old release,
#     the failed sha is quarantined (marker + ledger), INFO (not SEV2) is sent.
#   B auto-deploy cannot re-arm the failed sha (ledger gate).
#   C auto-deploy cannot re-flip the failed RELEASE DIR even with the ledger
#     lost (startup-failed marker gate — the property, not the sha string).
#   D auto-deploy stage 2 refuses to restart into a marked release (ledger lost).
#   E PASS — a healthy start: no failover, no marker, no notification; a
#     manual failover invocation against the healthy unit is a no-op.
#   F ladder terminates — no valid rollback target => halt + SEV2, no flip;
#     a further crash-loop under our own halt does NOT page again.
#
# Run: bash scripts/deploy/crash-loop-failover.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
FAILOVER="$SCRIPT_DIR/crash-loop-failover.sh"
AUTODEPLOY="$SCRIPT_DIR/auto-deploy.sh"
[[ -f "$FAILOVER" && -f "$AUTODEPLOY" ]] || { echo "missing $FAILOVER / $AUTODEPLOY" >&2; exit 1; }

systemctl --user list-units >/dev/null 2>&1 || {
  echo "SKIP: no systemd --user manager reachable" >&2; exit 0; }

TMP=$(mktemp -d)
MUNIT="paperclip-crashloop-scratch-$$.service"
FUNIT="paperclip-failover-scratch-$$.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PORT=$(( 21000 + RANDOM % 9000 ))

ARTIFACTS=/tmp/aur5095-test-artifacts
cleanup() {
  # Keep the run's logs for post-mortem regardless of outcome.
  mkdir -p "$ARTIFACTS" 2>/dev/null
  cp -f "$TMP/failover.log" "$TMP/auto.log" "$TMP/tick.out" "$TMP/alerts.log" "$ARTIFACTS/" 2>/dev/null
  systemctl --user stop "$MUNIT" 2>/dev/null
  systemctl --user stop "$FUNIT" 2>/dev/null
  systemctl --user reset-failed "$MUNIT" "$FUNIT" 2>/dev/null
  rm -f "$UNIT_DIR/$MUNIT" "$UNIT_DIR/$FUNIT"
  systemctl --user daemon-reload 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- fixtures ----------------------------------------------------------------
# Fixture git remote: commits whose SHAs double as release identities (needed
# by the auto-deploy re-arm cases, which resolve master via ls-remote).
FIX="$TMP/remote"
git init -q --initial-branch=master "$FIX"
fixture_commit() {
  git -C "$FIX" -c user.email=t@example.com -c user.name=t \
    commit -q --allow-empty -m "$1"
  git -C "$FIX" rev-parse HEAD
}
SHA_G=$(fixture_commit "good release")
SHA_B=$(fixture_commit "bad release: crash-loops on start")
SHA_C=$(fixture_commit "second bad release")
G12=${SHA_G:0:12} B12=${SHA_B:0:12} C12=${SHA_C:0:12}
set_master() { git -C "$FIX" update-ref refs/heads/master "$1"; }

APP="$TMP/app"
mkdir -p "$APP/releases"

# ok releases serve /api/health with their OWN sha through pwd -P (same shape
# as production run-server.sh); broken releases log the attempt and exit 1 —
# the attempt log is how we prove the retry loop STOPPED at the burst limit.
make_release() { # <sha> ok|broken
  local dir="$APP/releases/${1:0:12}"
  mkdir -p "$dir"
  printf '{"sha":"%s"}' "$1" > "$dir/build-info.json"
  if [[ "$2" == ok ]]; then
    cat > "$dir/serve.py" <<'PY'
import http.server, json, os, socketserver
here = os.path.dirname(os.path.abspath(__file__))
info = json.load(open(os.path.join(here, "build-info.json")))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"status": "ok",
                           "build": {"source": "release", "sha": info["sha"]}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", int(os.environ["PORT"])), H) as s:
    s.serve_forever()
PY
    cat > "$dir/run.sh" <<'SH'
#!/usr/bin/env bash
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$HERE/serve.py"
SH
  else
    cat > "$dir/run.sh" <<'SH'
#!/usr/bin/env bash
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
echo "attempt $(date +%s.%N) $(basename "$HERE")" >> "$HERE/../../attempts.log"
echo "broken release refuses to start (simulated fatal migration)" >&2
exit 1
SH
  fi
  chmod +x "$dir/run.sh"
}
make_release "$SHA_G" ok
make_release "$SHA_B" broken
make_release "$SHA_C" broken

point_current()  { ln -sfn "releases/${1:0:12}" "$APP/current"; }
point_previous() { ln -sfn "releases/${1:0:12}" "$APP/previous"; }

STATE_DIR="$TMP/state"; mkdir -p "$STATE_DIR"
ALERTS="$TMP/alerts.log"; : > "$ALERTS"
ATTEMPTS="$APP/attempts.log"; : > "$ATTEMPTS"
FLOG="$TMP/failover.log"
NOTIFY="$TMP/notify.sh"
cat > "$NOTIFY" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ALERTS"
STUB
chmod +x "$NOTIFY"
set_state_running() { printf 'running_sha=%s\n' "$1" > "$STATE_DIR/auto-deploy.state"; }

# Scratch main unit: SAME structure as production paperclip.service + the
# AUR-5095 drop-in, time-scaled (RestartSec 1 < window 60 / burst 3, vs
# production 10 < 600 / 5). The structural property under test is identical:
# the window CAN accumulate the burst, and exhaustion fires OnFailure=.
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$MUNIT" <<EOF
[Unit]
Description=AUR-5095 scratch crash-loop target (test suite, safe to kill)
StartLimitIntervalSec=60
StartLimitBurst=3
OnFailure=$FUNIT
[Service]
Type=simple
ExecStart=/bin/bash $APP/current/run.sh
Environment=PORT=$PORT
Restart=on-failure
RestartSec=1
EOF
cat > "$UNIT_DIR/$FUNIT" <<EOF
[Unit]
Description=AUR-5095 scratch failover (test suite, safe to kill)
[Service]
Type=oneshot
TimeoutStartSec=120
ExecStart=/bin/bash $FAILOVER
Environment=PAPERCLIP_DEPLOY_APP_ROOT=$APP
Environment=PAPERCLIP_DEPLOY_UNIT=$MUNIT
Environment=PAPERCLIP_HEALTH_URL=http://127.0.0.1:$PORT/api/health
Environment=PAPERCLIP_DEPLOY_STATE_DIR=$STATE_DIR
Environment=PAPERCLIP_DEPLOY_LOCK_FILE=$TMP/lock
Environment=PAPERCLIP_FAILOVER_LOG=$FLOG
Environment=PAPERCLIP_DEPLOY_NOTIFY=$NOTIFY
Environment=PAPERCLIP_FAILOVER_HEALTH_TIMEOUT_SEC=20
Environment=PAPERCLIP_FAILOVER_HEALTH_POLL_SEC=1
Environment=PAPERCLIP_FAILOVER_LOCK_WAIT_SEC=5
Environment=PAPERCLIP_DEPLOY_SUDO=
EOF
systemctl --user daemon-reload

HEALTH="http://127.0.0.1:$PORT/api/health"
health_sha() { curl -sf -m 2 "$HEALTH" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["build"]["sha"])' 2>/dev/null || echo none; }
cur() { basename "$(readlink "$APP/current")"; }
unit_start_ts() { systemctl --user show "$1" -p ExecMainStartTimestampMonotonic --value; }
wait_for() { # $1=timeout_s, rest=cmd; polls at 0.5s
  local t=$(( $1 * 2 )); shift
  local i
  for (( i = 0; i < t; i++ )); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}
# A failover run holds the deploy lock for its whole lifetime; asserting its
# side effects (or running auto-deploy ticks, which flock -n the same file)
# while it is mid-flight races it. Barrier on the lock being acquirable.
wait_lock_free() { wait_for "${1:-30}" flock -n "$TMP/lock" true; }
run_tick() { # extra env as KEY=VAL args
  env "$@" \
    PAPERCLIP_DEPLOY_MIGRATION_GATE_CMD=true \
    PAPERCLIP_DEPLOY_APP_ROOT="$APP" \
    PAPERCLIP_DEPLOY_REMOTE="$FIX" \
    PAPERCLIP_HEALTH_URL="$HEALTH" \
    PAPERCLIP_DEPLOY_UNIT="$MUNIT" \
    PAPERCLIP_DEPLOY_STATE_DIR="$STATE_DIR" \
    PAPERCLIP_DEPLOY_LOCK_FILE="$TMP/lock" \
    PAPERCLIP_AUTO_DEPLOY_LOG="$TMP/auto.log" \
    PAPERCLIP_DEPLOY_NOTIFY="$NOTIFY" \
    PAPERCLIP_DEPLOY_BUILD_CMD=false \
    PAPERCLIP_DEPLOY_RUN_COUNTS_CMD="printf {\"running\":0,\"queued\":0,\"staleRunning\":[]}" \
    PAPERCLIP_DEPLOY_MEM_FLOOR_MB=0 \
    PAPERCLIP_DEPLOY_SUDO= \
    PAPERCLIP_DEPLOY_RM="rm -rf" \
    PAPERCLIP_DEPLOY_QUIESCE_INTERVAL_SEC=1 \
    PAPERCLIP_DEPLOY_HEALTH_TIMEOUT_SEC=6 \
    PAPERCLIP_DEPLOY_HEALTH_POLL_SEC=1 \
    bash "$AUTODEPLOY" >> "$TMP/tick.out" 2>&1
}

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

# ================================================================================
# A. FIRE: broken release B crash-loops -> retries stop at burst=3, failover
#    flips current back to G, service healthy on G, B quarantined, INFO sent.
set_state_running "$SHA_G"
point_previous "$SHA_G"
point_current "$SHA_B"
systemctl --user start "$MUNIT" 2>/dev/null
if wait_for 45 bash -c "[[ \$(readlink '$APP/current') == releases/$G12 ]]" \
   && wait_for 15 bash -c "[[ \$(curl -sf -m 2 '$HEALTH' | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"build\"][\"sha\"])') == $SHA_G ]]"; then
  ok "A: failover flipped current back to $G12 and the service is healthy on it"
else
  fail "A: failover flipped current back to $G12 and the service is healthy on it" \
    "current=$(cur) health=$(health_sha) flog: $(tail -3 "$FLOG" 2>/dev/null | tr '\n' '|')"
fi
# Barrier: the failover oneshot must have FINISHED (INFO written, lock freed)
# before its side effects are judged or ticks run.
wait_for 30 bash -c "grep -q '^INFO ' '$ALERTS'" || true
wait_lock_free 30 || true
attempts=$(wc -l < "$ATTEMPTS")
[[ "$attempts" == 3 ]] \
  && ok "A: retry loop STOPPED at StartLimitBurst (3 start attempts, not 15-forever)" \
  || fail "A: retry loop STOPPED at StartLimitBurst (3 start attempts, not 15-forever)" "attempts=$attempts"
systemctl --user is-active --quiet "$MUNIT" \
  && ok "A: unit is active after failover (not left dead)" \
  || fail "A: unit is active after failover (not left dead)" "$(systemctl --user is-active "$MUNIT")"
[[ -e "$APP/releases/$B12/startup-failed" ]] \
  && ok "A: failed release dir carries the startup-failed marker" \
  || fail "A: failed release dir carries the startup-failed marker" "no marker in releases/$B12"
grep -q "^$SHA_B startup-crash-loop" "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null \
  && ok "A: failed sha is in the auto-deploy quarantine ledger" \
  || fail "A: failed sha is in the auto-deploy quarantine ledger" "$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null)"
if grep -q "^INFO .*SELF-RECOVERED" "$ALERTS" && ! grep -q "^SEV" "$ALERTS"; then
  ok "A: self-recovery notified at INFO, no SEV page (Telegram doctrine)"
else
  fail "A: self-recovery notified at INFO, no SEV page (Telegram doctrine)" "$(cat "$ALERTS")"
fi
[[ ! -f "$STATE_DIR/auto-deploy.halt" ]] \
  && ok "A: successful failover leaves NO halt file (auto-deploy keeps running)" \
  || fail "A: successful failover leaves NO halt file (auto-deploy keeps running)" "$(cat "$STATE_DIR/auto-deploy.halt")"

# ================================================================================
# B. auto-deploy cannot re-arm the failed sha: ledger gate (live today).
set_master "$SHA_B"
run_tick
if [[ "$(cur)" == "$G12" ]] && grep -q "arm skipped: master $SHA_B is quarantined" "$TMP/auto.log"; then
  ok "B: quarantine ledger stops stage 1 from re-arming the failed sha"
else
  fail "B: quarantine ledger stops stage 1 from re-arming the failed sha" \
    "current=$(cur) log: $(tail -3 "$TMP/auto.log" | tr '\n' '|')"
fi

# ================================================================================
# C. Ledger LOST: the startup-failed marker still refuses the flip — the gate
#    is on the property of the artifact, not the sha string.
rm -f "$STATE_DIR/auto-deploy.quarantine"
run_tick
if [[ "$(cur)" == "$G12" ]] && grep -q "arm REFUSED: releases/$B12 carries a startup-failed marker" "$TMP/auto.log"; then
  ok "C: startup-failed marker refuses the flip with the ledger gone"
else
  fail "C: startup-failed marker refuses the flip with the ledger gone" \
    "current=$(cur) log: $(tail -3 "$TMP/auto.log" | tr '\n' '|')"
fi
grep -q "^$SHA_B startup-failed-marker" "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null \
  && ok "C: marker re-seeds the lost ledger entry" \
  || fail "C: marker re-seeds the lost ledger entry" "$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null)"

# ================================================================================
# D. Stage 2 with the ledger lost: current armed at a MARKED release while the
#    old server still runs -> restart is refused by the marker clause.
rm -f "$STATE_DIR/auto-deploy.quarantine"
point_current "$SHA_B"          # G's server keeps serving (pwd -P pinned)
ts0=$(unit_start_ts "$MUNIT")
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1
if [[ "$(unit_start_ts "$MUNIT")" == "$ts0" ]] \
   && grep -q "REFUSING restart: activated sha $SHA_B is quarantined or marked startup-failed" "$TMP/auto.log"; then
  ok "D: stage 2 refuses to restart into a startup-failed release (ledger lost)"
else
  fail "D: stage 2 refuses to restart into a startup-failed release (ledger lost)" \
    "log: $(tail -3 "$TMP/auto.log" | tr '\n' '|')"
fi
point_current "$SHA_G"

# ================================================================================
# E. PASS: a normal healthy start is completely unaffected — no failover run,
#    no marker, no notification; manual failover invocation is a no-op.
wait_lock_free 15 || true
systemctl --user stop "$MUNIT" 2>/dev/null
systemctl --user reset-failed "$MUNIT" 2>/dev/null
: > "$ALERTS"
fts0=$(unit_start_ts "$FUNIT")
systemctl --user start "$MUNIT"
if wait_for 15 bash -c "[[ \$(curl -sf -m 2 '$HEALTH' | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"build\"][\"sha\"])') == $SHA_G ]]"; then
  sleep 4   # give a spurious OnFailure/notification time to appear
  if [[ "$(unit_start_ts "$FUNIT")" == "$fts0" && ! -s "$ALERTS" \
        && ! -e "$APP/releases/$G12/startup-failed" && "$(cur)" == "$G12" ]]; then
    ok "E: healthy start — no failover fired, no notification, no marker, no flip"
  else
    fail "E: healthy start — no failover fired, no notification, no marker, no flip" \
      "fts=$(unit_start_ts "$FUNIT") vs $fts0 alerts=$(cat "$ALERTS") current=$(cur)"
  fi
else
  fail "E: healthy start — no failover fired, no notification, no marker, no flip" "unit never came healthy on $G12"
fi
out=$(env PAPERCLIP_DEPLOY_APP_ROOT="$APP" PAPERCLIP_DEPLOY_UNIT="$MUNIT" \
  PAPERCLIP_HEALTH_URL="$HEALTH" PAPERCLIP_DEPLOY_STATE_DIR="$STATE_DIR" \
  PAPERCLIP_DEPLOY_LOCK_FILE="$TMP/lock" PAPERCLIP_FAILOVER_LOG="$FLOG" \
  PAPERCLIP_DEPLOY_NOTIFY="$NOTIFY" PAPERCLIP_DEPLOY_SUDO= \
  bash "$FAILOVER" 2>&1); rc=$?
if [[ "$rc" == 0 && "$(cur)" == "$G12" ]] && grep -q "no-op" <<<"$out"; then
  ok "E: manual failover invocation against a healthy unit is an inert no-op"
else
  fail "E: manual failover invocation against a healthy unit is an inert no-op" "rc=$rc out=$out"
fi

# ================================================================================
# F. Ladder terminates: every candidate invalid (marked/identical) -> NO flip,
#    halt + SEV2; a further crash-loop under our own halt does not page again.
wait_lock_free 15 || true
systemctl --user stop "$MUNIT" 2>/dev/null
systemctl --user reset-failed "$MUNIT" 2>/dev/null
: > "$ALERTS"; : > "$ATTEMPTS"
set_state_running "$SHA_B"      # marked in A -> invalid candidate
point_previous "$SHA_B"         # marked in A -> invalid candidate
point_current "$SHA_C"
systemctl --user start "$MUNIT" 2>/dev/null
if wait_for 45 bash -c "grep -q '^SEV2 .*NO valid rollback target' '$ALERTS'"; then
  ok "F: no valid rollback target -> SEV2 (control plane still down is a page)"
else
  fail "F: no valid rollback target -> SEV2 (control plane still down is a page)" "$(cat "$ALERTS")"
fi
[[ "$(cur)" == "$C12" ]] \
  && ok "F: with no valid target the failover does NOT flip current (no blind ladder)" \
  || fail "F: with no valid target the failover does NOT flip current (no blind ladder)" "current=$(cur)"
grep -q "AUR-5095" "$STATE_DIR/auto-deploy.halt" 2>/dev/null \
  && ok "F: failed recovery writes the auto-deploy halt file (automation stops)" \
  || fail "F: failed recovery writes the auto-deploy halt file (automation stops)" "$(ls "$STATE_DIR" 2>/dev/null)"
[[ -e "$APP/releases/$C12/startup-failed" ]] \
  && ok "F: the second failed release is marked too" \
  || fail "F: the second failed release is marked too" "no marker in releases/$C12"
wait_lock_free 15 || true
sev_before=$(grep -c "^SEV" "$ALERTS")
systemctl --user reset-failed "$MUNIT" 2>/dev/null
systemctl --user start "$MUNIT" 2>/dev/null
sleep 8   # 3 attempts (~3s) + OnFailure firing + script run
sev_after=$(grep -c "^SEV" "$ALERTS")
if [[ "$sev_after" == "$sev_before" ]] && grep -q "SEV2 already sent" "$FLOG"; then
  ok "F: re-fire under our own halt does not page again (no SEV2 spam)"
else
  fail "F: re-fire under our own halt does not page again (no SEV2 spam)" \
    "sev_before=$sev_before sev_after=$sev_after flog: $(tail -2 "$FLOG" | tr '\n' '|')"
fi

# ================================================================================
echo
if (( FAILURES > 0 )); then
  echo "$FAILURES FAILURE(S)"
  exit 1
fi
echo "all checks passed"
