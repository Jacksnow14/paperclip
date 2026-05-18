# Wake reliability: `process_lost` and `process_lost_retry`

**Status:** analysis complete — no code changes required  
**Issue:** [AUR-952](/AUR/issues/AUR-952) (child of [AUR-761](/AUR/issues/AUR-761))  
**Date:** 2026-05-18

---

## Root cause: what is `process_lost`?

The Paperclip heartbeat scheduler tracks child processes for local adapters.
When the scheduler cannot detect that a previously-launched process is still alive,
it marks the run `failed` with `errorCode: "process_lost"` and — if retry budget
remains — automatically queues one follow-up run.

**Code path** (`server/src/services/heartbeat.ts`):

```
reaped orphan scan
  → isTrackedLocalChildProcessAdapter(adapterType) == true
  → processLossRetryCount < 1
    → enqueueProcessLossRetry()      (first failure: queue retry)
  → processLossRetryCount >= 1
    → releaseIssueExecutionAndPromote()  (second failure: release lock)
```

**Which adapters trigger it:**  
Only those in `SESSIONED_LOCAL_ADAPTERS` (heartbeat.ts:147-155):
`claude_local`, `codex_local`, `cursor`, `gemini_local`, `hermes_local`,
`opencode_local`, `pi_local`.  
The `http` adapter **never** generates a `process_lost` or `process_lost_retry`.

**Retry cap:** exactly one automatic retry (`processLossRetryCount < 1`).  
If the retry also dies from `process_lost`, the server calls
`releaseIssueExecutionAndPromote`, which clears the execution lock and
promotes any deferred wakeup requests so the issue re-enters the scheduling queue.

---

## Last-7-day metrics (2026-05-11 → 2026-05-18)

Queries run against the embedded Postgres instance (port 54329).

### process_lost events by adapter

| Adapter       | Count (7d) | First seen           |
|---------------|------------|----------------------|
| `claude_local`| 108        | 2026-05-13T20:39Z    |
| `codex_local` | 15         | 2026-05-13T21:01Z    |
| `http`        | 0          | —                    |

### process_lost events by agent

| Agent             | Adapter       | Count |
|-------------------|---------------|-------|
| Claude Code Fast  | claude_local  | 49    |
| CTO               | claude_local  | 27    |
| Claude Code Max   | claude_local  | 17    |
| CEO               | claude_local  | 12    |
| CTO Ops           | codex_local   | 6     |
| CMO               | codex_local   | 5     |
| Junior Coder      | codex_local   | 3     |
| Video Editor      | claude_local  | 1     |
| Content Manager   | claude_local  | 1     |
| CFO               | codex_local   | 1     |
| UX Designer       | claude_local  | 1     |

### process_lost_retry run outcomes

Runs where `contextSnapshot.wakeReason = 'process_lost_retry'`:

| Adapter       | Status    | Error code       | Count |
|---------------|-----------|------------------|-------|
| claude_local  | succeeded | —                | 40    |
| claude_local  | failed    | process_lost     | 11    |
| claude_local  | failed    | adapter_failed   | 5     |
| claude_local  | cancelled | cancelled        | 3     |
| claude_local  | failed    | claude_auth_required | 1 |
| codex_local   | succeeded | —                | 11    |
| codex_local   | failed    | process_lost     | 2     |

**Retry success rate:** claude_local ≈ 67% (40/60), codex_local ≈ 85% (11/13).  
**Double process_lost** (retry also died from process_lost): **13 total** (~17% of all retries).

### Wakeup requests generated

| Adapter       | process_lost_retry requests |
|---------------|----------------------------|
| claude_local  | 65                         |
| codex_local   | 13                         |

---

## Exact query commands

```bash
# Run from any environment with postgres client at 127.0.0.1:54329
# db=paperclip, user=paperclip, password=paperclip

# process_lost by adapter (7d)
SELECT a.adapter_type, COUNT(*), MIN(r.created_at), MAX(r.created_at)
FROM heartbeat_runs r
JOIN agents a ON r.agent_id = a.id
WHERE r.error_code = 'process_lost'
  AND r.created_at >= NOW() - INTERVAL '7 days'
GROUP BY a.adapter_type ORDER BY count DESC;

# process_lost_retry outcome by adapter (7d)
SELECT a.adapter_type, r.status, r.error_code, COUNT(*)
FROM heartbeat_runs r
JOIN agents a ON r.agent_id = a.id
WHERE r.context_snapshot->>'wakeReason' = 'process_lost_retry'
  AND r.created_at >= NOW() - INTERVAL '7 days'
GROUP BY a.adapter_type, r.status, r.error_code ORDER BY count DESC;

# double process_lost (retry also hit process_lost)
SELECT COUNT(*) FROM heartbeat_runs r
WHERE r.context_snapshot->>'wakeReason' = 'process_lost_retry'
  AND r.error_code = 'process_lost'
  AND r.created_at >= NOW() - INTERVAL '7 days';
```

---

## Watchdog coverage analysis

`/home/ievgen/bot/scripts/wake_watchdog.py` monitors
`/home/ievgen/bot/state/pending_wakes/*.json` sentinel files. These files are
written by agents when they schedule a future wake (`wake_at.sh`). The watchdog
fires a re-engage comment on the linked issue if the deadline passes without the
sentinel being cleared.

**Coverage for `process_lost_retry`: not needed.**

The `process_lost_retry` mechanism is entirely server-side:

1. The heartbeat scheduler detects a dead child process.
2. `enqueueProcessLossRetry()` creates a new `agentWakeupRequests` row and a new `heartbeatRuns` row directly in the database — no sentinel file is written by the agent.
3. The server-side scheduler picks up the queued run without any external nudge.

The watchdog is the right fallback for **agent-scheduled wakes** (sentinel files), not for **system-generated retries** (DB rows). Adding sentinel-file logic for `process_lost_retry` would be redundant and could cause duplicate wakes.

**One indirect coverage gap** (acceptable risk):  
If both the original run and the retry die from `process_lost`, `releaseIssueExecutionAndPromote` is called. This clears the execution lock and promotes deferred wakeup requests. If the Paperclip server crashes at exactly that moment, the lock could remain stuck until the next heartbeat reaper cycle. The watchdog does not detect stuck execution locks; that is a separate concern (see [AUR-761](/AUR/issues/AUR-761) for broader scope).

---

## Decision

**Watchdog: no code change required.**

| Failure path                            | Current handling                                | Coverage |
|-----------------------------------------|-------------------------------------------------|----------|
| First process_lost (claude/codex local) | Server auto-retries once                        | ✅ full   |
| Retry succeeds (67–85% of retries)      | Normal completion path                          | ✅ full   |
| Retry also dies (process_lost, ~17%)    | `releaseIssueExecutionAndPromote` releases lock | ✅ full   |
| Server crash mid-release               | Next reaper cycle re-detects + releases         | ⚠️ partial |
| Scheduled wake missed after process_lost| Sentinel file still present → watchdog fires   | ✅ full   |
| http adapter process_lost              | Never happens (http doesn't track children)     | N/A      |

The ~17% double-process_lost rate (13/week) is worth monitoring as a leading indicator. If it rises above ~30/week, investigate OS-level process management or resource pressure on the host running `claude_local`.

---

## Recommendations

1. **No watchdog change needed** — the server-side retry and lock-release paths are load-bearing and functioning.
2. **Add a Telegram alert** for `double_process_lost` if weekly count exceeds 30 (current baseline: 13/week). The board routine script (`/home/ievgen/bot/scripts/board_routine.py`) is a natural place to add this check.
3. **Reaper cycle** already handles server-crash edge case on next tick — no additional change needed.
4. Monitor `process_lost` rate per agent; Claude Code Fast (49/7d = ~7/day) is the highest and may warrant investigating whether the OS is killing the process (OOM, SIGKILL from cron cleanup, etc.).
