#!/usr/bin/env bash
# AUR-4564 shared-clone guard.
#
# /home/ievgen/paperclip is checked out by ~100 concurrent worktrees that all
# point at the SAME .git; that main checkout itself is the only one where a
# `git checkout <ref> -- <path>` or a whole-branch switch can silently
# overwrite another agent's uncommitted work with nothing warning either
# side (AUR-4531 lost a full patch this way). The stash stack is a second,
# wider hazard: it is shared by the main clone AND every one of its linked
# worktrees, so a `git stash pop`/`drop` run from ANY of them can consume
# another agent's only copy of unrelated WIP (nearly happened live -- see the
# AUR-4564 issue thread).
#
# This was first attempted as `git config alias.checkout '!...'` /
# `alias.stash '!...'`. That does not work: git dispatches known built-in
# subcommand names before it ever consults [alias] (verified empirically --
# aliasing `checkout`, `status`, and `log` on this git build was silently
# never invoked; only a *new* alias name fired). The one interception point
# that does work is a `git` shell function, which is how the sibling AUR-3258
# dirty-tree guard (scripts/git-safety-guard.sh) already operates. This file
# composes with whatever `git` function is already defined (from AUR-3258 or
# elsewhere) instead of clobbering it, regardless of which one is sourced
# first.
#
# Limitation, stated plainly: like any shell-function guard, this only
# intercepts `git` invoked as a bare command name from a shell that has
# sourced this file (which is how the harness runs every agent's Bash-tool
# commands -- "shell environment is initialized from the user's profile").
# It does not intercept `/usr/bin/git` called by absolute path, a non-bash
# tool, or a shell started with --norc. It is a strong deterrent for the
# actual, dominant failure mode, not a kernel-level access-control boundary.
# The pre-commit hook (installed separately, see install.sh) IS a hard
# boundary for commits specifically, since git hooks fire regardless of how
# git was invoked.
#
# Install (per shell profile), typically after any existing
# git-safety-guard.sh line:
#   source /path/to/dev-guards/shared-clone-guard.sh
#
# Override once ownership of a stash entry is verified by hand:
#   SCG_STASH_FORCE=1 git stash pop

SCG_MAIN_CLONE=${SCG_MAIN_CLONE:-/home/ievgen/paperclip}

__scg_main_clone_root() {
  local common_dir
  common_dir=$(command git rev-parse --git-common-dir 2>/dev/null) || return 1
  (cd "$common_dir" && cd .. && pwd)
}

__scg_in_main_clone() {
  local toplevel
  toplevel=$(command git rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ "$toplevel" == "$SCG_MAIN_CLONE" ]] || return 1
  [[ "$(__scg_main_clone_root 2>/dev/null)" == "$SCG_MAIN_CLONE" ]]
}

# In scope for the stash guard: the main clone itself OR any of its linked
# worktrees (they all share one stash stack).
__scg_shares_main_clone_stash() {
  [[ "$(__scg_main_clone_root 2>/dev/null)" == "$SCG_MAIN_CLONE" ]]
}

__scg_refuse() {
  cat >&2 <<EOF
REFUSED (AUR-4564): $1

$SCG_MAIN_CLONE is the shared clone: every agent's checkout of that exact
path is the SAME working tree (and, for stash, the same stack shared by all
~100 of its worktrees too), so uncommitted or unstashed work there can be
destroyed by another agent with nothing warning either side.
EOF
}

__scg_checkout_is_path_restricted() {
  local saw_dashdash=false a
  for a in "$@"; do [[ "$a" == "--" ]] && saw_dashdash=true; done
  $saw_dashdash && return 0
  [[ $# -eq 1 && "$1" == "." ]] && return 0
  return 1
}

__scg_stash_attributed() {
  local target="$1" raw_msg custom_msg branch issue_token
  raw_msg=$(command git log -1 --format=%s "$target" 2>/dev/null) || return 1

  # git ALWAYS prefixes a stash entry's message with "On <branch>: " (or
  # "WIP on <branch>: " for a plain `git stash` with no -m) -- so matching
  # the raw message against the CURRENT branch name would spuriously
  # "attribute" every entry ever pushed while on that branch to whoever is on
  # it now. That defeats the guard precisely in the shared-clone case, where
  # the main clone's checked-out branch is generic/shared. Only trust the
  # part of the message the pusher actually chose to write.
  custom_msg="${raw_msg#On *: }"
  if [[ "$custom_msg" == "$raw_msg" ]]; then
    custom_msg="${raw_msg#WIP on *: }"
  fi
  [[ "$custom_msg" == "$raw_msg" ]] && custom_msg=""

  [[ -z "$custom_msg" ]] && return 1

  branch=$(command git rev-parse --abbrev-ref HEAD 2>/dev/null)
  issue_token=$(grep -ioE 'aur-?[0-9]+' <<<"$branch" | head -1)
  [[ -n "$branch" && "$custom_msg" == *"$branch"* ]] && return 0
  [[ -n "$issue_token" && "${custom_msg,,}" == *"${issue_token,,}"* ]] && return 0
  [[ -n "${PAPERCLIP_STASH_OWNER_TOKEN:-}" && "$custom_msg" == *"$PAPERCLIP_STASH_OWNER_TOKEN"* ]] && return 0
  return 1
}

# Preserve any `git` function already defined (e.g. AUR-3258's dirty-tree
# guard) under a fixed name so this layers on top instead of replacing it,
# no matter which file was sourced first. Re-sourcing this file is a no-op
# (idempotent): it won't re-wrap itself.
if declare -F git >/dev/null && [[ "$(declare -f git)" != *__scg_next_git* ]]; then
  eval "$(declare -f git | sed '1s/^git /__scg_next_git /')"
elif ! declare -F __scg_next_git >/dev/null; then
  __scg_next_git() { command git "$@"; }
fi

git() {
  local sub="${1:-}"

  if [[ "$sub" == "checkout" ]] && __scg_in_main_clone; then
    shift
    if __scg_checkout_is_path_restricted "$@"; then
      __scg_refuse "git checkout -- <path> (force-overwrites paths from another ref, bypassing git's own dirty-tree protection). Use a dedicated worktree: git -C \"$SCG_MAIN_CLONE\" worktree add \"$SCG_MAIN_CLONE-<issue>\" -b <branch> origin/master"
      return 3
    fi
    __scg_next_git checkout "$@"
    return $?
  fi

  if [[ "$sub" == "stash" ]] && __scg_shares_main_clone_stash; then
    local action="${2:-push}"
    if [[ "$action" == "clear" ]]; then
      __scg_refuse "git stash clear drops every entry in the shared stack, never just yours. Drop entries individually with 'git stash drop stash@{N}' after confirming ownership."
      return 3
    fi
    if [[ "$action" == "pop" || "$action" == "drop" ]]; then
      local target="" a
      for a in "${@:3}"; do
        [[ "$a" == -* ]] && continue
        target="$a"
        break
      done
      [[ -z "$target" ]] && target="stash@{0}"
      if [[ "${SCG_STASH_FORCE:-0}" != "1" ]] && ! __scg_stash_attributed "$target"; then
        local msg
        msg=$(command git log -1 --format=%s "$target" 2>/dev/null)
        __scg_refuse "$action $target does not look like it belongs to you (entry message: '${msg:-<unreadable>}'). Verify with 'git stash show -p $target', then retry with SCG_STASH_FORCE=1 git stash $action $target."
        return 3
      fi
    fi
  fi

  __scg_next_git "$@"
}
