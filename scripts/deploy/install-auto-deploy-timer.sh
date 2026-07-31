#!/usr/bin/env bash
# AUR-4028: install/refresh the auto-deploy timer. Safe to re-run.
#
# Unlike install-drift-timer.sh this installs USER-level units (see the comment
# in paperclip-auto-deploy.service for why), so the unit files go to
# ~/.config/systemd/user and enabling needs no sudo. sudo is only used to
# create the state dir and log file with the right ownership.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /var/lib/paperclip
sudo touch /var/log/paperclip-auto-deploy.log
sudo chown "$(id -un):$(id -gn)" /var/log/paperclip-auto-deploy.log

mkdir -p "$UNIT_DIR"
cp "$HERE/systemd/paperclip-auto-deploy.service" "$HERE/systemd/paperclip-auto-deploy.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now paperclip-auto-deploy.timer

# Bootstrap: the timer's ExecStart lives inside the ACTIVE release
# (current/scripts/deploy/auto-deploy.sh). If the active release predates
# AUR-4028, no tick can ever run — run ONE tick from this checkout to cross
# that gap (arm via safe-deploy --build-only + flip, with every guard; direct
# build-release.sh --activate is refused since AUR-4155). Every subsequent arm
# is the timer's job, not a human's.
if [[ ! -x /opt/paperclip/app/current/scripts/deploy/auto-deploy.sh ]]; then
  echo "==> bootstrap: active release predates auto-deploy.sh; running one auto-deploy tick from $HERE (timed)"
  time "$HERE/auto-deploy.sh"
fi

echo "auto-deploy timer installed (user-level); state: /var/lib/paperclip/auto-deploy.state; log: /var/log/paperclip-auto-deploy.log"
systemctl --user list-timers paperclip-auto-deploy.timer --no-pager || true
