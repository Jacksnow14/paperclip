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
# and AUR-3930) — but GRADED, because the drift classes are not the same event.
#
# RETUNED for auto-deploy (AUR-4028): once the arm automation exists, a
# threshold tuned for the manual world is wrong. The daemon writes a state file
# (armed SHA, waiting-since, running count, last tick); this check reads it and
# splits "armed but not live" by what the daemon CLAIMS to be doing. A stale
# state file is itself the "automation is dead" signal — deliberate: the
# daemon's death is detected by the same mechanism that reports its normal
# operation.
#
#   provenance  (untracked-or-unreachable:*, armed-release-not-live)
#               Production is running something we cannot map to a commit, or a
#               deploy was armed, the daemon is NOT claiming to be waiting
#               (state file stale or phase inconsistent) and it never took
#               effect — the auto-deploy timer is dead or wedged. Threshold: 2h.
#   quiescence-wait (awaiting-quiescence)
#               Armed, daemon alive, waiting because running > 0. EXPECTED
#               post-merge state on a busy box: zero-running windows recur
#               several times daily but gaps reached 5.7 h on the day measured
#               (AUR-4020). Paging at 2h would fire on most merges. Threshold:
#               12h. Alert text carries the running count and wait duration.
#   dark-armed  (armed-restart-disabled)
#               Armed, daemon alive, restart half deliberately disabled
#               (PAPERCLIP_AUTO_RESTART_ENABLED=0 — the AUR-4028 landing state
#               until AUR-4032 arms it). Real reviewed commits sitting armed
#               for a day is still deploy debt: threshold 24h.
#   deploy-debt (behind-origin-master)
#               master moved and no release was even ARMED — the arm automation
#               is broken (it should arm within one 10-min tick). Threshold: 1h
#               (measured build wall time ~2.5 min; 2x that is far under the
#               1h floor, so the floor applies).
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
# 1h (was 24h): with auto-arm live, behind-origin-master means the arm
# automation is broken, not "someone forgot" (AUR-4028).
DEBT_THRESHOLD_SEC=${PAPERCLIP_DRIFT_DEBT_THRESHOLD_SEC:-3600}
QUIESCENCE_THRESHOLD_SEC=${PAPERCLIP_DRIFT_QUIESCENCE_THRESHOLD_SEC:-43200}
DARK_THRESHOLD_SEC=${PAPERCLIP_DRIFT_DARK_THRESHOLD_SEC:-86400}
ALERT_COOLDOWN_SEC=${PAPERCLIP_DRIFT_ALERT_COOLDOWN_SEC:-21600}
ISSUE_URL=${PAPERCLIP_DRIFT_ISSUE_URL:-https://paperclip/AUR/issues/AUR-3937}
AD_STATE_FILE=${PAPERCLIP_AUTO_DEPLOY_STATE:-/var/lib/paperclip/auto-deploy.state}
# Fresh = within 3 timer periods of the 10-min auto-deploy tick.
STATE_FRESH_SEC=${PAPERCLIP_DRIFT_STATE_FRESH_SEC:-1800}

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

# Auto-deploy daemon state (AUR-4028). ad_fresh=1 means the daemon ticked
# recently enough that its phase claim is believable.
ad_phase=- ad_armed=- ad_last_tick= ad_running_count=- ad_waiting_since=-
if [[ -r "$AD_STATE_FILE" ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      phase) ad_phase=$v ;;
      armed_sha) ad_armed=$v ;;
      last_tick) ad_last_tick=$v ;;
      running_count) ad_running_count=$v ;;
      waiting_since) ad_waiting_since=$v ;;
    esac
  done < "$AD_STATE_FILE"
fi
ad_fresh=0
if [[ -n "$ad_last_tick" ]]; then
  tick_epoch=$(date -u -d "$ad_last_tick" +%s 2>/dev/null || echo 0)
  (( $(date -u +%s) - tick_epoch <= STATE_FRESH_SEC )) && ad_fresh=1
fi

status=ok
reason=-
if [[ "$running_source" != "release" ]]; then
  status=DRIFT reason=untracked-or-unreachable:$running_source
elif [[ "$running_sha" != "$activated_sha" ]]; then
  # Armed but not live. What the daemon CLAIMS decides the grade: a fresh
  # state file naming this exact armed SHA downgrades to the expected states;
  # anything else (stale file, wrong SHA, inconsistent phase) is the sharp
  # "timer dead or wedged" signal and keeps the 2h provenance class.
  if [[ "$ad_fresh" == 1 && "$ad_phase" == "awaiting-quiescence" && "$ad_armed" == "$activated_sha" ]]; then
    status=DRIFT reason=awaiting-quiescence
  elif [[ "$ad_fresh" == 1 && "$ad_phase" == "restart-disabled" && "$ad_armed" == "$activated_sha" ]]; then
    status=DRIFT reason=armed-restart-disabled
  else
    status=DRIFT reason=armed-release-not-live
  fi
elif [[ "$master_sha" == "unknown" ]]; then
  status=UNKNOWN reason=remote-unreachable
elif [[ "$running_sha" != "$master_sha" ]]; then
  status=DRIFT reason=behind-origin-master
fi

line="$ts running=${running_sha:0:12} activated=${activated_sha:0:12} master=${master_sha:0:12} status=$status reason=$reason auto=$ad_phase"
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
  QUIESCENCE_THRESHOLD_SEC="$QUIESCENCE_THRESHOLD_SEC" DARK_THRESHOLD_SEC="$DARK_THRESHOLD_SEC" \
  AD_RUNNING_COUNT="$ad_running_count" AD_WAITING_SINCE="$ad_waiting_since" \
  ALERT_COOLDOWN_SEC="$ALERT_COOLDOWN_SEC" RUNNING_SHA="${running_sha:0:12}" \
  MASTER_SHA="${master_sha:0:12}" ISSUE_URL="$ISSUE_URL" \
  python3 -c '
import os, time, calendar

reason = os.environ["REASON"]
now = int(time.time())

if reason.startswith("untracked-or-unreachable") or reason == "armed-release-not-live":
    klass, threshold = "provenance", int(os.environ["PROVENANCE_THRESHOLD_SEC"])
elif reason == "awaiting-quiescence":
    klass, threshold = "quiescence-wait", int(os.environ["QUIESCENCE_THRESHOLD_SEC"])
elif reason == "armed-restart-disabled":
    klass, threshold = "dark-armed", int(os.environ["DARK_THRESHOLD_SEC"])
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
# awaiting-quiescence must carry the running count and the wait duration
# (AUR-4028): "why has it not restarted" is the whole point of the page.
extra = ""
if reason == "awaiting-quiescence":
    waited = ""
    try:
        ws = calendar.timegm(
            time.strptime(os.environ.get("AD_WAITING_SINCE", ""), "%Y-%m-%dT%H:%M:%SZ")
        )
        waited = " for %.1fh" % ((now - ws) / 3600.0)
    except ValueError:
        pass
    extra = (
        " Auto-deploy daemon is alive and waiting%s: running=%s at last tick"
        " (queued never blocks)."
        % (waited, os.environ.get("AD_RUNNING_COUNT", "?"))
    )
text = (
    "Paperclip deploy drift sustained %dh (%s): %s.%s "
    "Production is running %s; origin/master is %s. %s%s"
    % (hours, klass, reason, extra, os.environ["RUNNING_SHA"], os.environ["MASTER_SHA"],
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
