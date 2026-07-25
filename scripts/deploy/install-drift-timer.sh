#!/usr/bin/env bash
# AUR-3937: install/refresh the deploy-drift timer from the release this script
# lives in. Requires sudo. Safe to re-run.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo touch /var/log/paperclip-deploy-drift.log
sudo chown ievgen:ievgen /var/log/paperclip-deploy-drift.log
sudo cp "$HERE/systemd/paperclip-deploy-drift.service" "$HERE/systemd/paperclip-deploy-drift.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-deploy-drift.timer
echo "drift timer installed; log: /var/log/paperclip-deploy-drift.log"
