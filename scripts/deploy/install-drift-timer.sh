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

# --- unit-drift axis wiring (AUR-5648, follow-up to AUR-5647) ---------------
# Same defect one level up from the checkout axis: a unit/timer/drop-in edit
# merges to master, ships in the release tarball, and sits inert on disk until
# a human happens to re-run the relevant install-*.sh by hand — AUR-5633
# shipped in release 3a8d0d597825 but the installed drop-in stayed the Aug-5
# copy for 183h. This axis's watch list ships as a sibling drop-in
# (20-units.conf) already copied by the DROPIN_SRC block above, so this
# script refuses to leave it in the dark (empty) state, exactly as for
# PAPERCLIP_DRIFT_CHECKOUTS above.
units=$(sudo cat "$UNIT_DIR/paperclip-deploy-drift.service.d"/*.conf 2>/dev/null |
  sed -n 's/^Environment="\?PAPERCLIP_DRIFT_UNITS=//p' | sed 's/"$//' | tail -n 1 || true)
if [[ -z "$units" ]]; then
  echo "install-drift-timer: FATAL — PAPERCLIP_DRIFT_UNITS is empty after install." >&2
  echo "  The unit-drift axis (AUR-5648) would run against zero units and report a" >&2
  echo "  clean fleet forever. Add entries to" >&2
  echo "  scripts/deploy/systemd/paperclip-deploy-drift.service.d/20-units.conf" >&2
  echo "  as label:source-relative-path:installed-path:level. See AUR-5648." >&2
  exit 1
fi

unit_labels=$(printf '%b' "$units" | cut -d: -f1 | grep -v '^[[:space:]]*$' || true)
while IFS= read -r label; do
  [[ -n "$label" ]] || continue
  sudo touch "${LOG_BASE}.unit-${label}" "${STATE_BASE}.unit-${label}"
  sudo chown "$UNIT_USER:$UNIT_USER" "${LOG_BASE}.unit-${label}" "${STATE_BASE}.unit-${label}"
done <<<"$unit_labels"
echo "unit-drift axis armed for: $(printf '%b' "$units" | cut -d: -f1 | tr '\n' ' ')"

# --- timer-liveness axis wiring (AUR-5885, follow-up to AUR-5866) ----------
# Same "shipped dark" hazard as the checkout/unit axes above, one level
# further: paperclip-pr-review.timer sat disabled for 13 days with zero
# signal because nothing anywhere asked systemd whether it was actually
# alive. The watch list ships as a sibling drop-in (30-timers.conf) already
# copied by the DROPIN_SRC block above, so this script refuses to leave it
# in the dark (empty) state, exactly as for PAPERCLIP_DRIFT_CHECKOUTS/UNITS.
timers=$(sudo cat "$UNIT_DIR/paperclip-deploy-drift.service.d"/*.conf 2>/dev/null |
  sed -n 's/^Environment="\?PAPERCLIP_DRIFT_TIMERS=//p' | sed 's/"$//' | tail -n 1 || true)
if [[ -z "$timers" ]]; then
  echo "install-drift-timer: FATAL — PAPERCLIP_DRIFT_TIMERS is empty after install." >&2
  echo "  The timer-liveness axis (AUR-5885) would watch zero timers and report a" >&2
  echo "  clean fleet forever, exactly the silent-dead-unit class it exists to" >&2
  echo "  catch. Add entries to" >&2
  echo "  scripts/deploy/systemd/paperclip-deploy-drift.service.d/30-timers.conf" >&2
  echo "  as label:timer_unit:service_unit:max_staleness_sec. See AUR-5866." >&2
  exit 1
fi

timer_labels=$(printf '%b' "$timers" | cut -d: -f1 | grep -v '^[[:space:]]*$' || true)
while IFS= read -r label; do
  [[ -n "$label" ]] || continue
  sudo touch "${LOG_BASE}.timer-${label}" "${STATE_BASE}.timer-${label}"
  sudo chown "$UNIT_USER:$UNIT_USER" "${LOG_BASE}.timer-${label}" "${STATE_BASE}.timer-${label}"
done <<<"$timer_labels"
echo "timer-liveness axis armed for: $(printf '%b' "$timers" | cut -d: -f1 | tr '\n' ' ')"

if [[ "$NO_SYSTEMD" != "1" ]]; then
  sudo systemctl daemon-reload
  sudo systemctl enable --now paperclip-deploy-drift.timer
fi
echo "drift timer installed; log: $LOG_BASE"
