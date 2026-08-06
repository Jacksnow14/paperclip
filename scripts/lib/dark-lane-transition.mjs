/**
 * dark-lane-transition.mjs (AUR-4532)
 *
 * Pure state machine deciding, per agent per tick, whether a "dark lane"
 * (AUR-4679's fully-parked-agent shape) alert needs sending and what the
 * next persisted `agent.metadata.darkLane` should be.
 *
 * Split deliberately into two pure steps so the async side effect (actually
 * sending the founder alert) never has to guess what to persist:
 *
 *   planDarkLaneTransition   — given the previous persisted state and the
 *                              current ground-truth detection, decide the
 *                              tentative next state and which alert (if any)
 *                              needs to go out. Never talks to the network.
 *   finalizeDarkLaneState    — given that plan and whether the alert send
 *                              was CONFIRMED delivered, decide what actually
 *                              gets persisted. An unconfirmed send (blocked
 *                              by the rate window, or any other failure)
 *                              leaves the guard field exactly as it was
 *                              before the attempt, so the next tick retries
 *                              instead of silently swallowing the alert.
 *
 * State shape persisted at `agent.metadata.darkLane`:
 *   {
 *     active: boolean,        // ground truth: is this agent dark right now
 *     since: string|null,     // ISO timestamp the lane first went dark
 *     adapterType: string|null,
 *     reason: string|null,
 *     resetAt: string|null,   // earliest known provider reset for the park
 *     alertedAt: string|null, // set only once the "opened" alert is CONFIRMED
 *                             // delivered — the AC2 dedup guard
 *     recoveryPending: boolean, // true after active flips true->false until
 *                                // the recovery alert is CONFIRMED delivered
 *   }
 *
 * `active` is intentionally independent of `alertedAt`: observability (AC1 —
 * "distinguishable from a healthy idle agent by reading the agent record
 * alone") must not depend on Telegram delivery succeeding. A rate-limited or
 * failed send still leaves the agent visibly dark; it only withholds the
 * guard that would otherwise suppress a legitimate retry.
 */

export const DEFAULT_DARK_LANE_STATE = Object.freeze({
  active: false,
  since: null,
  adapterType: null,
  reason: null,
  resetAt: null,
  alertedAt: null,
  recoveryPending: false,
});

function normalizeState(state) {
  return state ? { ...DEFAULT_DARK_LANE_STATE, ...state } : { ...DEFAULT_DARK_LANE_STATE };
}

/**
 * @param {object} args
 * @param {object|null|undefined} args.prevState - previously persisted darkLane state (or absent)
 * @param {boolean} args.isDarkNow - ground-truth detection result for this tick
 * @param {{adapterType: string|null, reason: string|null, resetAt: string|null}|null} args.detail
 *        - required when isDarkNow is true, ignored otherwise
 * @param {string} args.nowIso - current time, ISO string (caller-supplied so this stays pure/testable)
 * @returns {{ tentativeState: object, alert: {kind: 'opened'|'recovered'}|null }}
 */
export function planDarkLaneTransition({ prevState, isDarkNow, detail, nowIso }) {
  const prev = normalizeState(prevState);

  if (isDarkNow) {
    if (!prev.active) {
      // Newly dark — first tick to observe this park.
      return {
        tentativeState: {
          active: true,
          since: nowIso,
          adapterType: detail?.adapterType ?? null,
          reason: detail?.reason ?? null,
          resetAt: detail?.resetAt ?? null,
          alertedAt: null,
          recoveryPending: false,
        },
        alert: { kind: "opened" },
      };
    }
    if (!prev.alertedAt) {
      // Still dark, but the "opened" alert was never confirmed delivered
      // (e.g. a prior tick hit the rate window) — retry it.
      return {
        tentativeState: { ...prev, resetAt: detail?.resetAt ?? prev.resetAt },
        alert: { kind: "opened" },
      };
    }
    // Already alerted and still dark: the AC2 no-repeat-alert case.
    return { tentativeState: prev, alert: null };
  }

  // Not dark now.
  if (prev.active) {
    if (prev.alertedAt) {
      // Recovered from a state we actually told someone about.
      return {
        tentativeState: { ...prev, active: false, recoveryPending: true },
        alert: { kind: "recovered" },
      };
    }
    // Went dark and came back before the open alert ever confirmed — nobody
    // was told, so there is nothing to tell them it recovered from. Clear
    // silently rather than firing a recovery alert for an outage that was
    // never announced.
    return { tentativeState: { ...DEFAULT_DARK_LANE_STATE }, alert: null };
  }
  if (prev.recoveryPending) {
    // A prior recovery alert attempt was not confirmed delivered — retry.
    return { tentativeState: prev, alert: { kind: "recovered" } };
  }
  // Fully quiescent: never dark, nothing pending.
  return { tentativeState: prev, alert: null };
}

/**
 * @param {object} tentativeState - from planDarkLaneTransition
 * @param {{kind: 'opened'|'recovered'}|null} alert - from planDarkLaneTransition
 * @param {boolean} confirmed - true only when the alert send was confirmed delivered
 * @param {string} nowIso - current time, ISO string
 * @returns {object} the state to actually persist
 */
export function finalizeDarkLaneState(tentativeState, alert, confirmed, nowIso) {
  if (!alert) return tentativeState;
  if (!confirmed) {
    // Do not swallow a blocked/failed send: leave the guard field exactly as
    // it was so the next tick retries.
    return tentativeState;
  }
  if (alert.kind === "opened") {
    return { ...tentativeState, alertedAt: nowIso };
  }
  // alert.kind === "recovered": confirmed recovery alert clears all state.
  return { ...DEFAULT_DARK_LANE_STATE };
}

/**
 * Structural equality for the small, flat darkLane state shape — used to
 * decide whether a PATCH is even needed this tick.
 */
export function darkLaneStatesEqual(a, b) {
  const na = normalizeState(a);
  const nb = normalizeState(b);
  return (
    na.active === nb.active &&
    na.since === nb.since &&
    na.adapterType === nb.adapterType &&
    na.reason === nb.reason &&
    na.resetAt === nb.resetAt &&
    na.alertedAt === nb.alertedAt &&
    na.recoveryPending === nb.recoveryPending
  );
}
