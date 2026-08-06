#!/usr/bin/env bash
# AUR-5095: install/refresh the crash-loop bound + failover for
# paperclip.service. Safe to re-run.
#
# Does NOT restart paperclip.service: StartLimit*/OnFailure= are start-job
# properties picked up on daemon-reload, so the live service is untouched.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LIBEXEC="$HOME/.local/libexec/paperclip"

# The failover script lives at a stable path OUTSIDE the release tree: at fire
# time `current` points at the broken release, so nothing resolved through it
# can be trusted to run the recovery.
install -d "$LIBEXEC"
install -m 755 "$HERE/crash-loop-failover.sh" "$LIBEXEC/crash-loop-failover.sh"

sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /var/lib/paperclip
sudo touch /var/log/paperclip-failover.log
sudo chown "$(id -un):$(id -gn)" /var/log/paperclip-failover.log

install -d "$UNIT_DIR/paperclip.service.d"
install -m 644 "$HERE/systemd/paperclip-failover.service" "$UNIT_DIR/paperclip-failover.service"
install -m 644 "$HERE/systemd/paperclip-crashloop-bound.conf" "$UNIT_DIR/paperclip.service.d/paperclip-crashloop-bound.conf"
systemctl --user daemon-reload

echo "installed: start-limit bound (600s/5) + OnFailure= failover on paperclip.service"
systemctl --user show paperclip.service -p StartLimitIntervalUSec -p StartLimitBurst -p OnFailure --no-pager
