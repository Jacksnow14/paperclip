#!/usr/bin/env bash
set -euo pipefail

# agent-gh-pr.sh — open or merge a GitHub PR for the current branch from an
# agent sandbox, with no `gh` CLI dependency. Uses git's configured credential
# helper for auth (token is never printed) and the GitHub REST API via curl.
#
# Usage:
#   ./scripts/agent-gh-pr.sh create [--base <branch>] [--title <t>] [--body <b>] [--draft] [--no-push]
#   ./scripts/agent-gh-pr.sh merge  <pr-number> [--method squash|merge|rebase]
#
# create:
#   - Pushes the current branch to origin (unless --no-push).
#   - Opens a PR from the current branch into <base> (default: master).
#   - Title defaults to the latest commit subject; body to the commit body.
#   - Prints the PR URL on success.
#
# merge:
#   - Merges an existing PR by number (default method: squash).
#   - Merging is a production-risk action; only run it after review/approval.
#
# Auth: resolved from `git credential fill` for host github.com (the same
# credential git push uses). Requires a token with `repo` scope. The token is
# read into a variable and sent only in the Authorization header — it is never
# echoed to stdout/stderr or written to any file.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.github.com"

die() { echo "Error: $*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }
require git
require curl

gh_token() {
  local tok
  tok="$(printf 'protocol=https\nhost=github.com\n\n' | git -C "$REPO_ROOT" credential fill 2>/dev/null | sed -n 's/^password=//p')"
  [ -n "$tok" ] || die "No GitHub token found via git credential (host github.com). Configure a credential helper with a repo-scoped token."
  printf '%s' "$tok"
}

owner_repo() {
  local url
  url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || die "No 'origin' remote."
  # https://github.com/OWNER/REPO(.git)  or  git@github.com:OWNER/REPO(.git)
  url="${url%.git}"
  case "$url" in
    *github.com[:/]*) printf '%s' "${url#*github.com}" | sed -E 's#^[:/]##' ;;
    *) die "origin is not a github.com remote: $url" ;;
  esac
}

current_branch() {
  git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD
}

# POST/PUT/GET helper. $1=method $2=path $3=json-body(optional). Token passed via
# stdin to curl --config so it never appears in the process arg list.
api() {
  local method="$1" path="$2" body="${3:-}" token
  token="$(gh_token)"
  local args=(--silent --show-error --fail-with-body -X "$method"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "$body" ]; then args+=(-d "$body"); fi
  printf 'header = "Authorization: token %s"\n' "$token" | \
    curl "${args[@]}" --config - "$API$path"
}

json_escape() { python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"; }
json_get() { python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get(sys.argv[1],""))' "$1"; }

cmd_create() {
  local base="master" title="" body="" draft=false push=true
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) base="$2"; shift ;;
      --title) title="$2"; shift ;;
      --body) body="$2"; shift ;;
      --draft) draft=true ;;
      --no-push) push=false ;;
      *) die "unknown create arg: $1" ;;
    esac
    shift
  done

  local branch repo
  branch="$(current_branch)"
  [ "$branch" != "HEAD" ] || die "detached HEAD; checkout a branch first."
  [ "$branch" != "$base" ] || die "current branch equals base ($base); nothing to PR."
  repo="$(owner_repo)"

  if [ "$push" = true ]; then
    git -C "$REPO_ROOT" push -u origin "$branch" >&2
  fi

  [ -n "$title" ] || title="$(git -C "$REPO_ROOT" log -1 --pretty=%s)"
  [ -n "$body" ]  || body="$(git -C "$REPO_ROOT" log -1 --pretty=%b)"

  local payload
  payload="$(python3 -c 'import json,sys
print(json.dumps({"title":sys.argv[1],"head":sys.argv[2],"base":sys.argv[3],"body":sys.argv[4],"draft":sys.argv[5]=="true"}))' \
    "$title" "$branch" "$base" "$body" "$draft")"

  local resp url
  resp="$(api POST "/repos/$repo/pulls" "$payload")"
  url="$(printf '%s' "$resp" | json_get html_url)"
  [ -n "$url" ] || { printf '%s\n' "$resp" >&2; die "PR creation failed (see response above)."; }
  echo "$url"
}

cmd_merge() {
  local num="" method="squash"
  while [ $# -gt 0 ]; do
    case "$1" in
      --method) method="$2"; shift ;;
      *) [ -z "$num" ] && num="$1" || die "unexpected merge arg: $1" ;;
    esac
    shift
  done
  [ -n "$num" ] || die "merge requires a PR number."
  local repo payload resp merged
  repo="$(owner_repo)"
  payload="$(python3 -c 'import json,sys;print(json.dumps({"merge_method":sys.argv[1]}))' "$method")"
  resp="$(api PUT "/repos/$repo/pulls/$num/merge" "$payload")"
  merged="$(printf '%s' "$resp" | json_get merged)"
  [ "$merged" = "True" ] || { printf '%s\n' "$resp" >&2; die "merge failed (see response above)."; }
  echo "Merged PR #$num into $repo via $method."
}

sub="${1:-}"; shift || true
case "$sub" in
  create) cmd_create "$@" ;;
  merge)  cmd_merge "$@" ;;
  ""|-h|--help)
    sed -n '4,33p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown subcommand: $sub (use create|merge)" ;;
esac
