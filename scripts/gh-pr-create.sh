#!/usr/bin/env bash
# gh-pr-create.sh — version-independent GitHub PR creation.
#
# Tries `gh pr create` first (fast path when the local gh CLI cooperates),
# then falls back to a direct REST call (POST /repos/{owner}/{repo}/pulls)
# authenticated with the vault-held github_push_token. This makes PR
# creation independent of the gh CLI's version/auth quirks (this host runs
# gh 2.4.0 from 2022).
#
# Usage: gh-pr-create.sh --base <branch> --head <branch> --title <title> [--body <text>] [--repo owner/name]
#
# If a PR already exists for --head, prints its existing URL and exits 0
# instead of erroring (idempotent).
#
# NEVER prints, logs, or echoes the token.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE=""
HEAD=""
TITLE=""
BODY=""
REPO_SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --repo) REPO_SLUG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BASE" || -z "$HEAD" || -z "$TITLE" ]]; then
  echo "usage: gh-pr-create.sh --base <branch> --head <branch> --title <title> [--body <text>] [--repo owner/name]" >&2
  exit 2
fi

if [[ -z "$REPO_SLUG" ]]; then
  origin_url="$(git config --get remote.origin.url || true)"
  # https://github.com/OWNER/REPO.git or git@github.com:OWNER/REPO.git
  REPO_SLUG="$(echo "$origin_url" | sed -E 's#(git@|https://)github\.com[:/]##; s#\.git$##')"
fi
if [[ -z "$REPO_SLUG" || "$REPO_SLUG" != */* ]]; then
  echo "gh-pr-create.sh: could not determine owner/repo from remote.origin.url" >&2
  exit 1
fi
OWNER="${REPO_SLUG%%/*}"
REPO="${REPO_SLUG##*/}"

find_existing_pr_url() {
  local token="$1"
  local resp
  resp="$(curl -sS \
    -H "Authorization: token ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${OWNER}/${REPO}/pulls?head=${OWNER}:${HEAD}&state=open")"
  python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and data:
    print(data[0].get('html_url', ''))
" <<<"$resp"
}

try_gh_cli() {
  command -v gh >/dev/null 2>&1 || return 1
  local out
  if out="$(gh pr create --base "$BASE" --head "$HEAD" --title "$TITLE" --body "$BODY" --repo "${OWNER}/${REPO}" 2>&1)"; then
    echo "$out" | grep -Eo 'https://github\.com/[^ ]+/pull/[0-9]+' | tail -1
    return 0
  fi
  if echo "$out" | grep -qi "already exists"; then
    return 2
  fi
  return 1
}

vault_token() {
  python3 -c "
import sys
sys.path.insert(0, '${SCRIPT_DIR}')
import secret_vault
f = secret_vault._load_key()
secrets = secret_vault._load_secrets(f)
rec = secrets.get('github_push_token')
if not rec or not rec.get('value'):
    sys.exit(1)
sys.stdout.write(rec['value'])
try:
    secret_vault._audit('get', 'github_push_token', 'via=gh-pr-create.sh')
except Exception:
    pass
"
}

rest_create_pr() {
  local token="$1"
  local payload http_code body url
  payload="$(python3 -c "
import json, sys
print(json.dumps({'title': sys.argv[1], 'head': sys.argv[2], 'base': sys.argv[3], 'body': sys.argv[4]}))
" "$TITLE" "$HEAD" "$BASE" "$BODY")"

  local tmp
  tmp="$(mktemp)"
  http_code="$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X POST \
    -H "Authorization: token ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${OWNER}/${REPO}/pulls" \
    -d "$payload")"
  body="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ "$http_code" == "201" ]]; then
    url="$(python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('html_url',''))" <<<"$body")"
    echo "$url"
    return 0
  fi

  if echo "$body" | grep -qi "already exists"; then
    url="$(find_existing_pr_url "$token")"
    if [[ -n "$url" ]]; then
      echo "$url"
      return 0
    fi
  fi

  echo "gh-pr-create.sh: REST PR creation failed (HTTP ${http_code})" >&2
  echo "$body" | python3 -c "import json,sys
try:
    print('message:', json.loads(sys.stdin.read()).get('message',''))
except Exception:
    pass" >&2
  return 1
}

main() {
  local gh_rc
  set +e
  gh_out="$(try_gh_cli)"
  gh_rc=$?
  set -e

  if [[ $gh_rc -eq 0 && -n "$gh_out" ]]; then
    echo "$gh_out"
    exit 0
  fi

  token="$(vault_token)" || { echo "gh-pr-create.sh: no github_push_token in vault" >&2; exit 1; }

  if [[ $gh_rc -eq 2 ]]; then
    url="$(find_existing_pr_url "$token")"
    if [[ -n "$url" ]]; then
      echo "$url"
      exit 0
    fi
  fi

  rest_create_pr "$token"
}

main "$@"
