#!/usr/bin/env bash
# AUR-4134: refuse to delete the release a live process is executing from.
#
# WHY THIS EXISTS. On 2026-07-25 22:01:28Z `build-release.sh` deleted
# /opt/paperclip/app/releases/aaac1485b86a while the production server was
# running out of it. Production served from a deleted directory for 15m47s and
# survived only because the kernel pins inodes for already-loaded modules; any
# lazy require, dynamic import, static asset read or migration read in that
# window would have failed. (AUR-4127.)
#
# It was NOT `--force`. `--force` only ever removes the release being built.
# The culprit was the retention/prune loop, whose sole protection was
# `readlink -f "$path" == "$CURRENT_TARGET"`. That is the wrong invariant,
# because build-release.sh deliberately never restarts the service — so between
# `--activate` and the next restart, `current` points at the release that will
# run NEXT while a different release is still executing. The prune had no
# concept of the latter.
#
# THE PREDICATE (verified against the loop by CTO+CEO on AUR-4127). The old
# prune deleted the running release R iff:
#
#     (a) R != current   AND   (b) >=2 non-current dirs are newer than R
#
# Two distinct ways in, and a guard keyed on `current` catches neither:
#   1. `--activate` of a new release flips (a) true and prunes in the SAME
#      invocation ~5s later, if two stale builds already sat newer than R.
#      This is the 25 Jul incident.
#   2. During an already-open activate->restart window, (a) is already true, so
#      two ordinary builds with NO `--activate` anywhere also satisfy (b).
#      This is the routine "iterating on a build failure after a deploy" case.
#
# So the guard's PRIMARY key is WHAT IS ACTUALLY RUNNING, read from /proc, and
# never `current` alone — `current` is precisely what stops pointing at
# production. That invariant holds no matter which path got you there, which
# matters because both of us enumerated the kill paths wrong at least once
# while analysing this.
#
# But "running" is necessary, not sufficient. Reviewing this change (@CEO,
# AUR-4127), the guard and the retention loop were found to disagree:
# prune_releases protected running + `current` + `previous`, while
# assert_deletable — the function that actually gates every `rm -rf` — refused
# only what was running. So `build-release.sh --force` against the
# just-activated release still deleted it, because between `--activate` and the
# next restart that release is `current` and NOT yet running. That dangles
# `current` for the length of a full clone + pnpm install + two builds, with
# paperclip-oom-guard.timer live and able to restart the unit into a symlink
# pointing at nothing. `previous` matters for the same class of reason: it is
# the rollback target, and losing it turns a bad deploy into an outage.
#
# The protected set is therefore the UNION — running ∪ current ∪ previous —
# and it is enforced in ONE place (assert_deletable) so the two `rm -rf` call
# sites cannot drift apart again. AUR-4127 scope 3 asked for exactly this: make
# it impossible to delete what `current` resolves to, in the inner script.
#
# Sourceable with no side effects: `source release-guard.sh` defines functions
# and does nothing else, so the tests exercise the real /proc logic rather than
# a mock.

# The removal command. Overridable ONLY so the hermetic test can avoid sudo.
# This is not a safety bypass: it cannot skip assert_deletable, which every
# call site invokes first.
PAPERCLIP_DEPLOY_RM=${PAPERCLIP_DEPLOY_RM:-"sudo rm -rf"}

# Print the release directory names that at least one live process is using.
#
# Union of two independent probes, because either alone can miss:
#   - cwd:     the production server runs with cwd inside its release dir
#              (verified: pid 733305 -> releases/3ed5204b0cef).
#   - cmdline: catches a process launched from the release that later chdir'd
#              away, which cwd alone would miss.
# Unreadable /proc entries are skipped, not treated as absent — see
# running_probe_ok below for the fail-safe.
#
# Runs entirely inside a subshell with `set +e` and pipefail cleared. That is
# deliberate and load-bearing: callers (build-release.sh) run under
# `set -euo pipefail`, and processes routinely exit between globbing /proc and
# reading their entries, so an unreadable /proc/<pid>/cmdline redirect would
# otherwise abort a deploy mid-flight. A transient scan error must never be
# able to kill the build — and, per assert_deletable, must never be silently
# read as "nothing is running" either.
detect_running_releases() {
  local app_root=$1
  (
    set +e +o pipefail
    local releases_dir="$app_root/releases" p cwd rest name arg
    {
      for p in /proc/[0-9]*; do
        cwd=$(readlink -f "$p/cwd" 2>/dev/null)
        case "${cwd:-}/" in
          "$releases_dir"/*)
            rest=${cwd#"$releases_dir"/}
            name=${rest%%/*}
            [[ -n "$name" ]] && printf '%s\n' "$name"
            ;;
        esac
        # cmdline is NUL-separated; a release path may appear in any argument.
        # Catches a process launched from a release that later chdir'd away.
        [[ -r "$p/cmdline" ]] || continue
        while IFS= read -r -d '' arg; do
          case "$arg" in
            "$releases_dir"/*)
              rest=${arg#"$releases_dir"/}
              name=${rest%%/*}
              [[ -n "$name" ]] && printf '%s\n' "$name"
              ;;
          esac
        done < "$p/cmdline" 2>/dev/null
      done
    } | sort -u
  )
}

# Fail-safe: can we enumerate processes at all? If /proc is not readable we
# cannot prove a release is idle, so callers must refuse to delete rather than
# assume it is safe. Unknown protects; it never permits.
running_probe_ok() {
  [[ -r /proc/self/cwd || -d /proc/self ]]
}

# Resolve a symlink to the release directory NAME it points at, or empty.
release_name_of_link() {
  local link=$1 target
  [[ -L "$link" ]] || return 0
  target=$(readlink -f "$link" 2>/dev/null) || return 0
  [[ -n "$target" ]] || return 0
  printf '%s\n' "${target##*/}"
}

# Refuse to delete a release that is running, is `current`, is `previous`, or
# sits outside releases/. Every `rm -rf` site in the deploy path MUST call this
# first — this function, not the caller, is where the protected set is defined.
assert_deletable() {
  local app_root=$1 path=$2
  local name running link

  # Structural: never rm -rf anything that is not a direct child of releases/.
  case "$path" in
    "$app_root/releases/"?*) ;;
    *) echo "refusing to delete '$path': not a release directory under $app_root/releases" >&2; return 1 ;;
  esac
  case "${path#"$app_root/releases/"}" in
    */*|.|..) echo "refusing to delete '$path': not a direct child of releases/" >&2; return 1 ;;
  esac

  if ! running_probe_ok; then
    echo "refusing to delete '$path': cannot read /proc, so cannot prove no process is running from it" >&2
    return 1
  fi

  name=${path##*/}
  while IFS= read -r running; do
    [[ -n "$running" ]] || continue
    if [[ "$running" == "$name" ]]; then
      echo "refusing to delete '$path': a live process is executing from this release (AUR-4127)" >&2
      return 1
    fi
  done < <(detect_running_releases "$app_root")

  # Not running, but still undeletable: `current` is what the next start will
  # serve (deleting it dangles the symlink through a whole rebuild) and
  # `previous` is the rollback target. Checked here rather than only in
  # prune_releases so that --force, which calls no retention code at all, is
  # covered by the same rule. To rebuild the active sha, activate another
  # release (or roll back) first — that is the operation you actually want.
  for link in current previous; do
    if [[ "$(release_name_of_link "$app_root/$link")" == "$name" ]]; then
      echo "refusing to delete '$path': it is the '$link' release ($link -> releases/$name); activate a different release first (AUR-4127)" >&2
      return 1
    fi
  done
  return 0
}

# Retention. Never reaps: anything running, `current`, or `previous`
# (`previous` is required for rollback). Keeps $keep releases beyond that
# protected set — the protected set is not charged against the keep budget,
# which is the bug in the old "keep active + 2 most recent" phrasing.
prune_releases() {
  local app_root=$1 keep=${2:-2}
  local releases_dir="$app_root/releases"
  local protected=() kept=0 dir path name

  [[ -d "$releases_dir" ]] || return 0

  while IFS= read -r name; do
    [[ -n "$name" ]] && protected+=("$name")
  done < <(detect_running_releases "$app_root")

  for name in "$(release_name_of_link "$app_root/current")" \
              "$(release_name_of_link "$app_root/previous")"; do
    [[ -n "$name" ]] && protected+=("$name")
  done

  if [[ ${#protected[@]} -gt 0 ]]; then
    echo "    protected: $(printf '%s ' "${protected[@]}")(running / current / previous)"
  fi

  # SC2045: a glob cannot sort by mtime, and newest-first ordering IS the
  # retention policy. Release dir names are 12-char hex shas — no spaces, no
  # globs — so word-splitting `ls -1t` is safe here. Preserved from the
  # original loop deliberately: this change is about WHAT is protected, not
  # about re-litigating the ordering.
  # shellcheck disable=SC2045
  for dir in $(ls -1t "$releases_dir" 2>/dev/null); do
    path="$releases_dir/$dir"
    if [[ " ${protected[*]-} " == *" $dir "* ]]; then
      continue
    fi
    kept=$((kept + 1))
    if [[ "$kept" -gt "$keep" ]]; then
      if ! assert_deletable "$app_root" "$path"; then
        echo "    skipping $path (guard refused)"
        continue
      fi
      echo "    pruning $path"
      $PAPERCLIP_DEPLOY_RM "$path"
    fi
  done
}

# The invariant, asserted after any prune. Independent of how the protected set
# was computed, so it still catches a kill path nobody enumerated.
assert_running_releases_intact() {
  local app_root=$1 name rc=0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ ! -d "$app_root/releases/$name" ]]; then
      echo "FATAL: release '$name' has a live process but its directory is gone" >&2
      rc=1
    fi
  done < <(detect_running_releases "$app_root")
  return $rc
}
