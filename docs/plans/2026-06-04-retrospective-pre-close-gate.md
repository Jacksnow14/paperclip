# Design: Retrospective pre-close gate (AUR-1810)

**Status:** DESIGN — awaiting board ratification. No enforcement until accepted.
**Owner:** CTO (`371a1b08`)
**Tracking:** AUR-1810 · backstop audit AUR-1809 · exemption source-of-truth AUR-1619

## Problem
The AUR-1809 daily retrospective audit found **9 of 27 substantive closures (~33%)**
closed without a `## Retrospective` comment — caught a full day late. An after-the-fact
audit is the wrong primary control. Make the retrospective a **precondition of the
`done` transition** instead; keep the audit as a backstop.

## Where the gate hooks

The single chokepoint for closure is `PATCH /issues/:id` in
`server/src/routes/issues.ts` (handler at line 2888). The transition is detected as
`updateFields.status === "done" && existing.status !== "done"` (the exact predicate
already used for telemetry at line 3471 and `becameDone` at line 3719).

The gate is a **pre-transition guard**, placed alongside the existing guards that
already 4xx a transition (e.g. the unresolved-blockers guard at line ~2949 returning
`409 "Issue follow-up blocked by unresolved blockers"`). It runs **before** the issue
update commits, so a blocked close never mutates state.

Guard logic:
1. Only engage when the request transitions an open issue → `done`. (cancel,
   in_review, blocked, and done→done idempotent re-writes are untouched.)
2. If `isExempt(existing)` → **pass** (see §Shared exemption).
3. Compute "has retrospective" = a `## Retrospective` heading exists in **either**:
   - any existing comment on the issue (`svc.listComments(id)`), **or**
   - `commentBody` of *this same PATCH* (agents close with the retro comment in one
     call — this must count, or every legitimate close would 400 on the first try).
4. If has-retrospective → pass. Else → `422` with an actionable body (see §Error UX).

Heading match: a line matching `/^\s*#{1,6}\s+Retrospective\b/im` (tolerates `##`/`###`
and leading whitespace; anchored to a heading so prose mentioning "retrospective"
doesn't satisfy it). This mirrors the detection the AUR-1809 audit uses, kept in the
same shared helper so detection can never drift between gate and audit.

## Shared exemption (invariant #2 — lockstep with AUR-1619 §1a)

`isExempt` currently lives inline in `scripts/check-routing-rationale.mjs` (exported).
The retro gate runs **in-server (TypeScript)**, the audit runs **as a Node script
(.mjs)**. To keep one source of truth:

- Extract the exemption + heading-detection predicates into a shared, dependency-free
  module `packages/shared/src/governance/closure-exemption.ts` (compiled, importable
  by server) with a `.mjs`-consumable surface.
- `check-routing-rationale.mjs` and the AUR-1809 audit import `isExempt` from the
  shared module instead of redefining it.
- The server gate imports the same `isExempt` and `hasRetrospectiveHeading`.

Exemption rule reused verbatim (no behavioral change): `exec.routing-rationale: skip`
token, `/content slot/i` titles, daily-brief publication, content-pipeline children
(`write script` + `workflow signal`; `render & upload` + `video editor render task`),
and single-owner sign-off/approval gates. We additionally honor `originKind != manual`
(routine_execution / system-authored closures) as exempt — these have no human
retrospective obligation, matching the audit's scope. **If you change one, change the
shared helper; both pick it up.** A unit test asserts gate and audit resolve identical
exemption verdicts for a shared fixture set.

> Note: AUR-1810's invariant text references a `scripts/check-routing-rationale.mjs`
> that is not present on this working branch (branch divergence — see memory
> `project_branch_divergence`). The implementation child issue must rebase onto the
> branch that carries it (last touched in `8424ffc8`) before extracting the helper,
> so the refactor lands against the live file rather than a fork copy.

## Error UX (invariant #1 — never a silent or unrecoverable block)

`422 Unprocessable Entity`:
```json
{
  "error": "retrospective_required",
  "message": "Cannot close AUR-1234 as done: add a comment containing a `## Retrospective` heading first (see AGENTS.md § Before Closing Any Issue). You can include it in the same close request's comment.",
  "remedy": "post_retrospective_comment"
}
```
- The message names the exact remedy and that it can be done in the same call.
- It is **terminal and human-readable** — the agent's own close logic reads the error
  and posts the retro, it does not re-wake (invariant #3).

## No new loops (invariant #3)

The gate returns a plain 4xx from the PATCH handler. It does **not** create an
interaction, does **not** re-assign, does **not** emit a wake. A blocked close is a
normal validation failure the caller handles inline (post retro → retry once). Because
the same-request `commentBody` path satisfies the gate, a correctly-behaving agent
closes in a single PATCH and never sees the error. There is no retry storm surface.

## Backstop stays (invariant #4)

AUR-1809 keeps running unchanged. It now catches only the residue the gate cannot:
exempt-but-should-have-had-one, direct DB writes, and any path that bypasses
`PATCH /issues/:id`. Gate + audit share the exemption/detection helper so their
verdicts stay consistent.

## Rollout plan (staged, reversible)

A company-setting flag `governance.retroGate` with three values:

| Phase | Value | Behavior |
|-------|-------|----------|
| 0 | `off` (default) | Gate code present, no-op. Ships dark. |
| 1 | `log` | On a would-block close: **allow** the transition, emit a `governance/retro-gate/{issueId}` memory record + activity log. Measures real block-rate against the AUR-1809 baseline (33%) with zero risk. Run ~1 week. |
| 2 | `enforce` | Would-block closes return 422. Audit confirms residual misses → ~0. |

Promotion 0→1→2 is a config change, instantly reversible to `off`. Board ratifies the
**policy**; CTO flips `log`→`enforce` only after the `log` phase shows the gate fires on
real misses and **zero** false-positives against exempt closures.

## Deliverables & sequencing
1. **This doc** + `request_confirmation` to board (CEO + board) — *this issue*.
2. **After approval** (child issue): shared-helper extraction + gate guard +
   `governance.retroGate` flag, defaulting `off`. Tests: (a) non-exempt done-without-retro
   → 422; (b) same-request retro comment → passes; (c) exempt issue without retro →
   passes; (d) gate and audit agree on the exemption fixture set.
3. **Separate flip** (not code): `off`→`log`, observe, `log`→`enforce`.

## Invariant coverage
- #1 no permanent block → 422 names the remedy; same-request comment satisfies it.
- #2 lockstep exemption → single shared helper imported by gate + audit; parity test.
- #3 no loops → terminal 4xx, no wake/interaction/reassign.
- #4 audit stays → AUR-1809 unchanged as backstop, shares the helper.
