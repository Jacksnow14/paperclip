# Runbook: Productivity Review Watchdog

`server/src/services/productivity-review.ts` scans in-progress/todo issues and files a
`Review productivity for {issue}` child issue against an issue's owner (manager/CTO/CEO) when it
sees a pattern that looks like the assignee is stuck: a no-comment run streak, an unusually long
active episode, or high run/comment churn. This runbook covers how to read its output and how it
avoids blaming agents for infrastructure failures.

## Triggers

| Trigger | Condition |
|---|---|
| `no_comment_streak` | N consecutive terminal, agent-attributable runs with no run-linked issue comment (default 10) |
| `long_active_duration` | Issue has been `in_progress` continuously past a threshold (default 6h) |
| `high_churn` | Run count or assignee-run-comment count in the last 1h/6h exceeds a threshold (default 10/1h, 30/6h) |

`no_comment_streak` and `high_churn` are "soft stop" triggers: while a review is open on one of
these, `isProductivityReviewContinuationHoldActive` can be used by the heartbeat loop to hold the
agent's continuation until a manager decides.

## Infra-kill exclusion (AUR-3926)

**Runs that failed because the control plane restarted or lost track of the child process are not
evidence about the assigned agent, and are excluded from every churn/no-comment computation.**

A run is classified infra-killed when `heartbeatRuns.errorCode === "process_lost"` (or, as a
defense-in-depth fallback for any row missing the error code, `error` starting with
`"Process lost"`). This is the same and only code path documented in
`server/src/services/heartbeat.ts` (`buildProcessLossMessage`, `errorCode: "process_lost"` at the
retry-detection site around `heartbeat.ts:6717`) — it fires precisely when the control plane
itself restarted mid-run and cannot account for the child, carrying no signal about what the agent
did or didn't do.

Concretely:

- `countIssueRunsSince` (feeds `runCountLastHour`/`runCountLastSixHours`, i.e. the `high_churn`
  tally) excludes infra-killed runs at the SQL layer (`infraKilledRunSqlExclusion`).
- The no-comment streak walk (`collectEvidence`) skips infra-killed terminal runs entirely --
  they neither extend nor break the streak, so a retry storm during an outage cannot inflate the
  no-comment streak.
- Retries of an infra-killed run (`retryOfRunId`) are just another row in `heartbeat_runs`; each
  row is classified independently by its own `errorCode`/`error`, so an exhausted retry that also
  died to `process_lost` is excluded the same way, and a retry that goes on to genuinely succeed
  or fail is counted on its own merits. Nothing double-counts a single incident.
- **What still counts:** any terminal run that is not classified infra-killed -- including plain
  agent-caused failures -- still counts as churn. This is intentional and is why a 10-run,
  0-comment streak of genuinely `succeeded` runs still fires `no_comment_streak`/`high_churn`.
  The exclusion is narrowly scoped to the recognized "Process lost" signal, not to failures in
  general -- we do not have a reliable way to detect other "unknown cause" failures without more
  signal than the run row carries, so those are treated as attributable by default (fail-closed
  would mean *not* accusing the agent, which for a genuine failure is the wrong direction).

## Outage suppression

A single agent retrying repeatedly is ambiguous. **Two or more distinct agents dying to
`process_lost` in the same window is a control-plane death, categorically** -- that was the
synchronized-timestamp tell that exposed AUR-3921 as a false positive during the AUR-3924 OOM
incident.

Before evaluating any candidate issue for a given company, `reconcileProductivityReviews` calls
`detectCompanyInfraOutage`, which looks at all terminal `heartbeat_runs` for that company in the
last `outageWindowMs` (default 1h) and computes:

- `distinctInfraAgentCount` -- distinct `agentId`s with at least one `process_lost` run in the
  window
- `infraCount / total` -- the share of terminal runs in the window that are `process_lost`

An outage is declared when `distinctInfraAgentCount >= outageMinDistinctAgents` (default 2) **and**
`total >= outageMinTerminalRuns` (default 5) **and** `infraCount / total >= outageInfraShare`
(default 0.5). While a company is in that state for the current reconcile pass, **no per-agent
productivity review is created or refreshed** for that company -- candidates are counted under
`result.suppressedForInfraOutage` instead. One `logger.warn` and one `activity_log` row
(`company.productivity_review_suppressed_for_infra_outage`) are emitted per company per pass, so
there is a single infra signal instead of N per-agent false accusations.

## Reading the evidence block

Every filed review's evidence section now states the infra/attributable split explicitly:

```
- Terminal sampled runs: 10 (9 infra-killed `process_lost`, 1 attributable to the agent)
```

and a contradiction line is appended to the trigger reasons whenever a review is about to fire
with `$0` in cost events despite attributable runs being sampled -- `Cost events total: 0 cents`
next to a high run count is itself a signal that the runs never did billable work, which is
exactly the AUR-3921 tell (`10 runs/0 assignee-run comments` with `Cost events total: 0 cents`).
Treat that combination as a reason to double-check the run detail before acting on the review, even
if the infra-kill/outage filters above did not catch it (e.g. a future infra failure mode this
runbook doesn't yet know about).

## Productivity reviews do not feed agent scorecards automatically

Filing a productivity review issue does **not** by itself write to, or degrade, an agent's
`performance/` or `scorecard-adjusted/` Memory records -- there is no code path from
`productivity-review.ts` or `issues.ts` into `server/src/services/memory.ts`. Those records are
only written when an agent explicitly calls the Memory capture API as part of its own
issue-closing retrospective (see each agent's `AGENTS.md`). Practically, this means:

- A false productivity review (e.g. filed during an infra outage) cannot, by itself, corrupt
  routing/performance data.
- The residual risk is behavioral, not structural: an agent closing out a review-triggered episode
  should reflect the infra cause in its own retrospective rather than self-reporting churn/rework
  it didn't actually cause. The evidence block above (infra split + contradiction line) is designed
  to make that easy to see at a glance.

## Tuning

All thresholds are overridable per call via `reconcileProductivityReviews({ thresholds })`; see the
`DEFAULT_PRODUCTIVITY_REVIEW_*` and `DEFAULT_PRODUCTIVITY_REVIEW_OUTAGE_*` exports in
`productivity-review.ts` for current defaults.
