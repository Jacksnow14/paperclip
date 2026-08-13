#!/usr/bin/env bash
# Vendored, version-controlled implementation of the delivery-verification
# wrapper (AUR-5601, following AUR-4613/AUR-5577).
#
# Usage: verify-issue-comment.sh <issueId> <body-file> [minChars=2000]
#
# Posts the comment via scripts/verify-issue-comment.mjs, which re-reads it
# from the comments LIST endpoint and prints:
#   Verified: comment <id> (<N> chars)
# or exits non-zero. Paste the printed line into your handoff note.
#
# Before AUR-5601 the only copy of this wrapper lived untracked at
# /home/ievgen/bot/verify-issue-comment.sh: no history, no review, no CI, and
# a host rebuild or accidental delete would have silently removed the fleet's
# only compliant one-command delivery path.
#
# This vendored copy is the reviewed implementation: it runs the
# verify-issue-comment.mjs that sits next to it in THIS checkout, so the two
# files are always consistent by construction (same commit, no drift).
#
# /home/ievgen/bot/verify-issue-comment.sh is now a thin bootstrap shim that
# resolves the freshest copy of this file (and its dependencies) from the git
# object store and execs it, so a caller running the bootstrap always
# exercises the reviewed, tracked version rather than a possibly-stale
# on-disk copy. That resolution logic deliberately does NOT prefer the shared
# main clone's working tree — AUR-5577's fix reached nobody for that exact
# reason (the working tree was 44 commits behind and nothing auto-pulled it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/verify-issue-comment.mjs" "$@"
