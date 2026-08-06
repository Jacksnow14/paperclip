/**
 * routine-staleness-local-state.mjs (AUR-5042)
 *
 * Durable, on-host dedup store for the routine-staleness sweep, mirroring
 * the AUR-5027 dark-lane pattern: this file — not any Paperclip-side record
 * — is authoritative for "did we already file an issue for this outage?".
 * That decision must survive on the host independent of any agent lane,
 * which is the entire point of AUR-5042 (a detector co-located with the
 * thing it watches cannot report that thing's death).
 *
 * One JSON file per company: `<stateDir>/<companyId>.json`, mapping
 * routineId -> { alertedForSince, alertedAt, issueId }. `alertedForSince` is
 * the routine's `lastSuccessfulCompletionAt` value (ISO string) at the time
 * the alert fired — when that value advances (the routine succeeds again),
 * the entry is stale and a fresh miss streak can alert again.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function stateFilePath(stateDir, companyId) {
  return path.join(stateDir, `${companyId}.json`);
}

/**
 * A missing file (fresh host, first run) is a legitimate empty state.
 * Anything else unreadable (corrupt JSON, permission error) is thrown
 * rather than silently treated as empty — this store is authoritative for
 * the dedup decision, so silently returning {} on a read failure would
 * reproduce a duplicate-issue-per-tick bug for every routine already
 * tracked as alerted.
 */
export async function loadLocalState(stateDir, companyId) {
  const file = stateFilePath(stateDir, companyId);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`routine-staleness local state unreadable at ${file}: ${err.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`routine-staleness local state corrupt at ${file}: ${err.message ?? err}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Write-then-rename so a crash mid-write never leaves the next tick reading
 * a half-written file. rename() is atomic within one filesystem.
 */
export async function saveLocalState(stateDir, companyId, stateMap) {
  await fs.mkdir(stateDir, { recursive: true });
  const file = stateFilePath(stateDir, companyId);
  const tmp = path.join(stateDir, `.${companyId}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(stateMap, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Decide whether a currently-stale routine needs a fresh alert this tick.
 *
 * @param {object} prevEntry - `stateMap[routineId]` from the previous tick, or undefined
 * @param {string} sinceIso - the routine's current `since` (last success or createdAt) as ISO
 * @returns {boolean} true if this exact outage (same `since`) was not already alerted
 */
export function needsAlert(prevEntry, sinceIso) {
  return !prevEntry || prevEntry.alertedForSince !== sinceIso;
}
