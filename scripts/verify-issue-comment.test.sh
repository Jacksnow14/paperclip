#!/usr/bin/env bash
# Regression harness for the vendored scripts/verify-issue-comment.sh wrapper
# (AUR-5601). Discovered and run by scripts/run-shell-suites.sh in CI.
#
# Guards against the two ways this wrapper can silently stop working:
#   1. it must resolve scripts/verify-issue-comment.mjs relative to ITSELF,
#      not relative to the caller's cwd, since the fleet-wide bootstrap shim
#      (/home/ievgen/bot/verify-issue-comment.sh) invokes it from an
#      extraction cache directory, never from this checkout's own cwd.
#   2. it must be executable and marked so in git (a mode regression breaks
#      `exec bash <path>` in the bootstrap shim, which does not go through a
#      shell that would auto-chmod).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/verify-issue-comment.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

[[ -f "$SCRIPT" ]] || { echo "FATAL: $SCRIPT not found" >&2; exit 1; }
[[ -x "$SCRIPT" ]] && ok "wrapper is executable" || bad "wrapper is not executable (git mode regression?)"

# No args -> the underlying .mjs prints its usage line and exits 2, without
# needing PAPERCLIP_API_KEY or network access.
out="$(cd /tmp && "$SCRIPT" 2>&1)"
rc=$?
if [[ $rc -eq 2 ]]; then ok "no-args exits 2"; else bad "no-args exit code (want 2, got $rc)"; fi
if [[ "$out" == *"Usage: node scripts/verify-issue-comment.mjs"* ]]; then
  ok "no-args prints usage from the underlying .mjs"
else
  bad "no-args usage output missing (got: $out)"
fi

# Run from an unrelated cwd to prove the script resolves its .mjs relative to
# its own location (BASH_SOURCE), not the caller's cwd.
out="$(cd / && "$SCRIPT" 2>&1)"
rc=$?
if [[ $rc -eq 2 ]]; then
  ok "resolves its own .mjs regardless of caller cwd"
else
  bad "cwd-independence broke (rc=$rc, out: $out)"
fi

# issueId + missing body file -> the .mjs reports a read failure (still no
# network dependency) rather than a "file not found" from the wrapper itself.
# PAPERCLIP_API_KEY is forced to a dummy value so this assertion is
# deterministic regardless of whether the CI environment happens to have a
# real key set (the .mjs checks for a key before reading the body file).
out="$(PAPERCLIP_API_KEY=dummy "$SCRIPT" SOME-ISSUE /nonexistent/body-file 2>&1)"
rc=$?
if [[ $rc -eq 2 ]] && [[ "$out" == *"cannot read body file"* ]]; then
  ok "missing body file surfaces the .mjs's own error"
else
  bad "missing body file handling (rc=$rc, out: $out)"
fi

echo "verify-issue-comment.test.sh: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
