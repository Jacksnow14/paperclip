#!/usr/bin/env bash
# AUR-4564: install the shared-clone guards into a clone's common git dir.
#
# Guard scripts are copied into "$common_dir/dev-guards/" (untracked, part of
# the common git dir) rather than invoked from the tracked working tree,
# because the tracked tree's content changes with whatever branch happens to
# be checked out -- a hook or alias that pointed at the tracked copy would
# stop working the moment the main clone switches branches. .git/ itself is
# the one thing that stays put regardless of what's checked out.
#
# Usage: scripts/dev/shared-clone-guard/install.sh [path-to-clone]
# Defaults to the clone this script itself lives in.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-$(cd "$here/../../.." && pwd)}"

common_dir="$(git -C "$target" rev-parse --git-common-dir)"
case "$common_dir" in
  /*) : ;;
  *) common_dir="$target/$common_dir" ;;
esac
common_dir="$(cd "$common_dir" && pwd)"

dest="$common_dir/dev-guards"
mkdir -p "$dest"
cp "$here/lib.sh" "$here/pre-commit-hook.sh" "$here/shared-clone-guard.sh" "$dest/"
chmod +x "$dest"/*.sh

hooks_dir="$common_dir/hooks"
mkdir -p "$hooks_dir"
if [[ -e "$hooks_dir/pre-commit" ]] && ! grep -q "AUR-4564" "$hooks_dir/pre-commit" 2>/dev/null; then
  echo "REFUSING to overwrite existing $hooks_dir/pre-commit (no AUR-4564 marker found) -- merge by hand." >&2
  exit 1
fi
cp "$dest/pre-commit-hook.sh" "$hooks_dir/pre-commit"
chmod +x "$hooks_dir/pre-commit"

# `git config alias.checkout` / `alias.stash` do NOT work: git dispatches
# known built-in subcommand names before it ever consults [alias] (verified
# empirically -- see shared-clone-guard.sh header). The only interception
# point that works is a `git` shell function sourced into the shell profile,
# same mechanism as the sibling AUR-3258 git-safety-guard.sh. Wire it in
# idempotently, appended after any existing git-safety-guard.sh line so it
# composes on top rather than racing it.
profile="${SCG_PROFILE:-$HOME/.bashrc}"
marker="AUR-4564 shared-clone guard"
source_line="[ -f \"$dest/shared-clone-guard.sh\" ] && source \"$dest/shared-clone-guard.sh\""
if [[ -f "$profile" ]] && grep -qF "$marker" "$profile" 2>/dev/null; then
  echo "Profile $profile already wires in the AUR-4564 guard -- leaving it alone."
else
  {
    echo ""
    echo "# $marker: checkout/stash guard for the /home/ievgen/paperclip shared clone"
    echo "$source_line"
  } >> "$profile"
  echo "Appended AUR-4564 guard source line to $profile"
fi

echo "Installed AUR-4564 shared-clone guards into $common_dir"
echo "  hook:          $hooks_dir/pre-commit"
echo "  shell function: $dest/shared-clone-guard.sh (sourced from $profile)"
echo "  NOTE: the shell-function guard only takes effect in NEW shells that source $profile."
