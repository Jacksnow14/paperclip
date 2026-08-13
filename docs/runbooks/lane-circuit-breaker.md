# Lane circuit breaker (AUR-5464)

Stops a provider outage (quota wall, auth wall, org-level entitlement
revocation) from being amplified by the fleet's own scheduler. The 2026-08-06
→ 08-12 org block produced 241 `claude_auth_required` failures because
admission kept starting runs into a lane that provably could not execute them.

Code: `server/src/services/lane-breaker.ts` (state machine, both trip sources,
half-open bookkeeping) on top of the AUR-4385 classifier in
`server/src/services/fleet-capacity.ts`. The single enforcement point is
`claimQueuedRun` in `server/src/services/heartbeat.ts` — the only
queued→running transition.

## States

| State | Meaning | Admission behaviour |
|---|---|---|
| `closed` | Lane healthy | Runs admitted normally |
| `open` (tripped) | A trip source proves the lane cannot execute | Queued runs are **left queued** (never cancelled — an outage must not destroy work); the periodic admission drive re-attempts them |
| `half_open` | One probe earned | Exactly **one** queued run is admitted as a probe per 30-minute interval; everything else stays deferred |

## Trip sources (independent — neither is a single point of failure for the other)

1. **Error stream** (always on): the fleet-capacity classifier derives
   per-agent state from terminal run history. Admission gates on
   `quota_exhausted`, `entitlement_revoked`, `lane_down` (rollup), and treats
   `quota_reset_unverified` as "earned an immediate probe", not "open the
   floodgates".
2. **Provider probe reports** (AUR-5435/AUR-5461 intake):
   `POST /api/companies/:companyId/fleet-capacity/lanes/:lane/probe-report`
   with `{"healthy": false, "reason": "...", "source": "..."}`. An unhealthy
   report trips the lane even when run history is quiet. A healthy report
   clears only a probe-sourced trip — it can **never** clear an error-stream
   trip, because only a succeeded run proves recovery.

`entitlement_revoked` (the 08-06 class: *"Your organization has disabled
Claude subscription access…"*, which ships under `errorCode: adapter_failed`)
has no reset boundary and **never auto-clears on a timer**. Quota walls with a
parseable reset boundary get an immediate probe once the boundary passes —
one run, not the fleet.

## Re-arm (closing the breaker)

The **only** proof of recovery is a `succeeded` run strictly after the
failure (classifier invariant — quota-starved runs still carry `startedAt` /
`usageJson`, so nothing weaker counts). Paths to that proof:

- **Automatic:** every 30 minutes a tripped lane admits one queued run as a
  half-open probe. If it succeeds, the failure tail breaks and the lane closes
  on the next evaluation (≤20 s snapshot cache). If it fails, the lane stays
  open and the next probe waits another interval.
- **Quota reset boundary passed:** the first probe is immediate (no 30-minute
  wait), because the provider itself claims recovery.

### Manual re-arm (operator)

After fixing the underlying outage (e.g. `claude /login`, subscription
re-enabled), don't wait for the probe interval:

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "http://127.0.0.1:3100/api/companies/<companyId>/fleet-capacity/lanes/claude_local/rearm"
```

This clears any provider-probe trip (operator override) and makes the **next
queued run an immediate probe**. It deliberately cannot blind-open the lane:
if the provider is still down, the probe fails and the lane re-trips. There is
no force-open switch — that is the design, not a gap.

Equivalent proof-by-hand: trigger any agent in the lane (`Test`/wake); its
succeeding run closes the breaker the same way.

## Observing

- `GET /api/companies/:companyId/fleet-capacity` → `lanes[]`: per-lane
  `state`, `trippedBy` (`error_stream` / `provider_probe`), `reason`,
  `nextProbeEligibleAt`, `providerProbe`, `manualRearmAt`. This is the "one
  board-visible state, not N failures" surface.
- Activity log: `fleet.lane_breaker_tripped`, `fleet.lane_breaker_rearmed`,
  `fleet.lane_breaker_probe_admitted`, `fleet.lane_breaker_manual_rearm`
  (entityType `fleet_lane`) — durable transition history.
- Server log: deferrals are throttled to one line per lane per minute
  (`laneBreaker: lane tripped — leaving queued runs queued`).

## Failure-mode notes

- Breaker evaluation errors **fail open** (admission proceeds, error logged):
  it is an availability guard, not a correctness gate, and a broken guard must
  not take the whole fleet dark.
- Breaker state is in-memory but the trip is *derived* from durable run
  history — a control-plane restart re-derives the trip on the first admission
  attempt; only the probe cadence resets (worst case: one extra probe per
  lane).
- Retry suppression is separate and pre-existing: `claude_auth_required` /
  `claude_quota_exhausted` / the org-block text schedule no bounded retry
  (verified in `heartbeat-retry-scheduling.test.ts`).
