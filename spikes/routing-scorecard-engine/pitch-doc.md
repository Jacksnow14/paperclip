# Routing & Scorecard Engine — a cost-adjusted "who should do this work" API

## Problem

Every team that routes recurring work across multiple people, vendors, or
automated workers eventually asks: *who should get the next unit of work,
and why?* Most routing today is either a static rule ("always send it to
X") or a raw quality score that ignores what the work actually cost. Both
fail the same way: a performer who is slightly better but three times
more expensive looks like the obvious choice on quality alone, with no
number to say otherwise. When cost data is missing for some records —
common, since cost tracking is usually bolted on after the fact — naive
implementations either silently treat "unknown cost" as "zero cost"
(inflating that performer's apparent efficiency) or discard the record
(losing a real quality signal). Both are quiet bugs that compound over
months of routing decisions.

## Solution

A small, embeddable API — no framework, no external dependencies, no
LLM calls — that turns performance history into a single defensible
number and a routing decision with a plain-English reason attached:

- **Score**: `(quality × value) / cost`, computed per unit of work. A
  record with no measured cost is flagged as "unmeasured," never divided
  or defaulted to zero, so it can't silently distort an average.
- **Streak detection**: four independent statistical checks over a
  performer's recent history — a baseline shift, a small-sample decline,
  a sustained quality floor, and a rework streak — so a real regression
  surfaces before it becomes a pattern, without false-alarming on normal
  variance.
- **ROI ledger**: aggregates cost-adjusted value over time into a single
  return-on-cost ratio per performer or task type.
- **Routing recommendation**: given several candidates, picks the one
  with the best cost-adjusted track record where that data exists, falls
  back to raw quality where it doesn't, and always returns why — not just
  which.

It ships as a plain REST API (OpenAPI 3.0 spec included) with a pluggable
storage interface, so it drops into an existing stack without dictating
how you store or identify your performers.

## Measured results (representative sample, fixture-derived)

These numbers come from a 31-case unit test suite exercising the exact
formulas above against representative fixtures — not production-scale
data, and not a claim about live volume:

- A performer whose last three outcomes went 5 → 3 → 2 with associated
  rework correctly triggers a regression alert; a performer holding
  steady at 4 → 4 → 4, even with occasional rework, correctly does not —
  demonstrating the detectors distinguish a real decline from noise.
- An unmeasured-cost record is excluded from the ROI ratio entirely
  rather than folded in as free: including it the naive way would have
  doubled the computed ratio in our test case (from 1.6 to 3.2) — the
  exact class of silent error this design exists to prevent.
- Given two candidates where only one has cost-adjusted history, the
  routing recommendation correctly prefers that candidate and states the
  average score and sample count it used to decide.

## Ask

Vendors like AccuKnox (workload/risk scoring) and Wired2Lead (lead-routing
intelligence) show that buyers already pay for "route to the best option
and explain why" as a feature — but neither offers this specific,
cost-adjusted, embeddable primitive as a standalone API. We're looking
for 2–3 design partners with real routing decisions (support tickets,
sales leads, contractor assignments, or similar) to pilot this against
their own historical data, tell us where the formulas break, and help
shape the v1 API before we build a production backend around it.
