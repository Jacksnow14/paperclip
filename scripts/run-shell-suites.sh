#!/usr/bin/env bash
# Shell-suite runner for the scripts-test CI job (AUR-4675, fixing AUR-4042).
#
# Before this existed, the scripts-test job ran `node --test scripts/` only:
# every one of the *.test.sh suites under scripts/ was silently never
# executed, and the job reported success while asserting nothing about them —
# a green-and-meaningless gate. This runner executes each shell suite and,
# critically, FAILS LOUDLY IF DISCOVERY FINDS ZERO SUITES: a discovery
# pattern that silently matches nothing is the exact rot mode that produced
# AUR-4042 in the first place.
#
# Suites are expected to self-guard host dependencies (auto-deploy.test.sh
# exits 0 with a SKIP notice when no systemd --user manager is reachable;
# paperclip-mem-watch.test.sh runs its canonical-source drift check only on
# the prod host). A suite that cannot run its environment must SKIP loudly,
# never fail silently — and never silently pass while asserting nothing.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mapfile -t SUITES < <(git ls-files 'scripts/*.test.sh' 'scripts/**/*.test.sh' | sort -u)

if [[ ${#SUITES[@]} -eq 0 ]]; then
  echo "FATAL: zero shell test suites discovered under scripts/ — discovery is broken, refusing to report green" >&2
  exit 1
fi

echo "discovered ${#SUITES[@]} shell suites"
FAILED=()
for suite in "${SUITES[@]}"; do
  echo "=== ${suite} ==="
  if timeout 300 bash "$suite"; then
    echo "--- ${suite}: PASS"
  else
    rc=$?
    echo "--- ${suite}: FAIL (rc=${rc})" >&2
    FAILED+=("$suite")
  fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "shell suites FAILED (${#FAILED[@]}/${#SUITES[@]}): ${FAILED[*]}" >&2
  exit 1
fi
echo "all ${#SUITES[@]} shell suites passed"
