#!/usr/bin/env bash
# seed_admin_profile.sh — one-shot operator helper to seed a super-admin browser
# profile that scripts/browser_bridge.py can reuse headlessly.
#
# Why this exists: browser_bridge.py drives Playwright's *own* bundled Chromium
# against a persistent user-data-dir. Seeding must use the SAME binary + SAME
# profile dir so the cookie store (basic os_crypt on headless Linux) is readable
# by the later headless runs. Seeding with a different Chrome build risks version
# skew / cookie-decrypt failures.
#
# Usage (run inside the host VNC desktop, DISPLAY=:99):
#   scripts/seed_admin_profile.sh [profile-name]   # default: gworkspace-admin
#
# Then: complete the super-admin login + 2FA in the window, navigate to confirm
# admin.google.com loads, and CLOSE the browser window (cookies persist to disk).
set -euo pipefail

PROFILE="${1:-gworkspace-admin}"
PROFILE_DIR="/home/ievgen/browser-profiles/${PROFILE}"
URL="https://admin.google.com"

# Locate Playwright's bundled Chromium (the exact binary browser_bridge.py uses).
CHROME_BIN="$(python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)
PY
)"

if [[ -z "${CHROME_BIN}" || ! -x "${CHROME_BIN}" ]]; then
  echo "ERROR: could not locate Playwright chromium binary" >&2
  exit 1
fi

mkdir -p "${PROFILE_DIR}"
export DISPLAY="${DISPLAY:-:99}"

echo "Launching headed Chromium for seeding:"
echo "  binary : ${CHROME_BIN}"
echo "  profile: ${PROFILE_DIR}"
echo "  display: ${DISPLAY}"
echo "  url    : ${URL}"
echo
echo ">> Log in as a tryauranode.com super-admin, complete 2FA, then close the window."

exec "${CHROME_BIN}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --lang=en-US,en \
  "${URL}"
