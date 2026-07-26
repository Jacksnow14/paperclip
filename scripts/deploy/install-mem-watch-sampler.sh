#!/usr/bin/env bash
# AUR-3924/AUR-4056/AUR-4086: install/refresh the host memory/OOM sampler.
# Requires sudo. Safe to re-run. Mirrors install-mem-watch-alert-timer.sh: the
# sampler is installed to /usr/local/sbin and run from a systemd timer, not
# from an app release, so it keeps working even if the release pipeline is
# what's broken -- it is the primary evidence base for the AUR-3924 incident
# cluster and must not depend on the thing it might need to explain.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo install -m 0755 "$HERE/paperclip-mem-watch.sh" /usr/local/sbin/paperclip-mem-watch.sh

sudo cp "$HERE/systemd/paperclip-mem-watch.service" "$HERE/systemd/paperclip-mem-watch.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-mem-watch.timer
echo "mem-watch sampler installed; log: ${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}"
