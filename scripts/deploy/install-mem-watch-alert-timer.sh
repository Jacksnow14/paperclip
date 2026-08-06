#!/usr/bin/env bash
# AUR-4025: install/refresh the mem-watch alert timer. Requires sudo. Safe to
# re-run. Mirrors install-drift-timer.sh (AUR-3937), but installs the checker to
# /usr/local/sbin instead of pointing systemd at an app release -- this monitor
# must keep working even if the app release pipeline is what's broken.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo install -m 0755 "$HERE/check-mem-watch-alert.sh" /usr/local/sbin/paperclip-mem-watch-alert.sh

sudo touch /var/log/paperclip-mem-watch-alert.state
sudo chown ievgen:ievgen /var/log/paperclip-mem-watch-alert.state
# The rate-limit state must be writable by the unit's User=ievgen. /var/log is
# root-owned, so an uncreated file here would leave the escalation gate unable
# to rate-limit -- the same silent-disable failure install-drift-timer.sh guards
# against.

sudo touch /var/log/paperclip-mem-watch-alert.pending
sudo chown ievgen:ievgen /var/log/paperclip-mem-watch-alert.pending
# AUR-4489: the pending (owed-page) record needs the same treatment, or every
# deferred page would silently degrade to the /tmp fallback and not survive a
# reboot.

sudo cp "$HERE/systemd/paperclip-mem-watch-alert.service" "$HERE/systemd/paperclip-mem-watch-alert.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-mem-watch-alert.timer
echo "mem-watch alert timer installed; state: /var/log/paperclip-mem-watch-alert.state"
