#!/usr/bin/env node
/**
 * check-agent-error-dormancy.mjs
 *
 * Detector for AUR-5644's core failure shape: an agent sits in
 * `status='error'` while it still owns actionable issues, and nothing
 * anywhere records that it is refusing work. Before AUR-5644's admission fix,
 * a refused wake against an `error` agent didn't even leave a `skipped`
 * `agent_wakeup_requests` row (the throw in enqueueWakeup happened before
 * writeSkippedRequest ran) — so the only way to notice a wedged agent was to
 * go looking. The CTO agent sat wedged 2.9h holding 25 actionable issues,
 * including a `critical`, before a human noticed (AUR-5643).
 *
 * `error` is no longer a purely-manual recovery: AUR-5644 clears it
 * automatically on a genuine new-assignment wake (mirroring the
 * scheduled_retry-promotion precedent at heartbeat.ts's admission gate). This
 * detector covers the residual case that self-heal cannot: a lane that is
 * genuinely dead (adapter down, quota permanently exhausted, etc.) never
 * gets a *new* assignment wake to trigger the clear, so it stays wedged
 * silently. This script is the visibility backstop for that case — it never
 * mutates board state.
 *
 * Usage:
 *   node scripts/check-agent-error-dormancy.mjs
 *
 * Env vars required:
 *   PAPERCLIP_API_URL     Base URL (resolved via scripts/lib/paperclip-api-base.mjs)
 *   PAPERCLIP_API_KEY     Bearer token
 *   PAPERCLIP_COMPANY_ID  Company UUID
 *   PAPERCLIP_COMPANY_IDS Optional comma-separated list overriding COMPANY_ID.
 *
 * Env vars optional:
 *   AGENT_ERROR_DORMANCY_THRESHOLD_MS  Minimum time an agent must have sat in
 *     `error` before it's flagged (default 15 minutes). Below this, a fresh
 *     failure hasn't yet had a chance to self-heal via a new-assignment wake
 *     or an operator glance; flagging it immediately would just be noise.
 *
 * Exit codes:
 *   0 — no dormant-but-actionable agent found
 *   1 — at least one agent is `error` + holding actionable issues past the
 *       threshold (details on stdout)
 *   2 — configuration/API/shape error. A census that cannot be read is
 *       UNKNOWN, never "clean" — this script fails closed.
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

export const DORMANCY_FLAG_THRESHOLD_MS = 15 * 60 * 1000;

// Issues in these statuses are not actionable: `backlog` never gets a wake
// in the first place (queueIssueAssignmentWakeup's own skip check), and
// `done`/`cancelled` are terminal — an error agent still "holding" one of
// those isn't blocking anything.
const NON_ACTIONABLE_ISSUE_STATUSES = new Set(['backlog', 'done', 'cancelled']);

/**
 * Pure classifier. Given every agent in a company (id, status, a timestamp
 * marking when that status was last set) and every issue in the company
 * (assigneeAgentId, status), returns the agents that are `error` AND own at
 * least one actionable issue AND have sat in `error` longer than the
 * threshold.
 *
 * @param {Array<{id: string, status: string, statusSince: string|Date|null}>} agentRows
 * @param {Array<{assigneeAgentId: string|null, status: string, identifier?: string}>} issueRows
 * @param {{now?: Date, thresholdMs?: number}} [opts]
 * @returns {Array<{agentId: string, sinceMs: number, actionableIssues: Array<{identifier: string|undefined, status: string}>}>}
 */
export function classifyDormantErrorAgents(agentRows, issueRows, opts = {}) {
  const now = opts.now ?? new Date();
  const thresholdMs = opts.thresholdMs ?? DORMANCY_FLAG_THRESHOLD_MS;

  const actionableByAgent = new Map();
  for (const issue of issueRows) {
    if (!issue?.assigneeAgentId) continue;
    if (NON_ACTIONABLE_ISSUE_STATUSES.has(issue.status)) continue;
    let list = actionableByAgent.get(issue.assigneeAgentId);
    if (!list) {
      list = [];
      actionableByAgent.set(issue.assigneeAgentId, list);
    }
    list.push({ identifier: issue.identifier, status: issue.status });
  }

  const flagged = [];
  for (const agent of agentRows) {
    if (!agent?.id || agent.status !== 'error') continue;
    const actionableIssues = actionableByAgent.get(agent.id) ?? [];
    if (actionableIssues.length === 0) continue;
    const sinceMs = agent.statusSince ? new Date(agent.statusSince).getTime() : NaN;
    if (Number.isNaN(sinceMs)) continue;
    const elapsedMs = now.getTime() - sinceMs;
    if (elapsedMs <= thresholdMs) continue;
    flagged.push({ agentId: agent.id, sinceMs: elapsedMs, actionableIssues });
  }
  flagged.sort((a, b) => b.sinceMs - a.sinceMs);
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
  const thresholdMs = process.env.AGENT_ERROR_DORMANCY_THRESHOLD_MS
    ? Number.parseInt(process.env.AGENT_ERROR_DORMANCY_THRESHOLD_MS, 10)
    : DORMANCY_FLAG_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    console.error(`Invalid AGENT_ERROR_DORMANCY_THRESHOLD_MS: ${process.env.AGENT_ERROR_DORMANCY_THRESHOLD_MS}`);
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
    const agentsResp = await apiGet(`/api/companies/${companyId}/agents`);
    if (!Array.isArray(agentsResp)) {
      console.error(`agents census unusable for company ${companyId}: ${typeof agentsResp}`);
      return 2;
    }
    const agentRows = agentsResp.map((a) => ({
      id: a.id,
      status: a.status,
      name: a.name ?? a.id,
      // `updatedAt` is stamped alongside every status write (finalizeAgentStatus,
      // and AUR-5644's assignment-wake clear), so it's the best available proxy
      // for "how long has this agent sat in its current status" without a
      // dedicated status-history table.
      statusSince: a.updatedAt ?? a.lastHeartbeatAt ?? null,
    }));

    const errorAgentIds = agentRows.filter((a) => a.status === 'error').map((a) => a.id);
    if (errorAgentIds.length === 0) {
      console.log(`OK [${companyId}]: no agent in status=error (${agentRows.length} agents censused)`);
      continue;
    }

    const issueRowsNested = await Promise.all(
      errorAgentIds.map((agentId) =>
        apiGet(`/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&limit=200`),
      ),
    );
    const issueRows = [];
    for (const resp of issueRowsNested) {
      const rows = Array.isArray(resp) ? resp : Array.isArray(resp?.issues) ? resp.issues : null;
      if (!rows) {
        console.error(`issues census unusable for company ${companyId}: ${JSON.stringify(resp).slice(0, 200)}`);
        return 2;
      }
      issueRows.push(...rows);
    }

    const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
    const flagged = classifyDormantErrorAgents(agentRows, issueRows, { thresholdMs });
    if (flagged.length === 0) {
      console.log(
        `OK [${companyId}]: ${errorAgentIds.length} agent(s) in status=error but none holding ` +
          `actionable issues past ${Math.round(thresholdMs / 60000)}m`,
      );
      continue;
    }
    anyFlagged = true;
    for (const { agentId, sinceMs, actionableIssues } of flagged) {
      const issueList = actionableIssues
        .map((i) => `${i.identifier ?? 'no-id'}(${i.status})`)
        .join(', ');
      console.log(
        `DORMANT [${companyId}]: agent ${agentName.get(agentId) ?? agentId} (${agentId}) — ` +
          `status=error for ${Math.round(sinceMs / 60000)}m while holding ${actionableIssues.length} ` +
          `actionable issue(s): ${issueList}`,
      );
    }
  }

  if (!anyFlagged) return 0;
  console.log(
    `\nDormant error agent(s) found. AUR-5644's assignment-wake self-heal only fires on a ` +
      `NEW assignment wake — a lane with no fresh assignment traffic can still wedge silently. ` +
      `Reroute the held issues to a healthy lane, or investigate why the lane is dead (quota, ` +
      `adapter outage) before waking it manually.`,
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
