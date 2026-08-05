#!/usr/bin/env bash
# AUR-4037: install/refresh the release-retention timer. Requires sudo. Safe to
# re-run. Mirrors install-drift-timer.sh (AUR-3937).
#
# Unlike install-mem-watch-alert-timer.sh, this does NOT copy the script to
# /usr/local/sbin. Retention policy is versioned with the release it ships in,
# and prune-releases.sh sources release-guard.sh from its own directory — the
# protected-set logic and the entry point must always be the same vintage.
# Pointing systemd at /opt/paperclip/app/current keeps them together and means
# a policy change ships by deploying, not by remembering to re-run this script.
#
# The tradeoff is explicit: if `current` is broken badly enough that the
# ExecStart path does not exist, retention stops running. That is the correct
# failure direction here — prune-releases.sh already fails closed on an
# unresolvable `current` anyway, so a deploy in that state must not be pruned
# under a stale copy of the policy.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

sudo cp "$HERE/systemd/paperclip-release-prune.service" \
        "$HERE/systemd/paperclip-release-prune.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-release-prune.timer

echo "release prune timer installed."
echo "  next run:  systemctl list-timers paperclip-release-prune.timer"
echo "  last run:  journalctl -u paperclip-release-prune -n 50"
echo "  dry run:   PAPERCLIP_DEPLOY_RM='echo WOULD-DELETE' \\"
echo "               /opt/paperclip/app/current/scripts/deploy/prune-releases.sh"
