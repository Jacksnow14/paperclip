#!/usr/bin/env bash
# AUR-4034: install/refresh the deploy-source bare-mirror refresh timer.
# Requires sudo. Safe to re-run. Mirrors install-mem-watch-alert-timer.sh:
# installs the script to /usr/local/sbin instead of pointing systemd at an
# app release, so the mirror refresh keeps working even if the app release
# pipeline is what's broken -- and because the mirror must exist before any
# build can read it, so it cannot depend on a release having built already.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo install -m 0755 "$HERE/refresh-src-mirror.sh" /usr/local/sbin/paperclip-src-mirror-refresh.sh

sudo cp "$HERE/systemd/paperclip-src-mirror-refresh.service" \
        "$HERE/systemd/paperclip-src-mirror-refresh.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-src-mirror-refresh.timer

echo "==> running an initial refresh so the mirror exists before the first build"
sudo /usr/local/sbin/paperclip-src-mirror-refresh.sh

echo "src mirror refresh timer installed."
echo "  mirror:    ${PAPERCLIP_SRC_MIRROR:-/opt/paperclip/src.git}"
echo "  next run:  systemctl list-timers paperclip-src-mirror-refresh.timer"
echo "  last run:  journalctl -u paperclip-src-mirror-refresh -n 50"
