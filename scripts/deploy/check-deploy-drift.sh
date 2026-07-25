#!/usr/bin/env bash
# AUR-3937 acceptance item 4: nothing on this box compared deployed-SHA to
# origin/master, which is how production ran a five-day-stale artifact
# unnoticed. This check asks the RUNNING server what it is executing (not the
# checkout, not the artifact on disk), compares against origin/master, and
# fails loudly on any of:
#   - health unreachable            (can't prove anything)
#   - build.source != "release"     (unknown provenance — the July 20 incident)
#   - running != activated release  (a deploy was armed but never took effect)
#   - running != origin/master      (merged work is not live — the 14-merge debt)
#
# Emits one sampler-style line per run; exit 0 only when fully converged.
# Wired to a systemd timer by scripts/deploy/install-drift-timer.sh.
set -uo pipefail

HEALTH_URL=${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}
REMOTE=${PAPERCLIP_DEPLOY_REMOTE:-https://github.com/Jacksnow14/paperclip.git}
APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
DRIFT_LOG=${PAPERCLIP_DRIFT_LOG:-/var/log/paperclip-deploy-drift.log}

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

health=$(curl -sf -m 10 -H "Accept: application/json" "$HEALTH_URL" 2>/dev/null || true)
if [[ -n "$health" ]]; then
  read -r running_source running_sha < <(printf '%s' "$health" | python3 -c '
import json, sys
b = (json.load(sys.stdin).get("build") or {})
print(b.get("source") or "absent", b.get("sha") or "none")
' 2>/dev/null || echo "unparseable none")
else
  running_source=unreachable
  running_sha=none
fi

activated_sha=$(python3 -c "import json; print(json.load(open('$APP_ROOT/current/build-info.json'))['sha'])" 2>/dev/null || echo "none")
master_sha=$(git ls-remote "$REMOTE" refs/heads/master 2>/dev/null | cut -f1)
[[ -n "$master_sha" ]] || master_sha=unknown

status=ok
reason=-
if [[ "$running_source" != "release" ]]; then
  status=DRIFT reason=untracked-or-unreachable:$running_source
elif [[ "$running_sha" != "$activated_sha" ]]; then
  status=DRIFT reason=armed-release-not-live
elif [[ "$master_sha" == "unknown" ]]; then
  status=UNKNOWN reason=remote-unreachable
elif [[ "$running_sha" != "$master_sha" ]]; then
  status=DRIFT reason=behind-origin-master
fi

line="$ts running=${running_sha:0:12} activated=${activated_sha:0:12} master=${master_sha:0:12} status=$status reason=$reason"
echo "$line"
echo "$line" >> "$DRIFT_LOG" 2>/dev/null || true
if [[ "$status" == "DRIFT" ]]; then
  echo "paperclip deploy drift: $reason (running=${running_sha:0:12} master=${master_sha:0:12})" >&2
  exit 1
fi
exit 0
