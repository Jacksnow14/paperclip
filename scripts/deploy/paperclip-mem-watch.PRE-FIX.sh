#!/bin/bash
# paperclip-mem-watch — AUR-3924 — SCHEMA v4 (2026-07-25 16:05 UTC)
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

LOG=${PAPERCLIP_MEM_WATCH_LOG:-/var/log/paperclip-mem-watch.log}
HEADER="ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,cp_pid,cp_since,cp_oom_adj,release,cap_deployed"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mem_avail=$(free -m | awk '/^Mem:/{print $7}')
mem_used=$(free -m | awk '/^Mem:/{print $3}')
swap_used=$(free -m | awk '/^Swap:/{print $3}')
swap_free=$(free -m | awk '/^Swap:/{print $4}')
swap_total=$(free -m | awk '/^Swap:/{print $2}')
load1=$(awk '{print $1}' /proc/loadavg)

# OOM kills in the last 5 minutes (systemd-reported, any unit or slice)
ooms=$(journalctl --since "-5min" --no-pager 2>/dev/null \
        | grep -cE "killed by the OOM killer|Failed with result 'oom-kill'" || true)

agents=$(pgrep -c -f '/\.local/bin/claude --print' 2>/dev/null || echo 0)

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
if [[ -z "$dist_dir" ]]; then
  cap_deployed=NA          # cannot locate the running artifact: report unknown, never "no"
elif grep -rq "PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS" "$dist_dir" 2>/dev/null; then
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

[[ -s "$LOG" ]] || echo "$HEADER" >> "$LOG"
echo "$ts,$mem_avail,$mem_used,$swap_used,$swap_free,$swap_total,$load1,$ooms,$agents,$busy_agents,$max_per_agent,$build_rss_mb,$db_restarts,$cp_pid,$cp_since,$cp_adj,$release,$cap_deployed" >> "$LOG"

tail -n 5000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
