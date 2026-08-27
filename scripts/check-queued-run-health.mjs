#!/usr/bin/env node
/**
 * check-queued-run-health.mjs (AUR-6279)
 *
 * Detector for the claude_local quota-wall shape: a run (or wakeup request)
 * created but never admitted. It sits at `status: queued` forever — no
 * `startedAt`, no token usage — because the adapter's session quota is
 * exhausted and nothing ever picks the row up. Occurred 3x for the CMO agent
 * (AUR-6277) and was independently confirmed live for Claude Code Max
 * (5 stale queued runs, oldest >20h old at detection time) while building
 * this script — a distinct, ongoing instance of the same pattern.
 *
 * This is a DIFFERENT shape from AUR-4679's park detector
 * (./check-parked-agents.mjs, `classifyParkedAgents`): that one flags an
 * agent whose entire run set sits behind a future `scheduledRetryAt` — a
 * deliberate, self-resolving backoff. `LIVE_STATUSES = new Set(['queued',
 * 'running'])` in that module treats ANY queued row as proof of near
 * liveness, which is exactly why a stuck-queued run (this issue's pattern) is
 * invisible to it: the queued row IS the problem here, not evidence against
 * one.
 *
 * Two independent scans, since only runs have a company-wide census endpoint:
 *   1. Company-wide `GET /api/companies/{id}/heartbeat-runs` (unbounded —
 *      only a limit-less read is a true census, see check-parked-agents.mjs)
 *      → runs with status=queued, age > threshold, zero token usage.
 *   2. Per-agent `GET /api/agents/{id}/wakeup-requests?limit=20` (no
 *      company-wide equivalent exists — confirmed by reading
 *      server/src/routes/*.ts) → wakeup requests with status=queued,
 *      age > threshold.
 *
 * Escalation path (AUR-6279's AC: "post a comment on the affected issue and
 * send an alert to the CEO"), adapted to two confirmed permission
 * constraints found while building this:
 *
 *   - `POST /issues/:id/comments` 403s "Agent cannot mutate another agent's
 *     issue" for any actor that neither owns the target issue nor holds
 *     `tasks:comment_cross_issue` (auto-granted only to role `ceo` agents,
 *     server/src/routes/issues.ts:1122). A CTO-owned routine (see below)
 *     does not have this grant, so a direct comment on an arbitrary
 *     third-party issue (e.g. the CMO's) will usually 403.
 *   - `POST /api/companies/:companyId/routines` rejects any `assigneeAgentId`
 *     other than the calling agent — a routine cannot be created "assigned
 *     to CEO" by CTO (confirmed live on AUR-4494/AUR-5745). So this can only
 *     run self-assigned to whichever agent creates it.
 *
 * Given both constraints, the reliable escalation is the same one
 * check-stalled-blocked.mjs already proves works for a CTO-owned watchdog:
 * FILE A NEW ISSUE per incident, assigned to CEO_AGENT_ID, rather than
 * assume a direct comment on the affected issue will land. This single
 * write satisfies both AC bullets at once (self-documentation + CEO alert).
 * A direct comment on the affected issue is still attempted best-effort
 * (succeeds when the affected issue happens to be owned by the calling
 * agent, or if cross-issue-comment permission is ever granted) but a 403
 * there is expected and non-fatal — the filed issue is the guaranteed path.
 *
 * Usage:
 *   node scripts/check-queued-run-health.mjs [--apply]
 *
 *   Without --apply: prints the plan only, files nothing, comments nothing.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
 *   PAPERCLIP_COMPANY_IDS   optional comma-separated override
 *   MAX_FLAGS_PER_RUN       optional cap on new issues filed per run (default 5)
 *
 * Exit codes:
 *   0 — ran to completion (finding + filing incidents is success, not failure)
 *   2 — configuration/API/shape error; fails closed like check-parked-agents.mjs
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

export const STALE_QUEUED_THRESHOLD_MS = 10 * 60 * 1000;
export const CEO_AGENT_ID = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';
export const DEFAULT_MAX_FLAGS_PER_RUN = 5;

export const FLAG_REGEX = /queued-run-health:\s*(run|wakeup)\s+([0-9a-f-]+)/i;

export function flagTitle(kind, id) {
  return `queued-run-health: ${kind} ${id}`;
}

export function resolveMaxFlagsPerRun(env = process.env) {
  const raw = env.MAX_FLAGS_PER_RUN;
  if (raw === undefined) return DEFAULT_MAX_FLAGS_PER_RUN;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FLAGS_PER_RUN;
}

/**
 * A queued run/wakeup-request reports usage in at least two observed shapes
 * across endpoints (flat inputTokens/outputTokens on /agents/:id/runs,
 * nested usageJson on the company-wide census) — check both defensively
 * rather than assume one.
 */
function tokenTotal(row) {
  const usage = row?.usageJson;
  const usageIn = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0) || 0;
  const usageOut = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0) || 0;
  const flatIn = Number(row?.inputTokens ?? 0) || 0;
  const flatOut = Number(row?.outputTokens ?? 0) || 0;
  return usageIn + usageOut + flatIn + flatOut;
}

function ageMs(isoTimestamp, now) {
  const t = new Date(isoTimestamp).getTime();
  if (Number.isNaN(t)) return null;
  return now.getTime() - t;
}

/**
 * Pure classifier over the company-wide heartbeat-runs census.
 *
 * @param {Array<object>} runs
 * @param {{now?: Date, thresholdMs?: number}} [opts]
 * @returns {Array<{runId: string, agentId: string, createdAt: string, issueId: string|null, ageMs: number}>}
 */
export function classifyStaleQueuedRuns(runs, opts = {}) {
  const now = opts.now ?? new Date();
  const thresholdMs = opts.thresholdMs ?? STALE_QUEUED_THRESHOLD_MS;

  const flagged = [];
  for (const run of runs) {
    if (!run?.id || !run?.agentId) continue;
    if (run.status !== 'queued') continue;
    if (run.startedAt) continue; // admitted — not the "never admitted" shape
    const createdAt = run.createdAt ?? run.requestedAt;
    if (!createdAt) continue;
    const age = ageMs(createdAt, now);
    if (age === null || age <= thresholdMs) continue;
    if (tokenTotal(run) !== 0) continue; // has usage — not zero-token
    flagged.push({
      runId: run.id,
      agentId: run.agentId,
      createdAt: new Date(createdAt).toISOString(),
      issueId: run.contextSnapshot?.issueId ?? null,
      ageMs: age,
    });
  }
  flagged.sort((a, b) => a.runId.localeCompare(b.runId));
  return flagged;
}

/**
 * Pure classifier over one agent's wakeup-requests list. No company-wide
 * equivalent endpoint exists (confirmed: only /agents/:id/wakeup-requests),
 * so the caller loops this per agent.
 *
 * @param {Array<object>} wakeups
 * @param {{agentId: string, now?: Date, thresholdMs?: number}} opts
 * @returns {Array<{requestId: string, agentId: string, requestedAt: string, ageMs: number}>}
 */
export function classifyStaleQueuedWakeups(wakeups, opts = {}) {
  const now = opts.now ?? new Date();
  const thresholdMs = opts.thresholdMs ?? STALE_QUEUED_THRESHOLD_MS;
  const agentId = opts.agentId;

  const flagged = [];
  for (const wakeup of wakeups) {
    if (!wakeup?.id) continue;
    if (wakeup.status !== 'queued') continue;
    const requestedAt = wakeup.requestedAt ?? wakeup.createdAt;
    if (!requestedAt) continue;
    const age = ageMs(requestedAt, now);
    if (age === null || age <= thresholdMs) continue;
    flagged.push({
      requestId: wakeup.id,
      agentId: agentId ?? wakeup.agentId,
      requestedAt: new Date(requestedAt).toISOString(),
      ageMs: age,
    });
  }
  flagged.sort((a, b) => a.requestId.localeCompare(b.requestId));
  return flagged;
}

export function buildIncidentDescription({ kind, incident, agentName, sourceIssuePrefix }) {
  const ageMinutes = Math.round(incident.ageMs / 60000);
  const lines = [
    `## Queued-run health alert (AUR-6279)`,
    ``,
    `Detected via the AUR-6279 queued-run health monitor.`,
    ``,
    `- **Kind:** ${kind}`,
    `- **Agent:** ${agentName} (\`${incident.agentId}\`)`,
  ];
  if (kind === 'run') {
    lines.push(`- **Run:** \`${incident.runId}\``);
    lines.push(`- **Created:** ${incident.createdAt} (${ageMinutes} min ago)`);
    lines.push(`- **Status:** queued, never admitted (no startedAt, zero token usage)`);
    if (incident.issueId) {
      lines.push(`- **Affected issue:** ${sourceIssuePrefix ?? ''}${incident.issueId}`.trim());
    }
  } else {
    lines.push(`- **Wakeup request:** \`${incident.requestId}\``);
    lines.push(`- **Requested:** ${incident.requestedAt} (${ageMinutes} min ago)`);
    lines.push(`- **Status:** queued, older than the ${STALE_QUEUED_THRESHOLD_MS / 60000}-minute threshold`);
  }
  lines.push(
    ``,
    `This matches the claude_local quota-wall pattern described in AUR-6277/AUR-6279: ` +
      `a wakeup request or run created but never admitted by the adapter. Check whether ` +
      `the affected agent's lane is quota-exhausted and route around it if so.`,
  );
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main({ apply, apiUrl, apiKey, companyId, maxFlagsPerRun = resolveMaxFlagsPerRun() }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  async function apiGet(pathname) {
    const res = await fetch(`${apiUrl}${pathname}`, { headers });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status} ${res.statusText}`);
    return res.json();
  }
  async function apiPost(pathname, body) {
    const res = await fetch(`${apiUrl}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${pathname} → ${res.status} ${res.statusText}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  if (!apply) {
    console.log('[DRY-RUN] No issues will be filed or commented on. Pass --apply to execute.\n');
  }

  // No `limit`: only a limit-less read is a true census.
  const runs = await apiGet(`/api/companies/${companyId}/heartbeat-runs`);
  if (!Array.isArray(runs)) throw new Error(`heartbeat-runs census unusable for company ${companyId}`);

  const agents = await apiGet(`/api/companies/${companyId}/agents`);
  if (!Array.isArray(agents)) throw new Error(`agents census unusable for company ${companyId}`);
  const agentName = new Map(agents.map((a) => [a.id, a.name ?? a.id]));

  const company = await apiGet(`/api/companies/${companyId}`).catch(() => null);
  const issuePrefix = company?.issuePrefix ?? null;

  const staleRuns = classifyStaleQueuedRuns(runs, { now: new Date() });

  const staleWakeups = [];
  for (const agent of agents) {
    let wakeups;
    try {
      wakeups = await apiGet(`/api/agents/${agent.id}/wakeup-requests?limit=20`);
    } catch (err) {
      console.warn(`  wakeup-requests fetch failed for ${agentName.get(agent.id) ?? agent.id}: ${err.message ?? err}`);
      continue;
    }
    if (!Array.isArray(wakeups)) continue;
    staleWakeups.push(...classifyStaleQueuedWakeups(wakeups, { agentId: agent.id, now: new Date() }));
  }

  console.log(
    `── Scan: ${runs.length} run(s) censused, ${staleRuns.length} stale queued run(s); ` +
      `${agents.length} agent(s) checked for wakeup requests, ${staleWakeups.length} stale queued wakeup(s) ──\n`,
  );

  const allIncidents = [
    ...staleRuns.map((incident) => ({ kind: 'run', id: incident.runId, incident })),
    ...staleWakeups.map((incident) => ({ kind: 'wakeup', id: incident.requestId, incident })),
  ];

  if (allIncidents.length === 0) {
    console.log('OK: no stale queued runs or wakeup requests found.');
    return 0;
  }

  // Dedup: existing open flag issues, matched by the same title-regex
  // pattern check-stalled-blocked.mjs uses.
  const existingFlags = await apiGet(
    `/api/companies/${companyId}/issues?q=${encodeURIComponent('queued-run-health:')}&status=backlog,todo,in_progress,in_review,blocked&limit=200`,
  ).catch(() => []);
  const existingFlagList = Array.isArray(existingFlags) ? existingFlags : (existingFlags.issues ?? []);
  const openFlagTargets = new Set();
  for (const flag of existingFlagList) {
    const match = FLAG_REGEX.exec(flag.title ?? '');
    if (match) openFlagTargets.add(`${match[1]}:${match[2]}`);
  }

  const toFileAll = allIncidents.filter(({ kind, id }) => !openFlagTargets.has(`${kind}:${id}`));
  const skippedDedup = allIncidents.filter(({ kind, id }) => openFlagTargets.has(`${kind}:${id}`));
  const toFile = toFileAll.slice(0, maxFlagsPerRun);
  const droppedByCap = toFileAll.slice(maxFlagsPerRun);

  if (skippedDedup.length > 0) {
    console.log(`  SKIPPED-DEDUP — open flag exists (${skippedDedup.length}):`);
    skippedDedup.forEach(({ kind, id }) => console.log(`    - ${kind} ${id}`));
    console.log();
  }
  if (droppedByCap.length > 0) {
    console.log(`  CAP: maxFlagsPerRun=${maxFlagsPerRun} reached — dropping ${droppedByCap.length} candidate(s) this run (will be reconsidered next run):`);
    droppedByCap.forEach(({ kind, id }) => console.log(`    - ${kind} ${id}`));
    console.log();
  }

  let anyFailure = false;
  for (const { kind, id, incident } of toFile) {
    const title = flagTitle(kind, id);
    const name = agentName.get(incident.agentId) ?? incident.agentId;
    console.log(`  FILE: "${title}" (agent ${name}) → owner ${CEO_AGENT_ID}`);
    if (!apply) continue;

    const description = buildIncidentDescription({ kind, incident, agentName: name, sourceIssuePrefix: issuePrefix ? `${issuePrefix}-` : '' });
    try {
      await apiPost(`/api/companies/${companyId}/issues`, {
        title,
        description,
        status: 'todo',
        priority: 'high',
        assigneeAgentId: CEO_AGENT_ID,
      });
      console.log(`    → filed (assignee ${CEO_AGENT_ID}).`);
    } catch (err) {
      console.error(`    → FAILED to file: ${err.message ?? err}`);
      anyFailure = true;
      continue;
    }

    // Best-effort direct comment on the affected issue (run incidents only —
    // wakeup requests carry no contextSnapshot.issueId). Expected to 403 for
    // most third-party issues under a CTO-owned identity; the filed issue
    // above is the guaranteed escalation path regardless of this outcome.
    if (kind === 'run' && incident.issueId) {
      try {
        await apiPost(`/api/issues/${incident.issueId}/comments`, {
          body: `Queued-run health monitor: run \`${incident.runId}\` on this issue has been stuck ` +
            `at status=queued for ${Math.round(incident.ageMs / 60000)} minutes with zero token usage — ` +
            `likely a claude_local quota-wall stall (AUR-6279). Filed ${title} for tracking, assigned to CEO.`,
        });
        console.log(`    → also commented directly on affected issue ${incident.issueId}.`);
      } catch (err) {
        console.log(`    → direct comment on affected issue ${incident.issueId} not possible (expected for cross-agent issues): ${err.message ?? err}`);
      }
    }
  }

  return anyFailure ? 2 : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  (async () => {
    const apply = process.argv.includes('--apply');
    const apiKey = process.env.PAPERCLIP_API_KEY;
    const companyIds = (process.env.PAPERCLIP_COMPANY_IDS ?? process.env.PAPERCLIP_COMPANY_ID ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!apiKey || companyIds.length === 0) {
      console.error('Missing PAPERCLIP_API_KEY or PAPERCLIP_COMPANY_ID(S)');
      process.exit(2);
    }
    const apiUrl = await resolveApiBase();

    let anyError = false;
    for (const companyId of companyIds) {
      try {
        const code = await main({ apply, apiUrl, apiKey, companyId });
        if (code !== 0) anyError = true;
      } catch (err) {
        console.error(`FATAL [${companyId}]: ${err.message ?? err}`);
        anyError = true;
      }
    }
    process.exit(anyError ? 2 : 0);
  })();
}
