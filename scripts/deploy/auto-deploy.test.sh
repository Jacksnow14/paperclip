#!/usr/bin/env bash
# AUR-4028: behavioural probes for auto-deploy.sh — the AUR-3937 immutability
# suite is the bar: assert what the SERVICE actually did (restarted, stayed up,
# stayed broken), never what a function returned.
#
# Hermetic: scratch PAPERCLIP_DEPLOY_APP_ROOT under mktemp, a scratch
# `systemd --user` unit on a scratch loopback port, stub notifier, stub build
# command, injected run-counts. The real paperclip.service is NEVER touched;
# the scratch unit name embeds $$ so even a concurrent run cannot collide.
#
# Run: bash scripts/deploy/auto-deploy.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
AUTODEPLOY="$SCRIPT_DIR/auto-deploy.sh"
[[ -f "$AUTODEPLOY" ]] || { echo "missing $AUTODEPLOY" >&2; exit 1; }

# (is-system-running exits nonzero on a merely degraded manager; list-units
# only fails when the user manager is genuinely unreachable.)
systemctl --user list-units >/dev/null 2>&1 || {
  echo "SKIP: no systemd --user manager reachable" >&2; exit 0; }

TMP=$(mktemp -d)
UNIT="paperclip-deploy-scratch-$$.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"
PORT=$(( 21000 + RANDOM % 9000 ))

cleanup() {
  systemctl --user stop "$UNIT" 2>/dev/null
  systemctl --user reset-failed "$UNIT" 2>/dev/null
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- fixtures ----------------------------------------------------------------
# Fixture git remote: three commits whose SHAs double as release identities.
FIX="$TMP/remote"
git init -q --initial-branch=master "$FIX"
fixture_commit() {
  git -C "$FIX" -c user.email=t@example.com -c user.name=t \
    commit -q --allow-empty -m "$1"
  git -C "$FIX" rev-parse HEAD
}
SHA_G=$(fixture_commit "good old release")
SHA_B=$(fixture_commit "bad release")
SHA_N=$(fixture_commit "good new release")
G12=${SHA_G:0:12} B12=${SHA_B:0:12} N12=${SHA_N:0:12}
set_master() { git -C "$FIX" update-ref refs/heads/master "$1"; }

APP="$TMP/app"
mkdir -p "$APP/releases"

# make_release <sha> ok|broken — a release is a dir with build-info.json and a
# run.sh. The ok flavour serves /api/health with ITS OWN sha (resolved through
# the symlink with pwd -P, exactly like production run-server.sh, so a later
# `current` flip never changes what a running server reports). The broken
# flavour exits 1 immediately: the service genuinely does not come up.
make_release() {
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
echo "broken release refuses to start" >&2
exit 1
SH
  fi
  chmod +x "$dir/run.sh"
}
make_release "$SHA_G" ok
make_release "$SHA_B" broken
make_release "$SHA_N" ok

point_current() { ln -sfn "releases/${1:0:12}" "$APP/current"; }

STATE_DIR="$TMP/state"
ALERTS="$TMP/alerts.log"
BUILD_LOG="$TMP/build.log"
COUNTS="$TMP/counts.json"
NOTIFY="$TMP/notify.sh"
BUILD="$TMP/build.sh"
cat > "$NOTIFY" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ALERTS"
STUB
cat > "$BUILD" <<STUB
#!/usr/bin/env bash
printf 'build %s\n' "\$*" >> "$BUILD_LOG"
exit 1
STUB
chmod +x "$NOTIFY" "$BUILD"
set_counts() { printf '{"running":%s,"queued":%s,"staleRunning":[]}' "$1" "$2" > "$COUNTS"; }
set_counts 0 0

# Scratch --user unit, same launch shape as production (ExecStart through the
# `current` symlink).
mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=AUR-4028 scratch deploy target (test suite, safe to kill)
[Service]
Type=simple
ExecStart=/bin/bash $APP/current/run.sh
Environment=PORT=$PORT
Restart=no
EOF
systemctl --user daemon-reload

HEALTH="http://127.0.0.1:$PORT/api/health"
health_sha() { curl -sf -m 2 "$HEALTH" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["build"]["sha"])' 2>/dev/null || echo none; }
unit_start_ts() { systemctl --user show "$UNIT" -p ExecMainStartTimestampMonotonic --value; }
state_get() { awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$STATE_DIR/auto-deploy.state" 2>/dev/null; }
wait_sha() { # $1=sha $2=timeout
  local i
  for (( i = 0; i < ${2:-10} * 2; i++ )); do
    [[ "$(health_sha)" == "$1" ]] && return 0
    sleep 0.5
  done
  return 1
}

run_tick() { # extra env as KEY=VAL args
  # AUR-5019: the migration gate defaults to a pass-through stub (`true`) so the
  # pre-gate cases keep asserting their own concern; the J cases point GATE_CMD
  # at a scripted stub to drive block/infra/pass outcomes.
  #
  # PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED is pinned OFF here (production
  # default is ON) so cases A-J, several of which deliberately leave the
  # scratch unit health-unreachable (D/F), stay exactly as they were before
  # the health self-heal feature existed. The K cases below opt back in
  # explicitly, same pattern as PAPERCLIP_AUTO_RESTART_ENABLED above.
  #
  # "$@" MUST come last: env(1) applies same-name VAR=VAL assignments in
  # order with the last one winning, so a caller override placed before the
  # fixed defaults below would be silently clobbered by them.
  env \
    PAPERCLIP_DEPLOY_MIGRATION_GATE_CMD="${GATE_CMD:-true}" \
    PAPERCLIP_DEPLOY_APP_ROOT="$APP" \
    PAPERCLIP_DEPLOY_REMOTE="$FIX" \
    PAPERCLIP_HEALTH_URL="$HEALTH" \
    PAPERCLIP_DEPLOY_UNIT="$UNIT" \
    PAPERCLIP_DEPLOY_STATE_DIR="$STATE_DIR" \
    PAPERCLIP_DEPLOY_LOCK_FILE="$TMP/lock" \
    PAPERCLIP_AUTO_DEPLOY_LOG="$TMP/auto.log" \
    PAPERCLIP_DEPLOY_NOTIFY="$NOTIFY" \
    PAPERCLIP_DEPLOY_BUILD_CMD="$BUILD" \
    PAPERCLIP_DEPLOY_RUN_COUNTS_CMD="cat $COUNTS" \
    PAPERCLIP_DEPLOY_MEM_FLOOR_MB=0 \
    PAPERCLIP_DEPLOY_SUDO= \
    PAPERCLIP_DEPLOY_RM="rm -rf" \
    PAPERCLIP_DEPLOY_QUIESCE_INTERVAL_SEC=1 \
    PAPERCLIP_DEPLOY_HEALTH_TIMEOUT_SEC=6 \
    PAPERCLIP_DEPLOY_HEALTH_POLL_SEC=1 \
    PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=0 \
    PAPERCLIP_HEALTH_PROBE_TIMEOUT_SEC=2 \
    PAPERCLIP_HEALTH_PROBE_RETRIES=3 \
    PAPERCLIP_HEALTH_PROBE_BACKOFF_SEC=0.2 \
    "$@" \
    bash "$AUTODEPLOY" >> "$TMP/tick.out" 2>&1
}

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

# --- baseline: scratch unit healthy on G ---------------------------------------
point_current "$SHA_G"
systemctl --user start "$UNIT"
wait_sha "$SHA_G" 10 || { echo "FATAL: scratch unit never came healthy on $G12" >&2; exit 1; }

# ================================================================================
# A. Dark by default: armed release + quiescent box + NO flag -> no restart.
#    This is the landing state ("Stage 2 gated off by default"), asserted
#    behaviourally so nobody can arm it by accident.
set_master "$SHA_N"; point_current "$SHA_N"; set_counts 0 0
ts0=$(unit_start_ts)
run_tick; rc=$?
if [[ "$(unit_start_ts)" == "$ts0" && "$(health_sha)" == "$SHA_G" && "$rc" == 0 ]]; then
  ok "A: restart is OFF by default — armed + quiescent still means no restart"
else
  fail "A: restart is OFF by default — armed + quiescent still means no restart" "rc=$rc sha=$(health_sha)"
fi
[[ "$(state_get phase)" == "restart-disabled" ]] \
  && ok "A: state file says restart-disabled (drift detector reads dark-armed)" \
  || fail "A: state file says restart-disabled (drift detector reads dark-armed)" "phase=$(state_get phase)"

# ================================================================================
# B. Quiescence: injected running>0 -> the unit's start timestamp is UNCHANGED.
set_counts 2 0
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1
if [[ "$(unit_start_ts)" == "$ts0" && "$(health_sha)" == "$SHA_G" ]]; then
  ok "B: running=2 blocks the restart (unit untouched)"
else
  fail "B: running=2 blocks the restart (unit untouched)" "sha=$(health_sha)"
fi
[[ "$(state_get phase)" == "awaiting-quiescence" && "$(state_get running_count)" == "2" ]] \
  && ok "B: state reports awaiting-quiescence with the running count" \
  || fail "B: state reports awaiting-quiescence with the running count" "$(cat "$STATE_DIR/auto-deploy.state" 2>/dev/null)"
w1=$(state_get waiting_since)
sleep 1.1
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1
[[ "$(state_get waiting_since)" == "$w1" && -n "$w1" ]] \
  && ok "B: waiting_since survives across ticks (drift detector measures the wait)" \
  || fail "B: waiting_since survives across ticks (drift detector measures the wait)" "w1=$w1 w2=$(state_get waiting_since)"

# ...and with running=0 the same tick DOES restart, into the armed sha.
set_counts 0 0
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1; rc=$?
if [[ "$(unit_start_ts)" != "$ts0" ]] && wait_sha "$SHA_N" 5 && [[ "$rc" == 0 ]]; then
  ok "B: running=0 across two samples restarts into the armed sha ($N12)"
else
  fail "B: running=0 across two samples restarts into the armed sha ($N12)" "rc=$rc sha=$(health_sha)"
fi

# ================================================================================
# C. Queued does NOT block: queued=7, running=0 -> restart proceeds. This
#    encodes the AUR-4020 decision so a later reader cannot "fix" it back.
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 0 7
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1; rc=$?
if [[ "$(unit_start_ts)" != "$ts0" ]] && wait_sha "$SHA_G" 5 && [[ "$rc" == 0 ]]; then
  ok "C: queued=7 does not block — restart proceeded (queued runs survive a restart)"
else
  fail "C: queued=7 does not block — restart proceeded (queued runs survive a restart)" "rc=$rc sha=$(health_sha)"
fi

# ================================================================================
# C2. Quiescence deadline (AUR-5178): on a cap-saturated host running==0 is
#     unsatisfiable, so the wait must TERMINATE. Three probes: no premature
#     fire, deadline-forced restart (with the armed sha having CHANGED since
#     the wait began — the clock must not reset per-sha), and the 0 opt-out.
# C2a: running=4, wait just started, deadline far away -> no restart, and the
#      state note names the pending deadline.
set_master "$SHA_N"; point_current "$SHA_N"; set_counts 4 9
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1 PAPERCLIP_DEPLOY_QUIESCE_DEADLINE_SEC=3600; rc=$?
if [[ "$(unit_start_ts)" == "$ts0" && "$(health_sha)" == "$SHA_G" && "$rc" == 0 ]]; then
  ok "C2a: saturated but within deadline — no restart"
else
  fail "C2a: saturated but within deadline — no restart" "rc=$rc sha=$(health_sha)"
fi
[[ "$(state_get phase)" == "awaiting-quiescence" ]] && state_get note | grep -q "force in" \
  && ok "C2a: state note carries the remaining time to the forced restart" \
  || fail "C2a: state note carries the remaining time to the forced restart" "$(cat "$STATE_DIR/auto-deploy.state" 2>/dev/null)"

# C2b: the wait began 2h ago under a DIFFERENT armed sha; still saturated.
#      Deadline 60s long passed -> the tick restarts anyway and the health
#      gate confirms the armed sha. This is the saturated-cap termination case.
cat > "$STATE_DIR/auto-deploy.state" <<EOF
last_tick=$(date -u +%Y-%m-%dT%H:%M:%SZ)
phase=awaiting-quiescence
armed_sha=$SHA_G
running_sha=$SHA_G
running_count=4
queued_count=9
stale_discounted=-
waiting_since=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
restart_enabled=1
note=-
EOF
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1 PAPERCLIP_DEPLOY_QUIESCE_DEADLINE_SEC=60; rc=$?
if [[ "$(unit_start_ts)" != "$ts0" ]] && wait_sha "$SHA_N" 5 && [[ "$rc" == 0 ]]; then
  ok "C2b: deadline exceeded while saturated — restart forced, armed sha live ($N12)"
else
  fail "C2b: deadline exceeded while saturated — restart forced, armed sha live ($N12)" "rc=$rc sha=$(health_sha)"
fi
grep -q "quiescence deadline EXCEEDED" "$TMP/auto.log" \
  && ok "C2b: the forced restart is named in the log (running count and wait included)" \
  || fail "C2b: the forced restart is named in the log (running count and wait included)" "$(tail -3 "$TMP/auto.log" 2>/dev/null)"

# C2c: NEGATIVE CONTROL — identical aged wait, deadline=0 (opt-out) -> the
#      gate waits forever again. Without this, C2b proves only that a restart
#      can happen, not that the deadline is what forced it.
cat > "$STATE_DIR/auto-deploy.state" <<EOF
last_tick=$(date -u +%Y-%m-%dT%H:%M:%SZ)
phase=awaiting-quiescence
armed_sha=$SHA_N
running_sha=$SHA_N
running_count=4
queued_count=9
stale_discounted=-
waiting_since=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
restart_enabled=1
note=-
EOF
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 4 9
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1 PAPERCLIP_DEPLOY_QUIESCE_DEADLINE_SEC=0; rc=$?
if [[ "$(unit_start_ts)" == "$ts0" && "$rc" == 0 && "$(state_get phase)" == "awaiting-quiescence" ]]; then
  ok "C2c: NEGATIVE CONTROL — deadline=0 keeps the pre-AUR-5178 wait-forever behavior"
else
  fail "C2c: NEGATIVE CONTROL — deadline=0 keeps the pre-AUR-5178 wait-forever behavior" "rc=$rc phase=$(state_get phase)"
fi

# restore the pre-D world: unit healthy on G (D asserts a rollback INTO G)
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 0 0
systemctl --user restart "$UNIT"
wait_sha "$SHA_G" 10 || { echo "FATAL: scratch unit did not return to $G12 after C2" >&2; exit 1; }

# ================================================================================
# D. Rollback: an unhealthy release -> the unit ends up running the PREVIOUS
#    sha, healthy, and the bad sha is quarantined.
set_master "$SHA_B"; point_current "$SHA_B"; set_counts 0 0; : > "$ALERTS"
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1; rc=$?
if wait_sha "$SHA_G" 5 && systemctl --user is-active --quiet "$UNIT"; then
  ok "D: broken release $B12 rolled back — unit healthy on previous sha $G12"
else
  fail "D: broken release $B12 rolled back — unit healthy on previous sha $G12" "rc=$rc sha=$(health_sha)"
fi
[[ "$(readlink "$APP/current")" == "releases/$G12" ]] \
  && ok "D: current repointed back to the rollback target" \
  || fail "D: current repointed back to the rollback target" "current=$(readlink "$APP/current")"
grep -q "^$SHA_B failed-health-gate" "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null \
  && ok "D: bad sha quarantined (no good/bad flapping every 10 minutes)" \
  || fail "D: bad sha quarantined (no good/bad flapping every 10 minutes)" "quarantine=$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null)"
grep -q "ROLLED BACK" "$ALERTS" && [[ "$rc" != 0 ]] \
  && ok "D: rollback escalated (SEV2) and the tick exits nonzero" \
  || fail "D: rollback escalated (SEV2) and the tick exits nonzero" "rc=$rc alerts=$(cat "$ALERTS")"

# ================================================================================
# E. Quarantine holds: the rolled-back sha is NOT re-armed on the next tick.
#    master still points at B; the build stub must not be invoked.
rm -f "$BUILD_LOG"
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1; rc=$?
if [[ ! -s "$BUILD_LOG" ]] && grep -q "arm skipped: master $SHA_B is quarantined" "$TMP/auto.log"; then
  ok "E: quarantined sha is not re-armed on the following tick"
else
  fail "E: quarantined sha is not re-armed on the following tick" "rc=$rc build_log=$(cat "$BUILD_LOG" 2>/dev/null)"
fi
[[ "$(health_sha)" == "$SHA_G" ]] \
  && ok "E: production untouched while master tip is quarantined" \
  || fail "E: production untouched while master tip is quarantined" "sha=$(health_sha)"

# ================================================================================
# F. NEGATIVE CONTROL: same unhealthy release, rollback DISABLED -> the unit
#    stays genuinely broken. Without this, test D proves only that a service
#    can start — not that the rollback is what saved it.
: > "$STATE_DIR/auto-deploy.quarantine"   # D quarantined B; clear so the gate is reached
point_current "$SHA_B"; set_counts 0 0; : > "$ALERTS"
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1 PAPERCLIP_AUTO_ROLLBACK_ENABLED=0; rc=$?
sleep 1
if [[ "$(health_sha)" == "none" ]] && ! systemctl --user is-active --quiet "$UNIT"; then
  ok "F: NEGATIVE CONTROL — without rollback the service stays down (health unreachable, unit not active)"
else
  fail "F: NEGATIVE CONTROL — without rollback the service stays down (health unreachable, unit not active)" "sha=$(health_sha) active=$(systemctl --user is-active "$UNIT")"
fi
[[ "$(readlink "$APP/current")" == "releases/$B12" && "$rc" != 0 ]] \
  && ok "F: current still points at the broken release; tick exits nonzero" \
  || fail "F: current still points at the broken release; tick exits nonzero" "rc=$rc current=$(readlink "$APP/current")"
[[ "$(state_get phase)" == "restart-failed-rollback-disabled" ]] \
  && ok "F: state file names the failure instead of pretending" \
  || fail "F: state file names the failure instead of pretending" "phase=$(state_get phase)"

# recover the scratch unit for the remaining cases
point_current "$SHA_G"
systemctl --user reset-failed "$UNIT" 2>/dev/null
systemctl --user restart "$UNIT"
wait_sha "$SHA_G" 10 || { echo "FATAL: scratch unit did not recover" >&2; exit 1; }

# ================================================================================
# G. Missing rollback target: the running sha's release dir is gone (pruning
#    can legitimately do this) -> REFUSE to restart, escalate, production up.
set_master "$SHA_N"; point_current "$SHA_N"; set_counts 0 0; : > "$ALERTS"
mv "$APP/releases/$G12" "$TMP/parked-$G12"
ts0=$(unit_start_ts)
run_tick PAPERCLIP_AUTO_RESTART_ENABLED=1; rc=$?
if [[ "$(unit_start_ts)" == "$ts0" && "$(health_sha)" == "$SHA_G" && "$rc" != 0 ]]; then
  ok "G: missing rollback target refuses the restart — production stays up"
else
  fail "G: missing rollback target refuses the restart — production stays up" "rc=$rc sha=$(health_sha)"
fi
grep -q "rollback target releases/$G12" "$ALERTS" \
  && ok "G: refusal escalated with the missing path named" \
  || fail "G: refusal escalated with the missing path named" "alerts=$(cat "$ALERTS")"
[[ "$(state_get phase)" == "refused-missing-rollback-target" ]] \
  && ok "G: state file names the refusal" \
  || fail "G: state file names the refusal" "phase=$(state_get phase)"
mv "$TMP/parked-$G12" "$APP/releases/$G12"

# ================================================================================
# H. Build backoff: 3 failed builds of one sha -> quarantine + SEV2, and the
#    4th tick does NOT try again (no 3GB build attempt every 10 min forever).
#    The sha must have NO complete release on disk: one that does is armed by
#    the flip-only resume path without any build (asserted in I1).
SHA_H=$(fixture_commit "never built release")
point_current "$SHA_G"; set_master "$SHA_H"; : > "$ALERTS"; rm -f "$BUILD_LOG"
rm -f "$STATE_DIR/auto-deploy.quarantine" "$STATE_DIR/auto-deploy.build-failures"
for i in 1 2 3 4; do run_tick; done
builds=$(wc -l < "$BUILD_LOG" 2>/dev/null || echo 0)
if [[ "$builds" == "3" ]] && grep -q "^$SHA_H auto-arm-build-failed" "$STATE_DIR/auto-deploy.quarantine"; then
  ok "H: 3 failed builds quarantine the sha; tick 4 does not rebuild"
else
  fail "H: 3 failed builds quarantine the sha; tick 4 does not rebuild" "builds=$builds quarantine=$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null)"
fi
grep -q "auto-arm-build-failed" "$ALERTS" \
  && ok "H: build quarantine escalated SEV2" \
  || fail "H: build quarantine escalated SEV2" "alerts=$(cat "$ALERTS")"

# ================================================================================
# I. Arm goes through the safety wrapper (AUR-4155/AUR-4029 world) and the flip
#    is auto-deploy's own.
# I1: a COMPLETE release already on disk (build-info.json sha matches) is
#     flipped without invoking the build wrapper at all, and stays dark.
rm -f "$STATE_DIR/auto-deploy.quarantine" "$STATE_DIR/auto-deploy.build-failures"
point_current "$SHA_G"; set_master "$SHA_N"; rm -f "$BUILD_LOG"; set_counts 0 0
ts0=$(unit_start_ts)
run_tick; rc=$?
if [[ "$(readlink "$APP/current")" == "releases/$N12" && ! -s "$BUILD_LOG" \
      && "$(unit_start_ts)" == "$ts0" && "$rc" == 0 ]]; then
  ok "I1: complete release on disk is flipped without a rebuild, no restart (dark)"
else
  fail "I1: complete release on disk is flipped without a rebuild, no restart (dark)" \
    "rc=$rc current=$(readlink "$APP/current") build_log=$(cat "$BUILD_LOG" 2>/dev/null)"
fi

# I2: no release on disk -> build wrapper invoked with --build-only (NEVER
#     --activate: that is refused since AUR-4155), then auto-deploy flips.
SHA_I=$(fixture_commit "built via wrapper"); I12=${SHA_I:0:12}
cat > "$BUILD" <<STUB
#!/usr/bin/env bash
printf 'build %s\n' "\$*" >> "$BUILD_LOG"
sha=""
while [[ \$# -gt 0 ]]; do case "\$1" in --ref) sha="\$2"; shift 2 ;; *) shift ;; esac; done
d="$APP/releases/\${sha:0:12}"
mkdir -p "\$d"
cp "$APP/releases/$G12/serve.py" "$APP/releases/$G12/run.sh" "\$d/" 2>/dev/null
printf '{"sha":"%s"}' "\$sha" > "\$d/build-info.json"
STUB
set_master "$SHA_I"
ts0=$(unit_start_ts)
run_tick; rc=$?
if grep -q -- "--ref $SHA_I --build-only" "$BUILD_LOG" && ! grep -q -- "--activate" "$BUILD_LOG" \
   && [[ "$(readlink "$APP/current")" == "releases/$I12" && "$(unit_start_ts)" == "$ts0" && "$rc" == 0 ]]; then
  ok "I2: build via wrapper --build-only, flip is auto-deploy's own, still dark"
else
  fail "I2: build via wrapper --build-only, flip is auto-deploy's own, still dark" \
    "rc=$rc current=$(readlink "$APP/current") build_log=$(cat "$BUILD_LOG" 2>/dev/null)"
fi

# I3: a preflight/watchdog refusal from the wrapper is a busy BOX, not a bad
#     SHA: three refused ticks must not strike, quarantine, or page.
SHA_J=$(fixture_commit "refused by preflight")
cat > "$BUILD" <<STUB
#!/usr/bin/env bash
printf 'build %s\n' "\$*" >> "$BUILD_LOG"
echo "FATAL: preflight did not clear within 60s: mem_avail 1900MB < floor 2500MB" >&2
exit 1
STUB
set_master "$SHA_J"; : > "$ALERTS"; rm -f "$BUILD_LOG"
for i in 1 2 3; do run_tick; done
if ! grep -q "^$SHA_J " "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null && [[ ! -s "$ALERTS" ]] \
   && [[ "$(wc -l < "$BUILD_LOG")" == "3" ]]; then
  ok "I3: preflight refusals retry every tick — no strikes, no quarantine, no SEV2"
else
  fail "I3: preflight refusals retry every tick — no strikes, no quarantine, no SEV2" \
    "quarantine=$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null) alerts=$(cat "$ALERTS" 2>/dev/null) builds=$(wc -l < "$BUILD_LOG" 2>/dev/null)"
fi
grep -q "arm skipped: safe-deploy preflight/watchdog refused" "$TMP/auto.log" \
  && ok "I3: the skip is named in the log (not silently swallowed)" \
  || fail "I3: the skip is named in the log (not silently swallowed)" "$(tail -5 "$TMP/auto.log" 2>/dev/null)"

# I4: a PARTIAL release dir (no matching build-info.json — build died mid-way)
#     is cleared under the AUR-4134 guard and rebuilt, then flipped.
SHA_K=$(fixture_commit "partial then rebuilt"); K12=${SHA_K:0:12}
mkdir -p "$APP/releases/$K12"
touch "$APP/releases/$K12/half-written.tmp"
cat > "$BUILD" <<STUB
#!/usr/bin/env bash
printf 'build %s\n' "\$*" >> "$BUILD_LOG"
sha=""
while [[ \$# -gt 0 ]]; do case "\$1" in --ref) sha="\$2"; shift 2 ;; *) shift ;; esac; done
d="$APP/releases/\${sha:0:12}"
mkdir -p "\$d"
cp "$APP/releases/$G12/serve.py" "$APP/releases/$G12/run.sh" "\$d/" 2>/dev/null
printf '{"sha":"%s"}' "\$sha" > "\$d/build-info.json"
STUB
set_master "$SHA_K"; rm -f "$BUILD_LOG"
run_tick; rc=$?
if [[ ! -e "$APP/releases/$K12/half-written.tmp" && "$(readlink "$APP/current")" == "releases/$K12" && "$rc" == 0 ]] \
   && grep -q -- "--ref $SHA_K --build-only" "$BUILD_LOG"; then
  ok "I4: partial release dir cleared (guarded) and rebuilt, then flipped"
else
  fail "I4: partial release dir cleared (guarded) and rebuilt, then flipped" \
    "rc=$rc current=$(readlink "$APP/current") leftover=$(ls "$APP/releases/$K12" 2>/dev/null | tr '\n' ' ')"
fi

# ================================================================================
# J. AUR-5019 migration gate: stands between a complete build and the flip.
GATE_LOG="$TMP/gate.log"
GATE_STUB="$TMP/gate.sh"
cat > "$GATE_STUB" <<STUB
#!/usr/bin/env bash
# \$1 = exit code to simulate; remaining args are what auto-deploy passed.
rc="\$1"; shift
printf 'gate %s\n' "\$*" >> "$GATE_LOG"
echo "MIGRATION-GATE: stub exit \$rc"
exit "\$rc"
STUB
chmod +x "$GATE_STUB"

# J1: gate exit 2 (replay aborted) on a complete on-disk release -> NO flip,
#     sha quarantined as migration-gate-blocked, SEV2 paged, and crucially NOT
#     counted as a build failure (the build was fine).
SHA_L=$(fixture_commit "blocked by migration gate"); L12=${SHA_L:0:12}
make_release "$SHA_L" ok
point_current "$SHA_G"; set_master "$SHA_L"; set_counts 0 0
: > "$ALERTS"; rm -f "$BUILD_LOG" "$GATE_LOG" "$STATE_DIR/auto-deploy.build-failures"
GATE_CMD="$GATE_STUB 2" run_tick; rc=$?
if [[ "$(readlink "$APP/current")" == "releases/$G12" ]] \
   && grep -q "^$SHA_L migration-gate-blocked" "$STATE_DIR/auto-deploy.quarantine" \
   && grep -q "migration gate BLOCKED" "$ALERTS"; then
  ok "J1: gate exit 2 blocks the flip, quarantines the sha, pages SEV2"
else
  fail "J1: gate exit 2 blocks the flip, quarantines the sha, pages SEV2" \
    "rc=$rc current=$(readlink "$APP/current") quarantine=$(cat "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null) alerts=$(cat "$ALERTS" 2>/dev/null)"
fi
[[ "$(state_get phase)" == "arm-blocked-migration-gate" ]] \
  && ok "J1: state file names the gate block (drift detector reads why master is not arming)" \
  || fail "J1: state file names the gate block (drift detector reads why master is not arming)" "phase=$(state_get phase)"
[[ ! -s "$STATE_DIR/auto-deploy.build-failures" ]] \
  && ok "J1: a gate block is not a build-failure strike" \
  || fail "J1: a gate block is not a build-failure strike" "$(cat "$STATE_DIR/auto-deploy.build-failures")"
# ...and the quarantine holds: the next tick must not re-run the gate.
run_tick
[[ "$(wc -l < "$GATE_LOG")" == "1" ]] \
  && ok "J1: quarantined sha is not re-gated every tick" \
  || fail "J1: quarantined sha is not re-gated every tick" "gate_log=$(cat "$GATE_LOG")"

# J2: gate exit 3 (gate infra failure) -> NO flip, NO quarantine, NO page;
#     the next tick retries the gate; a recovered gate then flips.
SHA_M=$(fixture_commit "gate infra flake"); M12=${SHA_M:0:12}
make_release "$SHA_M" ok
set_master "$SHA_M"; : > "$ALERTS"; rm -f "$GATE_LOG"
GATE_CMD="$GATE_STUB 3" run_tick
if [[ "$(readlink "$APP/current")" == "releases/$G12" ]] \
   && ! grep -q "^$SHA_M " "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null \
   && [[ ! -s "$ALERTS" && "$(state_get phase)" == "arm-gate-infra-failed" ]]; then
  ok "J2: gate infra failure fails closed — no flip, no strike, no quarantine, no page"
else
  fail "J2: gate infra failure fails closed — no flip, no strike, no quarantine, no page" \
    "current=$(readlink "$APP/current") phase=$(state_get phase) alerts=$(cat "$ALERTS" 2>/dev/null)"
fi
GATE_CMD="$GATE_STUB 3" run_tick
[[ "$(wc -l < "$GATE_LOG")" == "2" ]] \
  && ok "J2: infra failure is retried next tick (no quarantine backoff)" \
  || fail "J2: infra failure is retried next tick (no quarantine backoff)" "gate_log=$(cat "$GATE_LOG")"
GATE_CMD="$GATE_STUB 0" run_tick; rc=$?
if [[ "$(readlink "$APP/current")" == "releases/$M12" && "$rc" == 0 ]] \
   && grep -q -- "--release $APP/releases/$M12" "$GATE_LOG"; then
  ok "J2: recovered gate passes the CANDIDATE release dir and the flip proceeds"
else
  fail "J2: recovered gate passes the CANDIDATE release dir and the flip proceeds" \
    "rc=$rc current=$(readlink "$APP/current") gate_log=$(cat "$GATE_LOG" 2>/dev/null)"
fi

# J3: break-glass — PAPERCLIP_MIGRATION_GATE_ENABLED=0 flips without invoking
#     the gate at all (a gate that would have blocked is bypassed, loudly owned
#     by whoever set the env).
SHA_O=$(fixture_commit "break-glass ungated"); O12=${SHA_O:0:12}
make_release "$SHA_O" ok
set_master "$SHA_O"; rm -f "$GATE_LOG"
GATE_CMD="$GATE_STUB 2" run_tick PAPERCLIP_MIGRATION_GATE_ENABLED=0; rc=$?
if [[ "$(readlink "$APP/current")" == "releases/$O12" && ! -s "$GATE_LOG" && "$rc" == 0 ]]; then
  ok "J3: break-glass env flips ungated (gate not invoked)"
else
  fail "J3: break-glass env flips ungated (gate not invoked)" \
    "rc=$rc current=$(readlink "$APP/current") gate_log=$(cat "$GATE_LOG" 2>/dev/null)"
fi

# J4: R3 — consecutive gate INFRA refusals page SEV2 (a silently dead deploy
#     pipeline is the "channel that cannot report its own failure" class),
#     while the build-failure strike ledger stays untouched, and a working
#     gate resets the streak.
SHA_P=$(fixture_commit "gate infra streak"); P12=${SHA_P:0:12}
make_release "$SHA_P" ok
set_master "$SHA_P"; : > "$ALERTS"
rm -f "$GATE_LOG" "$STATE_DIR/auto-deploy.gate-infra-failures" "$STATE_DIR/auto-deploy.build-failures"
GATE_CMD="$GATE_STUB 3" run_tick PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS=3
GATE_CMD="$GATE_STUB 3" run_tick PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS=3
[[ ! -s "$ALERTS" ]] \
  && ok "J4: infra refusals below the threshold do not page" \
  || fail "J4: infra refusals below the threshold do not page" "alerts=$(cat "$ALERTS")"
GATE_CMD="$GATE_STUB 3" run_tick PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS=3
if grep -q "migration gate INFRA-FAILING: 3 consecutive" "$ALERTS" \
   && [[ ! -s "$STATE_DIR/auto-deploy.build-failures" ]] \
   && ! grep -q "^$SHA_P " "$STATE_DIR/auto-deploy.quarantine" 2>/dev/null \
   && [[ "$(readlink "$APP/current")" != "releases/$P12" ]]; then
  ok "J4: threshold-th consecutive infra refusal pages SEV2; build strikes 0, no quarantine, no flip"
else
  fail "J4: threshold-th consecutive infra refusal pages SEV2; build strikes 0, no quarantine, no flip" \
    "alerts=$(cat "$ALERTS" 2>/dev/null) strikes=$(cat "$STATE_DIR/auto-deploy.build-failures" 2>/dev/null) current=$(readlink "$APP/current")"
fi
# A working gate resets the streak: a pass tick flips P, then a fresh sha's
# single infra refusal starts from 1 — no page.
GATE_CMD="$GATE_STUB 0" run_tick PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS=3
SHA_Q=$(fixture_commit "streak reset probe")
make_release "$SHA_Q" ok
set_master "$SHA_Q"; : > "$ALERTS"
GATE_CMD="$GATE_STUB 3" run_tick PAPERCLIP_DEPLOY_GATE_INFRA_ALERT_TICKS=3
if [[ "$(readlink "$APP/current")" == "releases/$P12" && ! -s "$ALERTS" ]] \
   && [[ "$(cat "$STATE_DIR/auto-deploy.gate-infra-failures" 2>/dev/null)" == "1" ]]; then
  ok "J4: a passing gate resets the infra streak (next refusal counts from 1)"
else
  fail "J4: a passing gate resets the infra streak (next refusal counts from 1)" \
    "current=$(readlink "$APP/current") counter=$(cat "$STATE_DIR/auto-deploy.gate-infra-failures" 2>/dev/null) alerts=$(cat "$ALERTS" 2>/dev/null)"
fi

# ================================================================================
# K. Health self-heal (2026-08-19 outage): probe_health failing on an
#    UNCHANGED activated sha — the unit stopped is the test's stand-in for "the
#    process is alive but every DB-bound route is wedged" (both look identical
#    to probe_health, which only sees the HTTP surface). Restore a clean
#    healthy baseline first: this axis is independent of D/E/F above.
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 0 0
systemctl --user restart "$UNIT"
wait_sha "$SHA_G" 10 || { echo "FATAL: scratch unit did not return to $G12 before K" >&2; exit 1; }
HUS="$STATE_DIR/auto-deploy.health-unreachable-since"
HRL="$STATE_DIR/auto-deploy.health-restart-last"

# K0: kill switch off (explicit =0, same as A-J's pinned default) -> even a
#     long-sustained outage never restarts, and the since-file is cleared
#     rather than left accumulating silently.
systemctl --user stop "$UNIT"; systemctl --user reset-failed "$UNIT" 2>/dev/null
printf '%s' "$(( $(date -u +%s) - 3600 ))" > "$HUS"
: > "$ALERTS"
run_tick PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=0
if ! systemctl --user is-active --quiet "$UNIT" && [[ ! -s "$ALERTS" ]] && [[ ! -f "$HUS" ]]; then
  ok "K0: kill switch off — sustained outage never restarts, since-file cleared"
else
  fail "K0: kill switch off — sustained outage never restarts, since-file cleared" \
    "active=$(systemctl --user is-active "$UNIT") alerts=$(cat "$ALERTS" 2>/dev/null) since=$(cat "$HUS" 2>/dev/null)"
fi
[[ "$(state_get phase)" == "health-unreachable" ]] \
  && ok "K0: state still reports health-unreachable (drift detector's alerting is untouched)" \
  || fail "K0: state still reports health-unreachable (drift detector's alerting is untouched)" "phase=$(state_get phase)"

# K1: enabled, but not sustained past threshold yet -> first tick just starts
#     the clock, no restart attempted.
rm -f "$HUS" "$HRL"; : > "$ALERTS"
run_tick PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=1 PAPERCLIP_AUTO_HEALTH_RESTART_THRESHOLD_SEC=3600
if ! systemctl --user is-active --quiet "$UNIT" && [[ ! -s "$ALERTS" ]] && [[ -f "$HUS" ]]; then
  ok "K1: below threshold — no restart yet, since-file started"
else
  fail "K1: below threshold — no restart yet, since-file started" \
    "active=$(systemctl --user is-active "$UNIT") alerts=$(cat "$ALERTS" 2>/dev/null) since=$(cat "$HUS" 2>/dev/null || echo MISSING)"
fi

# K2: sustained past threshold (since-file backdated) -> restarts into the
#     SAME activated sha and self-recovers, no rollback question involved.
printf '%s' "$(( $(date -u +%s) - 120 ))" > "$HUS"
: > "$ALERTS"
run_tick PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=1 PAPERCLIP_AUTO_HEALTH_RESTART_THRESHOLD_SEC=60 PAPERCLIP_AUTO_HEALTH_RESTART_COOLDOWN_SEC=0
if wait_sha "$SHA_G" 5 && systemctl --user is-active --quiet "$UNIT"; then
  ok "K2: sustained unreachable past threshold — self-heal restart recovers the SAME sha ($G12)"
else
  fail "K2: sustained unreachable past threshold — self-heal restart recovers the SAME sha ($G12)" "sha=$(health_sha)"
fi
grep -q "SELF-RECOVERED" "$ALERTS" \
  && ok "K2: self-recovery notifies INFO, not a founder-facing SEV2" \
  || fail "K2: self-recovery notifies INFO, not a founder-facing SEV2" "alerts=$(cat "$ALERTS" 2>/dev/null)"
[[ ! -f "$HUS" ]] \
  && ok "K2: since-file cleared on success (next outage starts a fresh clock)" \
  || fail "K2: since-file cleared on success (next outage starts a fresh clock)" "since=$(cat "$HUS" 2>/dev/null)"

# K3: restart does not hold (activated sha is genuinely broken) -> health
#     gate times out, escalates SEV2, and records the attempt (for K4).
#     master must move to B too, not just current — otherwise stage 1 (arm)
#     sees activated != master and quietly flips current back to G before
#     stage 2 ever runs, as D/F already establish for the rollback path.
set_master "$SHA_B"; point_current "$SHA_B"
systemctl --user stop "$UNIT" 2>/dev/null; systemctl --user reset-failed "$UNIT" 2>/dev/null
printf '%s' "$(( $(date -u +%s) - 120 ))" > "$HUS"
: > "$ALERTS"
run_tick PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=1 PAPERCLIP_AUTO_HEALTH_RESTART_THRESHOLD_SEC=60 PAPERCLIP_AUTO_HEALTH_RESTART_COOLDOWN_SEC=0
if grep -q "did NOT bring it back healthy" "$ALERTS"; then
  ok "K3: broken activated sha — self-heal restart fails and escalates SEV2"
else
  fail "K3: broken activated sha — self-heal restart fails and escalates SEV2" "alerts=$(cat "$ALERTS" 2>/dev/null)"
fi
[[ -f "$HRL" ]] \
  && ok "K3: restart attempt recorded (starts the cooldown clock)" \
  || fail "K3: restart attempt recorded (starts the cooldown clock)" "missing $HRL"

# K4: cooldown blocks an immediate re-attempt on the still-broken sha — no
#     restart-loop, no repeat page; the drift detector's own sustained
#     provenance alert is the backstop from here.
: > "$ALERTS"
run_tick PAPERCLIP_AUTO_HEALTH_RESTART_ENABLED=1 PAPERCLIP_AUTO_HEALTH_RESTART_THRESHOLD_SEC=60 PAPERCLIP_AUTO_HEALTH_RESTART_COOLDOWN_SEC=3600
if [[ ! -s "$ALERTS" ]] && grep -q "a prior restart didn't hold" "$TMP/auto.log"; then
  ok "K4: cooldown suppresses a repeat restart attempt/page on the same outage"
else
  fail "K4: cooldown suppresses a repeat restart attempt/page on the same outage" "alerts=$(cat "$ALERTS" 2>/dev/null)"
fi

# restore a clean baseline in case this suite ever gains cases after K.
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 0 0
systemctl --user restart "$UNIT"
wait_sha "$SHA_G" 10 || echo "WARNING: scratch unit did not return to $G12 after K" >&2

# ================================================================================
# L. AUR-5093: the Stage 2 single-shot probe (probe_health_with_retry) must
#    retry a few times, with backoff, before concluding unreachable — one
#    slow/refused attempt must not immediately read as "production is down".
#    Differential timing check against a genuinely-down unit: RETRIES=1 (no
#    retry) vs the default RETRIES=3/BACKOFF=0.2s must show the retrying tick
#    taking measurably longer for the identical down-unit fixture.
systemctl --user stop "$UNIT" 2>/dev/null; systemctl --user reset-failed "$UNIT" 2>/dev/null
rm -f "$HUS" "$HRL"; : > "$ALERTS"
t0=$(date +%s%N)
run_tick PAPERCLIP_HEALTH_PROBE_RETRIES=1
t1=$(date +%s%N)
no_retry_ms=$(( (t1 - t0) / 1000000 ))
phase_no_retry=$(state_get phase)

rm -f "$HUS" "$HRL"; : > "$ALERTS"
t0=$(date +%s%N)
run_tick
t1=$(date +%s%N)
retry_ms=$(( (t1 - t0) / 1000000 ))
phase_retry=$(state_get phase)

if [[ "$phase_no_retry" == "health-unreachable" && "$phase_retry" == "health-unreachable" ]] \
   && (( retry_ms > no_retry_ms + 250 )); then
  ok "L: single-shot probe retries before concluding unreachable (retry tick ${retry_ms}ms vs no-retry ${no_retry_ms}ms)"
else
  fail "L: single-shot probe retries before concluding unreachable (retry tick ${retry_ms}ms vs no-retry ${no_retry_ms}ms)" \
    "phase_no_retry=$phase_no_retry phase_retry=$phase_retry"
fi

# restore a clean baseline (this is now the last section in the suite).
set_master "$SHA_G"; point_current "$SHA_G"; set_counts 0 0
systemctl --user restart "$UNIT"
wait_sha "$SHA_G" 10 || echo "WARNING: scratch unit did not return to $G12 after L" >&2

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "auto-deploy behavioural suite: all cases passed"
  exit 0
fi
echo "auto-deploy behavioural suite: $FAILURES case(s) failed"
exit 1
