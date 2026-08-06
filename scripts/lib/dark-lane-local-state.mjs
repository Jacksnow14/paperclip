/**
 * dark-lane-local-state.mjs (AUR-5027)
 *
 * Durable, on-host store for the AC2 dedup guard (`alertedAt` /
 * `recoveryPending`), keyed by companyId + agentId. This is what the
 * alert/no-alert decision in alert-dark-agent-lanes.mjs actually trusts —
 * `agent.metadata.darkLane` is written best-effort as an observability
 * projection (AC1) only, and a failed PATCH there (403 today, a transient
 * 5xx or deploy blip tomorrow) must never reproduce a repeat alert. See the
 * issue for the class of bug this closes: the success signal for a write is
 * not the same object as the outcome a dedup guard needs.
 *
 * One JSON file per company: `<stateDir>/<companyId>.json`, mapping
 * agentId -> persisted darkLane state (same shape as
 * ./dark-lane-transition.mjs's DEFAULT_DARK_LANE_STATE).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function stateFilePath(stateDir, companyId) {
  return path.join(stateDir, `${companyId}.json`);
}

/**
 * A missing file (fresh host, first run) is a legitimate empty state.
 * Anything else unreadable (corrupt JSON, permission error) is thrown
 * rather than silently treated as empty: since this store is authoritative
 * for the dedup decision, silently returning {} on a read failure would
 * reproduce the exact repeat-alert bug this module exists to close for
 * every agent this company was already tracking as dark/alerted.
 */
export async function loadLocalState(stateDir, companyId) {
  const file = stateFilePath(stateDir, companyId);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`dark-lane local state unreadable at ${file}: ${err.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dark-lane local state corrupt at ${file}: ${err.message ?? err}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Write-then-rename so a crash mid-write (or a concurrent tick, though this
 * script is not designed to overlap itself) never leaves the next tick
 * reading a half-written file. rename() is atomic within one filesystem.
 */
export async function saveLocalState(stateDir, companyId, stateMap) {
  await fs.mkdir(stateDir, { recursive: true });
  const file = stateFilePath(stateDir, companyId);
  const tmp = path.join(stateDir, `.${companyId}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(stateMap, null, 2));
  await fs.rename(tmp, file);
}
