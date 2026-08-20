#!/bin/bash
# paperclip-mem-watch — AUR-3924 — SCHEMA v4 (2026-07-25 16:05 UTC)
# AUR-4056 (2026-07-25): record-splitting fix. Schema UNCHANGED (still 18 cols).
#
# v3 -> v4. Two of these columns had silently stopped meaning what they say,
# which is the same defect class as the restart counters this issue already
# tripped over. Rebuilt, not annotated:
#
#   - cap_deployed hard-coded /home/ievgen/paperclip/server/dist. At 15:51:16
#     production switched to /opt/paperclip/app/releases/<sha>/server/dist.
#     The column was grepping a path production no longer executes, so it could
#     report "no" forever after the cap shipped, or "yes" if anyone rebuilt the
#     old checkout while production ran a release without it. WRONG IN BOTH
#     DIRECTIONS. It now derives the path from the RUNNING process cmdline, so
#     it cannot drift from reality again no matter where production moves.
#
#   - cp_restarts read raw NRestarts, which resets to 0 when a unit is REPLACED
#     rather than restarted (it went 17 -> 0 at the pinned-release cutover with
#     no restart having occurred). "Flat at 17" became unverifiable. Replaced by
#     cp_pid + cp_since: identity, not a counter. A control plane that died and
#     came back changes pid; one that was replaced changes pid AND release. Both
#     are visible, neither can silently reset.
#
#   - added build_rss_mb: total RSS of tsc/vite/vitest processes. These are the
#     actual spike driver (three of them held 4.5 GB at 16:02 and took
#     mem_avail to 429 MB) and were invisible in every prior schema, which made
#     the agent process count look like the whole story. It is not.
#
# v2 -> v3: added busy_agents and max_per_agent. The interim per-agent cap was
# argued for on the premise that runs spread ~1 per agent across 18 agents.
# Measured, they concentrate: 11 runs sat in 4 agents, max 4 each. These two
# columns make that premise checkable per sample instead of inferred from a
# fleet average. Both are free /proc reads - no credential is stored here.
#
# Samples the signals AUR-3924 must close on, so the "sustained window under real
# agent load" is verifiable from a log instead of re-derived from journalctl.
#
# v1 -> v2 changes, and why:
#   - DROPPED `sys_restarts`. It tracked the system-unit `paperclip.service`,
#     which was retired at 10:27:35. After that it read 0 forever, so the column
#     silently changed meaning mid-log — a cold reader would see "7 -> 0" and
#     conclude the restart counter reset or the unit recovered. It did neither;
#     the unit ceased to exist.
#   - ADDED `db_restarts`. Postgres now runs as its own unit (paperclip-db.service).
#     That is the counter that now matters: it was previously un-monitorable
#     because the database lived inside a control plane's cgroup.
#   - ADDED `swap_free_mb`. v1 logged only swap_used, which cannot distinguish
#     "absorbing spikes and reclaiming" (sawtooth, fine) from "monotonically
#     filling" (fuse burning, not fine). That distinction decides whether the
#     box is stable or merely pre-failure.
#   - ADDED `cap_deployed`. The AUR-3929 host-wide concurrency cap is committed
#     but NOT in the running build. This column proves, per sample, whether the
#     fix is actually live — so nobody closes the P0 on a commit production
#     never loaded.
#
# v1 rows are preserved at /var/log/paperclip-mem-watch.v1.log. The two schemas
# are deliberately in separate files rather than one file with a changed header.

set -uo pipefail

# AUR-4056: overridable so the write path can be exercised hermetically in a
# test instead of only against the live production log.
LOG=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
HEADER="ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,cp_pid,cp_since,cp_oom_adj,release,cap_deployed"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mem_avail=$(free -m | awk '/^Mem:/{print $7}')
mem_used=$(free -m | awk '/^Mem:/{print $3}')
swap_used=$(free -m | awk '/^Swap:/{print $3}')
swap_free=$(free -m | awk '/^Swap:/{print $4}')
swap_total=$(free -m | awk '/^Swap:/{print $2}')
load1=$(awk '{print $1}' /proc/loadavg)

# OOM kills in the last 5 minutes. AUR-4119 defect 2/4: a single kernel kill
# echoes "killed by the OOM killer" once per ANCESTOR CGROUP SLICE at staggered
# timestamps (measured: 1 real kill -> up to 6 echo lines over 24 minutes, not
# the "2 lines" this comment used to claim), so that pattern over- and
# unpredictably double-counts and leaks kills across 5-minute window
# boundaries. Grepping "kernel: oom-kill:" against the whole journal fixes the
# double-count but is still a text match against every unit's output,
# including this app's own request-log lines -- one such line is on this box
# right now (a logged 404 whose body happens to quote that exact string,
# because it is this fix's own commentary). This process runs as root, so
# unlike the ievgen-run ad hoc check (defect 3/4, routine description) it
# needs no `sudo -n` workaround and can use `-k` to restrict to the KERNEL
# transport outright, which cannot match app log text by construction.
#
# AUR-4338 fire 9 (defect 9): count GLOBAL OOM kills only. The kernel tags each
# kill with a constraint: CONSTRAINT_NONE is a true box-wide out-of-memory --
# the AUR-3924 P0 failure mode (measured 96h: 6 such kills, node, anon-rss
# 4.68-6.34 GB). CONSTRAINT_MEMCG is a CGROUP hitting its OWN limit, which is
# bounded by construction and is not a host-memory breach (measured: one such
# kill, python3, anon-rss 49 MB, on a box with 6175 MB swap free -- it still
# SEV2-paged the founder at 07:04:40Z, Telegram message_id=89804).
# This matters ahead of AUR-4536, which enforces a per-run memory ceiling at
# the adapter spawn path: every correct enforcement action it takes WILL emit a
# CONSTRAINT_MEMCG kill. Counting those here would page the founder on every
# ceiling hit and would hold AUR-4338 rule 1 clause 3 at FAIL forever -- the
# "fires forever" failure mode, re-armed by the very fix meant to end it.
ooms=$(journalctl -k --since "-5min" --no-pager 2>/dev/null \
        | grep -E "oom-kill:" \
        | grep -cE "constraint=CONSTRAINT_NONE" || true)

# AUR-4056. `pgrep -c` prints "0" and ALSO exits 1 when nothing matches, so the
# old `|| echo 0` fired in ADDITION to pgrep's own output and produced the
# two-line value "0\n0". That embedded newline split every zero-agent record
# across two lines (29 of 75 rows on 2026-07-25). The record write was already a
# single atomic append -- the newline was in the DATA, not in the write. Keep the
# `||` on the assignment, never inside the substitution.
agents=$(pgrep -c -f '/\.local/bin/claude --print' 2>/dev/null) || agents=0

db_restarts=$(systemctl show paperclip-db.service -p NRestarts --value 2>/dev/null)
cp_since=$(runuser -u ievgen -- env XDG_RUNTIME_DIR=/run/user/1000 \
             systemctl --user show paperclip.service -p ActiveEnterTimestamp --value 2>/dev/null \
             | awk '{print $2"T"$3}')
[[ -n "$cp_since" ]] || cp_since=NA

# Total RSS held by build tooling — the real spike driver.
build_rss_mb=$(ps -eo rss,args --no-headers 2>/dev/null \
  | awk '/(typescript\/bin\/tsc|vite\/bin\/vite\.js|vitest)/ && !/awk/ {s+=$1} END {printf "%d", s/1024}')
[[ -n "$build_rss_mb" ]] || build_rss_mb=0

# Is the OOM guard still holding on the production control plane?
cp_pid=$(runuser -u ievgen -- env XDG_RUNTIME_DIR=/run/user/1000 \
           systemctl --user show paperclip.service -p MainPID --value 2>/dev/null)
cp_adj=$(cat "/proc/${cp_pid:-0}/oom_score_adj" 2>/dev/null || echo NA)

# Is the AUR-3929 host-wide cap in the artifact production ACTUALLY executes?
# Derive the path from the running process rather than assuming a location —
# production moved once already and this column did not notice.
dist_dir=""
release=NA
if [[ "${cp_pid:-0}" -gt 0 ]]; then
  entry=$(tr '\0' '\n' < "/proc/$cp_pid/cmdline" 2>/dev/null | grep -m1 'server/dist/index\.js$')
  if [[ -n "$entry" ]]; then
    dist_dir=$(dirname "$entry")
    case "$entry" in
      /opt/paperclip/app/releases/*) release=$(echo "$entry" | cut -d/ -f6) ;;
      *) release=checkout ;;
    esac
  fi
fi
# AUR-4338 defect 11 (2026-08-05). This branch matched ONLY the literal env-var
# string. AUR-4536 refactored that literal into a named constant
# (GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR) exported from @paperclipai/adapter-utils,
# so from release 42e064b139da the literal no longer appears anywhere under
# server/dist -- while the cap itself is still enforced
# (heartbeat.js: resolveGlobalRunCap -> resolveGlobalMaxConcurrentRuns).
# cap_deployed therefore flipped yes->no at 2026-08-05T12:18:44Z on a build whose
# cap was fully intact: a false negative for a SYMBOL-LOCATION reason, which is
# defect 1 returning by another door. It fails clause 1 of AUR-4338 rule 1 (a
# false alarm, not a false all-clear) but it is ALSO an input to rule 2, where a
# false "not deployed" during a low-swap moment would trigger an unnecessary
# production dispatch-rate intervention.
# Match the enforcement CALL, not one spelling of the env var. Deliberately scoped
# to $dist_dir and NOT the release root: docs/ and scripts/ under the release both
# contain the literal, so widening the search would return "yes" for every build
# ever -- a false ALL-CLEAR, the dangerous direction.
if [[ -z "$dist_dir" ]]; then
  cap_deployed=NA          # cannot locate the running artifact: report unknown, never "no"
elif [[ ! -d "$dist_dir" ]]; then
  # AUR-4134/AUR-4127. The release directory was deleted underneath a process
  # that is still running from it. Without this branch the grep below simply
  # finds nothing and reports "no" — indistinguishable from a build that
  # genuinely lacks the cap. That false "no" was live for ~10 min on 25 Jul
  # while production served from a deleted directory, and would have invited a
  # "corrective" redeploy during the exact window production was already
  # half-swapped. A vanished release must be LOUDER than a content regression,
  # not identical to one.
  cap_deployed=missing
elif grep -rqE "PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS|GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR|resolveGlobalMaxConcurrentRuns" "$dist_dir" 2>/dev/null; then
  cap_deployed=yes
else
  cap_deployed=no
fi

busy_agents=0
max_per_agent=0
pids=$(pgrep -f '/\.local/bin/claude --print' 2>/dev/null)
if [[ -n "$pids" ]]; then
  counts=$(for p in $pids; do
             tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null \
               | awk -F= '/^PAPERCLIP_AGENT_ID=/{print $2}'
           done | sort | uniq -c | awk '{print $1}')
  if [[ -n "$counts" ]]; then
    busy_agents=$(echo "$counts" | grep -c .)
    max_per_agent=$(echo "$counts" | sort -rn | head -1)
  fi
fi

# AUR-4056 defence in depth. Fixing `agents` removes the only field known to
# carry a newline today, but every value above comes from an external command
# whose output this script does not control, and the file is a positional CSV:
# ONE stray newline or comma silently re-columns every field after it, and a
# reader cannot tell a shifted field from a real reading. So the row is now
# built from sanitised fields and the column count is asserted before the append
# rather than assumed after it.
#
#   - first line only: a command that emits two lines contributes its first,
#     which is the correct value in the pgrep case ("0\n0" -> "0").
#   - commas -> ";": a comma inside a value is the same corruption as a newline,
#     just harder to see (it shifts columns without splitting the line).
#   - empty -> NA: an empty capture (e.g. `systemctl show` for a unit that no
#     longer exists) would otherwise collapse a column and shift the rest.
csv_field() {
  local v=${1-}
  v=${v%%$'\n'*}          # first line only
  v=${v//$'\r'/}          # strip CR
  v=${v//,/;}             # separator can never appear inside a value
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "${v:-NA}"
}

row=""
for f in "$ts" "$mem_avail" "$mem_used" "$swap_used" "$swap_free" "$swap_total" \
         "$load1" "$ooms" "$agents" "$busy_agents" "$max_per_agent" \
         "$build_rss_mb" "$db_restarts" "$cp_pid" "$cp_since" "$cp_adj" \
         "$release" "$cap_deployed"; do
  row+="${row:+,}$(csv_field "$f")"
done

# Tripwire: if the row is ever not exactly the header's width, say so in the
# journal instead of appending a row that reads as valid but is not.
want_cols=$(awk -F, '{print NF}' <<< "$HEADER")
have_cols=$(awk -F, '{print NF}' <<< "$row")
if [[ "$have_cols" != "$want_cols" ]] || [[ "$row" == *$'\n'* ]]; then
  echo "paperclip-mem-watch: REFUSING malformed row (${have_cols} cols, want ${want_cols}): ${row}" >&2
  exit 1
fi

[[ -s "$LOG" ]] || echo "$HEADER" >> "$LOG"
printf '%s\n' "$row" >> "$LOG"

tail -n 5000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
