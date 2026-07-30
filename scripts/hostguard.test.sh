#!/usr/bin/env bash
# hostguard verification harness (AUR-3941 verification bar).
#
# Proves BOTH halves of the bar, using stub binaries so the live control plane
# and database are never touched:
#   (a) company-ending ops are gated and attributable
#   (b) routine agent autonomy is demonstrably intact
#
# Exit 0 = all assertions pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/hostguard.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stubs: record the call instead of performing it.
cat > "$TMP/stub" <<'EOF'
#!/usr/bin/env bash
echo "STUB-EXEC: $*" >> "$STUB_CALLS"
exit 0
EOF
chmod +x "$TMP/stub"
: > "$TMP/calls"
: > "$TMP/notify"
cat > "$TMP/notify.sh" <<'EOF'
#!/usr/bin/env bash
echo "NOTIFY: $*" >> "$STUB_NOTIFY"
EOF
chmod +x "$TMP/notify.sh"

mkdir -p "$TMP/bin"
ln -sf "$GUARD" "$TMP/bin/systemctl"
ln -sf "$GUARD" "$TMP/bin/rm"

export HOSTGUARD_LOG="$TMP/audit.jsonl"
export HOSTGUARD_REAL_SYSTEMCTL="$TMP/stub"
export HOSTGUARD_REAL_RM="$TMP/stub"
export HOSTGUARD_NOTIFY="$TMP/notify.sh"
export STUB_CALLS="$TMP/calls" STUB_NOTIFY="$TMP/notify"
export PAPERCLIP_AGENT_ID="371a1b08-0286-4a12-a516-f587f42df5eb"
export PAPERCLIP_ISSUE_ID="AUR-3941" PAPERCLIP_RUN_ID="test-run"
: > "$HOSTGUARD_LOG"

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

run() { "$TMP/bin/$@" >"$TMP/out" 2>"$TMP/err"; echo $?; }

echo "== (a) company-ending ops are GATED =="
# The exact command that would have dropped the control plane in AUR-3924.
check "systemctl --user stop paperclip.service is refused" "$(run systemctl --user stop paperclip.service)" 87
check "  refusal names the target"      "$(grep -c 'REFUSED' "$TMP/err")" 1
check "systemctl stop paperclip-db is refused"  "$(run systemctl stop paperclip-db.service)" 87
check "systemctl disable paperclip-db is refused" "$(run systemctl disable paperclip-db.service)" 87
check "systemctl mask paperclip-db is refused"    "$(run systemctl mask paperclip-db.service)" 87
# rm on the live database datadir — needs no root today.
check "rm -rf on DB datadir is refused" \
  "$(run rm -rf /home/ievgen/paperclip-data/instances/default/db)" 87
check "rm -rf via ../ traversal is refused" \
  "$(run rm -rf /home/ievgen/paperclip-data/instances/default/../default/db)" 87
check "  nothing was ever exec'd"        "$(wc -l < "$TMP/calls")" 0

echo "== gated ops are ATTRIBUTABLE =="
check "every refusal logged"             "$(grep -c '"decision":"refused"' "$HOSTGUARD_LOG")" 6
check "log carries agent_id"             "$(grep -c '"agent_id":"371a1b08-0286-4a12-a516-f587f42df5eb"' "$HOSTGUARD_LOG")" 6
check "log carries issue"                "$(grep -c '"issue":"AUR-3941"' "$HOSTGUARD_LOG")" 6
if command -v python3 >/dev/null; then
  if python3 -c 'import json,sys;[json.loads(l) for l in open(sys.argv[1]) if l.strip()]' "$HOSTGUARD_LOG"; then
    ok "audit log is valid JSONL"; else bad "audit log is not valid JSONL"; fi
fi

echo "== explicit intent ESCALATES (friction, not a wall) =="
: > "$TMP/calls"
HOSTGUARD_INTENT="AUR-3941: verification" "$TMP/bin/systemctl" stop paperclip-db.service >/dev/null 2>&1
check "intent lets it through"           "$(grep -c 'STUB-EXEC: stop paperclip-db.service' "$TMP/calls")" 1
check "escalation is logged"             "$(grep -c '"decision":"escalated"' "$HOSTGUARD_LOG")" 1
check "intent string is captured"        "$(grep -c '"intent":"AUR-3941: verification"' "$HOSTGUARD_LOG")" 1
sleep 0.3
check "founder is alerted"               "$(grep -c 'NOTIFY:' "$TMP/notify")" 1

echo "== (b) routine agent AUTONOMY is intact (no intent, no prompt) =="
: > "$TMP/calls"
for c in "start booking-service" "restart telephony-gateway" "enable paperclip-oom-guard.timer" \
         "daemon-reload" "start paperclip-mem-watch.timer"; do
  check "systemctl $c works unattended" "$(run systemctl $c)" 0
done
check "  all five actually exec'd"       "$(wc -l < "$TMP/calls")" 5
# Reads must stay silent and free.
BEFORE="$(wc -l < "$HOSTGUARD_LOG")"
for c in "status paperclip-db.service" "is-active paperclip-db.service" \
         "show paperclip-db.service" "list-timers" "cat paperclip-db.service"; do
  check "systemctl $c passes through" "$(run systemctl $c)" 0
done
check "  reads add zero log noise"       "$(( $(wc -l < "$HOSTGUARD_LOG") - BEFORE ))" 0

echo "== rm autonomy: unprotected paths are untouched fast-path =="
: > "$TMP/calls"
touch "$TMP/scratch.txt"
check "rm on workspace file passes"      "$(run rm -f "$TMP/scratch.txt")" 0
check "rm on /tmp path passes"           "$(run rm -rf /tmp/hostguard-nonexistent-xyz)" 0
check "  rm fast path adds no log noise" "$(grep -c '"tool":"rm","reason":"routine' "$HOSTGUARD_LOG")" 0

# REGRESSION (caught in review, AUR-3941): agent workspaces live UNDER
# /home/ievgen/paperclip-data/instances/<id>/projects/... A protected-path entry
# of ".../instances" would refuse every routine workspace rm and silently
# destroy agent autonomy. Only the DB datadir may be protected.
WS="/home/ievgen/paperclip-data/instances/default/projects/b26d3647/71e3873d/_default"
check "rm in agent workspace NOT refused"       "$(run rm -rf "$WS/node_modules")" 0
check "rm of workspace file NOT refused"        "$(run rm -f "$WS/deliverables/x.json")" 0
check "rm under instances/<id>/projects passes" "$(run rm -rf /home/ievgen/paperclip-data/instances/default/projects)" 0
# ...but the datadir sibling is still protected.
check "rm of instances/default/db still refused" \
  "$(run rm -rf /home/ievgen/paperclip-data/instances/default/db)" 87
check "rm of a file INSIDE the datadir refused" \
  "$(run rm -f /home/ievgen/paperclip-data/instances/default/db/PG_VERSION)" 87
check "rm of another instance's db refused" \
  "$(run rm -rf /home/ievgen/paperclip-data/instances/staging/db)" 87
check "rm of postgres binaries refused"  "$(run rm -rf /opt/paperclip/postgres)" 87
check "rm of the user unit file refused" \
  "$(run rm -f /home/ievgen/.config/systemd/user/paperclip.service)" 87

echo
printf 'hostguard: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
