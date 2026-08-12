#!/usr/bin/env node
/**
 * alert-dark-agent-lanes.mjs (AUR-4532)
 *
 * "Alert when an agent lane goes dark (quota-starved must not read as idle)."
 *
 * Builds observability + founder alerting on top of AUR-4679's existing,
 * tested detector (`classifyParkedAgents` in ./check-parked-agents.mjs) for
 * the one genuinely harmful park shape: an agent whose ENTIRE run set sits
 * behind a far-future `scheduledRetryAt` with no queued/running/near-retry
 * continuation. That agent reports `status: idle, pauseReason: null` —
 * indistinguishable from a healthy unoccupied agent — and silently absorbs
 * every dispatch routed to it. AUR-4336 (72h) and AUR-4354 (48h, 89
 * dispatches) both went unnoticed this way.
 *
 * What this script adds on top of the detector:
 *
 *   1. Observability: persists `agent.metadata.darkLane` on the agent record
 *      itself so a dark lane is distinguishable from a healthy idle agent by
 *      reading the agent record ALONE — no need to walk 40 runs. See
 *      ./lib/dark-lane-transition.mjs for the exact shape.
 *   2. Alerting: fires exactly one founder alert per state transition (open
 *      or recover), never per tick, via the pure state machine in
 *      ./lib/dark-lane-transition.mjs. A blocked/failed send leaves the
 *      guard field unset so the NEXT tick retries instead of the alert being
 *      silently swallowed.
 *
 * Severity: graded (AUR-5355, 2026-08-07; was flat SEV2, briefly flat INFO).
 * A single dark lane is not a "production outage the fleet cannot
 * self-recover from" — the fleet's own routing doctrine's answer to one
 * lane starving is to route around it (route cross-adapter / to a different
 * agent), not to page the founder's phone. That case alerts at INFO: logged
 * to the audit trail (notify_founder.sh's INFO path was fixed under the
 * same issue to log every filtered call, so INFO here is "logged, never
 * delivered," not "does nothing"), never delivered.
 *
 * But when EVERY agent sharing an adapterType is dark at once, that is not
 * a single-lane hiccup the fleet can route around — it is that adapter's
 * entire capacity gone, which per the telegram-founder-channel billing/
 * quota carve-out IS founder-actionable (top up quota / re-auth the
 * provider) and nothing else in the fleet is armed to page on it. That case
 * alerts at SEV2. See `isFullAdapterOutage` below: computed fresh off the
 * current census each tick (self + every other agent of the same
 * adapterType currently flagged dark), not persisted, so it always reflects
 * ground truth. A "recovered" event is graded off the same census-inclusive
 * check but the recovering agent itself is by definition no longer dark at
 * that instant, so a "recovered" alert can never grade SEV2 by this
 * definition — recovery is good news and does not need to interrupt the
 * founder urgently, regardless of whether sibling lanes are still down.
 * State transitions (open/recover) still fire the alert exactly once each
 * via the state machine below — only the delivery severity is graded.
 *
 * Usage:
 *   node scripts/alert-dark-agent-lanes.mjs [--dry-run]
 *
 *   --dry-run   Compute + print the plan for every candidate agent; never
 *               sends an alert and never PATCHes an agent record.
 *
 * Env vars required (same as check-parked-agents.mjs):
 *   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
 *   PAPERCLIP_COMPANY_IDS   optional comma-separated override
 *   NOTIFY_FOUNDER_CMD      optional override of the notify_founder.sh path,
 *                           for tests / non-default installs. Defaults to
 *                           ~/bot/notify_founder.sh.
 *
 * Exit codes:
 *   0 — ran to completion (including "found and alerted on a dark lane" —
 *       that is success for this script, not a failure)
 *   2 — configuration/API/shape error; fails closed like check-parked-agents.mjs
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveApiBase } from './lib/paperclip-api-base.mjs';
import { classifyParkedAgents } from './check-parked-agents.mjs';
import {
  DEFAULT_DARK_LANE_STATE,
  planDarkLaneTransition,
  finalizeDarkLaneState,
  darkLaneStatesEqual,
} from './lib/dark-lane-transition.mjs';
import { loadLocalState, saveLocalState } from './lib/dark-lane-local-state.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_NOTIFY_FOUNDER_CMD = path.join(homedir(), 'bot', 'notify_founder.sh');
const DEFAULT_STATE_DIR = path.join(homedir(), 'paperclip-data', 'dark-lane-alert', 'state');

/**
 * Send the founder alert and classify the outcome per the reachability
 * doctrine: only an unambiguous confirmation counts as delivered. Anything
 * else — non-zero exit, stdout that doesn't start with "sent", a thrown
 * error — is a failed delivery, never assumed successful.
 *
 * @returns {Promise<'confirmed'|'blocked'|'failed'>}
 */
export async function sendFounderAlert(message, { cmd = DEFAULT_NOTIFY_FOUNDER_CMD, severity = 'INFO' } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, [severity, message], { encoding: 'utf8' });
    return stdout.trim().toLowerCase().startsWith('sent') ? 'confirmed' : 'failed';
  } catch (err) {
    // notify_founder.sh exits 2 for a policy/rate-window refusal — treat
    // that distinctly from a hard failure only for logging; either way the
    // send is NOT confirmed, so the caller must not set the guard field.
    if (err && err.code === 2) return 'blocked';
    return 'failed';
  }
}

/**
 * Grade "is this dark event a whole-adapter outage" (AUR-5355). Computed
 * fresh off this tick's census — never persisted — so it always reflects
 * ground truth rather than a stale snapshot from when the state machine
 * last wrote `agent.metadata.darkLane`.
 *
 * `flaggedByAgent` already reflects `isDarkNow` for every agent this tick
 * (it is the exact map `isDarkNow` was derived from), including the
 * candidate agent itself — so a recovering agent (no longer in
 * `flaggedByAgent`) can never satisfy "every peer is dark," which is
 * intentional: see the module doc comment on why "recovered" never grades
 * SEV2 under this definition.
 *
 * @param {object} agent
 * @param {Array<object>} agents - full company census
 * @param {Map<string, unknown>} flaggedByAgent - agentId -> parkedRuns for agents dark THIS tick
 * @returns {boolean}
 */
function isFullAdapterOutage({ agent, agents, flaggedByAgent }) {
  const adapterType = agent.adapterType ?? null;
  if (!adapterType) return false;
  const peers = agents.filter((a) => a.adapterType === adapterType);
  return peers.every((a) => flaggedByAgent.has(a.id));
}

function buildAgentUrl({ issuePrefix, agent }) {
  const key = agent.urlKey ?? agent.id;
  if (!issuePrefix) return `(agent ${agent.name ?? agent.id})`;
  return `https://app.paperclip.ing/${issuePrefix}/agents/${key}`;
}

function buildAlertMessage({ kind, agent, state, issuePrefix }) {
  const url = buildAgentUrl({ issuePrefix, agent });
  const name = agent.name ?? agent.id;
  if (kind === 'opened') {
    const reset = state.resetAt ? `until ${state.resetAt}` : 'reset time unknown';
    return `Lane dark: ${name} (${state.adapterType ?? 'unknown adapter'}) has zero live continuation, parked ${reset}. It will silently absorb dispatches. ${url}`;
  }
  return `Lane recovered: ${name} (${state.adapterType ?? 'unknown adapter'}) has live continuation again. ${url}`;
}

/**
 * Pure-ish core: given one company's agents + heartbeat-runs census and
 * injected side effects (sendAlert/patchAgent), decide and apply the
 * dark-lane transition for every candidate agent. Injected functions make
 * this fully unit-testable without touching the network.
 *
 * `localState` (AUR-5027) is the AUTHORITATIVE source for the AC2 dedup
 * decision — a map of agentId -> persisted darkLane state, durable on the
 * cron host independent of `agent.metadata`. `agent.metadata.darkLane` is
 * consulted only as a bootstrap fallback when localState has no entry yet
 * for an agent (e.g. a fresh cron host inheriting state a prior, working
 * metadata PATCH already recorded), and is otherwise written best-effort as
 * an observability projection (AC1): its PATCH failing degrades to a
 * warning and never affects the alert decision or the returned localState.
 *
 * @param {object} args
 * @param {Array<object>} args.agents - normalized agent rows (id, name, urlKey, adapterType, metadata)
 * @param {Array<object>} args.runs - heartbeat-runs census rows for this company
 * @param {Date} args.now
 * @param {string} args.issuePrefix
 * @param {(message: string, severity: 'INFO'|'SEV2') => Promise<'confirmed'|'blocked'|'failed'>} args.sendAlert
 * @param {(agentId: string, metadata: object) => Promise<void>} args.patchAgent
 * @param {Object<string, object>} [args.localState] - previous tick's authoritative state, keyed by agentId
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{
 *   results: Array<{agentId: string, name: string, alert: string|null, severity: string|null, sendResult: string|null, patched: boolean, patchError: string|null}>,
 *   localState: Object<string, object>,
 * }>}
 */
export async function tickCompany({ agents, runs, now, issuePrefix, sendAlert, patchAgent, localState = {}, dryRun = false }) {
  const nowIso = now.toISOString();
  const flagged = classifyParkedAgents(runs, { now });
  const flaggedByAgent = new Map(flagged.map((f) => [f.agentId, f.parkedRuns]));

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const candidateIds = new Set(flaggedByAgent.keys());
  for (const agent of agents) {
    const existing = localState[agent.id] ?? agent.metadata?.darkLane;
    if (existing?.active || existing?.recoveryPending) candidateIds.add(agent.id);
  }

  const results = [];
  const nextLocalState = { ...localState };
  for (const agentId of candidateIds) {
    const agent = agentById.get(agentId);
    if (!agent) continue; // stale run referencing a since-deleted agent

    // Local durable state wins whenever it has an opinion; metadata is only
    // the bootstrap fallback for an agent localState has never seen.
    const prevState = localState[agentId] ?? agent.metadata?.darkLane ?? null;
    const isDarkNow = flaggedByAgent.has(agentId);
    const parkedRuns = flaggedByAgent.get(agentId) ?? [];
    const detail = isDarkNow
      ? { adapterType: agent.adapterType ?? null, reason: 'provider_reset_park', resetAt: parkedRuns[0]?.scheduledRetryAt ?? null }
      : null;

    const { tentativeState, alert } = planDarkLaneTransition({ prevState, isDarkNow, detail, nowIso });

    const severity = alert ? (isFullAdapterOutage({ agent, agents, flaggedByAgent }) ? 'SEV2' : 'INFO') : null;

    let sendResult = null;
    let confirmed = false;
    if (alert && !dryRun) {
      const message = buildAlertMessage({ kind: alert.kind, agent, state: tentativeState, issuePrefix });
      sendResult = await sendAlert(message, severity);
      confirmed = sendResult === 'confirmed';
    }

    const finalState = dryRun ? tentativeState : finalizeDarkLaneState(tentativeState, alert, confirmed, nowIso);

    if (!dryRun) {
      if (darkLaneStatesEqual(finalState, DEFAULT_DARK_LANE_STATE)) {
        delete nextLocalState[agentId];
      } else {
        nextLocalState[agentId] = finalState;
      }
    }

    let patched = false;
    let patchError = null;
    if (!dryRun && !darkLaneStatesEqual(finalState, agent.metadata?.darkLane ?? null)) {
      const nextMetadata = { ...(agent.metadata ?? {}) };
      if (darkLaneStatesEqual(finalState, DEFAULT_DARK_LANE_STATE)) {
        delete nextMetadata.darkLane;
      } else {
        nextMetadata.darkLane = finalState;
      }
      // A patch failure (e.g. a permission gate on cross-agent writes) must
      // not crash the whole census, and — unlike before AUR-5027 — must not
      // put the AC2 dedup guard at risk either: `nextLocalState` above
      // already carries the authoritative decision regardless of whether
      // this PATCH succeeds. This is now purely the AC1 observability
      // projection, so a failure here is surfaced via `patchError` for
      // logging but degrades to a warning, never an error exit.
      try {
        await patchAgent(agentId, nextMetadata);
        patched = true;
      } catch (err) {
        patchError = err?.message ?? String(err);
      }
    }

    results.push({
      agentId,
      name: agent.name ?? agentId,
      alert: alert?.kind ?? null,
      severity,
      sendResult,
      patched,
      patchError,
    });
  }

  return { results, localState: nextLocalState };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const companyIds = (process.env.PAPERCLIP_COMPANY_IDS ?? process.env.PAPERCLIP_COMPANY_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!API_KEY || companyIds.length === 0) {
    console.error('Missing PAPERCLIP_API_KEY or PAPERCLIP_COMPANY_ID(S)');
    return 2;
  }
  const API_URL = await resolveApiBase();
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  async function apiGet(pathname) {
    const res = await fetch(`${API_URL}${pathname}`, { headers });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPatchAgent(agentId, metadata) {
    const res = await fetch(`${API_URL}/api/agents/${agentId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ metadata }),
    });
    if (!res.ok) throw new Error(`PATCH /api/agents/${agentId} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  const STATE_DIR = process.env.DARK_LANE_STATE_DIR || DEFAULT_STATE_DIR;

  let anyAlerted = false;
  let anyError = false;

  for (const companyId of companyIds) {
    let runs;
    let agents;
    let company;
    let localState;
    try {
      // No `limit`: only a limit-less read is a true census (see
      // check-parked-agents.mjs). live-runs is capped at 50 and unusable here.
      runs = await apiGet(`/api/companies/${companyId}/heartbeat-runs`);
      agents = await apiGet(`/api/companies/${companyId}/agents`);
      company = await apiGet(`/api/companies/${companyId}`).catch(() => null);
      localState = await loadLocalState(STATE_DIR, companyId);
    } catch (err) {
      // A census/API failure OR an unreadable local state file are both
      // fatal for this company's tick: local state is now authoritative for
      // AC2 (AUR-5027), so proceeding on a guess here would either silently
      // swallow a real alert or reproduce a repeat-alert — loud skip, not a
      // silent one, is the safe failure mode.
      console.error(`census fetch failed for company ${companyId}: ${err.message ?? err}`);
      anyError = true;
      continue;
    }
    if (!Array.isArray(runs) || !Array.isArray(agents)) {
      console.error(`unusable census shape for company ${companyId}`);
      anyError = true;
      continue;
    }

    const issuePrefix = company?.issuePrefix ?? null;

    const { results, localState: nextLocalState } = await tickCompany({
      agents,
      runs,
      now: new Date(),
      issuePrefix,
      dryRun,
      localState,
      sendAlert: (message, severity) => sendFounderAlert(message, { severity }),
      patchAgent: (agentId, metadata) => apiPatchAgent(agentId, metadata),
    });

    if (!dryRun) {
      try {
        await saveLocalState(STATE_DIR, companyId, nextLocalState);
      } catch (err) {
        // The AC2 decision for THIS tick was already made and acted on
        // correctly (alerts above reflect it); this only means a future
        // tick may not see it. Still loud — a persistently broken state
        // directory is a real repeat-alert risk again — but it must not
        // discard the alerts/results this tick already produced.
        console.error(`[${companyId}] failed to persist dark-lane local state — REPEAT-ALERT RISK until fixed: ${err.message ?? err}`);
        anyError = true;
      }
    }

    for (const r of results) {
      if (r.alert) {
        anyAlerted = true;
        console.log(
          `[${companyId}] ${r.name} (${r.agentId}): ${r.alert} alert (${r.severity}) — send=${dryRun ? 'dry-run' : r.sendResult} patched=${r.patched}`,
        );
      } else if (dryRun) {
        console.log(`[${companyId}] ${r.name} (${r.agentId}): no alert this tick`);
      }
      if (r.patchError) {
        // AUR-5027: the AC2 dedup decision above is already durable in local
        // state regardless of this PATCH, so a failure here is only a lost
        // observability projection (AC1) — a warning, never a census error.
        console.warn(
          `[${companyId}] ${r.name} (${r.agentId}): metadata.darkLane PATCH failed (observability only, dedup guard is unaffected): ${r.patchError}`,
        );
      }
    }
    if (results.length === 0) {
      console.log(`[${companyId}]: no dark-lane candidates`);
    }
  }

  if (anyError) return 2;
  if (dryRun) console.log(anyAlerted ? '\n(dry-run: no alerts sent, no records patched)' : '\nOK: no dark lanes found (dry-run)');
  return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FATAL:', err.message ?? err);
      process.exit(2);
    });
}
