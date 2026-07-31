#!/usr/bin/env bash
# AUR-3993 — behavioural tests for guarded-deploy-tick.sh.
#
# The paths that matter here are the ones that almost never run: the deadline
# alarm, the disarm, the rollback. Those are exactly the paths the superseded
# watcher shipped unexercised, which is how it ended up with a `exit 3` branch
# telling a human to "re-arm" that nothing was listening for. Every external
# effect in the tick is an env seam, so all of them are driven against fakes here.
#
# Each test asserts its CONTROL first where one exists — a test whose control
# does not reproduce the defect proves nothing.

set -uo pipefail
TICK="${TICK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guarded-deploy-tick.sh}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

T=$(mktemp -d /tmp/aur3993-test.XXXXXX)
trap 'rm -rf "$T"; pkill -f "$T/claude" 2>/dev/null; true' EXIT

# --- fake world -------------------------------------------------------------
mkdir -p "$T/releases/aaaaaaaaaaaa/server/dist" "$T/releases/bbbbbbbbbbbb/server/dist" "$T/state"
echo '{"sha": "aaaaaaaaaaaa"}' >"$T/releases/aaaaaaaaaaaa/build-info.json"
echo '{"sha": "bbbbbbbbbbbb"}' >"$T/releases/bbbbbbbbbbbb/build-info.json"
# guard-less release carries the OLD vacuous probe string but not the guard marker
# verbatim from the real dist of both releases — this is the string the old,
# vacuous probe matched, and it is why that probe could never fail
echo 'const ADAPTER_CLI_UNRESOLVABLE_ERROR_CODE = "adapter_cli_unresolvable";' >"$T/releases/aaaaaaaaaaaa/server/dist/heartbeat.js"
echo 'const ADAPTER_CLI_UNRESOLVABLE_ERROR_CODE = "adapter_cli_unresolvable";' >"$T/releases/bbbbbbbbbbbb/server/dist/heartbeat.js"
echo 'throw new Error("issue_id does not resolve to a real issue");' >"$T/releases/bbbbbbbbbbbb/server/dist/memory.js"
ln -sfn "$T/releases/bbbbbbbbbbbb" "$T/current"          # activated = bbbb (has guard)
: >"$T/cgroup.procs"                                      # empty = quiet
serve() { echo "{\"status\":\"ok\",\"build\":{\"sha\":\"$1\"}}" >"$T/health.json"; }
serve aaaaaaaaaaaa                                        # serving = aaaa (guard-less)

cat >"$T/fake-restart.sh" <<EOF
#!/usr/bin/env bash
echo restart >>"$T/restart.calls"
# honour a scripted outcome: healthy-on-target, or never-healthy
if [ -f "$T/restart-fails" ]; then exit 0; fi
sed -n 's|.*"sha": *"\([0-9a-f]*\)".*|\1|p' "\$(readlink -f "$T/current")/build-info.json" \
  | { read -r s; echo "{\"status\":\"ok\",\"build\":{\"sha\":\"\$s\"}}" >"$T/health.json"; }
EOF
cat >"$T/fake-disarm.sh" <<EOF
#!/usr/bin/env bash
echo disarm >>"$T/disarm.calls"
EOF
cat >"$T/fake-notify.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >>"$T/notify.calls"
EOF
chmod +x "$T"/fake-*.sh

run_tick() {  # run_tick [EXTRA_ENV=...]
  env HEALTH="file://$T/health.json" \
      CURRENT_LINK="$T/current" \
      RELEASES="$T/releases" \
      CGROUP_PROCS="$T/cgroup.procs" \
      STATE_DIR="$T/state" \
      LOG="$T/tick.log" \
      NOTIFY="$T/fake-notify.sh" \
      RESTART_CMD="$T/fake-restart.sh" \
      DISARM_CMD="$T/fake-disarm.sh" \
      HEALTH_POLLS="${HEALTH_POLLS:-3}" \
      HEALTH_POLL_SLEEP="${HEALTH_POLL_SLEEP:-1}" \
      DEADLINE_SECS="${DEADLINE_SECS:-21600}" \
      ALERT_COOLDOWN="${ALERT_COOLDOWN:-21600}" \
      bash "$TICK" >>"$T/tick.stdout" 2>&1
  echo $?
}
reset_state() { rm -rf "$T/state" "$T"/*.calls "$T/tick.log"; mkdir -p "$T/state"; }
calls() { [ -f "$T/$1.calls" ] && wc -l <"$T/$1.calls" | tr -d ' ' || echo 0; }

echo "== 1. busy host: never restarts, resets streak =="
reset_state
cp /bin/sleep "$T/claude"; "$T/claude" 60 & FAKEPID=$!
echo "$FAKEPID" >"$T/cgroup.procs"
check "control: fake agent proc is counted as a live run" \
      "$(grep -c 'waiting: 1 agent run' <(run_tick >/dev/null; cat "$T/tick.log"))" "1"
check "no restart while a run is in flight (AUR-4087)" "$(calls restart)" "0"
check "quiet streak held at 0" "$(cat "$T/state/quiet_streak")" "0"
kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null; : >"$T/cgroup.procs"

echo "== 2. quiet host: needs TWO consecutive quiet ticks =="
reset_state
run_tick >/dev/null
check "one quiet tick does not deploy" "$(calls restart)" "0"
check "streak advanced to 1" "$(cat "$T/state/quiet_streak")" "1"
run_tick >/dev/null
check "second consecutive quiet tick deploys" "$(calls restart)" "1"
check "success disarms the timer" "$(calls disarm)" "1"
check "success is announced, not silent" "$(calls notify)" "1"
check "serving proof is written for the next heartbeat" \
      "$(grep -c 'serving_sha=bbbbbbbbbbbb' "$T/state/landed")" "1"
check "log records the target resolved from the live symlink" \
      "$(grep -c 'target=bbbbbbbbbbbb' "$T/tick.log")" "1"

echo "== 3. guard marker is not vacuous (CEO Correction 2) =="
reset_state; serve aaaaaaaaaaaa
run_tick >/dev/null; run_tick >/dev/null
check "guard marker FOUND in the release that has the guard" \
      "$(grep -c 'guard marker present' "$T/tick.log")" "1"
# control: the string the old script grepped for is present in BOTH releases,
# so the old check would have reported success for the guard-less one too.
check "control: old probe string 'unresolvable' present in guard-LESS release" \
      "$(grep -rlsF 'unresolvable' "$T/releases/aaaaaaaaaaaa/server/dist" | wc -l | tr -d ' ')" "1"
check "new marker ABSENT from guard-less release" \
      "$(grep -rlsF 'does not resolve to a real issue' "$T/releases/aaaaaaaaaaaa/server/dist" | wc -l | tr -d ' ')" "0"

echo "== 4. already serving the activated release: disarm, never restart =="
reset_state; serve bbbbbbbbbbbb
run_tick >/dev/null
check "no restart when target already serving" "$(calls restart)" "0"
check "disarmed" "$(calls disarm)" "1"
check "already-serving is announced once" "$(calls notify)" "1"
run_tick >/dev/null
check "announcement is not repeated on later ticks" "$(calls notify)" "1"
serve aaaaaaaaaaaa

echo "== 5. deadline alarm fires, and is rate-limited =="
reset_state
cp /bin/sleep "$T/claude"; "$T/claude" 60 & FAKEPID=$!
echo "$FAKEPID" >"$T/cgroup.procs"       # stay busy so it can never land
DEADLINE_SECS=0 ALERT_COOLDOWN=3600 run_tick >/dev/null
check "alarm fires once past the deadline" "$(calls notify)" "1"
check "alarm names the stalled release" "$(grep -c 'still not serving' "$T/notify.calls")" "1"
DEADLINE_SECS=0 ALERT_COOLDOWN=3600 run_tick >/dev/null
check "alarm is rate-limited inside the cooldown" "$(calls notify)" "1"
DEADLINE_SECS=0 ALERT_COOLDOWN=0 run_tick >/dev/null
check "alarm re-fires once the cooldown lapses" "$(calls notify)" "2"
check "alarming never forces a restart" "$(calls restart)" "0"
kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null; : >"$T/cgroup.procs"

echo "== 6. target comes up unhealthy: rolls back to the previously-serving release =="
reset_state; serve aaaaaaaaaaaa; touch "$T/restart-fails"
run_tick >/dev/null; rc=$(run_tick)
check "rollback path taken" "$(grep -c 'rolling back to aaaaaaaaaaaa' "$T/tick.log")" "1"
check "symlink flipped back to the previously-serving release" \
      "$(basename "$(readlink -f "$T/current")")" "aaaaaaaaaaaa"
check "operator is alarmed on rollback" "$(grep -c 'rolled back' "$T/notify.calls")" "1"
rm -f "$T/restart-fails"; ln -sfn "$T/releases/bbbbbbbbbbbb" "$T/current"

echo "== 7. concurrent activation by another agent counts as success, not rollback =="
reset_state; serve aaaaaaaaaaaa
cat >"$T/fake-restart.sh" <<EOF
#!/usr/bin/env bash
echo restart >>"$T/restart.calls"
echo '{"status":"ok","build":{"sha":"cccccccccccc"}}' >"$T/health.json"
EOF
chmod +x "$T/fake-restart.sh"
run_tick >/dev/null; run_tick >/dev/null
check "newer sha from a concurrent activation is treated as success" \
      "$(grep -c 'concurrent activation' "$T/tick.log")" "1"
check "no false rollback on an unexpected-but-healthy sha (design rule 2)" \
      "$(grep -c 'rolling back' "$T/tick.log")" "0"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
