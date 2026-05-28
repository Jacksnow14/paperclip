# SGI Roadmap for Auranode Infrastructure

Owner: CEO (Paperclip agent `3823a155-…`)
Source issue: [AUR-1395](/AUR/issues/AUR-1395) — SGI Path for Auranode infra
Status: Tier 1 + Tier 2 delivered. Tier 3 pending board sign-off.
Last revised: 2026-05-28

---

## 1. The objective

Move Auranode infra (Paperclip, memory, agent comms, budget, profit-seeking, delivery) from "AI that executes tasks" toward an **AGI** posture (general competence across tasks the company sets) and then a **SGI** posture (the system reliably becomes *better at being a company* with every task it ships — improvement is part of the loop, not a side project).

This is a productisation problem, not a research problem. We do not need a smarter model on each tick. We need every tick to be *data* that the next tick learns from, and we need that learning to *change behaviour automatically* — not after a quarterly retro humans never write.

## 2. The mental model: three concentric loops

```
   Loop 1: Per-task    — every issue produces structured signal (scorecard, gap, retro)
   Loop 2: Per-week    — signal is summarised and acted on (routing, triage, prompt edits)
   Loop 3: Per-quarter — the architecture itself is rewritten based on what worked
```

Without Loop 1, Loops 2 and 3 are guessing.
Without Loop 2, Loop 1 is just logging.
Without Loop 3, the company plateaus at "good agents", not "improving company".

Tier 1 built Loop 1. Tier 2 built Loop 2. Tier 3 is Loop 3 plus the missing economic feedback (budget / profit-seeking).

## 3. What is live today (delivered under AUR-1395)

### Tier 1 — Per-task signal capture (AUR-1405, 1415, 1416, 1417 — all `done`)

| Loop                       | Mechanism                                                            | Evidence              |
|----------------------------|----------------------------------------------------------------------|-----------------------|
| Retrospective enforcement  | All 12 agent `AGENTS.md` require retro comment + memory capture before `done`. Daily compliance audit routine. | routine `415630fe`, retros in memory (4 captured today). |
| Pre-task memory query      | All 9 adapters inject `paperclipMemoryPreamble` so every agent starts with relevant prior facts. | 13 live `AGENTS.md` + onboarding templates updated. |
| Performance scorecards     | Every `done` writes `performance/{agentId}/{taskType}/{date}` with outcome / token_cost / quality_signal / rework_required. Auto-accepted via review gate. | 10 scorecards in memory today, all accepted. |
| Tool-gap registry          | Agents log `tool-gaps/…` whenever they workaround a missing capability. | 4 gaps logged today, all accepted. |

### Tier 2 — Per-week / per-event acting on the signal (AUR-1444, 1445, 1446 — all `done`)

| Loop                                    | Mechanism                                                                       | Evidence              |
|-----------------------------------------|---------------------------------------------------------------------------------|-----------------------|
| A. Routing by scorecard                 | CEO instructions mandate scorecard query + `routing/{issueId}` rationale capture for any `priority: high\|critical`. Watchdog routine flags misses. Auto-accept on rationale records (commit `ee9c6915`). | watchdog routine `099327ae` active; rationale capture API live. |
| B. Weekly tool-gap triage               | Monday 09:00 UTC routine summarises new gaps, opens implementation issues for the highest-value ones, files zero-gap-week notes on AUR-1447. | routines `b775423e` (CTO) + `6702e194` (CEO) active. *Note: duplicate routine — consolidate in Tier 3 cleanup.* |
| C. Prompt self-edit proposals (SGI Loop C) | Daily streak-detector routine identifies agents with 3 declining scorecards; opens a self-edit proposal issue requesting board approval. CEO approval protocol in this `AGENTS.md`. | routine `4f0c9d5d` active. |

**Net effect**: the system can now (a) measure itself per task, (b) reroute work based on those measurements, (c) demand fixes for its own missing tools, and (d) propose its own prompt changes when an agent visibly drifts. That is the first three properties of an SGI loop: *observe, evaluate, act on self*.

## 4. What is missing — Tier 3 proposal (the real SGI step)

Tier 1+2 makes individual agents better. Tier 3 makes the *company* better — economically, architecturally, and across projects.

### Loop D — Economic feedback (budget + profit-seeking)
The system currently rewards "task done" but does not reward "task done *cheaply* against the value it produced". Without this, the scorecards push for quality but not for unit economics.

Proposal:
- Every `done` issue gets a `value_signal` (board-set or inferred from project type) alongside `token_cost`.
- Scorecards become **cost-adjusted**: `quality_signal × value / token_cost`.
- Routing prefers the highest cost-adjusted agent for a given task type, not just the highest-quality one.
- Per-project budget ledger: every project sees its lifetime tokens, lifetime value, and ROI. Negative-ROI projects flag for review automatically.
- Profit-seeking trigger: when a project crosses a positive-ROI threshold, the system suggests *more of it* (more similar issues, more capacity) without waiting for the board.

Estimated cost: ~40K tokens implementation, mostly on the scorecard schema migration and the routing-policy module already touched in Tier 2.

### Loop E — Cross-project memory synthesis
Memory today is mostly per-issue. Patterns *across* projects are invisible unless the CEO happens to query.

Proposal:
- Nightly synthesis routine reads the day's retros, scorecards, and gaps; produces `synthesis/{YYYY-MM-DD}` records ("recurring failure modes", "consistently strong patterns").
- Quarterly architecture review issue is auto-opened with these synthesis records as context — the system writes the prompt for its own next refactor.

Estimated cost: ~25K tokens.

### Loop F — Capacity self-management (auto-hire / auto-retire)
Today new agents only appear when the CEO hires. Tier 1+2 gives us enough signal to automate it.

Proposal:
- When a tool-gap is filed >3 times and the missing capability is a specialist role (e.g. "data labelling agent"), the system auto-drafts a `paperclip-create-agent` request and surfaces it to the board for one-click approval.
- When an agent's scorecards stay in the bottom quartile across >10 tasks after self-edit attempts, the system proposes retiring or repurposing it.

Estimated cost: ~30K tokens; depends on the hiring/retire API being safe to drive from an agent.

### Loop G — Acceptance-criteria pre-flight
Most of the rework we see in retros comes from issues being underspecified. Tier 3 catches it earlier.

Proposal:
- Before any non-trivial assignment, an automated reviewer checks the issue against an acceptance-criteria schema (must have measurable AC, must name expected artifact, must name verifier). If missing, the issue is bounced back to the creator before any executor wakes.
- This converts "agent spends 20K tokens guessing the goal" into "issue gets 200 tokens of clarification first".

Estimated cost: ~15K tokens; cheap and very high leverage.

### Stretch — Loop H (the real SGI primitive)
Once D–G are live, the company has enough self-data to attempt the actual SGI move: **let the system propose and run its own experiments**.

- The system proposes a hypothesis ("if we route bugs to agent X instead of Y, projected ROI +12%").
- Board approves the experiment scope and budget cap.
- The system runs the experiment over N tasks with the change in place, measures, and writes its own conclusion.
- The conclusion (if positive) becomes a permanent prompt edit via Loop C; the scorecards verify it stuck.

This is the AGI→SGI step: the system is no longer just executing the board's plans; it is generating, testing, and locking in its own improvements within board-defined guardrails.

Estimated cost: ~80K tokens to build the experiment framework, plus per-experiment cost.

## 5. Recommended sequencing

| Priority | Loop | Why first |
|----------|------|-----------|
| 1 | **G — Acceptance-criteria pre-flight** | Cheapest, highest leverage; reduces the cost basis of every other loop. |
| 2 | **D — Economic feedback** | Without it Tier 2 routing optimises the wrong variable. |
| 3 | **E — Cross-project synthesis** | Compounds with D once cost signal is in. |
| 4 | **F — Capacity self-management** | Needs D+E to be safe. |
| 5 | **H — Experiment framework** | Only meaningful once D–F are stable. |

Total Tier 3 budget estimate: ~190K tokens across five loops, deliverable incrementally.

## 6. What we deliberately don't do

- **No model swaps as the answer.** Tier 3 is about the company process, not about throwing a smarter model at the problem.
- **No autonomous spending.** Every economic action proposed by the system still passes through a board approval gate until trust is earned per project.
- **No deletion of agents without proposal.** Loop F retires by proposal, not by silent removal.
- **No silent prompt edits.** Loop C and any future Loop H prompt change is board-approved, logged, and reversible. The system improves itself transparently or not at all.

## 7. What the board needs to decide

1. **Sign-off on Tier 1+2** as the live SGI foundation (loops A–C plus the four signal-capture conventions). This locks in what is already in production.
2. **Tier 3 commission**: which of D, E, F, G, H to authorise, in what order, and against what token budget.
3. **Value-signal source for Loop D**: who/what assigns the per-issue value number — board, project owner, or an inferred heuristic from project type — so D can begin.

Once the board answers these, the CEO will open the Tier 3 children and drive them the same way Tier 1 and Tier 2 were driven.
