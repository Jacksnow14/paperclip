# Runbook: Diagnosing `Process lost` Runs

Status: Operator runbook
Last updated: 2026-07-25
Origin: AUR-3924 / AUR-3929 (OOM amplification loop on the 7.7 GB host)

A heartbeat run ends as **`Process lost`** when the control plane can no
longer find the adapter child process it spawned. The message
(`server/src/services/heartbeat.ts`, `buildProcessLossMessage`) has four
variants:

| Message fragment | Meaning |
|---|---|
| `parent pid ... exited, but descendant process group ... was still alive` | The adapter leader died but left descendants; they were terminated |
| `child pid ... is no longer running` | The tracked child died (OOM kill, crash, external kill) |
| `process group ... is no longer running` | The whole process group is gone |
| `server may have restarted` | The control plane itself restarted and lost its in-memory handles |

## First: rule out memory exhaustion

The AUR-3924 incident was a swapfile that existed but was never `swapon`'d.
Check memory **before** anything else:

```bash
free -m            # "available" under ~300 MB on this host means trouble
cat /proc/swaps    # a missing/empty entry here with a swapfile on disk = AUR-3924 all over again
```

## Second: was it the OOM killer?

There are **two units named `paperclip.service` in different scopes** on this
host. Check both, because journal entries land in different scopes:

```bash
journalctl --user --since "2 hours ago" | grep -cE "oom-kill|killed by the OOM"
journalctl --since "2 hours ago" | grep -cE "oom-kill|killed by the OOM"   # system scope
```

Then check restart counts and memory of both units:

```bash
systemctl --user show paperclip.service -p NRestarts -p MemoryCurrent
systemctl show paperclip.service -p NRestarts -p MemoryCurrent
```

## Third: attribute adapter children to a control plane

```bash
ps -o pid=,ppid=,rss= -C claude
```

Group by `ppid`: each distinct parent pid is one control-plane instance.
Two parent pids means two control planes are both spawning children (the
AUR-3924 configuration). Each `claude` child holds ~200–300 MB RSS at rest.

## Reading the pattern

**Synchronized `Process lost` timestamps across multiple agents mean a
control-plane death (OOM kill or restart), NOT agent misbehaviour.** All
in-flight runs die in the same second because their parent died — the agents
did nothing wrong. Misreading this as per-agent failure is what produced the
false-positive review in AUR-3921. A single agent's `Process lost` with
healthy memory, by contrast, usually is that run's own crash.

## What the system does about it (since AUR-3929)

- **Global concurrency ceiling.** Admission of every run passes a host-wide
  cap in addition to the per-agent `maxConcurrentRuns`. Default is derived
  from memory: `floor((total RAM − 3 GB reserved) / 1 GB per-run budget)`,
  clamped to 2–12 — on the 7.7 GB host that is 4 concurrent runs. The
  reserve covers OS + Postgres + control plane(s); the 1 GB budget covers a
  `claude` child's ~250 MB baseline plus peak headroom. Override with
  `PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS` (1–64). The gate counts `running`
  rows in `heartbeat_runs` under a Postgres advisory lock, so every
  control-plane instance sharing the database shares the ceiling.
- **Backoff on `process_lost` retries.** A reaped run is retried at most 3
  times, waiting 30 s / 2 m / 8 m (±50% jitter) as a `scheduled_retry` run
  before re-entering the queue. A mass process-loss event therefore fans back
  in as a spread-out trickle, and re-admission is still subject to the global
  ceiling. Exhausted retries fall through to the normal stranded-issue
  recovery path.

Why this breaks the amplification loop rather than slowing it: the loop
required `OOM kill → retries → more concurrent processes → worse OOM`.
Retries can no longer add concurrency — total adapter processes are bounded
by the ceiling no matter how many runs are queued or retrying — and they
cannot even reach the queue in the same second, so memory pressure from
agent runs has a hard upper bound of `cap × per-run budget`.

## What not to do

- Do **not** restart `paperclip.service` (either scope) to "clear" a
  `Process lost` backlog — the restart orphans all in-flight runs and
  produces the exact mass process-loss you are diagnosing.
- Do not raise `PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS` above the derived
  default on a memory-constrained host without redoing the arithmetic above.
