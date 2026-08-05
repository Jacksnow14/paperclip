#!/usr/bin/env bash
# AUR-4564: installed as .git/hooks/pre-commit in the shared clone. Hooks live
# in the common git dir, so this ONE installation fires for a commit attempted
# from ANY worktree -- it must tell the main clone apart from a dedicated
# worktree itself rather than relying on where it's installed.
#
# lib.sh is intentionally NOT resolved relative to this file: install.sh puts
# this hook in "$common_dir/hooks/" but lib.sh in "$common_dir/dev-guards/"
# (dev-guards/ is shared with the checkout/stash aliases, hooks/ is git's own
# fixed location for this file) -- so this must look lib.sh up via the common
# git dir at run time, the same way lib.sh looks up the main clone root.
set -uo pipefail

common_dir=$(git rev-parse --git-common-dir 2>/dev/null) && common_dir=$(cd "$common_dir" && pwd)
guard_lib="${common_dir:-}/dev-guards/lib.sh"

if ! source "$guard_lib" 2>/dev/null; then
  echo "REFUSED (AUR-4564): pre-commit guard library missing/unreadable at $guard_lib -- re-run scripts/dev/shared-clone-guard/install.sh, or bypass deliberately with 'git commit --no-verify'." >&2
  exit 1
fi

if scg_in_main_clone; then
  scg_refuse "git commit"
  exit 1
fi

exit 0
