#!/usr/bin/env bash
# AUR-3937: install/refresh the deploy-drift timer from the release this script
# lives in. Requires sudo. Safe to re-run.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo touch /var/log/paperclip-deploy-drift.log
sudo chown ievgen:ievgen /var/log/paperclip-deploy-drift.log
# The alert rate-limit state must be writable by the unit's User=ievgen. /var/log
# is root-owned, so an uncreated file here would leave the escalation gate unable
# to rate-limit — precisely the silent-disable failure the gate exists to prevent.
sudo touch /var/log/paperclip-deploy-drift.alert-state
sudo chown ievgen:ievgen /var/log/paperclip-deploy-drift.alert-state
sudo cp "$HERE/systemd/paperclip-deploy-drift.service" "$HERE/systemd/paperclip-deploy-drift.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-deploy-drift.timer
echo "drift timer installed; log: /var/log/paperclip-deploy-drift.log"
