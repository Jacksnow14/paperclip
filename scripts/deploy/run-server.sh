#!/usr/bin/env bash
# AUR-3937: production launcher. Lives inside the immutable release tree, so the
# exact run command is itself pinned and reviewed. systemd ExecStart points at
# /opt/paperclip/app/current/scripts/deploy/run-server.sh.
#
# pwd -P resolves the `current` symlink to the physical release directory, so a
# later `current` flip never yanks the tree out from under a running process.
set -euo pipefail
RELEASE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)

# The tsx loader is required at runtime: @paperclipai/shared and @paperclipai/db
# export raw .ts sources, which server/dist imports through the loader.
exec /usr/bin/node \
  --import "$RELEASE_ROOT/server/node_modules/tsx/dist/loader.mjs" \
  "$RELEASE_ROOT/server/dist/index.js"
