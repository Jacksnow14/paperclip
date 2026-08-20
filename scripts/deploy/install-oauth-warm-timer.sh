#!/usr/bin/env bash
# Install/refresh the claude_local OAuth warmer timer (AUR-5864). Requires
# sudo. Safe to re-run. Unlike install-fleet-refresh-timer.sh this unit needs
# no Paperclip API credentials — it only reads the local .credentials.json
# and shells out to the claude CLI, so there is no /etc/paperclip env-file
# gate here.
#
# Per AUR-5864: do NOT run this against production until a request_confirmation
# on that issue (or its parent AUR-5857) has been accepted — this timer runs
# unattended against the ONE shared credential file the whole claude_local
# fleet depends on.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo cp "$HERE/systemd/paperclip-oauth-warm.service" \
        "$HERE/systemd/paperclip-oauth-warm.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-oauth-warm.timer

echo "oauth warm timer installed."
echo "  next run:  systemctl list-timers paperclip-oauth-warm.timer"
echo "  last run:  journalctl -u paperclip-oauth-warm -n 50"
echo "  dry run:   node /opt/paperclip/app/current/scripts/oauth-warm.mjs --dry-run"
echo "  rollback:  systemctl disable --now paperclip-oauth-warm.timer"
