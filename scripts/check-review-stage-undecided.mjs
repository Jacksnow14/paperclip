#!/usr/bin/env node
/**
 * check-review-stage-undecided.mjs
 *
 * Watchdog for the "silent review-stage downgrade" defect (AUR-4171).
 *
 * Defect being detected
 * ---------------------
 * An issue carrying an `executionPolicy` with review stages can end up with a
 * reviewer who "approves" in a free-text comment but never records the stage
 * decision (no row in `issue_execution_decisions`). The stage stays `pending`,
 * so the executor's `PATCH {status:"done"}` is silently re-applied as
 * `in_review` and the issue sits there forever with nobody at fault.
 *
 * The discriminator is SYNTACTIC, not semantic: *the current stage participant
 * spoke on the issue but recorded nothing*. We never parse comment text for
 * approval sentiment — the same words in a run-log or a question would produce
 * the same (correct) flag, because the failure is the missing decision row, not
 * the words. Conversely, stage state ALONE is not discriminating: a healthy
 * issue waiting on a reviewer who has simply not looked yet has a
 * byte-identical `executionState`. Only the participant-authored comment
 * separates "stuck" from "queued".
 *
 * Detection predicate (see `evaluateIssue`) — ALL must hold:
 *   1. executionState.status === "pending"
 *   2. executionState.currentStageType === "review"
 *   3. executionState.currentStageId NOT in executionState.completedStageIds
 *   4. executionState.lastDecisionOutcome is null OR "changes_requested"
 *      (BOTH signatures — the live AUR-3233 row is `null`; a detector written
 *      only against "changes_requested" matches zero rows)
 *   5. a stage-open bound can be resolved from the activity feed (AUR-4702 /
 *      AUR-6176 — see "Stage-open bound" below). If it cannot, the issue is
 *      SKIPPED, never flagged and never silently treated as "any comment ever".
 *   6. the current participant (executionState.currentParticipant) authored a
 *      comment at or after that bound
 *   7. that comment is older than --min-age-hours (default 24)
 *
 * Stage-open bound (AUR-4702 / AUR-6176)
 * ---------------------------------------
 * There is no `stageOpenedAt` column, no `executionStateUpdatedAt` field, and
 * no `/decisions` endpoint — all three were verified absent at runtime
 * (`GET /api/issues/{id}` never returns `executionStateUpdatedAt`, and
 * `/decisions`, `/execution`, `/execution/decisions`, `/execution-stages` all
 * 404). A prior WIP branch (`aur-4171-ask2-detection-wip`) resolved the bound
 * from those fields and was therefore inert in production — `bound` was
 * always `null` and the predicate silently fell back to "any comment the
 * participant ever authored while `in_review`", producing the exact false
 * positive this rebuild fixes (reviewer requests changes -> executor
 * resubmits -> the reviewer's STALE old comment satisfied the fallback).
 *
 * `GET /api/issues/{id}/activity` DOES exist and returns every activity row
 * for the issue, newest first (the `limit` query param is accepted by
 * `/companies/{id}/activity` but silently ignored by this per-issue route —
 * verified empirically: `?limit=5` and no `limit` at all return the same
 * count). `issue.updated` rows carry `details.executionState` and
 * `details._previous.executionState`, which is enough to find the instant the
 * CURRENT stage entered its `pending` state.
 *
 * IMPORTANT — verified against real production rows (AUR-6145), the
 * AUR-4702 write-up's proposed heuristic ("lastDecisionOutcome was non-null
 * and is now reset") does NOT hold: when a reviewer requests changes and the
 * executor resubmits, `lastDecisionOutcome` stays `"changes_requested"` on the
 * resubmit row — it is never reset to `null`. The field that DOES reliably
 * mark "this row is where the stage (re)entered pending" is
 * `executionState.status` itself. A row is a stage-open transition when its
 * OWN `executionState.status === "pending"` on the current `currentStageId`,
 * AND the previous state was either absent, on a different stage, or not
 * `"pending"` (see `activityOpensCurrentStage`). Walking the feed
 * newest-to-oldest and taking the first match gives the true stage-open bound.
 *
 * Usage:
 *   node scripts/check-review-stage-undecided.mjs [--min-age-hours N]
 *                                                 [--max-nudges N] [--apply]
 *
 *   Without --apply: dry-run — prints full plan, writes nothing.
 *   With --apply:    posts ONE nudge comment per stuck stage (idempotent —
 *                    deduped on a marker string scanned out of the existing
 *                    comment thread, so it fires once per stageId, not once
 *                    per run).
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exit codes:
 *   0 — clean (nothing to do, or all intended actions applied — a partial run
 *       where SOME mutations failed still exits 0; see the Failed count in the
 *       run summary for what to retry)
 *   1 — dry-run with pending actions (apply to execute)
 *   2 — configuration/API error
 *   4 — every intended mutation this run failed — nothing was accomplished
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Exported core predicate (pure — unit-tested without network) ─────────────

/** Default staleness threshold before a silent stage is worth nudging. */
export const DEFAULT_MIN_AGE_HOURS = 24;

/**
 * Marker embedded in every nudge comment so re-runs dedup per STAGE, not per
 * issue: a stage that legitimately re-opens (changes_requested → new review)
 * gets a new stageId and therefore a fresh nudge.
 */
export function nudgeMarker(stageId) {
  return `<!-- review-stage-undecided-watchdog:${stageId} -->`;
}

/**
 * The `lastDecisionOutcome` values that mean "no APPROVAL is on record for the
 * open stage". `null` is the live AUR-3233 signature (the stage never received
 * any decision at all); `changes_requested` is the second signature (a prior
 * round was decided, the re-review round never was). A detector written only
 * against `changes_requested` matches zero rows in production.
 */
export const UNDECIDED_OUTCOMES = new Set([null, undefined, 'changes_requested']);

function principalKey(principal) {
  if (!principal || typeof principal !== 'object') return null;
  if (principal.type === 'agent' && principal.agentId) return `agent:${principal.agentId}`;
  if (principal.type === 'user' && principal.userId) return `user:${principal.userId}`;
  // Tolerate a principal that omits `type` but carries exactly one id.
  if (principal.agentId) return `agent:${principal.agentId}`;
  if (principal.userId) return `user:${principal.userId}`;
  return null;
}

/** The principal key for a comment's author, or null if unattributable. */
export function commentAuthorKey(comment) {
  if (!comment) return null;
  const agentId = comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
  if (agentId) return `agent:${agentId}`;
  if (comment.authorUserId) return `user:${comment.authorUserId}`;
  return null;
}

/**
 * Stage-state half of the predicate (conditions 1-4). Returns a structured
 * verdict rather than a bare boolean so the dry-run log can explain WHY an
 * issue was skipped.
 *
 * NOTE: this is deliberately NOT sufficient on its own — controls in the test
 * suite carry a byte-identical executionState and must stay silent. See
 * `latestParticipantComment` / `resolveStageOpenedAt`.
 */
export function stageIsUndecided(issue) {
  const state = issue?.executionState ?? null;
  if (!state || typeof state !== 'object') {
    return { undecided: false, reason: 'no-execution-state' };
  }
  if (state.status !== 'pending') {
    return { undecided: false, reason: `state.status=${state.status ?? 'null'}` };
  }
  if (state.currentStageType !== 'review') {
    return { undecided: false, reason: `stageType=${state.currentStageType ?? 'null'}` };
  }
  const stageId = state.currentStageId ?? null;
  if (!stageId) {
    return { undecided: false, reason: 'no-current-stage-id' };
  }
  const completed = Array.isArray(state.completedStageIds) ? state.completedStageIds : [];
  if (completed.includes(stageId)) {
    return { undecided: false, reason: 'stage-already-completed' };
  }
  if (!UNDECIDED_OUTCOMES.has(state.lastDecisionOutcome ?? null)) {
    return { undecided: false, reason: `lastDecisionOutcome=${state.lastDecisionOutcome}` };
  }
  const participant = principalKey(state.currentParticipant);
  if (!participant) {
    return { undecided: false, reason: 'no-current-participant' };
  }
  return { undecided: true, reason: 'pending-review-stage-with-no-decision', stageId, participant };
}

/**
 * True when an `issue.activity` row is the moment the CURRENT review stage
 * entered its `pending` state — i.e. the row a participant comment must beat
 * to count as "spoke on this stage/round".
 *
 * A row qualifies when:
 *   - it is an `issue.updated` row,
 *   - its OWN `executionState.currentStageId` equals the stage we're
 *     resolving, AND its own `executionState.status === "pending"` (the row
 *     lands on pending — a row landing on `changes_requested` or `approved`
 *     is a DECISION being recorded, not a stage opening), AND
 *   - the state immediately before this row was either absent, on a
 *     different stage, or not `"pending"` — i.e. this is genuinely the
 *     transition INTO pending, not a no-op replay of an already-pending
 *     state (which happens on unrelated status flips, e.g. a `cancelled` ->
 *     `in_review` restore with an unchanged pending stage — verified against
 *     a real AUR-5053 row that must NOT count).
 *
 * Verified against two real production sequences (AUR-5053, AUR-6145): a
 * first-round open (`_previous.executionState` null) and a resubmit-after-
 * changes-requested reopen (`_previous.executionState.status ===
 * "changes_requested"`, SAME stage id, `lastDecisionOutcome` carried forward
 * unchanged — it does NOT reset to null on resubmit, contradicting the
 * lastDecisionOutcome-reset heuristic floated in AUR-4702's description).
 */
export function activityOpensCurrentStage(row, currentStageId) {
  if (!row || row.action !== 'issue.updated') return false;
  const details = row.details ?? {};
  const state = details.executionState ?? null;
  if (!state || typeof state !== 'object') return false;
  if (state.currentStageId !== currentStageId) return false;
  if (state.status !== 'pending') return false;

  const previous = details._previous ?? null;
  const previousState =
    previous && typeof previous === 'object' ? (previous.executionState ?? null) : null;
  if (!previousState || typeof previousState !== 'object') return true; // (a) no prior state at all
  if (previousState.currentStageId !== currentStageId) return true; // (b) different stage before
  if (previousState.status !== 'pending') return true; // (c) same stage, re-entered pending

  return false; // same stage, already pending — not an open event
}

/**
 * Resolve the instant the CURRENT review stage (re)opened, i.e. the lower
 * bound a participant comment must beat to count as "spoke on this stage".
 *
 * Walks the activity feed newest -> oldest and returns the `createdAt` of the
 * first row for which `activityOpensCurrentStage` holds. Fails CLOSED: if no
 * such row is found (empty feed, feed doesn't go back far enough, or the
 * shape doesn't match), returns `boundAt: null` with a distinct `reason` —
 * the caller must SKIP the issue, never fall back to "any comment ever".
 *
 * @param {object} issue
 * @param {{ activity?: Array<object> }} [opts]
 * @returns {{ boundAt: string|null, reason: string }}
 */
export function resolveStageOpenedAt(issue, { activity = [] } = {}) {
  const stageId = issue?.executionState?.currentStageId ?? null;
  if (!stageId) {
    return { boundAt: null, reason: 'no-current-stage-id' };
  }
  if (!Array.isArray(activity)) {
    return { boundAt: null, reason: 'activity-not-an-array' };
  }
  if (activity.length === 0) {
    return { boundAt: null, reason: 'no-activity-rows' };
  }

  const sorted = [...activity].sort(
    (a, b) => new Date(b?.createdAt ?? 0).getTime() - new Date(a?.createdAt ?? 0).getTime(),
  );

  for (const row of sorted) {
    if (!activityOpensCurrentStage(row, stageId)) continue;
    const ts = new Date(row.createdAt);
    if (Number.isNaN(ts.getTime())) continue;
    return { boundAt: ts.toISOString(), reason: 'resolved' };
  }

  return { boundAt: null, reason: 'stage-open-transition-not-found-in-activity' };
}

/**
 * Most recent comment authored by `participantKey` at or after `sinceMs`, or
 * `null` if the participant said nothing in that window.
 *
 * Most recent (not oldest) is deliberate: a participant who spoke 10 days ago
 * AND an hour ago is actively engaged, and nudging them is noise. Staleness is
 * measured against their latest word.
 */
export function latestParticipantComment(comments, participantKey, sinceMs) {
  let newest = null;
  for (const comment of comments ?? []) {
    if (commentAuthorKey(comment) !== participantKey) continue;
    const createdAt = comment?.createdAt ? new Date(comment.createdAt).getTime() : NaN;
    if (!Number.isFinite(createdAt)) continue;
    if (createdAt < sinceMs) continue;
    if (!newest || createdAt > new Date(newest.createdAt).getTime()) newest = comment;
  }
  return newest;
}

/**
 * Full predicate. Pure — no network, no clock, no env.
 *
 * @param {{ issue: object, comments: Array<object>, activity?: Array<object>,
 *           now?: Date|string|number, minAgeHours?: number }} input
 * @returns {{ flagged: boolean, skipped?: boolean, reason: string,
 *             stageId?: string|null, participant?: string|null,
 *             comment?: object|null, ageHours?: number,
 *             alreadyNudged?: boolean }}
 */
export function evaluateIssue({
  issue,
  comments = [],
  activity = [],
  now = Date.now(),
  minAgeHours = DEFAULT_MIN_AGE_HOURS,
}) {
  const verdict = stageIsUndecided(issue);
  if (!verdict.undecided) {
    return { flagged: false, reason: verdict.reason, stageId: issue?.executionState?.currentStageId ?? null };
  }

  const bound = resolveStageOpenedAt(issue, { activity });
  if (!bound.boundAt) {
    // Fail CLOSED — a bound we can't resolve must never degrade into "any
    // comment the participant ever posted". This is the exact defect the
    // rebuild fixes. Surfaced as a SKIP with a distinct reason, not a flag
    // and not silent "healthy".
    return {
      flagged: false,
      skipped: true,
      reason: `bound-unresolved:${bound.reason}`,
      stageId: verdict.stageId,
      participant: verdict.participant,
    };
  }

  const spoke = latestParticipantComment(comments, verdict.participant, new Date(bound.boundAt).getTime());
  if (!spoke) {
    // The healthy case: the reviewer simply has not looked yet (or their only
    // comment predates the current round). The stage state here is IDENTICAL
    // to the flagged case — this branch is what makes the detector
    // discriminating.
    return {
      flagged: false,
      reason: 'participant-silent',
      stageId: verdict.stageId,
      participant: verdict.participant,
    };
  }

  const nowMs = new Date(now).getTime();
  const ageHours = (nowMs - new Date(spoke.createdAt).getTime()) / 3_600_000;
  if (ageHours < minAgeHours) {
    return {
      flagged: false,
      reason: 'participant-spoke-recently',
      stageId: verdict.stageId,
      participant: verdict.participant,
      comment: spoke,
      ageHours,
    };
  }

  const marker = nudgeMarker(verdict.stageId);
  const alreadyNudged = (comments ?? []).some((c) => (c?.body ?? '').includes(marker));

  return {
    flagged: true,
    reason: 'participant-spoke-but-recorded-no-decision',
    stageId: verdict.stageId,
    participant: verdict.participant,
    comment: spoke,
    ageHours,
    alreadyNudged,
  };
}

/**
 * The nudge body. Names the stage, the participant, and the TWO valid actions,
 * because the whole failure mode is a reviewer who believes a free-text comment
 * recorded a decision.
 */
export function buildNudgeBody({ issueId, stageId, participant, ageHours }) {
  const hours = Math.round(ageHours);
  return [
    nudgeMarker(stageId),
    `## Review stage is open but no decision is recorded`,
    ``,
    `Issue **${issueId}** has an execution review stage \`${stageId}\` that is still \`pending\`.`,
    `Its current participant (\`${participant}\`) commented on this issue ~${hours}h ago, but no`,
    `execution decision was ever recorded for the stage.`,
    ``,
    `A free-text comment does **not** record a stage decision. While the stage stays`,
    `\`pending\`, the executor's \`PATCH {status:"done"}\` is silently re-applied as`,
    `\`in_review\` and this issue cannot close.`,
    ``,
    `\`${participant}\` — please record the decision with one of:`,
    ``,
    `- **Approve:** \`PATCH /api/issues/${issueId}\` with \`{"status":"done"}\` **and** a comment, posted by that participant.`,
    `- **Request changes:** \`PATCH /api/issues/${issueId}\` with \`{"status":"in_progress"}\` **and** a comment, posted by that participant.`,
    ``,
    `Filed by \`scripts/check-review-stage-undecided.mjs\` (AUR-4171). This nudge fires`,
    `once per stage id, not once per run.`,
    ``,
    `exec.preflight: skip`,
  ].join('\n');
}

// ── API helpers ───────────────────────────────────────────────────────────────

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  return { apiGet, apiPost };
}

/**
 * Extracts the HTTP status code apiPost embeds in its thrown error message
 * (`METHOD path → STATUS statusText`), falling back to 'unknown' for
 * network-level failures that never reached a response.
 */
export function extractStatusCode(errorMessage) {
  const match = /→\s*(\d+)/.exec(errorMessage ?? '');
  return match ? match[1] : 'unknown';
}

async function runMutation(label, fn, failures) {
  try {
    await fn();
    return true;
  } catch (err) {
    const status = extractStatusCode(err.message);
    console.error(`    FAILED (${status}): ${label} — ${err.message}`);
    failures.push({ label, status, message: err.message });
    return false;
  }
}

// ── Main routine ──────────────────────────────────────────────────────────────

/**
 * Only `in_review` issues can carry a pending review stage that blocks a close,
 * so that is the whole candidate pool.
 */
export const ISSUE_STATUS_FILTER = 'in_review';

/** Max comments pulled per candidate — newest first; a stuck stage is recent. */
export const COMMENT_FETCH_LIMIT = 200;

export async function main({
  minAgeHours,
  apply,
  apiUrl,
  apiKey,
  companyId,
  maxNudges = 20,
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPost } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  console.log('── Phase A: Collect in_review candidates ──');

  const issuesBatch = await apiGet(
    `/api/companies/${companyId}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`
  );
  const listIssues = Array.isArray(issuesBatch) ? issuesBatch : (issuesBatch.issues ?? []);
  console.log(`  ${listIssues.length} issue(s) in ${ISSUE_STATUS_FILTER}.\n`);

  console.log('── Phase B: Evaluate stage state + participant activity ──');

  const now = Date.now();
  const flagged = [];
  const skipped = new Map(); // reason → count
  const failedMutations = [];

  for (const listIssue of listIssues) {
    const key = listIssue.id ?? listIssue.identifier;
    if (!key) continue;

    // The issues LIST endpoint hard-nulls `executionState`
    // (services/issues.ts: `executionState: sql<null>\`null\``), so every
    // candidate MUST be re-fetched via the single-issue GET or the detector
    // sees `no-execution-state` for 100% of rows and reports a false "clean".
    let issue;
    try {
      issue = await apiGet(`/api/issues/${key}`);
    } catch (err) {
      console.error(`  SKIP ${listIssue.identifier ?? key}: issue fetch failed — ${err.message}`);
      skipped.set('fetch-failed', (skipped.get('fetch-failed') ?? 0) + 1);
      continue;
    }

    const stageVerdict = stageIsUndecided(issue);
    if (!stageVerdict.undecided) {
      skipped.set(stageVerdict.reason, (skipped.get(stageVerdict.reason) ?? 0) + 1);
      continue;
    }

    // Only fetch activity + comments for genuine candidates — cheapest gate
    // first. `/issues/{id}/activity` returns the full history for the issue
    // (it ignores `limit`), so no pagination handling is needed here.
    let activity;
    try {
      activity = await apiGet(`/api/issues/${key}/activity`);
    } catch (err) {
      console.error(`  SKIP ${listIssue.identifier ?? key}: activity fetch failed — ${err.message}`);
      skipped.set('activity-fetch-failed', (skipped.get('activity-fetch-failed') ?? 0) + 1);
      continue;
    }

    let comments;
    try {
      comments = await apiGet(`/api/issues/${key}/comments?order=asc&limit=${COMMENT_FETCH_LIMIT}`);
    } catch (err) {
      console.error(`  SKIP ${listIssue.identifier ?? key}: comment fetch failed — ${err.message}`);
      skipped.set('fetch-failed', (skipped.get('fetch-failed') ?? 0) + 1);
      continue;
    }
    const commentList = Array.isArray(comments) ? comments : (comments?.comments ?? []);
    const activityList = Array.isArray(activity) ? activity : (activity?.activity ?? []);

    // Trace the resolved bound for every genuine candidate, independent of
    // the eventual verdict — this is the one line that proves the rebuilt
    // resolver computes a real, non-null timestamp against production data,
    // not just that the overall predicate stayed silent.
    const bound = resolveStageOpenedAt(issue, { activity: activityList });
    console.log(
      `  TRACE ${issue.identifier ?? key} stage ${stageVerdict.stageId}: ` +
        `stage-open bound = ${bound.boundAt ?? `null (${bound.reason})`}`
    );

    const result = evaluateIssue({ issue, comments: commentList, activity: activityList, now, minAgeHours });
    if (!result.flagged) {
      skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
      continue;
    }

    flagged.push({ issue, result });
  }

  for (const [reason, count] of [...skipped.entries()].sort()) {
    console.log(`  SKIPPED (${reason}): ${count}`);
  }
  console.log();

  console.log('── Phase C: Nudge stuck stages ──');

  const alreadyNudged = flagged.filter(({ result }) => result.alreadyNudged);
  const toNudgeAll = flagged.filter(({ result }) => !result.alreadyNudged);
  const toNudge = toNudgeAll.slice(0, maxNudges);
  const deferred = toNudgeAll.slice(maxNudges);

  for (const { issue, result } of alreadyNudged) {
    console.log(
      `  ALREADY-NUDGED ${issue.identifier ?? issue.id} stage ${result.stageId} ` +
        `(participant ${result.participant}, ${Math.round(result.ageHours)}h silent)`
    );
  }

  if (deferred.length > 0) {
    console.log(`  DEFERRED — cap reached (max-nudges=${maxNudges}), held back ${deferred.length}:`);
    for (const { issue, result } of deferred) {
      console.log(`    - ${issue.identifier ?? issue.id} stage ${result.stageId}`);
    }
    console.log(`  Re-run the watchdog to process the remainder.`);
  }

  if (toNudge.length === 0) {
    console.log('  No new stuck stages to nudge.\n');
  } else {
    for (const { issue, result } of toNudge) {
      const issueId = issue.identifier ?? issue.id;
      console.log(
        `  NUDGE ${issueId} stage ${result.stageId} → participant ${result.participant} ` +
          `(silent ${Math.round(result.ageHours)}h since their last comment)`
      );
      if (apply) {
        const body = buildNudgeBody({
          issueId,
          stageId: result.stageId,
          participant: result.participant,
          ageHours: result.ageHours,
        });
        const ok = await runMutation(
          `nudge ${issueId} stage ${result.stageId}`,
          async () => {
            await apiPost(`/api/issues/${issue.id ?? issueId}/comments`, { body });
          },
          failedMutations,
        );
        if (ok) console.log('    → nudge posted.');
      }
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('── Summary ──');
  console.log(`  Candidates (in_review): ${listIssues.length}`);
  console.log(`  Flagged (undecided):    ${flagged.length}`);
  console.log(`  Nudged this run:        ${apply ? toNudge.length - failedMutations.length : 0}`);
  console.log(`  Already nudged:         ${alreadyNudged.length}`);
  console.log(`  Deferred:               ${deferred.length}`);
  console.log(`  Failed:                 ${failedMutations.length}`);
  if (failedMutations.length > 0) {
    for (const { label, status } of failedMutations) {
      console.log(`    - ${label} → ${status}`);
    }
    console.log('  Re-run the watchdog to retry the above (idempotent).');
  }

  if (!apply && toNudge.length > 0) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above actions.');
    return 1;
  }

  if (apply && toNudge.length > 0 && failedMutations.length === toNudge.length) {
    console.log('\nERROR: every intended mutation failed this run — see Failed list above.');
    return 4;
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      'min-age-hours': { type: 'string', default: String(DEFAULT_MIN_AGE_HOURS) },
      'max-nudges': { type: 'string', default: '20' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-review-stage-undecided.mjs [--min-age-hours N] [--max-nudges N] [--apply]');
    console.log(`  --min-age-hours N   Participant comment must be older than N hours (default: ${DEFAULT_MIN_AGE_HOURS})`);
    console.log('  --max-nudges N      Cap nudges posted per run (default: 20, anti-flood guard)');
    console.log('  --apply             Execute changes (default: dry-run, exit 1 if actions pending)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  const minAgeHours = Number(args['min-age-hours']);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    console.error(`ERROR: --min-age-hours must be a non-negative number (got ${args['min-age-hours']}).`);
    process.exit(2);
  }

  resolveApiBase().then(API_URL => main({
    minAgeHours,
    maxNudges: parseInt(args['max-nudges'], 10),
    apply: args.apply,
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
  })).then(code => process.exit(code)).catch(err => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
