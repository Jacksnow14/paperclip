#!/usr/bin/env bash
# AUR-4564 / AUR-6017: shared detection library for the shared-clone guards.
# Installed per-repo (each shared clone -- /home/ievgen/paperclip,
# /home/ievgen/Auranode -- gets its own copy in its own common git dir), so
# nothing here needs to hardcode which clone it's protecting.
#
# A main clone is a git worktree like any other, but it is the ONLY one
# whose .git is a real directory rather than a `gitdir:` pointer file --
# every linked worktree points back at it. That makes "is this the main
# worktree" a path-identity check, not a naming convention: worktree paths
# in this fleet are wildly inconsistent (paperclip-aurNNNN,
# paperclip-wt-aurNNNN, paperclip-worktrees/aurNNNN, pc-wt-aurNNNN,
# auranode-worktrees/aurNNNN, /tmp/aur-NNNN-*), so nothing that
# pattern-matches a path would be reliable.
set -uo pipefail

# Absolute path to the main worktree's working directory, derived from the
# common git dir (shared by every worktree, main or linked).
scg_main_clone_root() {
  local common_dir
  common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  (cd "$common_dir" && cd .. && pwd)
}

# True (exit 0) when the current working directory's worktree IS the main
# clone -- i.e. the one no agent should ever write to directly.
scg_in_main_clone() {
  local toplevel main_root
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  main_root=$(scg_main_clone_root) || return 1
  [[ "$toplevel" == "$main_root" ]]
}

scg_refuse() {
  local verb="$1" main_root
  main_root=$(scg_main_clone_root 2>/dev/null || echo "the shared clone")
  cat >&2 <<EOF
REFUSED (AUR-4564): $verb in $main_root is not allowed.

$main_root is the shared clone: every agent's checkout of that exact path is
the SAME working tree, so uncommitted or unstashed work there is destroyed
the moment another agent switches branches or pops the wrong stash entry --
with nothing warning either side. Only reads (log/diff/show/status) are safe
here.

Use a dedicated worktree instead:
  git -C "$main_root" worktree add "$main_root-<issue>" -b <branch> origin/<default-branch>
then run "$verb" inside "$main_root-<issue>".

To remove this worktree when done:
  git -C "$main_root" worktree remove "$main_root-<issue>"
EOF
  return 1
}
