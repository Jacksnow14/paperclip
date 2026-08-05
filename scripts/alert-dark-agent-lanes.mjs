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
 * Severity: SEV2, per notify_founder.sh's contract (INFO is filtered before
 * logging under the fleet's default TELEGRAM_MIN_SEVERITY=SEV2, so an INFO
 * call here would neither deliver nor log — indistinguishable from doing
 * nothing). A lane that silently absorbs every dispatch for days is exactly
 * the "production outage the fleet cannot self-recover from" case the
 * telegram-founder-channel doctrine carves out for SEV2.
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

const execFileAsync = promisify(execFile);

const DEFAULT_NOTIFY_FOUNDER_CMD = path.join(homedir(), 'bot', 'notify_founder.sh');

/**
 * Send the founder alert and classify the outcome per the reachability
 * doctrine: only an unambiguous confirmation counts as delivered. Anything
 * else — non-zero exit, stdout that doesn't start with "sent", a thrown
 * error — is a failed delivery, never assumed successful.
 *
 * @returns {Promise<'confirmed'|'blocked'|'failed'>}
 */
export async function sendFounderAlert(message, { cmd = DEFAULT_NOTIFY_FOUNDER_CMD } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, ['SEV2', message], { encoding: 'utf8' });
    return stdout.trim().toLowerCase().startsWith('sent') ? 'confirmed' : 'failed';
  } catch (err) {
    // notify_founder.sh exits 2 for a policy/rate-window refusal — treat
    // that distinctly from a hard failure only for logging; either way the
    // send is NOT confirmed, so the caller must not set the guard field.
    if (err && err.code === 2) return 'blocked';
    return 'failed';
  }
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
 * @param {object} args
 * @param {Array<object>} args.agents - normalized agent rows (id, name, urlKey, adapterType, metadata)
 * @param {Array<object>} args.runs - heartbeat-runs census rows for this company
 * @param {Date} args.now
 * @param {string} args.issuePrefix
 * @param {(message: string) => Promise<'confirmed'|'blocked'|'failed'>} args.sendAlert
 * @param {(agentId: string, metadata: object) => Promise<void>} args.patchAgent
 * @param {boolean} [args.dryRun]
 * @returns {Promise<Array<{agentId: string, name: string, alert: string|null, sendResult: string|null, patched: boolean}>>}
 */
export async function tickCompany({ agents, runs, now, issuePrefix, sendAlert, patchAgent, dryRun = false }) {
  const nowIso = now.toISOString();
  const flagged = classifyParkedAgents(runs, { now });
  const flaggedByAgent = new Map(flagged.map((f) => [f.agentId, f.parkedRuns]));

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const candidateIds = new Set(flaggedByAgent.keys());
  for (const agent of agents) {
    const existing = agent.metadata?.darkLane;
    if (existing?.active || existing?.recoveryPending) candidateIds.add(agent.id);
  }

  const results = [];
  for (const agentId of candidateIds) {
    const agent = agentById.get(agentId);
    if (!agent) continue; // stale run referencing a since-deleted agent

    const prevState = agent.metadata?.darkLane ?? null;
    const isDarkNow = flaggedByAgent.has(agentId);
    const parkedRuns = flaggedByAgent.get(agentId) ?? [];
    const detail = isDarkNow
      ? { adapterType: agent.adapterType ?? null, reason: 'provider_reset_park', resetAt: parkedRuns[0]?.scheduledRetryAt ?? null }
      : null;

    const { tentativeState, alert } = planDarkLaneTransition({ prevState, isDarkNow, detail, nowIso });

    let sendResult = null;
    let confirmed = false;
    if (alert && !dryRun) {
      const message = buildAlertMessage({ kind: alert.kind, agent, state: tentativeState, issuePrefix });
      sendResult = await sendAlert(message);
      confirmed = sendResult === 'confirmed';
    }

    const finalState = dryRun ? tentativeState : finalizeDarkLaneState(tentativeState, alert, confirmed, nowIso);

    let patched = false;
    let patchError = null;
    if (!dryRun && !darkLaneStatesEqual(finalState, prevState)) {
      const nextMetadata = { ...(agent.metadata ?? {}) };
      if (darkLaneStatesEqual(finalState, DEFAULT_DARK_LANE_STATE)) {
        delete nextMetadata.darkLane;
      } else {
        nextMetadata.darkLane = finalState;
      }
      // A patch failure (e.g. a permission gate on cross-agent writes) must
      // not crash the whole census: every other candidate in this company,
      // and every other company, still needs to be evaluated and alerted on.
      // It DOES mean this agent's alertedAt/recoveryPending guard never
      // persisted, so the next tick will legitimately re-plan the same
      // alert — that is a real repeat-alert risk, not swallowed silently:
      // it is surfaced via `patchError` in the result and logged by the
      // caller so an unresolved permission gate is loud, not quiet.
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
      sendResult,
      patched,
      patchError,
    });
  }

  return results;
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

  let anyAlerted = false;
  let anyError = false;

  for (const companyId of companyIds) {
    let runs;
    let agents;
    let company;
    try {
      // No `limit`: only a limit-less read is a true census (see
      // check-parked-agents.mjs). live-runs is capped at 50 and unusable here.
      runs = await apiGet(`/api/companies/${companyId}/heartbeat-runs`);
      agents = await apiGet(`/api/companies/${companyId}/agents`);
      company = await apiGet(`/api/companies/${companyId}`).catch(() => null);
    } catch (err) {
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

    const results = await tickCompany({
      agents,
      runs,
      now: new Date(),
      issuePrefix,
      dryRun,
      sendAlert: (message) => sendFounderAlert(message),
      patchAgent: (agentId, metadata) => apiPatchAgent(agentId, metadata),
    });

    for (const r of results) {
      if (r.alert) {
        anyAlerted = true;
        console.log(
          `[${companyId}] ${r.name} (${r.agentId}): ${r.alert} alert — send=${dryRun ? 'dry-run' : r.sendResult} patched=${r.patched}`,
        );
      } else if (dryRun) {
        console.log(`[${companyId}] ${r.name} (${r.agentId}): no alert this tick`);
      }
      if (r.patchError) {
        // Loud on purpose: an unresolved write-permission gate here means the
        // alertedAt guard never persists, so the SAME transition re-plans an
        // alert on every future tick. This must page attention, not scroll by.
        console.error(
          `[${companyId}] ${r.name} (${r.agentId}): metadata.darkLane PATCH failed — REPEAT-ALERT RISK until fixed: ${r.patchError}`,
        );
        anyError = true;
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
