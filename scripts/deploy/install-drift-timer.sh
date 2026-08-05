#!/usr/bin/env bash
# AUR-3937: install/refresh the deploy-drift timer from the release this script
# lives in. Requires sudo. Safe to re-run.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
UNIT_DIR=${PAPERCLIP_DRIFT_UNIT_DIR:-/etc/systemd/system}
LOG_BASE=${PAPERCLIP_DRIFT_LOG:-/var/log/paperclip-deploy-drift.log}
STATE_BASE=${PAPERCLIP_DRIFT_ALERT_STATE:-/var/log/paperclip-deploy-drift.alert-state}
UNIT_USER=${PAPERCLIP_DRIFT_UNIT_USER:-ievgen}
# Set to 1 for a hermetic dry run: no systemctl, no --now. Used by the tests.
NO_SYSTEMD=${PAPERCLIP_DRIFT_INSTALL_NO_SYSTEMD:-0}

sudo touch "$LOG_BASE"
sudo chown "$UNIT_USER:$UNIT_USER" "$LOG_BASE"
# The alert rate-limit state must be writable by the unit's User=ievgen. /var/log
# is root-owned, so an uncreated file here would leave the escalation gate unable
# to rate-limit — precisely the silent-disable failure the gate exists to prevent.
sudo touch "$STATE_BASE"
sudo chown "$UNIT_USER:$UNIT_USER" "$STATE_BASE"
sudo cp "$HERE/systemd/paperclip-deploy-drift.service" "$HERE/systemd/paperclip-deploy-drift.timer" "$UNIT_DIR/"

# --- checkout-drift axis wiring (AUR-4187) ----------------------------------
# AUR-4227 shipped the axis with `CHECKOUTS=${PAPERCLIP_DRIFT_CHECKOUTS-}` — an
# empty opt-in default — and nothing ever set it. The axis ran on the live 15-min
# timer for days and observed zero checkouts: no `${LOG}.checkout-*` file existed
# at all. A detector that ships dark is indistinguishable from a healthy fleet,
# which is the exact AUR-4187 failure class the axis was built to catch, one
# level up. So the watch list now installs WITH the unit, and this script refuses
# to leave an installation in the dark state.
DROPIN_SRC="$HERE/systemd/paperclip-deploy-drift.service.d"
if [[ -d "$DROPIN_SRC" ]]; then
  sudo mkdir -p "$UNIT_DIR/paperclip-deploy-drift.service.d"
  sudo cp "$DROPIN_SRC"/*.conf "$UNIT_DIR/paperclip-deploy-drift.service.d/"
fi

# Read the effective watch list back out of what was just installed, rather than
# from this script's own variables — the assertion has to measure the deployed
# artifact, not the intent.
# `tail -n 1`: when several drop-ins set the same variable systemd uses the LAST
# assignment, so concatenating every match would report a watch list the unit
# will never see — the assertion has to agree with systemd, not with the files.
# `|| true`: with `set -o pipefail` a missing drop-in makes `cat` fail, which
# would abort this script under `set -e` BEFORE the assertion below could
# report why. The dark state has to reach the error message, not exit silently.
checkouts=$(sudo cat "$UNIT_DIR/paperclip-deploy-drift.service.d"/*.conf 2>/dev/null |
  sed -n 's/^Environment="\?PAPERCLIP_DRIFT_CHECKOUTS=//p' | sed 's/"$//' | tail -n 1 || true)
if [[ -z "$checkouts" ]]; then
  echo "install-drift-timer: FATAL — PAPERCLIP_DRIFT_CHECKOUTS is empty after install." >&2
  echo "  The checkout-drift axis (AUR-4227) would run against zero checkouts and" >&2
  echo "  report a clean fleet forever. Add entries to" >&2
  echo "  scripts/deploy/systemd/paperclip-deploy-drift.service.d/10-checkouts.conf" >&2
  echo "  as label:path:intended-branch. See AUR-4187." >&2
  exit 1
fi

# Each watched checkout gets its own (log, state) pair so one drifting checkout
# cannot reset another's sustained-duration clock. Those files live in root-owned
# /var/log while the unit runs as $UNIT_USER, so — exactly as for the primary
# axis above — an uncreated file silently disables that checkout's escalation
# gate while the DRIFT line still prints. Pre-create them here.
labels=$(printf '%b' "$checkouts" | cut -d: -f1 | grep -v '^[[:space:]]*$' || true)
while IFS= read -r label; do
  [[ -n "$label" ]] || continue
  sudo touch "${LOG_BASE}.checkout-${label}" "${STATE_BASE}.checkout-${label}"
  sudo chown "$UNIT_USER:$UNIT_USER" "${LOG_BASE}.checkout-${label}" "${STATE_BASE}.checkout-${label}"
done <<<"$labels"
echo "checkout-drift axis armed for: $(printf '%b' "$checkouts" | cut -d: -f1 | tr '\n' ' ')"

if [[ "$NO_SYSTEMD" != "1" ]]; then
  sudo systemctl daemon-reload
  sudo systemctl enable --now paperclip-deploy-drift.timer
fi
echo "drift timer installed; log: $LOG_BASE"
