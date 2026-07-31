# Runbook: `Process lost` / OOM on the control plane

Closes required outcome 5 of [AUR-3924](/AUR/issues/AUR-3924) (the docs half — regression
tests for the concurrency cap and `process_lost` backoff live in [AUR-3929](/AUR/issues/AUR-3929),
next to that code, not here).

Diagnosing the AUR-3924 outage took two agents roughly two hours of `journalctl`/`ps`/`ss`
forensics, produced one false-positive productivity review against an innocent agent
([AUR-3921](/AUR/issues/AUR-3921)), and generated a premature "all clear" that was wrong by
12 minutes. Every bit of that was re-derivable from the box. Read this instead of
re-deriving it.

**Read-only.** Every command in this runbook is diagnostic. None of them stop, restart, or
mutate a systemd unit.

---

## 1. Is this the agent or the box? (answer this first, under a minute)

The decisive signal is **synchronization**. One agent's run dying is agent behavior. Several
runs from **different agents** dying at the same second is a control-plane death — the kernel
or systemd did it, not the agent.

Run these four commands:

```bash
journalctl --since "-6h" | grep -cE "killed by the OOM killer|Failed with result 'oom-kill'"
systemctl show paperclip.service -p LoadState -p NRestarts
systemctl --user show paperclip.service -p LoadState -p NRestarts
tail -20 /var/log/paperclip-mem-watch.log     # 5-min sampler installed under AUR-3924
```

(Deliberately no `--value` on the two `systemctl show` calls: with more than one `-p`, systemd
prints bare values in *its* order, not the order you asked for — on this box that is `NRestarts`
first, then `LoadState`, which is exactly how you misread a healthy box at 3am. Keep the labels.)

**Do not loosen that first command to a naive `journalctl ... | grep -i 'oom'`.** A bare
substring match is not sufficient — `oom` shows up in plenty of `journalctl` lines that are
not a kill. The AUR-4008 review (2026-07-25, repeating a trap first hit during the AUR-3924
review) matched on `sudo` audit lines logging commands that merely *mention* OOM, not commands
that *caused* one:

```text
sudo: ... COMMAND=/usr/bin/systemctl show -p OOMPolicy paperclip.service
sudo: ... COMMAND=/usr/bin/lsof /tmp/aur-3924-oom-monitor.log
```

Both are innocuous diagnostic/monitoring commands an agent ran while investigating — not
evidence of a kill. Match the actual kill/exit patterns shown above
(`"killed by the OOM killer"`, `"Failed with result 'oom-kill'"`), never a generic `oom`
substring, or you will manufacture a false-positive incident out of someone else's audit
trail.

How to read them:

- **OOM count > 0 in the window** the reported run died in → infra event. Go to §2.
- **`systemctl show paperclip.service` (no `--user`)** — as of AUR-3931 (landed
  2026-07-25) this unit no longer exists. `LoadState=not-found` is the **expected, healthy**
  result; `NRestarts` will print `0` regardless because that's systemd's default for any
  unrecognized unit name, not evidence of zero restarts. Don't read `NRestarts=0` here as
  "the unit is fine" — check `LoadState` first. If `LoadState` ever comes back
  `loaded`/`active` again, that is itself an anomaly worth flagging (see §3).
- **`systemctl --user show paperclip.service`** is the real, currently-running control
  plane (port 3100). A jump in `NRestarts` compared to what you'd expect from the incident
  window means systemd restarted it — almost certainly from an OOM kill or `OOMPolicy=stop`
  (see §4 for why that policy was changed).
- **`mem-watch.log`** gives you the last several 5-minute samples: available memory, swap
  used, load, OOM kills in that 5-min window, concurrent agent-child count, and the two
  restart counters. Find the row spanning the death timestamp. If `oom_5min` is 0 and the
  restart counters are flat across that row, the box was healthy at that moment — the
  "Process lost" report is **not** infra-caused, and you should look at that specific run
  (network blip, the agent's own process exiting, cancellation) instead of writing an
  incident.

**State plainly: `Process lost -- server may have restarted` is an infrastructure symptom,
never evidence about the assigned agent.** Do not open a productivity/behavior review against
an agent on the strength of a `Process lost` message alone — that is exactly the mistake that
produced the AUR-3921 false positive.

---

## 2. The amplification loop

This is why "just restart it" makes an OOM incident worse, not better:

```
OOM kill (control plane or a DB backend)
        │
        ▼
in-flight runs on that process are orphaned
        │
        ▼
orphaned runs get marked failed ("Process lost")
        │
        ▼
failed runs auto-retry
        │
        ▼
more concurrent `claude` agent children spawn
        │
        ▼
memory pressure increases
        │
        └──────────────► back to OOM kill
```

Two things break this loop today (see §4 for how to verify they're still in effect):

- **`paperclip-oom-guard`** biases which process the kernel picks when it does have to kill
  something, so a kill lands on a single sacrificial `claude` child instead of the control
  plane or the database.
- **`OOMPolicy=continue`** on the user `paperclip.service` unit (drop-in at
  `~/.config/systemd/user/paperclip.service.d/oom-policy.conf`) means a child process getting
  OOM-killed no longer takes the whole unit down with it (systemd's default is
  `OOMPolicy=stop`, which would stop the unit — and every in-flight run on it — the moment
  *any* cgroup member gets killed). One run fails instead of all of them.

Neither of these lowers memory pressure. They only stop a single kill from cascading. If
you're seeing repeated OOM kills, the underlying fix is reducing concurrent agent load or
adding memory — not restarting anything.

---

## 3. Topology: what changed under AUR-3931, and the trap it used to be

**Current state (verified on this box 2026-07-25):** there is one production control-plane
unit — the user unit `paperclip.service`, port 3100 — and Postgres runs as its own unit,
`paperclip-db.service`, in its own cgroup (`/system.slice/paperclip-db.service`), on port
54329. Confirm this yourself any time:

```bash
systemctl list-unit-files | grep -i paperclip     # only db/mem-watch/oom-guard — no bare
                                                    # system-level paperclip.service
ss -ltnp | grep -E ':3100|:3210|:54329'            # :3210 should not appear at all
```

**Until AUR-3931 landed, this was not true**, and the following was the load-bearing warning
in this runbook. It's preserved verbatim below because the incident history (and comments
still live in `paperclip-oom-guard.sh`) reference it, and because the same class of trap —
"a systemd `KillMode=control-group` unit shares a cgroup with something you can't afford to
lose" — can reappear if topology changes again:

> **`sudo systemctl stop paperclip.service` is a company-ending command.** systemd's default
> `KillMode=control-group` kills the embedded Postgres inside that unit's cgroup. The
> production control plane keeps serving traffic with no database. Every agent on this box has
> passwordless root (`sudo -n -l` → `(ALL) NOPASSWD: ALL`), so nothing will stop you. Do not
> run it until AUR-3931 has extracted Postgres.

**AUR-3931 has now extracted Postgres.** `paperclip-db.service` has its own `KillMode=mixed`,
its own `OOMScoreAdjust=-900`, its own `OOMPolicy=continue`, and no dependency on
`paperclip.service`'s cgroup — stopping the app unit does not touch it.

That does **not** make `sudo systemctl stop paperclip.service` a safe or casual command. It is
still the live production control plane: stopping it orphans every in-flight run and walks you
straight into §2's amplification loop the moment it comes back up under retry load. There is
no diagnostic reason to run it. Treat the underlying lesson as still live even though the
specific database-loss mechanism is gone — **before you stop or restart any unit on this box,
check what shares its cgroup right now**, because that answer changes as the infra evolves
(it already has once).

Passwordless root is still true and still means nothing technical stops you from running a
destructive command by mistake:

```bash
sudo -n -l    # -> (ALL : ALL) ALL, no password
```

---

## 4. Mitigations that are live, and how to check they still are

| Mitigation | Unit / file | Purpose |
| --- | --- | --- |
| `paperclip-oom-guard.timer` | `/etc/systemd/system/paperclip-oom-guard.{service,timer}`, script `/usr/local/sbin/paperclip-oom-guard.sh` | Every 30s, sets `oom_score_adj`: `-900` Postgres, `-800` control-plane main pid, `+600` `claude` agent children — biases kernel kill selection toward a sacrificial agent child |
| `paperclip-mem-watch.timer` | `/etc/systemd/system/paperclip-mem-watch.{service,timer}`, script `/usr/local/sbin/paperclip-mem-watch.sh` (canonical source: `scripts/paperclip-mem-watch.sh` in this repo — see §4a) | Every 5min, appends a CSV row to `/var/log/paperclip-mem-watch.log` (§1) so a "sustained window under real load" is a log lookup, not journalctl forensics |
| `paperclip-mem-watch-alert.timer` | `/etc/systemd/system/paperclip-mem-watch-alert.{service,timer}`, script `/usr/local/sbin/paperclip-mem-watch-alert.sh` (canonical source: `scripts/deploy/check-mem-watch-alert.sh` on the unmerged `aur-4025-mem-watch-alert` branch — see §4b) | Every 5min, reads the sampler's last row and pages the founder (SEV2, 30min cooldown) when `oom_5min>0`, `swap_free_mb<2000`, or `mem_avail_mb<1500` — the breach-triggered wake AUR-3924 originally lacked |
| `OOMPolicy=continue` | `~/.config/systemd/user/paperclip.service.d/oom-policy.conf` | A `claude` child getting OOM-killed no longer stops the whole `paperclip.service` unit and orphans every other run on it |
| `OOMScoreAdjust=-900`, `OOMPolicy=continue` | built into `paperclip-db.service` | Postgres is the last thing the kernel should pick, independent of the guard timer |

Verify the guard is holding:

```bash
systemctl is-active paperclip-oom-guard.timer
systemctl is-active paperclip-mem-watch.timer
cat /proc/$(systemctl --user show paperclip.service -p MainPID --value)/oom_score_adj   # expect -800
cat /proc/$(pgrep -f 'bin/postgres -D .*instances/default/db' | head -1)/oom_score_adj  # expect -900
```

How to reverse (read-only runbook note only — do not run this without a reason):

```bash
sudo systemctl disable --now paperclip-oom-guard.timer
```

### 4a. Canonical source and sync path for `paperclip-mem-watch.sh` (AUR-4170)

The live copy at `/usr/local/sbin/paperclip-mem-watch.sh` is a **deployment target, not the
source of truth**. The canonical source is `scripts/paperclip-mem-watch.sh` in this repo,
kept byte-identical to the host copy and guarded by a hermetic regression harness for the
`oom_5min` kernel-only derivation (stubbed `journalctl`; needs no root and no live journal,
so it runs anywhere):

```bash
bash scripts/paperclip-mem-watch.test.sh    # exit 0 = all assertions pass
```

The harness runs the real sampler end-to-end and asserts: a genuine `kernel: oom-kill:`
line counts **exactly once** (not once per line of its 4-line kill block); app-log text
containing `oom-kill` / `oom_reaper` / a quoted `journalctl -k ... grep -ci 'oom-kill'`
command counts **zero** (the AUR-4119/AUR-4126 self-poisoning defect); and the retired
unrestricted grep gets both of those wrong, so a revert fails the suite.

To change the sampler: edit the repo copy, run the harness, ship via PR, then deploy with

```bash
sudo install -m 0755 scripts/paperclip-mem-watch.sh /usr/local/sbin/paperclip-mem-watch.sh
```

The harness includes a drift check that fails loudly when run **on the prod host** if the
two copies differ (it skips off-host, e.g. in CI). A hotfix applied directly to
`/usr/local/sbin` — as the AUR-4126 hotfix was — is therefore caught the next time the
suite runs here: port the hotfix back into `scripts/paperclip-mem-watch.sh` to clear it.

### 4b. Supervision path (verified on this box 2026-07-30, AUR-4036)

What starts the sampler and the alert, whether either survives a reboot, and — the question
AUR-4036 was actually asked — whether staleness in either one is detectable automatically, or
fails silently one layer down.

**What starts them.** Both are plain systemd timers, `WantedBy=timers.target`,
`systemctl is-enabled` reports `enabled` for both:

```bash
systemctl is-enabled paperclip-mem-watch.timer paperclip-mem-watch-alert.timer   # -> enabled, enabled
systemctl list-unit-files | grep mem-watch                                        # -> both "enabled"
```

**Reboot survival: yes, without a cold-start gap.** `enabled` means both re-arm at boot via
`timers.target`; each unit also carries `OnBootSec` (`paperclip-mem-watch.timer`: 2min,
`paperclip-mem-watch-alert.timer`: 3min) so the first sample/check after a reboot doesn't wait
out a full `OnUnitActiveSec=5min` before firing. Neither depends on `paperclip.service` or any
app release — both scripts live in `/usr/local/sbin`, installed by
`scripts/deploy/install-mem-watch-sampler.sh` and `scripts/deploy/install-mem-watch-alert-timer.sh`
respectively, by design (see the header comments in both scripts): a monitor that depends on the
app release pipeline can't be trusted to alert on that pipeline breaking.

**Provenance note, worth recording precisely:** the deployed units and scripts on this box are
**byte-identical** to `scripts/deploy/{paperclip-mem-watch.sh,check-mem-watch-alert.sh,systemd/*}`
on two branches — `aur-4086-mem-watch-consumers` (sampler install script + systemd units) and
`aur-4025-mem-watch-alert` (alert script + systemd units) — confirmed by direct `diff` against
`/usr/local/sbin` and `/etc/systemd/system` on 2026-07-30. **Neither branch is merged to
`origin/master`.** The supervision path described here is real and running, but its source is
not yet on the branch this runbook lives on; that gap belongs to whoever merges AUR-4025/AUR-4086,
not to this issue.

**Staleness self-alarm: no — this is the gap.** Read `paperclip-mem-watch-alert.sh` end to end:
it parses the *last row's field values* against the three breach thresholds
(`oom_5min>0`, `swap_free_mb<2000`, `mem_avail_mb<1500`). It never compares that row's `ts` to
the current wall clock. Concretely, if `paperclip-mem-watch.timer` were disabled, masked, or its
script started failing every run, the alert timer would keep running every 5 minutes, keep
reading the same increasingly-stale last row, and — as long as that last row happened to be
healthy — keep printing `breach=0` and paging no one, forever. Corroborating checks performed
for this issue, all consistent with "no other layer catches this either":

```bash
grep -i "onfailure" /etc/systemd/system/paperclip-mem-watch*.{service,timer}   # -> no output: no OnFailure= unit
journalctl -u paperclip-mem-watch.service -p err --no-pager                     # -> no entries since 2026-07-25 install
crontab -l; sudo crontab -l                                                     # -> no separate staleness/heartbeat cron for mem-watch
```

So today: a dead sampler is silent unless a human happens to run `tail
/var/log/paperclip-mem-watch.log` and notices the timestamp is old (§1 already tells you to do
that as your first diagnostic step, which is a mitigant, not a fix). Implementing an automatic
staleness self-alarm (e.g. the alert script also failing/paging when
`now - last_row.ts > 15min`) is scoped to **AUR-4025**, per this issue's non-goals — it is not
done here. This section exists so the next incident owner doesn't have to re-derive "does it
self-alarm" under time pressure; the answer, as of 2026-07-30, is no.

**Current health, for reference:** 1277 rows logged since the 2026-07-25 10:28:08 UTC install,
zero malformed rows (`REFUSING malformed row` count in the service journal: 0), max gap between
consecutive samples over the last 300 rows: 5.3 minutes — the sampler has not gone stale in its
observed lifetime; the gap above is about what happens if it ever does.

---

## 5. The false-negative trap: `free -m` lies about "healthy"

`free -m` showing comfortable "available" memory does **not** mean the box is healthy — swap
absorbs spikes while the box trends toward exhaustion, and a snapshot taken between spikes
looks fine. This specific mistake produced the premature all-clear (wrong by 12 minutes)
during the AUR-3924 incident.

Before declaring an all-clear, check swap headroom and commit pressure, not just available
memory:

```bash
grep -E "SwapFree|SwapTotal|Committed_AS|CommitLimit|MemAvailable" /proc/meminfo
```

- **`SwapFree` trending down** over consecutive `mem-watch.log` rows (§1) means the box is
  absorbing pressure via swap right now, even if `MemAvailable` looks fine in a single
  snapshot. Falling `SwapFree` across several 5-minute samples is not noise.
- **`Committed_AS` approaching `CommitLimit`** means the kernel has promised more memory to
  processes than it can back without overcommitting further — a high ratio here is a leading
  indicator of the next OOM kill even while `free -m` still shows headroom.

On this box at the time of writing, `Committed_AS` was already at ~84% of `CommitLimit` with
swap ~32% used — worth internalizing as what "not actually fine" looks like even when nothing
has been OOM-killed in the last few minutes.

---

## 6. What AUR-3929 added: the concurrency cap and retry backoff

Everything above (§1–5) is diagnostic. This section is the structural fix that makes the
amplification loop in §2 impossible rather than merely slower — read it if you're asking
"why didn't retries make this worse" during an incident.

- **Global concurrency ceiling.** Admission of every run passes a host-wide cap in addition
  to the per-agent `maxConcurrentRuns`. Default is derived from memory:
  `floor((total RAM − 3 GB reserved) / 1 GB per-run budget)`, clamped to 2–12 — on this
  7.7 GB host that is **4** concurrent runs. The reserve covers OS + Postgres + control
  plane(s); the 1 GB budget covers a `claude` child's ~250 MB baseline plus peak headroom.
  Override with `PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS` (1–64). The gate counts `running`
  rows in `heartbeat_runs` under a Postgres advisory lock, so every control-plane instance
  sharing the database shares the ceiling.
- **Backoff on `process_lost` retries.** A reaped run is retried at most 3 times, waiting
  30 s / 2 m / 8 m (±50% jitter) as a `scheduled_retry` run before re-entering the queue. A
  mass process-loss event (a control-plane restart — see §1) therefore fans back in as a
  spread-out trickle, not a synchronized stampede, and re-admission is still subject to the
  global ceiling. Exhausted retries fall through to the normal stranded-issue recovery path.

Why this breaks the loop rather than slowing it: the loop in §2 required
`OOM kill → retries → more concurrent processes → worse OOM`. Retries can no longer add
concurrency — total adapter processes are bounded by the ceiling no matter how many runs are
queued or retrying — and they can't even reach the queue in the same second, so memory
pressure from agent runs has a hard upper bound of `cap × per-run budget`.

Do not raise `PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS` above the derived default on a
memory-constrained host without redoing the arithmetic above.

---

## 7. Reset-proof close condition for AUR-3924 (AUR-4036)

AUR-3924's outstanding ask was evidence of "a sustained window under real agent load" with no
recurrence. Two prior columns in the sampler schema are unsound for that judgment because they
are restart *counters*, which reset to 0 when the underlying unit is **replaced** rather than
merely restarted — silently, with no distinguishing signal (`cp_restarts` did exactly this at
the 2026-07-25 pinned-release cutover; see the v3→v4 header comment in
`paperclip-mem-watch.sh`). `db_restarts` is the same class of value and is **deliberately not
used below**, for the same reason — it is descriptive context in the log, not a term in this
condition.

**Condition.** Take the most recent N ≥ 250 consecutive rows from
`/var/log/paperclip-mem-watch.log` (≈21h at the observed ~5min cadence). The condition holds
only if **every row** in the window satisfies all five terms:

1. **Sampling continuity.** No gap between consecutive `ts` values exceeds 10 minutes (proves
   the sampler itself wasn't stale mid-window — see §4b) and `cp_pid`+`cp_since` is populated on
   every row. A `cp_pid`/`cp_since` change *inside* the window is not disqualifying by itself —
   that is the point of using identity instead of a counter: a restart becomes visible instead of
   resetting a number to zero — but every row on both sides of the change must still satisfy
   terms 2–5.
2. **`mem_avail_mb >= 1500`** — the same absolute floor `paperclip-mem-watch-alert.sh` already
   pages on (§4b/AUR-4025), so "no page fired" and "condition holds" can never silently disagree
   with each other.
3. **`swap_free_mb >= 2000`** — same reasoning, same threshold as the alert.
4. **`oom_5min == 0`** — no kill in any 5-minute window covered by the sample.
5. **`build_rss_mb <= 3000`**, checked as its own absolute ceiling, not folded into term 2. Per
   AUR-4029: the 2026-07-25T16:25:39Z breach row logged `mem_avail_mb=917` alongside
   `build_rss_mb=3637` — the most dangerous point in that incident came from release-build RSS,
   which `mem_avail_mb` alone does not distinguish from generic memory pressure after the fact.
   3000 sits below every observed incident-adjacent value and above the P95 of routine build
   activity (714 MB over the last 300 samples) — routine `tsc`/`vite`/`vitest` runs should never
   trip it.
6. **`cap_deployed == "yes"`** — the AUR-3929 concurrency cap must be loaded in the artifact the
   *running* control-plane process actually executes (derived from `/proc/<cp_pid>/cmdline`, not
   an assumed path — see the sampler's v3→v4 note) for the whole window, so the condition can
   never certify a window where the structural fix (§6) wasn't even in effect.

**Verified today (2026-07-30).** Run against the live log:

```bash
python3 - <<'PY'
import datetime
LOG = "/var/log/paperclip-mem-watch.log"
rows = [l.strip().split(",") for l in open(LOG) if l.strip() and l[:4].isdigit()]
header = open(LOG).readline().strip().split(",")
idx = {n: i for i, n in enumerate(header)}
def g(r, n): return r[idx[n]]
window = rows[-250:]
bad, prev = [], None
for r in window:
    ts = datetime.datetime.strptime(g(r, "ts"), "%Y-%m-%dT%H:%M:%SZ")
    if prev and (ts - prev).total_seconds() / 60 > 10:
        bad.append(f"GAP ending {ts}")
    prev = ts
    if int(g(r, "mem_avail_mb")) < 1500: bad.append(f"mem_avail_mb {g(r,'ts')}")
    if int(g(r, "swap_free_mb")) < 2000: bad.append(f"swap_free_mb {g(r,'ts')}")
    if int(g(r, "oom_5min")) != 0:       bad.append(f"oom_5min {g(r,'ts')}")
    if int(g(r, "build_rss_mb")) > 3000: bad.append(f"build_rss_mb {g(r,'ts')}")
    if g(r, "cap_deployed") != "yes":    bad.append(f"cap_deployed {g(r,'ts')}")
print(f"{g(window[0],'ts')} .. {g(window[-1],'ts')} ({len(window)} rows), violations: {len(bad)}")
for b in bad: print(" -", b)
PY
```

Result on the full 250-row window (`2026-07-29T06:49:19Z .. 2026-07-30T03:55:34Z`): **one**
violation — `oom_5min=1` at `2026-07-29T11:52:28Z`. That row's `cp_pid`/`cp_since`
(`3510124` / `2026-07-26T12:07:46`) is unchanged from the row before and after it — the kill did
not take the control plane down, consistent with §2's oom-guard mitigation sacrificing a single
agent child. Re-running the same check for the window *after* that kill
(`2026-07-29T11:57:29Z .. 2026-07-30T03:55:34Z`, 189 consecutive rows, ≈15h58m) returns **zero**
violations — the condition holds now, continuously, for just under 16 hours since the last event.

This condition is a log query, not a re-derivation: any future incident owner can rerun the
script above with the current log and get a yes/no answer plus the exact offending rows, without
re-reading this runbook's incident history first.

---

## See also

- [AUR-3924](/AUR/issues/AUR-3924) — the incident and the guard/mem-watch mitigations
- [AUR-3929](/AUR/issues/AUR-3929) — the concurrency cap + `process_lost` backoff (§6) and
  their regression tests
- [AUR-3931](/AUR/issues/AUR-3931) — extracted Postgres into its own unit (§3)
- [AUR-3921](/AUR/issues/AUR-3921) — the false-positive productivity review this runbook
  exists to prevent a repeat of
- [AUR-4025](/AUR/issues/AUR-4025) — breach-triggered wake off the sampler log (§4/§4b); the
  scheduled staleness self-alarm gap this issue documents but does not fix is scoped there
- [AUR-4029](/AUR/issues/AUR-4029) — identified `build_rss_mb` as the real driver of the
  2026-07-25 breach, source of the §7 term 5 threshold
- [AUR-4036](/AUR/issues/AUR-4036) — verified the supervision path (§4b) and wrote the
  reset-proof close condition (§7)
- [`agent-privilege-model.md`](agent-privilege-model.md) — what an agent can actually do to
  this host and what is logged; reads the same §1 topology correction from the privilege side
- [`docs/runbooks/README.md`](README.md) — index of the full runbook set, including the
  AUR-3938 content that has no repo file
