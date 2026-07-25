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
systemctl show paperclip.service -p LoadState -p NRestarts --value
systemctl --user show paperclip.service -p LoadState -p NRestarts --value
tail -20 /var/log/paperclip-mem-watch.log     # 5-min sampler installed under AUR-3924
```

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
| `paperclip-mem-watch.timer` | `/etc/systemd/system/paperclip-mem-watch.{service,timer}`, script `/usr/local/sbin/paperclip-mem-watch.sh` | Every 5min, appends a CSV row to `/var/log/paperclip-mem-watch.log` (§1) so a "sustained window under real load" is a log lookup, not journalctl forensics |
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

## See also

- [AUR-3924](/AUR/issues/AUR-3924) — the incident and the guard/mem-watch mitigations
- [AUR-3929](/AUR/issues/AUR-3929) — regression tests for the concurrency cap and
  `process_lost` backoff
- [AUR-3931](/AUR/issues/AUR-3931) — extracted Postgres into its own unit (§3)
- [AUR-3921](/AUR/issues/AUR-3921) — the false-positive productivity review this runbook
  exists to prevent a repeat of
