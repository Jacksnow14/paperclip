# Routing & Scorecard Engine (spike)

A cost-adjusted performance scorecard and routing-recommendation engine,
extracted and repackaged as a standalone, dependency-minimal service.

This directory is fully self-contained. It does not import from anywhere
outside itself, requires no environment variables, and makes no network
calls other than the HTTP server it starts. It has nothing to do with the
rest of this monorepo at runtime — see "Provenance" below for how it
relates to it at the source level.

## What it does

Given how much an outcome cost (tokens, compute-minutes, anything
comparable) alongside how good it was and how much it was worth, this
engine:

- computes a single **cost-adjusted score**: `(quality * value) / cost`,
  refusing to fabricate a score when cost was never measured (that's
  "unmeasured", not "free" — see `src/score.ts`);
- tracks that score over time per (agent, task type) bucket and runs four
  independent detectors to catch a quality regression early — a baseline
  shift, a small-sample decline, a sustained low floor, or a rework streak
  (`src/streak.ts`);
- aggregates records into a **return-on-cost ledger**: lifetime value per
  1,000 units of cost spent, again refusing to fold in unmeasured-cost
  records as if they were free (`src/roi.ts`);
- **recommends which of several candidates to route new work to**, using
  cost-adjusted history where it exists and falling back to raw quality
  where it doesn't — always returning a human-readable rationale alongside
  the numbers (`src/routing.ts`).

## Run it

```sh
npm install
npm test    # compiles then runs the ported/derived unit test suite
npm start   # compiles then starts the HTTP server on :8787 (set PORT to override)
```

No other setup is required. `npm test` and `npm start` both run `tsc`
first via `npm run build`.

## Layout

```
src/
  util.ts     mean/median helpers
  score.ts    computeScoreAdjusted — the core formula
  streak.ts   evaluateBucket, selectForCreation — regression detectors
  roi.ts      deriveValueSignal, aggregateRoi — the ROI ledger math
  routing.ts  recommendCandidate — the routing comparison + rationale
  store.ts    ScorecardStore interface + in-memory / JSON-file adapters
  server.ts   thin node:http layer implementing openapi.yaml
  index.ts    library entry point (re-exports everything above)
tests/        one test file per logic module, run via node:test
openapi.yaml  the API spec this server implements
```

## API

See [`openapi.yaml`](./openapi.yaml) for the full spec. Four endpoints:

- `POST /v1/score` — compute one score, no storage.
- `POST /v1/scorecards` — record a scorecard, get back its score and the
  current streak evaluation for its bucket.
- `GET /v1/scorecards/{agent_id}/{task_type}/summary` — sample count,
  median score, ROI aggregate, and streak evaluation for a bucket.
- `POST /v1/route` — given N candidates (each with inline records, or an
  `agent_id` to look up recent records from this server's own store),
  get back a recommendation and its rationale.

Quick manual check once `npm start` is running:

```sh
curl -s -X POST localhost:8787/v1/score \
  -H 'content-type: application/json' \
  -d '{"token_cost": 1000, "quality_signal": 4, "value_signal": 2}'
# {"score_adjusted":0.008,"reason":null}
```

## Storage

`ScorecardStore` (`src/store.ts`) is a two-method interface —
`append`/`query` — so a real deployment can swap in whatever database it
wants. Two adapters ship here:

- `InMemoryScorecardStore` — the default. No setup, resets on restart.
- `JsonFileScorecardStore` — a persistence demo only, not intended for
  concurrent or production use.

## Provenance — what this is a port of, and what it deliberately isn't

This code was extracted read-only from four places in a larger internal
platform, as a scoping exercise in whether the underlying decision logic
holds up as a standalone, externally-pitchable service. Each source file
below has a matching header comment citing exactly this:

| This file | Ported from | Left out (deliberately) |
|---|---|---|
| `src/score.ts` | The `score_adjusted` formula and its "unmeasured cost ≠ free" edge case | — (the formula is small enough to port whole) |
| `src/streak.ts` | The four-detector regression/streak evaluator | The source additionally orders two detectors by a separate "work date" pulled from an issue-title convention, and fails a window closed when that date is ambiguous or missing. This port takes the reduced input shape `{quality_signal, rework_required, timestamp}` and orders directly by timestamp — a caller with a genuine work-date/insertion-order distinction should sort before calling. |
| `src/roi.ts` | The value-derivation and lifetime value/tokens aggregation | Project resolution, revenue-basis accounting, and company-wide percentile bands — all specific to the source platform's data model, not general to the ROI math itself. |
| `src/routing.ts` | The Step 1 (cost-adjusted) / Step 2 (raw quality, fallback) candidate-comparison algorithm | Nothing structural — this is the full comparison logic, restated against a generic `Candidate`/`CandidateRecord` shape instead of the source platform's specific record types. |

None of the source files were modified. Nothing here imports from, or
writes back to, the platform it was extracted from — this is a clean-room
standalone copy, not a shim or wrapper around the original.

**Explicitly out of scope for this spike:** agent identity/run/checkout
modeling, billing, a dashboard, onboarding flows, or multi-tenant
productization. This is unopinionated, reusable decision logic — how you
identify a "candidate" or an "agent" is left entirely to the caller.

## Test coverage

`tests/streak.test.ts` and `tests/roi.test.ts` port the subset of the
source platform's test fixtures that apply to this port's simplified
input shape (documented case-by-case in each file's header comment).
`tests/score.test.ts` and `tests/routing.test.ts` are written fresh
against the source formula and the documented Step 1/Step 2 algorithm
respectively, since no standalone fixture file existed for either in the
source platform.
