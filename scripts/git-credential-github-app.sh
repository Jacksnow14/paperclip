#!/usr/bin/env bash
# Git credential-helper: mint a GitHub App installation token on demand.
#
# Wire it once (run manually after AUR-3033 human bootstrap):
#   git config credential.https://github.com.helper \
#     '!/home/ievgen/paperclip/scripts/git-credential-github-app.sh'
#
# Only handles the 'get' action; all others are no-ops (git expects this).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_SCRIPT="${SCRIPT_DIR}/github_app_token.py"

action="${1:-}"

if [[ "$action" == "get" ]]; then
    exec python3 "$TOKEN_SCRIPT" --git-credential
fi

# For 'store' / 'erase' / empty: no-op (tokens are ephemeral, nothing to persist/erase)
exit 0
