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
  env "$@" \
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

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "auto-deploy behavioural suite: all cases passed"
  exit 0
fi
echo "auto-deploy behavioural suite: $FAILURES case(s) failed"
exit 1
