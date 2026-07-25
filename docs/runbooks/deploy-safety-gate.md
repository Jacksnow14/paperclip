# Deploy safety gate (AUR-4029)

**Owner:** CTO · **Applies to:** every release build + activation on the 7.7 GB incident host
**Script:** `scripts/deploy/safe-deploy.sh` · **Wraps:** `scripts/deploy/build-release.sh` (AUR-3937)

## Why this exists

The release build is the largest single memory consumer on this box — larger than
the entire agent fleet at its ceiling.

| time (2026-07-25) | procs | avail_mb | swap_used | load1 | build_rss_mb | oom |
| ----------------- | ----- | -------- | --------- | ----- | ------------ | --- |
| 15:42:09Z         | 8     | 3779     | —         | 2.17  | (no build)   | 0   |
| 16:02:24Z         | 8     | **903**  | —         | 8.79  | AUR-3937 build | 0 |
| 16:20:27Z         | 12    | 1712     | 4068      | 3.07  | 2002         | 0   |
| 16:25:39Z         | 14    | **917**  | 5598      | 9.55  | **3637**     | 0   |

Two separate builds drove the box to ~900 MB of headroom. The second peaked at
**3637 MB resident** — ~50% higher than this issue's original 2.4 GB estimate,
and roughly eleven concurrent agents' worth of memory in one process.

Both survived, with zero kernel OOM kills, because of mitigations already
shipped under AUR-3924 (swap enabled, `OOMPolicy=continue`, control-plane
`oom_score_adj=-800`). That is the important distinction: **we survived it, we
were not protected from it.** 917 MB of headroom is a tailwind, not a margin.

The AUR-3929 concurrency cap does not close this. The cap governs *agent runs*;
the build is not an agent run. And the deploy that installs the cap necessarily
runs before the cap is in effect.

## What the gate guarantees

1. **The build cannot take the box down.** It runs in a systemd scope with
   `MemoryHigh=2560M`, `MemoryMax=3584M`, `MemorySwapMax=6G`. Past 2560 MB the
   kernel throttles it and reclaims its pages into swap; at 3584 MB it is killed.
   The victim is the build, never the agent fleet or the control plane.
   `nice=10` + `CPUWeight=20` mean it loses CPU contests too — the 16:25 build
   put load1 at 9.55.
2. **The box is watched, not just the build.** A watchdog samples live
   `MemAvailable` every 5s and stops the scope if it drops below **700 MB**. The
   cgroup bounds the build's own share; the watchdog bounds our exposure to
   everything else moving at the same time.
3. **Build and activate are separable.** `--build-only` produces and verifies the
   artifact while `current` still points at the old release. Activation is then a
   symlink flip plus a restart — seconds, not a 4-minute compile inline with a
   restart.
4. **No restart while a build is resident.** Activation blocks until the sampler
   reports `build_rss_mb = 0` (CEO's instruction on this issue).
5. **Verification is the grep, not the drift status.** Confirmation reads the
   sampler's own `release` and `cap_deployed` columns (AUR-4008). The sampler is
   only read, never modified (AUR-4023).
6. **Rollback is automatic** if the control plane does not come up, if the
   sampler never observes the new release, if `--expect-cap` is set and
   `cap_deployed` is not `yes`, or if `oom_5min` goes non-zero inside the
   15-minute post-activation watch.

## The floors: 2500 MB to start, 700 MB to abort

`safe-deploy.sh` refuses to *start* a build below **2500 MB** live `MemAvailable`,
and kills an in-flight build below **700 MB**.

The live reading comes from `/proc/meminfo`, not the sampler. The sampler ticks
every 5 minutes; a 5-minute-old number is not a safe basis for "may I allocate
2 GB right now." The sampler is used for what it is uniquely good at —
`oom_5min`, `build_rss_mb`, `release`, `cap_deployed`.

**700 MB is deliberately below the 903 MB historical survival point.** It is the
abort line, not the target. It has to sit under the observed trough or it fires
on healthy builds: the 19:51Z exercise legitimately touched 878 MB (see below)
and killing that build would have been a false positive.

### Measured, not projected

From the 19:51Z exercise (5-second sampling, `/tmp/aur4029-trace.csv`):

| metric | value |
| ------ | ----- |
| start `MemAvailable` | 4080 MB |
| **trough `MemAvailable`** | **878 MB** @ 19:53:02Z |
| build cgroup peak | 2559 MB (ceiling was `MemoryHigh=2560M`) |
| `memory.events` | `high 4185`, `max 0`, `oom 0`, `oom_kill 0` |
| kernel OOM kills in window | **0** |
| sampler `oom_5min`, all records ≥19:00Z | **0** |
| duration | 3m25s |

Read that carefully, because it is the whole point:

- **The cgroup bound held.** The build was throttled 4185 times at `MemoryHigh`
  and **never once reached `MemoryMax`** (`max 0`). Unbounded, the same build
  class reached 3637 MB by the sampler's reckoning. The kernel, not luck, is now
  what stops it.
- **The trough was still 878 MB**, below the 903 MB historical worst case. Honest
  accounting: bounding the build did *not* by itself lift the trough.
- **The trough was not caused by the build.** At 19:53:02Z `agent_procs` went
  4→5 — an agent spawned into the build's heaviest phase. Fifteen seconds later
  `MemAvailable` recovered to 2766 MB *while the build cgroup grew* 2140→2368 MB.
  A dip that deepens as the build shrinks and recovers as the build grows is
  page-cache reclaim and a concurrent spawn, not the compiler.

That last point is why `MemoryHigh` was subsequently lowered from 2560M to
**2048M**: the build demonstrably absorbs throttling for free (it still finished
in 3m25s while being throttled 4185 times), so trading build time for host
headroom costs nothing and widens the margin above the 700 MB abort line.

### Residual risk, stated plainly

A build colliding with a burst of agent spawns can still put the box under
1 GB. The gate does not eliminate that; it makes it **bounded, observed, and
abortable** rather than open-ended. The remaining exposure is the agent fleet's
own spawn burstiness, which is AUR-3929's territory, not this gate's.

## Procedure

```bash
cd /home/ievgen/paperclip

# 1. Build the artifact. Production keeps running the old release throughout.
./scripts/deploy/safe-deploy.sh --ref origin/master --build-only

# 2. Activate when ready. Add --expect-cap when the release is supposed to
#    contain the AUR-3929 cap; activation rolls back if cap_deployed != yes.
./scripts/deploy/safe-deploy.sh --ref origin/master --activate --expect-cap

# Manual rollback at any later point:
./scripts/deploy/safe-deploy.sh --rollback
```

`--activate` prompts before flipping; pass `--yes` for unattended runs.

Tunables (env overrides): `PAPERCLIP_DEPLOY_FLOOR_MB`,
`PAPERCLIP_DEPLOY_ABORT_FLOOR_MB`, `PAPERCLIP_DEPLOY_BUILD_MEM_MAX`,
`PAPERCLIP_DEPLOY_QUIESCE_MAX_PROCS`, `PAPERCLIP_DEPLOY_PREFLIGHT_WAIT_SEC`.

## Do not run `--activate` from inside an agent heartbeat

`systemctl --user restart paperclip.service` restarts the control plane, which
terminates **every in-flight agent run — including the one executing the
deploy.** The script would be killed between the symlink flip and the
verification step, leaving `current` swapped with nobody left to confirm or roll
back. That is the "half-swapped release" failure this issue was opened to
prevent, reintroduced through the back door.

`--build-only` is safe from an agent heartbeat: it never restarts anything.

Run `--activate` detached from the control plane, so it survives the restart:

```bash
systemd-run --user --unit paperclip-activate --collect \
  /home/ievgen/paperclip/scripts/deploy/safe-deploy.sh \
  --ref origin/master --activate --expect-cap --yes
journalctl --user -u paperclip-activate -f
```

## Footgun this gate closes

`build-release.sh --force` runs `sudo rm -rf` on the target release directory. If
that target is the *currently active* release, it deletes the code production is
executing from. `safe-deploy.sh` refuses to build the active release for this
reason.

## Known gap

The sampler writes records non-atomically: on 2026-07-25, **29 of 75** records
were split across two lines by concurrent appends. `safe-deploy.sh` tolerates
this by parsing only well-formed 18-field records, but it halves the sampler's
effective resolution (~10 min instead of 5 min). Tracked separately — per
AUR-4023 the sampler is not rebuilt here.
