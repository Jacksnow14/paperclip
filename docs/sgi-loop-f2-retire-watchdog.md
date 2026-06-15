# SGI Loop F-2 — Retire/Repurpose Proposal Watchdog

**Script:** `scripts/sgi-loop-f2-retire-watchdog.mjs`
**Routine:** `c97632e4` (Weekly Monday 09:00 UTC, `reuse_and_rewake`)
**Exec issue:** AUR-1489

## Purpose

Loop F-2 is the final stage of the SGI (Self-Governance & Improvement) pipeline.
It identifies agents who have sustained bottom-quartile cost-adjusted performance
*after* a Loop C self-edit attempt, and posts a board `request_confirmation`
interaction to propose either retiring or repurposing them.

**The watchdog never auto-retires an agent.** All proposals require explicit
board confirmation.

## Gates (all must pass)

| Gate | Logic |
|------|-------|
| **1 — Min sample count** | Agent must have ≥ 8 `scorecard-adjusted/*` records in the memory window. Single-sample agents (e.g. CFO, UX) are structurally unrepresentative and excluded. |
| **2 — Value-signal bias guard** | An agent with mean `quality_signal ≥ 3.5` is **exempt** regardless of cost-adjusted score. See below. |
| **3 — Bottom-quartile cost-adjusted score** | Mean `score_adjusted` must be at or below Q1 across the quality-gated set. |
| **4 — Loop C self-edit on record** | Must have a `prompt-improvement-proposal/{agentId}/*` memory record with `outcome: approved`. No such record → skip (no proposal). |
| **5 — 30-day cooldown** | No `capacity-decisions/{agentId}/*` record within the last 30 days. After posting a proposal, a cooldown record is written. |

## Value-Signal Bias Guard (Gate 2)

The cost-adjusted scorecard formula is `quality × value / tokens`. The
`value_signal` field defaults to **1** for `infra` and `ops` task types by the
scorecard convention (see `project_scorecard_convention.md` memory). CTO and CEO
handle a high proportion of infra/ops work, which structurally suppresses their
cost-adjusted scores even when their `quality_signal` is 4–5.

**Without the guard**, the watchdog would flag high-quality infrastructure agents
as retirement candidates — a false positive.

**Strategy chosen:** require `mean quality_signal < 3.5` as an additional gate.
An agent whose average quality is ≥ 3.5 cannot be proposed for retirement on a
low cost-adjusted score alone. This is simpler than normalising within task_type
and equally effective at preventing the false-positive.

## Idempotency

Re-running within the same ISO week posts no duplicate interactions.
`idempotencyKey = f2-retire-{agentId}-{isoYear}-W{isoWeek}`.

## Routine Setup

- **Primary routine `c97632e4`** (`reuse_and_rewake`): fires weekly, wakes CTO
  on AUR-1489. CTO runs `node scripts/sgi-loop-f2-retire-watchdog.mjs` in their
  heartbeat. When invoked, `PAPERCLIP_TASK_ID=AUR-1489` is set by the harness.

- **Duplicate paused routine `a70897ae`** (`loop-f-retire-watchdog`): disabled.
  This was an earlier stub. Do not re-enable it.

## Manual Test Run

```bash
source .env && node scripts/sgi-loop-f2-retire-watchdog.mjs --dry-run
```

## Output Format

- Console: per-agent gate trace, Q1 threshold, exemptions, gated reasons, proposal count.
- Live: `request_confirmation` interaction on AUR-1489, `capacity-decisions/{agentId}/{date}` cooldown record in Memory.
- Comment: posted to AUR-1489 summarising the run.
