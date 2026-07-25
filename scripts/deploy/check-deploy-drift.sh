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
#
# ESCALATION (added 2026-07-25). The first version of this check fired DRIFT
# every 15 minutes for a full day into an empty room: a detector that correctly
# identifies a production defect and escalates to no one is not a control, it is
# noise that trains us to ignore it. Sustained drift now reaches the founder on
# the one channel proven to work (Telegram, see /home/ievgen/bot/notify_founder.sh
# and AUR-3930) — but GRADED, because the two drift classes are not the same
# event:
#
#   provenance  (untracked-or-unreachable:*, armed-release-not-live)
#               Production is running something we cannot map to a commit, or a
#               deploy was armed and silently never took effect. This is the
#               July 20 incident. Threshold: 2h.
#   deploy-debt (behind-origin-master)
#               Production runs a real, pinned, reviewed commit that is simply
#               older than master. This is the EXPECTED state for a while after
#               every single merge. Paging on it at 2h would page on every merge
#               and re-create the exact alarm fatigue this block exists to stop.
#               Threshold: 24h.
#
# Sustained duration is derived from the drift log itself (the run of consecutive
# lines carrying the same reason), so there is no separate state to get stale.
# Alerts are rate-limited per reason. Delivery failure is logged loudly and never
# swallowed — see AUR-3930 on channels that print "sent" for undelivered messages.
set -uo pipefail

HEALTH_URL=${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}
REMOTE=${PAPERCLIP_DEPLOY_REMOTE:-https://github.com/Jacksnow14/paperclip.git}
APP_ROOT=${PAPERCLIP_DEPLOY_APP_ROOT:-/opt/paperclip/app}
DRIFT_LOG=${PAPERCLIP_DRIFT_LOG:-/var/log/paperclip-deploy-drift.log}
ALERT_STATE=${PAPERCLIP_DRIFT_ALERT_STATE:-/var/log/paperclip-deploy-drift.alert-state}
NOTIFY=${PAPERCLIP_DRIFT_NOTIFY:-/home/ievgen/bot/notify_founder.sh}
PROVENANCE_THRESHOLD_SEC=${PAPERCLIP_DRIFT_PROVENANCE_THRESHOLD_SEC:-7200}
DEBT_THRESHOLD_SEC=${PAPERCLIP_DRIFT_DEBT_THRESHOLD_SEC:-86400}
ALERT_COOLDOWN_SEC=${PAPERCLIP_DRIFT_ALERT_COOLDOWN_SEC:-21600}
ISSUE_URL=${PAPERCLIP_DRIFT_ISSUE_URL:-https://paperclip/AUR/issues/AUR-3937}

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

if [[ "$status" != "DRIFT" ]]; then
  exit 0
fi

echo "paperclip deploy drift: $reason (running=${running_sha:0:12} master=${master_sha:0:12})" >&2

# --- escalation gate -------------------------------------------------------
# Decides, from the drift log + the alert-state file, whether this sustained
# drift has earned a founder page. Prints "ALERT<TAB><text>" or "QUIET<TAB><why>".
decision=$(
  DRIFT_LOG="$DRIFT_LOG" ALERT_STATE="$ALERT_STATE" REASON="$reason" \
  PROVENANCE_THRESHOLD_SEC="$PROVENANCE_THRESHOLD_SEC" DEBT_THRESHOLD_SEC="$DEBT_THRESHOLD_SEC" \
  ALERT_COOLDOWN_SEC="$ALERT_COOLDOWN_SEC" RUNNING_SHA="${running_sha:0:12}" \
  MASTER_SHA="${master_sha:0:12}" ISSUE_URL="$ISSUE_URL" \
  python3 -c '
import os, time, calendar

reason = os.environ["REASON"]
now = int(time.time())

if reason.startswith("untracked-or-unreachable") or reason == "armed-release-not-live":
    klass, threshold = "provenance", int(os.environ["PROVENANCE_THRESHOLD_SEC"])
elif reason == "behind-origin-master":
    klass, threshold = "deploy-debt", int(os.environ["DEBT_THRESHOLD_SEC"])
else:
    print("QUIET\tunclassified-reason:%s" % reason); raise SystemExit(0)

# Sustained-since = start of the trailing run of consecutive same-reason DRIFT
# lines. Any ok/UNKNOWN/different-reason line in between resets the clock.
since = now
try:
    with open(os.environ["DRIFT_LOG"]) as fh:
        lines = [l.strip() for l in fh if l.strip()]
except OSError:
    lines = []

for line in reversed(lines):
    fields = dict(
        p.split("=", 1) for p in line.split() if "=" in p and not p.endswith("Z")
    )
    if fields.get("status") != "DRIFT" or fields.get("reason") != reason:
        break
    stamp = line.split(None, 1)[0]
    try:
        since = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        break

sustained = max(0, now - since)
if sustained < threshold:
    print("QUIET\tsustained=%ds < %s threshold=%ds" % (sustained, klass, threshold))
    raise SystemExit(0)

# Rate limit per reason so a genuine sustained drift pages once per cooldown,
# not once per 15-minute timer tick.
state_path = os.environ["ALERT_STATE"]
fallback_path = "/tmp/paperclip-deploy-drift.alert-state"
state = {}
for path in (state_path, fallback_path):
    try:
        with open(path) as fh:
            for l in fh:
                if "\t" in l:
                    k, v = l.rstrip("\n").split("\t", 1)
                    state[k] = v
        break
    except OSError:
        continue

cooldown = int(os.environ["ALERT_COOLDOWN_SEC"])
last = int(state.get(reason, 0) or 0)
if now - last < cooldown:
    print("QUIET\tcooldown active (%ds since last alert < %ds)" % (now - last, cooldown))
    raise SystemExit(0)

state[reason] = str(now)


def write_state(path):
    with open(path, "w") as fh:
        for k, v in sorted(state.items()):
            fh.write("%s\t%s\n" % (k, v))
    return path


# Losing the ability to rate-limit must never translate into losing the page.
# Silence is the failure mode this whole gate exists to prevent, so degrade to a
# writable fallback and, failing that, alert anyway rather than going quiet.
note = ""
try:
    write_state(state_path)
except OSError:
    try:
        write_state("/tmp/paperclip-deploy-drift.alert-state")
        note = " [rate-limit state fell back to /tmp: %s not writable]" % state_path
    except OSError as exc:
        note = " [UNRATE-LIMITED: no writable alert state (%s) — may repeat]" % exc

hours = sustained // 3600
text = (
    "Paperclip deploy drift sustained %dh (%s): %s. "
    "Production is running %s; origin/master is %s. %s%s"
    % (hours, klass, reason, os.environ["RUNNING_SHA"], os.environ["MASTER_SHA"],
       os.environ["ISSUE_URL"], note)
)
print("ALERT\t%s" % text)
' 2>/dev/null || printf 'QUIET\tescalation-gate-failed'
)

verdict=${decision%%$'\t'*}
detail=${decision#*$'\t'}

if [[ "$verdict" == "ALERT" ]]; then
  if [[ -x "$NOTIFY" ]] && "$NOTIFY" SEV2 "$detail"; then
    echo "paperclip deploy drift: escalated to founder (SEV2): $detail" >&2
  else
    # Never swallow a delivery failure — that is the exact failure shape
    # AUR-3930 documents. A missed page must be visible in the journal.
    echo "paperclip deploy drift: ESCALATION FAILED to deliver via $NOTIFY: $detail" >&2
  fi
else
  echo "paperclip deploy drift: not escalating ($detail)" >&2
fi

exit 1
