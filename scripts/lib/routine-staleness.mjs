/**
 * routine-staleness.mjs (AUR-5042)
 *
 * Pure core for "has this critical routine missed N consecutive expected
 * completions?" — the off-lane staleness sweep. `lastSuccessfulCompletionAt`
 * is the server-computed field (routines.ts `findLastSuccessfulCompletionAt`):
 * the most recent issue with `originId = routineId` and `status = 'done'`.
 * It only advances when a run issue is genuinely closed done, so it survives
 * exactly the failure mode this guard exists for: a run that dies mid-flight
 * (quota wall, auth wall, any terminal failure) leaves it frozen, even while
 * the routine keeps firing new (stranded) execution issues every tick.
 */

import { parseCron, nextCronTick } from './routine-cron.mjs';

/**
 * Count how many scheduled fires of `cronExpression` have come due (fire
 * time + grace <= now) strictly after `since`. Capped at `maxOccurrences` as
 * a safety backstop against a pathological cron expression or a `since` far
 * in the past.
 *
 * @param {object} args
 * @param {string} args.cronExpression
 * @param {Date} args.since
 * @param {Date} args.now
 * @param {number} [args.graceMs]
 * @param {number} [args.maxOccurrences]
 * @returns {number}
 */
export function countMissedOccurrences({ cronExpression, since, now, graceMs = 0, maxOccurrences = 2000 }) {
  const cron = parseCron(cronExpression);
  let count = 0;
  let cursor = since;
  for (let i = 0; i < maxOccurrences; i++) {
    const next = nextCronTick(cron, cursor);
    if (!next) break;
    if (next.getTime() + graceMs > now.getTime()) break; // not yet due, grace included
    count++;
    cursor = next;
  }
  return count;
}

/**
 * Evaluate one critical routine's staleness against its declared cron
 * schedule.
 *
 * @param {object} args
 * @param {string} args.routineId
 * @param {string} args.label
 * @param {string} args.cronExpression - the routine's schedule trigger cron
 * @param {Date|null} args.lastSuccessfulCompletionAt
 * @param {Date|null} args.createdAt - fallback reference if the routine has
 *   never once succeeded
 * @param {Date} args.now
 * @param {number} [args.graceHours] - hours of slack after a scheduled fire
 *   before it counts as missed (a run that's simply still executing is not
 *   yet a miss)
 * @param {number} [args.missedThreshold] - consecutive missed fires needed
 *   to call it stale
 * @returns {{
 *   routineId: string, label: string, stale: boolean, missedCount: number,
 *   since: string|null, threshold: number, reason?: string,
 * }}
 */
export function evaluateRoutineStaleness({
  routineId,
  label,
  cronExpression,
  lastSuccessfulCompletionAt,
  createdAt,
  now,
  graceHours = 3,
  missedThreshold = 1,
}) {
  const since = lastSuccessfulCompletionAt ?? createdAt ?? null;
  if (!since) {
    return { routineId, label, stale: false, missedCount: 0, since: null, threshold: missedThreshold, reason: 'no-reference-date' };
  }
  const missedCount = countMissedOccurrences({
    cronExpression,
    since,
    now,
    graceMs: graceHours * 60 * 60 * 1000,
  });
  return {
    routineId,
    label,
    stale: missedCount >= missedThreshold,
    missedCount,
    since: since.toISOString(),
    threshold: missedThreshold,
  };
}
