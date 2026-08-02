#!/usr/bin/env node
/**
 * check-parked-agents.mjs
 *
 * Detector for the one genuinely harmful shape of provider-reset parking
 * (AUR-4679): an agent whose ENTIRE live run set sits behind a far-future
 * `scheduledRetryAt`. Such an agent contributes nothing until the park
 * expires — days, for a codex weekly limit — and nothing else on the board
 * notices, because the parked row is a valid continuation path and the agent
 * reports `status: idle`-adjacent health.
 *
 * A far-future park by itself is NOT flagged: parking until a provider-named
 * reset is the deliberate policy (decision recorded at the clamp site in
 * server/src/services/heartbeat.ts, scheduleBoundedRetryForRun), the
 * adapter-wide pause is separately clamped to 6h (AUR-4139), and an agent
 * with other queued/running work is not dark. Only the conjunction — parked
 * rows AND no nearer liveness — is alert-worthy. Live example while building
 * this (2026-07-30): agent "CTO Ops" fully parked behind 2026-08-05T08:46Z
 * with zero other rows — in a secondary test company, which is also why a
 * single-company census had missed it.
 *
 * Usage:
 *   node scripts/check-parked-agents.mjs
 *
 *   Report-only: prints one line per fully-parked agent with the parked
 *   issues and due dates. Whoever runs it (routine agent, human) decides
 *   whether to reroute the parked work or wake the agent through another
 *   channel; this script never mutates board state.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL     Base URL (resolved via scripts/lib/paperclip-api-base.mjs)
 *   PAPERCLIP_API_KEY     Bearer token
 *   PAPERCLIP_COMPANY_ID  Company UUID
 *   PAPERCLIP_COMPANY_IDS Optional comma-separated list overriding COMPANY_ID.
 *                         Parks are company-scoped rows and /api/companies is
 *                         board-gated to agents, so cross-company coverage
 *                         needs the list armed explicitly — the live CTO Ops
 *                         park sat in a second company and was invisible to a
 *                         single-company census (found during AUR-4679).
 *
 * Exit codes:
 *   0 — no fully-parked agent
 *   1 — at least one fully-parked agent (details on stdout)
 *   2 — configuration/API/shape error. A census that cannot be read is
 *       UNKNOWN, never "clean" — this script fails closed.
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

/**
 * A park only counts when it is due beyond the deepest rung of the normal
 * transient backoff ladder (2h base + 25% jitter = 2.5h): anything nearer is
 * an ordinary retry that self-resolves, not a provider-reset park.
 */
export const PARK_FLAG_THRESHOLD_MS = 3 * 60 * 60 * 1000;

const LIVE_STATUSES = new Set(['queued', 'running']);

/**
 * Pure classifier. Given every run of one company (any statuses, the
 * heartbeat-runs census shape) returns the agents that are fully parked:
 * at least one scheduled_retry due beyond `now + thresholdMs`, and no
 * queued/running run, and no scheduled_retry due sooner than the threshold
 * (a near retry is a live continuation path — an agent waiting out a normal
 * backoff rung is not dark).
 *
 * @param {Array<{agentId: string, status: string, scheduledRetryAt: string|Date|null, contextSnapshot?: {issueId?: string}|null}>} runs
 * @param {{now?: Date, thresholdMs?: number}} [opts]
 * @returns {Array<{agentId: string, parkedRuns: Array<{scheduledRetryAt: string, issueId: string|null}>}>}
 */
export function classifyParkedAgents(runs, opts = {}) {
  const now = opts.now ?? new Date();
  const thresholdMs = opts.thresholdMs ?? PARK_FLAG_THRESHOLD_MS;
  const horizon = now.getTime() + thresholdMs;

  const byAgent = new Map();
  for (const run of runs) {
    if (!run?.agentId) continue;
    let entry = byAgent.get(run.agentId);
    if (!entry) {
      entry = { hasNearLiveness: false, parkedRuns: [] };
      byAgent.set(run.agentId, entry);
    }
    if (LIVE_STATUSES.has(run.status)) {
      entry.hasNearLiveness = true;
      continue;
    }
    if (run.status !== 'scheduled_retry' || !run.scheduledRetryAt) continue;
    const dueMs = new Date(run.scheduledRetryAt).getTime();
    if (Number.isNaN(dueMs) || dueMs <= now.getTime()) continue;
    if (dueMs <= horizon) {
      entry.hasNearLiveness = true;
    } else {
      entry.parkedRuns.push({
        scheduledRetryAt: new Date(dueMs).toISOString(),
        issueId: run.contextSnapshot?.issueId ?? null,
      });
    }
  }

  const flagged = [];
  for (const [agentId, entry] of byAgent) {
    if (entry.parkedRuns.length > 0 && !entry.hasNearLiveness) {
      entry.parkedRuns.sort((a, b) => a.scheduledRetryAt.localeCompare(b.scheduledRetryAt));
      flagged.push({ agentId, parkedRuns: entry.parkedRuns });
    }
  }
  flagged.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return flagged;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
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

  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  let anyFlagged = false;
  for (const companyId of companyIds) {
    // No `limit`: the endpoint ignores `status=`/`offset=` and only a
    // limit-less read is a true census (AUR-4679 notes). `live-runs` is
    // capped at 50 and unusable here.
    const runs = await apiGet(`/api/companies/${companyId}/heartbeat-runs`);
    if (!Array.isArray(runs) || runs.length === 0) {
      // A live fleet always has historical rows; an empty/odd payload is a
      // transport or shape regression, not an empty fleet.
      console.error(
        `heartbeat-runs census unusable for company ${companyId}: ${Array.isArray(runs) ? 'empty array' : typeof runs}`,
      );
      return 2;
    }

    const agents = await apiGet(`/api/companies/${companyId}/agents`);
    const agentName = new Map(
      (Array.isArray(agents) ? agents : []).map((a) => [a.id, a.name ?? a.id]),
    );

    const flagged = classifyParkedAgents(runs);
    if (flagged.length === 0) {
      console.log(`OK [${companyId}]: no fully-parked agent (${runs.length} runs censused)`);
      continue;
    }
    anyFlagged = true;
    for (const { agentId, parkedRuns } of flagged) {
      const issues = parkedRuns
        .map((r) => `${r.issueId ?? 'no-issue'}@${r.scheduledRetryAt}`)
        .join(', ');
      console.log(
        `PARKED [${companyId}]: agent ${agentName.get(agentId) ?? agentId} (${agentId}) — entire queue behind a future scheduledRetryAt: ${issues}`,
      );
    }
  }

  if (!anyFlagged) return 0;
  console.log(
    `\nFully-parked agent(s) found. The park itself is deliberate policy ` +
      `(see AUR-4679); act on the WORK, not the rows: reroute the parked issues to a ` +
      `healthy lane, or leave them if the reset is near. Do not drain the rows — they ` +
      `encode a provider signal.`,
  );
  return 1;
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
