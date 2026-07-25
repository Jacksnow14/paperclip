#!/usr/bin/env bash
# AUR-3937: build a pinned, committed ref into a root-owned release under
# /opt/paperclip/app. Production runs releases from here — never from a mutable
# agent checkout. Mirrors the AUR-3931 pattern (/opt/paperclip/postgres).
#
# Usage:
#   scripts/deploy/build-release.sh [--ref <git-ref>] [--force] [--activate]
#
#   --ref       ref to build (default origin/master). The resolved commit MUST
#               exist on the GitHub remote — unpushed local commits are refused.
#   --force     rebuild an existing release directory for the same SHA.
#   --activate  atomically point /opt/paperclip/app/current at the new release.
#               Takes effect on the next start of paperclip.service; this script
#               NEVER restarts the service.
set -euo pipefail

REPO=${PAPERCLIP_DEPLOY_SRC_REPO:-/home/ievgen/paperclip}
APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
REMOTE_URL=https://github.com/Jacksnow14/paperclip.git
REF=origin/master
FORCE=0
ACTIVATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --activate) ACTIVATE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

git -C "$REPO" fetch --quiet origin
SHA=$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")

# Traceability gate: refuse anything not on the GitHub remote. This is what
# makes every release answerable to "which commit is production running?".
if [[ -z "$(git -C "$REPO" branch -r --contains "$SHA" 2>/dev/null)" ]]; then
  echo "refusing to build $SHA: not reachable from any origin remote branch — push it first" >&2
  exit 1
fi

SHA12=${SHA:0:12}
RELEASE="$APP_ROOT/releases/$SHA12"

if [[ -e "$RELEASE" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "release $RELEASE already exists (use --force to rebuild)" >&2
    exit 1
  fi
  [[ "$RELEASE" == "$APP_ROOT/releases/"?* ]] || { echo "unsafe release path: $RELEASE" >&2; exit 1; }
  sudo rm -rf "$RELEASE"
fi

sudo install -d -o root -g root -m 755 "$APP_ROOT" "$APP_ROOT/releases"
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$RELEASE"

echo "==> cloning $SHA12 from $REPO"
# --no-hardlinks: the release must not share object inodes with the mutable
# repo — the chown to root below would otherwise poison the source repo's .git.
git clone --quiet --no-hardlinks --no-checkout "$REPO" "$RELEASE"
git -C "$RELEASE" remote set-url origin "$REMOTE_URL"
git -C "$RELEASE" checkout --quiet --detach "$SHA"

echo "==> installing dependencies (copy mode — no store hardlinks)"
# --package-import-method=copy: same reason as --no-hardlinks; root-chowning
# hardlinked store files would corrupt ownership inside the shared pnpm store.
(cd "$RELEASE" && pnpm install --frozen-lockfile --prefer-offline --package-import-method=copy)

echo "==> building server (+ workspace deps) and ui"
# This box has 7.7 GB RAM and a history of OOM kills: cap the heap and build
# serially. Server tsc OOMs at 2048 and completes at 3072 (measured 2026-07-25).
# Never raise this cap without reading AUR-3937.
export NODE_OPTIONS="--max-old-space-size=3072"
(cd "$RELEASE" && pnpm --filter "@paperclipai/server..." --workspace-concurrency=1 run build)
(cd "$RELEASE" && pnpm --filter "@paperclipai/ui" run build)

test -f "$RELEASE/server/dist/index.js" || { echo "build produced no server/dist/index.js" >&2; exit 1; }
test -f "$RELEASE/server/node_modules/tsx/dist/loader.mjs" || { echo "tsx loader missing from release" >&2; exit 1; }
test -f "$RELEASE/ui/dist/index.html" || { echo "build produced no ui/dist/index.html" >&2; exit 1; }

BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$RELEASE/build-info.json" <<EOF
{
  "sha": "$SHA",
  "ref": "$REF",
  "builtAt": "$BUILT_AT",
  "remote": "$REMOTE_URL",
  "builder": "scripts/deploy/build-release.sh ($(id -un)@$(hostname))"
}
EOF

echo "==> locking release (root:root, no group/other write)"
sudo chown -R root:root "$RELEASE"
sudo chmod -R go-w "$RELEASE"

if [[ "$ACTIVATE" -eq 1 ]]; then
  echo "==> activating $SHA12"
  sudo ln -sfn "releases/$SHA12" "$APP_ROOT/current.next"
  sudo mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
fi

echo "==> pruning old releases (keep active + 2 most recent)"
CURRENT_TARGET=""
if [[ -L "$APP_ROOT/current" ]]; then
  CURRENT_TARGET=$(readlink -f "$APP_ROOT/current" || true)
fi
KEPT=0
for dir in $(ls -1t "$APP_ROOT/releases" 2>/dev/null); do
  path="$APP_ROOT/releases/$dir"
  if [[ "$(readlink -f "$path")" == "$CURRENT_TARGET" ]]; then
    continue
  fi
  KEPT=$((KEPT + 1))
  if [[ "$KEPT" -gt 2 ]]; then
    [[ "$path" == "$APP_ROOT/releases/"?* ]] || continue
    echo "    pruning $path"
    sudo rm -rf "$path"
  fi
done

echo "release ready: $RELEASE (sha $SHA)"
[[ "$ACTIVATE" -eq 1 ]] && echo "activated: $APP_ROOT/current -> releases/$SHA12 (applies on next service start)"
exit 0
