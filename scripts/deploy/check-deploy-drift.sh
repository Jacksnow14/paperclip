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
#   - master static + CLEAN PRs     (reviewed work not merging — the AUR-4509 freeze)
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
#   merge-debt  (merge-debt)                                         [AUR-4661]
#               origin/master ITSELF is static (tip older than
#               MERGE_DEBT_MASTER_AGE_SEC, default 2 days) while >=
#               MERGE_DEBT_MIN_CLEAN (default 3) open PRs sit mergeable
#               (mergeable_state "clean", force-refreshed — see the counting
#               trap at the merge-debt block below). Both legs are required: a
#               quiet master is fine if nothing is ready, and CLEAN PRs are
#               fine while master moves — the CONJUNCTION is the defect. The
#               07-26..07-29 freeze (AUR-4509) sat exactly here for ~3.4 days
#               with 20+ CLEAN PRs while every class above was CORRECTLY
#               silent: production matched master; the debt was one hop
#               upstream. Threshold: 2h sustained (the conjunction already
#               embeds >= 2 days of stagnation; 2h of consecutive ticks
#               filters a flap right before a merge train lands).
#
# BOTH DEBT LEGS MUST STAY LIVE (AUR-4509's "merged" fallacy): PR #144 fixed
# the dropped-handoff bug, was MERGED, and stayed UNDEPLOYED — the bug blocked
# its own remedy. merge-debt closes the approved->merged gap; deploy-debt and
# the armed/quiescence classes close merged->running. Neither leg alone covers
# the chain: "it is merged" is not "it is live", and "production matches
# master" is not "work is landing".
#
# Sustained duration is derived from the drift log itself (the run of consecutive
# lines carrying the same reason), so there is no separate state to get stale.
# Alerts are rate-limited per reason. Delivery failure is logged loudly and never
# swallowed — see AUR-3930 on channels that print "sent" for undelivered messages.
#
# CHECKOUT-DRIFT AXIS (AUR-4227, control-plane half of AUR-4187): the running
# server is not the only place production code executes. Scheduled routines
# execute repo code by `cd`-ing into a checkout on disk, and AUR-4187 found one
# running a full day of stale code from a checkout that predated a merged safety
# fix — a class of drift the server-facing axes above cannot see. The axis below
# walks a configured list of routine-executable checkouts and runs the same
# graded escalation gate per checkout, isolated in its own log/state file pair so
# an unrelated reason (or an unrelated checkout) can never interrupt another's
# sustained-duration clock or rate-limit window. Per the artifact-provenance
# doctrine (AUR-4324), currency is checked against FETCH_HEAD from an explicit
# fetch, never a possibly-stale origin/<branch> tracking ref.
#
#   checkout-debt (checkout-behind:<label>)
#               A watched checkout's HEAD is not up to date with its intended
#               upstream branch. Same debt character as deploy-debt but measured
#               against a checkout on disk; a routine can legitimately lag a few
#               hours behind merges, so the threshold stays at the original 24h.
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
# merge-debt (AUR-4661)
REPO=${PAPERCLIP_DRIFT_REPO:-Jacksnow14/paperclip}
GH_BIN=${PAPERCLIP_DRIFT_GH:-gh}
MERGE_DEBT_MASTER_AGE_SEC=${PAPERCLIP_DRIFT_MERGE_DEBT_MASTER_AGE_SEC:-172800}
MERGE_DEBT_MIN_CLEAN=${PAPERCLIP_DRIFT_MERGE_DEBT_MIN_CLEAN:-3}
MERGE_DEBT_THRESHOLD_SEC=${PAPERCLIP_DRIFT_MERGE_DEBT_THRESHOLD_SEC:-7200}
MERGE_DEBT_RECHECK_DELAY_SEC=${PAPERCLIP_DRIFT_MERGE_DEBT_RECHECK_DELAY_SEC:-3}
MERGE_DEBT_ISSUE_URL=${PAPERCLIP_DRIFT_MERGE_DEBT_ISSUE_URL:-https://paperclip/AUR/issues/AUR-4661}
# checkout-drift axis (AUR-4227): `label:path:branch`, one entry per line.
# DELIBERATELY EMPTY by default — the axis is opt-in via
# PAPERCLIP_DRIFT_CHECKOUTS, because a wrong default here perpetually pages:
# e.g. /home/ievgen/paperclip deliberately sits on a non-master branch, so a
# baked-in "watch it against master" default would alarm forever. Each entry
# names the branch that checkout is INTENDED to track, so a checkout that
# legitimately lives on another branch is simply configured with that branch
# (or not configured at all).
CHECKOUTS=${PAPERCLIP_DRIFT_CHECKOUTS-}
CHECKOUT_DEBT_THRESHOLD_SEC=${PAPERCLIP_DRIFT_CHECKOUT_DEBT_THRESHOLD_SEC:-86400}
CHECKOUT_ISSUE_URL=${PAPERCLIP_DRIFT_CHECKOUT_ISSUE_URL:-https://paperclip/AUR/issues/AUR-4227}
# Kill switch for the checkout self-healing refresher (AUR-4984). Default ON;
# 0 restores detect-only behaviour (refresh=disabled on every checkout line).
CHECKOUT_REFRESH=${PAPERCLIP_DRIFT_CHECKOUT_REFRESH:-1}

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

# --- merge-debt (AUR-4661) --------------------------------------------------
# Only evaluated once every class above converged: during the AUR-4509 freeze
# production matched master exactly, so this is the only branch that can see
# it. Cost gate: the per-PR sweep only runs once master tip age already
# exceeds the age leg — a healthy tick costs one extra API call.
#
# THE COUNTING TRAP (measured on AUR-4509): `gh pr list --json
# mergeStateStatus` returned UNKNOWN for 64 of 68 open PRs — the field is a
# LAZY server-side compute the list endpoint never triggers. Counting CLEAN
# off the list reads 0, the conjunction never holds, and this class ships
# dead while looking green. So: poke each PR individually (GET /pulls/{n}
# forces the compute), then re-read stragglers in a second pass (pass 1
# resolved 48/64 on AUR-4509, pass 2 the remaining 16). PRs still unresolved
# after both passes make a below-the-line count UNTRUSTWORTHY: report
# merge-debt-unmeasurable, never a silent ok — transport failure is not a
# negative result.
merge_debt_fields=""
clean_count="" tip_age_sec=""
if [[ "$status" == "ok" ]]; then
  now_epoch=$(date -u +%s)
  tip_date=$("$GH_BIN" api "repos/$REPO/commits/$master_sha" --jq '.commit.committer.date' 2>/dev/null || true)
  tip_epoch=$(date -u -d "$tip_date" +%s 2>/dev/null || true)
  if [[ -z "$tip_epoch" ]]; then
    status=UNKNOWN reason=merge-debt-unmeasurable:tip-date
    echo "merge-debt leg unmeasurable: could not resolve master tip commit date via $GH_BIN" >&2
  elif (( now_epoch - tip_epoch > MERGE_DEBT_MASTER_AGE_SEC )); then
    tip_age_sec=$(( now_epoch - tip_epoch ))
    if pr_numbers=$("$GH_BIN" api --paginate "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null); then
      declare -A pr_state=()
      for n in $pr_numbers; do
        pr_state[$n]=$("$GH_BIN" api "repos/$REPO/pulls/$n" --jq '.mergeable_state' 2>/dev/null || echo poke-failed)
      done
      stragglers=()
      for n in $pr_numbers; do
        case "${pr_state[$n]}" in ""|unknown|poke-failed|null) stragglers+=("$n") ;; esac
      done
      if (( ${#stragglers[@]} > 0 )); then
        sleep "$MERGE_DEBT_RECHECK_DELAY_SEC"
        for n in "${stragglers[@]}"; do
          pr_state[$n]=$("$GH_BIN" api "repos/$REPO/pulls/$n" --jq '.mergeable_state' 2>/dev/null || echo poke-failed)
        done
      fi
      clean_count=0 unresolved=0
      for n in $pr_numbers; do
        case "${pr_state[$n]}" in
          clean) clean_count=$(( clean_count + 1 )) ;;
          ""|unknown|poke-failed|null) unresolved=$(( unresolved + 1 )) ;;
        esac
      done
      merge_debt_fields=" clean=$clean_count unresolved=$unresolved tip_age_h=$(( tip_age_sec / 3600 ))"
      if (( clean_count >= MERGE_DEBT_MIN_CLEAN )); then
        status=DRIFT reason=merge-debt
      elif (( unresolved > 0 )); then
        # Below the fire line ONLY while some PRs never resolved: that is not
        # a measurement of "nothing is ready", it is a transport failure.
        status=UNKNOWN reason=merge-debt-unmeasurable:pr-state
        echo "merge-debt leg unmeasurable: $unresolved PR(s) unresolved after two poke passes (clean=$clean_count < $MERGE_DEBT_MIN_CLEAN)" >&2
      fi
    else
      status=UNKNOWN reason=merge-debt-unmeasurable:pr-list
      echo "merge-debt leg unmeasurable: open-PR list fetch failed via $GH_BIN" >&2
    fi
  fi
fi

line="$ts running=${running_sha:0:12} activated=${activated_sha:0:12} master=${master_sha:0:12} status=$status reason=$reason auto=$ad_phase$merge_debt_fields"
echo "$line"
echo "$line" >> "$DRIFT_LOG" 2>/dev/null || true

overall_drift=0
[[ "$status" == "DRIFT" ]] && overall_drift=1

# --- escalation gate -------------------------------------------------------
# Decides, from a reason's own drift log + alert-state file, whether sustained
# drift on that reason has earned a founder page. Parameterized on its
# (log, state) pair so each checkout's sustained-duration clock and rate-limit
# window is isolated from the primary axis and from every other checkout
# (AUR-4227). Prints "ALERT<TAB><text>" or "QUIET<TAB><why>".
run_drift_gate() {
  local gate_log=$1 gate_state=$2 gate_reason=$3 gate_context=$4
  local decision
  decision=$(
  DRIFT_LOG="$gate_log" ALERT_STATE="$gate_state" REASON="$gate_reason" \
  PROVENANCE_THRESHOLD_SEC="$PROVENANCE_THRESHOLD_SEC" DEBT_THRESHOLD_SEC="$DEBT_THRESHOLD_SEC" \
  QUIESCENCE_THRESHOLD_SEC="$QUIESCENCE_THRESHOLD_SEC" DARK_THRESHOLD_SEC="$DARK_THRESHOLD_SEC" \
  AD_RUNNING_COUNT="$ad_running_count" AD_WAITING_SINCE="$ad_waiting_since" \
  MERGE_DEBT_THRESHOLD_SEC="$MERGE_DEBT_THRESHOLD_SEC" CLEAN_COUNT="$clean_count" \
  TIP_AGE_SEC="$tip_age_sec" MERGE_DEBT_ISSUE_URL="$MERGE_DEBT_ISSUE_URL" \
  CHECKOUT_DEBT_THRESHOLD_SEC="$CHECKOUT_DEBT_THRESHOLD_SEC" \
  CHECKOUT_ISSUE_URL="$CHECKOUT_ISSUE_URL" CONTEXT="$gate_context" \
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
elif reason == "merge-debt":
    klass, threshold = "merge-debt", int(os.environ["MERGE_DEBT_THRESHOLD_SEC"])
elif reason.startswith("checkout-behind:"):
    # AUR-4227: same debt character as deploy-debt but measured against a
    # checkout on disk; routines legitimately lag merges by hours, so this
    # keeps the original 24h debt threshold instead of the retuned 1h one.
    klass, threshold = "checkout-debt", int(os.environ["CHECKOUT_DEBT_THRESHOLD_SEC"])
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
if reason == "merge-debt":
    # Production matches master here — "running vs master" phrasing would read
    # as healthy. The page must say the stall is UPSTREAM of deploy.
    days = float(os.environ.get("TIP_AGE_SEC") or 0) / 86400.0
    text = (
        "Paperclip merge debt sustained %dh: origin/master static for %.1f days "
        "while %s open PRs are CLEAN and unmerged. Production matches master — "
        "the stall is upstream: reviewed work is not landing. %s%s"
        % (hours, days, os.environ.get("CLEAN_COUNT") or "?",
           os.environ["MERGE_DEBT_ISSUE_URL"], note)
    )
elif reason.startswith("checkout-behind:"):
    # "running vs master" phrasing would be wrong here too — the server may be
    # fully converged while a routine checkout executes stale code (AUR-4187).
    text = (
        "Paperclip checkout drift sustained %dh (%s): %s. %s %s%s"
        % (hours, klass, reason, os.environ.get("CONTEXT", ""),
           os.environ["CHECKOUT_ISSUE_URL"], note)
    )
else:
    text = (
        "Paperclip deploy drift sustained %dh (%s): %s.%s "
        "Production is running %s; origin/master is %s. %s%s"
        % (hours, klass, reason, extra, os.environ["RUNNING_SHA"], os.environ["MASTER_SHA"],
           os.environ["ISSUE_URL"], note)
    )
print("ALERT\t%s" % text)
' 2>/dev/null || printf 'QUIET\tescalation-gate-failed'
  )

  local verdict=${decision%%$'\t'*}
  local detail=${decision#*$'\t'}

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
}

if [[ "$status" == "DRIFT" ]]; then
  echo "paperclip deploy drift: $reason (running=${running_sha:0:12} master=${master_sha:0:12})" >&2
  run_drift_gate "$DRIFT_LOG" "$ALERT_STATE" "$reason" ""
fi

# --- checkout-drift axis (AUR-4227) -----------------------------------------
# A routine can be running fixed, reviewed code that is simply an older commit
# than its intended upstream — the AUR-4187 incident class, measured against a
# checkout on disk instead of the live server. Each checkout gets its own
# log/state file pair so one drifting checkout can never mask or reset
# another's sustained-duration clock, and a missing/unreachable checkout is
# skipped (not alarmed) — this axis reports what it can prove.
# Since AUR-4984 the axis also self-heals: a clean checkout that is strictly
# behind is fast-forwarded in place, so only dirty or diverged checkouts —
# the ones needing a human decision — still drift and page.
while IFS=: read -r co_label co_path co_branch; do
  [[ -n "$co_label" ]] || continue

  if [[ ! -d "$co_path" ]] || ! git -C "$co_path" rev-parse --git-dir >/dev/null 2>&1; then
    echo "checkout drift: $co_label ($co_path) not present on this host, skipping" >&2
    continue
  fi

  # Artifact-provenance doctrine (AUR-4324): fetch explicitly and compare
  # FETCH_HEAD, never a possibly-stale origin/<branch> tracking ref.
  if ! timeout 15 git -C "$co_path" fetch --quiet origin "$co_branch" 2>/dev/null; then
    echo "checkout drift: $co_label ($co_path) fetch of origin/$co_branch failed, skipping (network/remote unreachable)" >&2
    continue
  fi

  co_fetch_head=$(git -C "$co_path" rev-parse FETCH_HEAD 2>/dev/null || echo none)
  co_local_head=$(git -C "$co_path" rev-parse HEAD 2>/dev/null || echo none)
  [[ "$co_fetch_head" != "none" && "$co_local_head" != "none" ]] || continue

  # Self-healing refresher (AUR-4984): fast-forward a clean, strictly-behind
  # checkout instead of paging daily for the expected post-merge lag.
  # `merge --ff-only` is the only primitive allowed here — it refuses on
  # divergence, refuses to clobber the working tree, and can never discard a
  # commit; paperclip-shared backs ~100 linked worktrees where reset/checkout
  # are forbidden outright. Lives inline in this loop deliberately: a sidecar
  # could die silently, whereas here every checkout line must carry a
  # refresh= field — a line without one means the refresher is dead.
  if [[ "$CHECKOUT_REFRESH" != "1" ]]; then
    co_refresh=disabled
  elif git -C "$co_path" merge-base --is-ancestor "$co_fetch_head" "$co_local_head" 2>/dev/null; then
    co_refresh=noop-current
  else
    # A tree whose status cannot be read is treated as dirty: never touch a
    # tree not proven clean (AUR-4187: a watched tree held a diff that would
    # have reverted three merged safety fixes; AUR-4541 destroyed a patch).
    co_dirty=$(git -C "$co_path" status --porcelain 2>/dev/null || echo unreadable)
    if [[ -n "$co_dirty" ]]; then
      co_refresh=skipped-dirty
    elif ! git -C "$co_path" merge-base --is-ancestor "$co_local_head" "$co_fetch_head" 2>/dev/null; then
      # Local commits upstream does not have: only a true ancestor advance
      # may be fast-forwarded.
      co_refresh=skipped-diverged
    elif timeout 15 git -C "$co_path" merge --ff-only FETCH_HEAD >/dev/null 2>&1; then
      co_refresh=ff
      # Re-read HEAD so the logged local= is the POST-merge sha — the line
      # itself proves the advance happened.
      co_local_head=$(git -C "$co_path" rev-parse HEAD 2>/dev/null || echo "$co_local_head")
    else
      co_refresh=failed-ff
    fi
  fi

  if git -C "$co_path" merge-base --is-ancestor "$co_fetch_head" "$co_local_head" 2>/dev/null; then
    co_status=ok
    co_reason=-
  else
    co_status=DRIFT
    co_reason="checkout-behind:${co_label}"
    overall_drift=1
  fi

  co_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  co_line="$co_ts checkout=$co_label local=${co_local_head:0:12} remote=${co_fetch_head:0:12} status=$co_status reason=$co_reason refresh=$co_refresh"
  echo "$co_line"
  co_log="${DRIFT_LOG}.checkout-${co_label}"
  co_state="${ALERT_STATE}.checkout-${co_label}"
  echo "$co_line" >> "$co_log" 2>/dev/null || true

  if [[ "$co_status" == "DRIFT" ]]; then
    echo "paperclip checkout drift: $co_label ($co_path) is behind origin/$co_branch (local=${co_local_head:0:12} remote=${co_fetch_head:0:12})" >&2
    run_drift_gate "$co_log" "$co_state" "$co_reason" \
      "Checkout $co_label ($co_path) is pinned at ${co_local_head:0:12}; origin/$co_branch is ${co_fetch_head:0:12}."
  fi
done <<< "$CHECKOUTS"

[[ "$overall_drift" == "1" ]] && exit 1
exit 0
