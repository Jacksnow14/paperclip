#!/usr/bin/env bash
# AUR-4034: refresh the root-owned bare git mirror that production builds
# clone from. Runs as root (via its own systemd unit), independent of the
# release pipeline -- installed to /usr/local/sbin so it keeps working even
# if the app release currently active is broken.
#
# The mirror is NOT a plain `git clone --mirror`. Two things a mirror clone
# gets wrong for this use case, both found by running the real operations
# against a live mirror rather than assuming:
#
#   1. build-release.sh's traceability gate (`git branch -r --contains`)
#      only looks at refs/remotes/origin/*. A `--mirror` clone populates
#      refs/heads/* instead, which would make the gate return empty for
#      EVERY sha -- refusing legitimate builds, not just bad ones.
#   2. build-release.sh also does a plain `git clone --no-checkout "$REPO"
#      "$RELEASE"` to materialize the release. A plain (non-mirror) clone
#      only requests objects reachable from the SOURCE's refs/heads/* --
#      so if the mirror only has refs/remotes/origin/*, that clone fetches
#      zero objects ("cloned an empty repository") and the subsequent
#      checkout fails outright.
#
# The fix is to fetch into BOTH namespaces: refs/heads/* satisfies the
# release clone, refs/remotes/origin/* satisfies the traceability gate.
set -euo pipefail

MIRROR=${PAPERCLIP_SRC_MIRROR:-/opt/paperclip/src.git}
REMOTE_URL=${PAPERCLIP_SRC_MIRROR_REMOTE:-https://github.com/Jacksnow14/paperclip.git}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "refresh-src-mirror.sh must run as root (mirror is root-owned, go-w)" >&2
  exit 1
fi

if [[ ! -d "$MIRROR" ]]; then
  echo "==> provisioning bare mirror at $MIRROR"
  install -d -o root -g root -m 755 "$(dirname "$MIRROR")"
  git init --quiet --bare "$MIRROR"
  git -C "$MIRROR" remote add origin "$REMOTE_URL"
fi

# Idempotent: converge the fetch refspec to exactly these two values on
# every run, not just at first provisioning, so a manually-fixed mirror or a
# script re-run after an upgrade always ends up with the same config.
git -C "$MIRROR" config --unset-all remote.origin.fetch 2>/dev/null || true
git -C "$MIRROR" config --add remote.origin.fetch '+refs/heads/*:refs/heads/*'
git -C "$MIRROR" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# The mirror is root-owned but read by the unprivileged deploy user (agent
# checkouts run as that user, not root). Git refuses to operate on a repo
# owned by someone else ("dubious ownership", CVE-2022-24765) unless an
# exception is registered -- and it must be registered system-wide (not in
# root's own ~/.gitconfig) so the deploy user's git process honors it too.
if ! git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$MIRROR"; then
  git config --system --add safe.directory "$MIRROR"
fi

echo "==> fetching $REMOTE_URL into $MIRROR"
git -C "$MIRROR" remote update --prune

echo "==> locking mirror (root:root, no group/other write)"
chown -R root:root "$MIRROR"
chmod -R go-w "$MIRROR"

echo "mirror refreshed: $MIRROR ($(git -C "$MIRROR" rev-parse --verify refs/remotes/origin/master^{commit}))"
