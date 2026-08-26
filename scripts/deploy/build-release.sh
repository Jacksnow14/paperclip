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
#               NEVER restarts the service. Direct --activate is refused unless
#               the safe-deploy wrapper marks the call gated, or break-glass is
#               explicitly set for an emergency bypass.
set -euo pipefail

# AUR-4134: the guard that refuses to delete a release a live process is
# executing from. Lives here, in the inner script, and NOT only in the
# safe-deploy wrapper — the wrapper is bypassable by invoking this script
# directly, which is exactly how AUR-4127 fired.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/deploy/release-guard.sh
source "$SCRIPT_DIR/release-guard.sh"

REPO=${PAPERCLIP_DEPLOY_SRC_REPO:-/home/ievgen/paperclip}
APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
REMOTE_URL=https://github.com/Jacksnow14/paperclip.git
REF=origin/master
FORCE=0
ACTIVATE=0
# AUR-4042: retention policy is active + this many rollback releases.
KEEP_ROLLBACKS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --activate) ACTIVATE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$ACTIVATE" -eq 1 ]]; then
  if [[ "${PAPERCLIP_DEPLOY_BREAK_GLASS:-0}" == "1" ]]; then
    cat >&2 <<'EOF'
WARNING: PAPERCLIP_DEPLOY_BREAK_GLASS=1 bypassing safe-deploy.sh protections for build-release.sh --activate
WARNING: this skips the memory floor/watchdog, sampler verification, post-activation watch, and automatic rollback
EOF
  elif [[ "${PAPERCLIP_DEPLOY_GATED:-0}" != "1" ]]; then
    cat >&2 <<'EOF'
refusing direct build-release.sh --activate: use scripts/deploy/safe-deploy.sh --activate
emergency bypass only: set PAPERCLIP_DEPLOY_BREAK_GLASS=1 and rerun to make an explicit, logged exception
EOF
    exit 1
  fi
fi

# AUR-4034: $REPO may be a root-owned bare mirror (/opt/paperclip/src.git)
# that this process cannot write to. A working checkout has its git dir at
# $REPO/.git; a bare mirror IS the git dir, so this only fires for the
# checkout case. The mirror's freshness comes from its own refresh timer
# (scripts/deploy/refresh-src-mirror.sh), not from a fetch here.
if [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" fetch --quiet origin
fi
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
  # AUR-4134: --force must hard-fail against a release that is running, is
  # `current`, or is `previous`. The guard owns that set — do not restate it
  # here, because a comment claiming a narrower policy than the code enforces
  # is exactly what let the original gap through review (AUR-4127).
  assert_deletable "$APP_ROOT" "$RELEASE" || exit 1
  $PAPERCLIP_DEPLOY_RM "$RELEASE"
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
  # AUR-4134: remember what we are moving off, before we lose the pointer.
  # Retention protects `previous` so a rollback target always survives.
  PREV_NAME=$(release_name_of_link "$APP_ROOT/current")
  if [[ -n "$PREV_NAME" && "$PREV_NAME" != "$SHA12" ]]; then
    sudo ln -sfn "releases/$PREV_NAME" "$APP_ROOT/previous.next"
    sudo mv -T "$APP_ROOT/previous.next" "$APP_ROOT/previous"
  fi
  sudo ln -sfn "releases/$SHA12" "$APP_ROOT/current.next"
  sudo mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
fi

# AUR-4042: entry point owns the fail-closed skip on unresolvable `current`
# and the non-blocking concurrent-deploy lock; it sources release-guard.sh
# itself and delegates the protected set (running/current/previous) and the
# actual deletions to prune_releases — one definition, not restated here.
KEEP_ROLLBACKS="$KEEP_ROLLBACKS" PAPERCLIP_DEPLOY_APP_ROOT="$APP_ROOT" \
  "$SCRIPT_DIR/prune-releases.sh"

echo "release ready: $RELEASE (sha $SHA)"
[[ "$ACTIVATE" -eq 1 ]] && echo "activated: $APP_ROOT/current -> releases/$SHA12 (applies on next service start)"
exit 0
