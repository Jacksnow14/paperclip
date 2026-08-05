#!/usr/bin/env bash
# Install/refresh the daily fleet model refresh timer. Requires sudo. Safe to
# re-run. Same conventions as install-pr-review-timer.sh: active-release
# ExecStart, refuses a dark install without credentials.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

ENV_FILE=/etc/paperclip/pr-review.env
if ! sudo test -s "$ENV_FILE" ||
  ! sudo grep -q '^PAPERCLIP_API_KEY=' "$ENV_FILE" ||
  ! sudo grep -q '^PAPERCLIP_COMPANY_ID=' "$ENV_FILE"; then
  echo "install-fleet-refresh-timer: FATAL — $ENV_FILE missing or incomplete." >&2
  echo "  (Shared with the PR dispatcher; see install-pr-review-timer.sh.)" >&2
  exit 1
fi

sudo cp "$HERE/systemd/paperclip-fleet-refresh.service" \
        "$HERE/systemd/paperclip-fleet-refresh.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-fleet-refresh.timer

echo "fleet refresh timer installed."
echo "  next run:  systemctl list-timers paperclip-fleet-refresh.timer"
echo "  last run:  journalctl -u paperclip-fleet-refresh -n 50"
echo "  dry run:   node /opt/paperclip/app/current/scripts/fleet-model-refresh.mjs --dry-run"
