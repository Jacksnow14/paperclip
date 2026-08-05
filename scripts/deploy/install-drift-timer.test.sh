#!/usr/bin/env bash
# AUR-4187: regression coverage for the checkout-drift axis being ARMED, not
# merely present.
#
# AUR-4227 shipped the axis correctly and check-deploy-drift.test.sh proves its
# behaviour is right. It still watched nothing for days: `CHECKOUTS` defaults to
# empty, nothing set PAPERCLIP_DRIFT_CHECKOUTS, and the live 15-minute timer
# produced zero `${LOG}.checkout-*` files. A detector with an empty watch list
# emits exactly what a healthy fleet emits — which is the AUR-4187 failure class
# (code that cannot report its own staleness) reproduced one level up, inside
# the detector built to catch it.
#
# So these cases assert the two properties that keep it armed:
#   1. installing with an empty watch list is a hard, loud failure, and
#   2. the checked-in watch list is real (parses, non-empty), so emptying it
#      breaks CI instead of quietly blinding production.
#
# Hermetic: stubbed sudo/chown, fake unit dir, fake log base, no systemctl.
# Run: bash scripts/deploy/install-drift-timer.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
INSTALL="$SCRIPT_DIR/install-drift-timer.sh"
REPO_DROPIN="$SCRIPT_DIR/systemd/paperclip-deploy-drift.service.d/10-checkouts.conf"
[[ -f "$INSTALL" ]] || { echo "missing $INSTALL" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# `sudo` and `chown` stubs — the installer legitimately needs root on the real
# host, but the assertions here are about its control flow, not its privileges.
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/sudo" <<'STUB'
#!/usr/bin/env bash
while [[ "${1:-}" == -* ]]; do shift; done
exec "$@"
STUB
cat > "$BIN/chown" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$BIN/sudo" "$BIN/chown"

FAILURES=0
ok()   { echo "ok   — $1"; }
fail() { echo "FAIL — $1"; [[ -n "${2:-}" ]] && echo "       $2"; FAILURES=$((FAILURES + 1)); }

# Run the installer against a throwaway staging copy of scripts/deploy, so a
# case can mutate the drop-in without touching the repo.
#
# NB: this is deliberately NOT called in a command substitution. LOG_BASE has to
# survive the call so case 3 can assert against the files the installer created,
# and a subshell would swallow it. Output lands in $OUT instead.
CASE=0
LOG_BASE=
OUT=
run_install() { # $1 = dropin body ("" = no drop-in at all)
  CASE=$((CASE + 1))
  OUT="$TMP/out.$CASE"
  local stage="$TMP/stage.$CASE"
  mkdir -p "$stage/systemd"
  cp "$SCRIPT_DIR/systemd/paperclip-deploy-drift.service" \
     "$SCRIPT_DIR/systemd/paperclip-deploy-drift.timer" "$stage/systemd/"
  cp "$INSTALL" "$stage/install-drift-timer.sh"
  if [[ -n "$1" ]]; then
    mkdir -p "$stage/systemd/paperclip-deploy-drift.service.d"
    printf '%s\n' "$1" > "$stage/systemd/paperclip-deploy-drift.service.d/10-checkouts.conf"
  fi
  local unit_dir="$TMP/units.$CASE"; mkdir -p "$unit_dir"
  LOG_BASE="$TMP/logs.$CASE/drift.log"; mkdir -p "$(dirname "$LOG_BASE")"
  PATH="$BIN:$PATH" \
  PAPERCLIP_DRIFT_UNIT_DIR="$unit_dir" \
  PAPERCLIP_DRIFT_LOG="$LOG_BASE" \
  PAPERCLIP_DRIFT_ALERT_STATE="${LOG_BASE%.log}.alert-state" \
  PAPERCLIP_DRIFT_UNIT_USER="$(id -un)" \
  PAPERCLIP_DRIFT_INSTALL_NO_SYSTEMD=1 \
    bash "$stage/install-drift-timer.sh" >"$OUT" 2>&1
}

# 1. The dark state is refused. No drop-in => the axis would install watching
#    zero checkouts, which is the defect; the installer must exit non-zero and
#    say so, not print "installed" over a blind detector.
run_install ""; rc=$?
if [[ "$rc" != "0" ]] && grep -q "PAPERCLIP_DRIFT_CHECKOUTS is empty" "$OUT"; then
  ok "install with no checkout watch list fails loudly"
else
  fail "install with no checkout watch list fails loudly" "rc=$rc out=$(cat "$OUT")"
fi

# 2. Control: the same installer, same stubs, WITH a watch list, succeeds. Case
#    1 must fail for the empty list and nothing else.
run_install '[Service]
Environment="PAPERCLIP_DRIFT_CHECKOUTS=alpha:/tmp/alpha:main\nbeta:/tmp/beta:master"'; rc=$?
if [[ "$rc" == "0" ]] && grep -q "armed for: alpha beta" "$OUT"; then
  ok "install with a watch list succeeds and names the armed checkouts"
else
  fail "install with a watch list succeeds and names the armed checkouts" "rc=$rc out=$(cat "$OUT")"
fi

# 3. Every armed checkout gets its own (log, state) pair, pre-created. Without
#    them the unit (User=ievgen) cannot write into root-owned /var/log, so the
#    escalation gate cannot rate-limit and silently never pages while the DRIFT
#    line still prints — the same silent-disable the primary axis was fixed for.
missing=()
for label in alpha beta; do
  [[ -f "${LOG_BASE}.checkout-${label}" ]] || missing+=("log:$label")
  [[ -f "${LOG_BASE%.log}.alert-state.checkout-${label}" ]] || missing+=("state:$label")
done
if [[ ${#missing[@]} -eq 0 ]]; then
  ok "each armed checkout gets a pre-created (log, state) pair"
else
  fail "each armed checkout gets a pre-created (log, state) pair" "missing: ${missing[*]}"
fi

# 5. Two drop-ins setting the same variable: systemd uses the LAST assignment, so
#    the installer must read the last one too. Concatenating both reports a watch
#    list the unit will never see, and pre-creates duplicate (log, state) pairs —
#    which is exactly what happened on the host when a hand-written drop-in and
#    the shipped one coexisted, and the installer announced 14 armed checkouts
#    for a 7-entry list.
run_install '[Service]
Environment="PAPERCLIP_DRIFT_CHECKOUTS=stale:/tmp/stale:main"'
extra="$TMP/stage.$CASE/systemd/paperclip-deploy-drift.service.d/20-later.conf"
printf '%s\n' '[Service]
Environment="PAPERCLIP_DRIFT_CHECKOUTS=winner:/tmp/winner:main"' > "$extra"
# Re-run the same staged installer now that a second drop-in exists.
PATH="$BIN:$PATH" \
PAPERCLIP_DRIFT_UNIT_DIR="$TMP/units.$CASE" \
PAPERCLIP_DRIFT_LOG="$LOG_BASE" \
PAPERCLIP_DRIFT_ALERT_STATE="${LOG_BASE%.log}.alert-state" \
PAPERCLIP_DRIFT_UNIT_USER="$(id -un)" \
PAPERCLIP_DRIFT_INSTALL_NO_SYSTEMD=1 \
  bash "$TMP/stage.$CASE/install-drift-timer.sh" >"$OUT" 2>&1
if grep -q "armed for: winner $" "$OUT" || grep -qx "checkout-drift axis armed for: winner " "$OUT"; then
  ok "with two drop-ins the installer reads the last assignment, as systemd does"
else
  fail "with two drop-ins the installer reads the last assignment, as systemd does" "out=$(cat "$OUT")"
fi

# 4. The checked-in watch list is real. This is the case that rots first: someone
#    empties or comments out the list and every other test still passes, because
#    every other test supplies its own fixture list.
if [[ ! -f "$REPO_DROPIN" ]]; then
  fail "repo ships a non-empty checkout watch list" "missing $REPO_DROPIN"
else
  entries=$(sed -n 's/^Environment="\?PAPERCLIP_DRIFT_CHECKOUTS=//p' "$REPO_DROPIN" | sed 's/"$//')
  entries=$(printf '%b' "$entries" | grep -v '^[[:space:]]*$' || true)
  count=$(printf '%s\n' "$entries" | grep -c . || true)
  bad=$(printf '%s\n' "$entries" | grep -vc '^[A-Za-z0-9._-]\+:/[^:]\+:[^:]\+$' || true)
  if [[ "$count" -gt 0 && "$bad" == "0" ]]; then
    ok "repo ships a non-empty checkout watch list ($count entries, all label:path:branch)"
  else
    fail "repo ships a non-empty checkout watch list" "count=$count malformed=$bad entries=$entries"
  fi
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "install-drift-timer: all cases passed"
  exit 0
fi
echo "install-drift-timer: $FAILURES case(s) failed"
exit 1
