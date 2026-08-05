#!/usr/bin/env bash
# AUR-4042: entry point for release retention under
# $PAPERCLIP_DEPLOY_APP_ROOT/releases, invoked from build-release.sh after
# every build (activated or not).
#
# This script declares NO protected set of its own. `current`, `previous`,
# and "is a process actually running from here" are decided exactly once, in
# release-guard.sh's assert_deletable/prune_releases (AUR-4134) — restating
# that set in a second script is the specific defect this was rebased to
# avoid (two call sites disagreeing about what's undeletable is how AUR-4127
# happened in the first place). What this script owns is its own unique
# contribution:
#
#   - the non-blocking concurrent-deploy lock (flock -n): two overlapping
#     build-release.sh runs must not prune each other's freshly-staged
#     release. Never blocks, never forces the lock — skips and logs instead.
#   - the fail-closed skip when `current` cannot be resolved. This lives HERE,
#     at the retention entry point, and NOT in assert_deletable — that
#     function is deliberately permissive about a dangling `current`
#     (release-guard.test.sh: "dangling current does not block an unrelated
#     release") because the /proc probe is its primary protection. A dangling
#     `current` here instead means the whole deploy is in an anomalous state,
#     so the right response is to skip pruning entirely rather than prune
#     under a wrong model of what's active.
#
# The just-built release (this run's $RELEASE, whether or not --activate was
# passed) needs no special-casing: it is always the newest release directory,
# so with KEEP_ROLLBACKS >= 1 it is always within the keep budget on its own
# first prune pass.
#
# Env:
#   PAPERCLIP_DEPLOY_APP_ROOT   app root containing releases/ and current
#                               (default /opt/paperclip/app)
#   KEEP_ROLLBACKS              non-protected releases to retain beyond the
#                               running/current/previous set (default 1)
set -euo pipefail

APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
KEEP_ROLLBACKS=${KEEP_ROLLBACKS:-1}

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/deploy/release-guard.sh
source "$SCRIPT_DIR/release-guard.sh"

echo "==> pruning old releases (keep running + current + previous, then ${KEEP_ROLLBACKS} rollback(s))"

CURRENT_TARGET=""
if [[ -L "$APP_ROOT/current" ]]; then
  CURRENT_TARGET=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
fi

# Fail closed: current missing, dangling, or resolving outside releases/ means
# the deploy is in an anomalous state — skip the whole operation rather than
# prune under a wrong model of what's active.
if [[ -z "$CURRENT_TARGET" || ! -d "$CURRENT_TARGET" || "$CURRENT_TARGET" != "$APP_ROOT/releases/"* ]]; then
  echo "WARNING: \$APP_ROOT/current is missing, dangling, or does not resolve under releases/ — skipping prune entirely to avoid deleting the running release" >&2
  exit 0
fi

PRUNE_LOCK="$APP_ROOT/.prune.lock"
if [[ ! -e "$PRUNE_LOCK" ]]; then
  ( : > "$PRUNE_LOCK" ) 2>/dev/null || sudo install -m 666 /dev/null "$PRUNE_LOCK" 2>/dev/null || true
fi

if ! exec 9>"$PRUNE_LOCK"; then
  echo "NOTICE: cannot open release-prune lock $PRUNE_LOCK — skipping prune this run" >&2
  exit 0
fi

# Never block or force a concurrent deploy's prune out of the way — just skip.
if ! flock -n 9; then
  echo "NOTICE: release-prune lock held by another deploy — skipping prune this run" >&2
  exit 0
fi

prune_releases "$APP_ROOT" "$KEEP_ROLLBACKS"

# The invariant, checked independently of how the protected set was computed,
# so it still fires on a kill path nobody thought of.
assert_running_releases_intact "$APP_ROOT"
