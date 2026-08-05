#!/usr/bin/env bash
# Install/refresh the PR-backlog dispatcher timer. Requires sudo. Safe to
# re-run. Mirrors install-release-prune-timer.sh: the unit points at
# /opt/paperclip/app/current so dispatch policy ships by deploying.
#
# Refuses a dark install (same philosophy as install-drift-timer.sh /
# AUR-4187): without credentials the dispatcher would sweep, fail to file,
# and the backlog would strand exactly as before while the timer reads
# "active". /etc/paperclip/pr-review.env must exist and provide
# PAPERCLIP_API_KEY + PAPERCLIP_COMPANY_ID.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

ENV_FILE=/etc/paperclip/pr-review.env
if ! sudo test -s "$ENV_FILE" ||
  ! sudo grep -q '^PAPERCLIP_API_KEY=' "$ENV_FILE" ||
  ! sudo grep -q '^PAPERCLIP_COMPANY_ID=' "$ENV_FILE"; then
  echo "install-pr-review-timer: FATAL — $ENV_FILE missing or incomplete." >&2
  echo "  Create it (root-owned, mode 600) with:" >&2
  echo "    PAPERCLIP_API_KEY=..." >&2
  echo "    PAPERCLIP_COMPANY_ID=..." >&2
  echo "  Without it the dispatcher cannot file issues and the PR backlog" >&2
  echo "  strands silently — the exact failure this timer exists to end." >&2
  exit 1
fi

sudo cp "$HERE/systemd/paperclip-pr-review.service" \
        "$HERE/systemd/paperclip-pr-review.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-pr-review.timer

echo "pr-review dispatcher installed."
echo "  next run:  systemctl list-timers paperclip-pr-review.timer"
echo "  last run:  journalctl -u paperclip-pr-review -n 50"
echo "  dry run:   node /opt/paperclip/app/current/scripts/check-pr-backlog.mjs --dry-run"
