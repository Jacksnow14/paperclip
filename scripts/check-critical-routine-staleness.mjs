#!/usr/bin/env node
/**
 * check-critical-routine-staleness.mjs (AUR-5042)
 *
 * "Send-drift detection must survive its own lane dying."
 *
 * Root incident: the daily LIVE outreach routine (42a19235, AUR-2880) went
 * dark for 8 days (2026-07-29 .. 2026-08-06) because of the claude_local
 * weekly quota wall. The watchdog meant to catch exactly this — the 0-send
 * watchdog (ac2c352d, AUR-2878) — died of the SAME cause on the SAME lane at
 * the SAME time, because it is agent-run and co-located on the lane it
 * monitors. Nothing reported the outage for 8 days.
 *
 * This script is designed to never repeat that failure mode: it is invoked
 * by HOST CRON (never an agent lane — see the wrapper script this ships
 * alongside), and it evaluates `lastSuccessfulCompletionAt` — a field that
 * only advances on genuine `done` closure of a routine's run issue, so it
 * stays frozen exactly when a run dies mid-flight (quota wall, auth wall,
 * any terminal failure) even while the routine keeps firing new stranded
 * execution issues every tick. See scripts/lib/routine-staleness.mjs for the
 * pure evaluator this wraps.
 *
 * Severity: per fleet doctrine (telegram-founder-channel), this is an
 * ops/board signal, not a founder-action signal — a stranded routine has
 * already been failed over or is queued for retry under AUR-4363's
 * quota circuit-breaker; this detector's job is only to make sure someone
 * (a Paperclip issue) notices and tracks it, not to page the founder. So:
 * INFO to the audit log via notify_founder.sh (logged, never sent to
 * Telegram under the default TELEGRAM_MIN_SEVERITY=SEV2 — see
 * ~/bot/telegram-alert.sh), plus a filed Paperclip issue.
 *
 * Usage:
 *   node scripts/check-critical-routine-staleness.mjs [--dry-run]
 *
 *   --dry-run   Compute + print the plan for every critical routine; never
 *               sends the audit-log call, never files an issue, never
 *               writes local state.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
 *
 * Env vars optional:
 *   ROUTINE_STALENESS_STATE_DIR   Overrides the local dedup-state directory.
 *                                 Defaults to ~/paperclip-data/
 *                                 routine-staleness/state.
 *   NOTIFY_FOUNDER_CMD            Overrides the notify_founder.sh path, for
 *                                 tests / non-default installs. Defaults to
 *                                 ~/bot/notify_founder.sh.
 *   ROUTINE_STALENESS_OWNER_AGENT_ID  Overrides the assignee for filed
 *                                 issues. Defaults to the CTO agent.
 *
 * Exit codes:
 *   0 — ran to completion (including "found and reported a stale routine" —
 *       that is success for this script, not a failure)
 *   2 — configuration/API error; fails closed
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveApiBase } from './lib/paperclip-api-base.mjs';
import { evaluateRoutineStaleness } from './lib/routine-staleness.mjs';
import { loadLocalState, saveLocalState, needsAlert } from './lib/routine-staleness-local-state.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_NOTIFY_FOUNDER_CMD = path.join(homedir(), 'bot', 'notify_founder.sh');
const DEFAULT_STATE_DIR = path.join(homedir(), 'paperclip-data', 'routine-staleness', 'state');
const DEFAULT_OWNER_AGENT_ID = '371a1b08-0286-4a12-a516-f587f42df5eb'; // CTO

/**
 * Initial critical set per AUR-5042 requirement #4. Both routines have died
 * silently before; a third routine could be added later without
 * contradicting that requirement.
 */
export const CRITICAL_ROUTINES = [
  {
    id: '42a19235-94c4-4013-8ac4-8f06646be674',
    label: 'Daily email-deliverability LIVE safe-outreach (AUR-2880)',
  },
  {
    id: 'ac2c352d-912c-4ae6-9986-d995ff741819',
    label: 'Outreach 0-send watchdog (escalate silent send drift) — AUR-2878',
  },
];

function scheduleCronExpression(routine) {
  const trigger = (routine.triggers ?? []).find((t) => t.kind === 'schedule' && t.cronExpression);
  return trigger?.cronExpression ?? null;
}

function buildIssueBody({ result, routine }) {
  return [
    `Critical routine **${result.label}** (\`${result.routineId}\`) has missed ${result.missedCount} consecutive expected completion(s).`,
    '',
    `- Last successful completion: ${result.since ?? 'never'}`,
    `- Missed-completion threshold: ${result.threshold}`,
    `- Current status: ${routine.status ?? 'unknown'}`,
    `- Active issue: ${routine.activeIssue ? (routine.activeIssue.identifier ?? routine.activeIssue.id) : 'none'}`,
    '',
    'Filed by the AUR-5042 off-lane staleness sweep (host cron, not an agent ' +
      'lane — see scripts/check-critical-routine-staleness.mjs). This is an ' +
      'ops/board signal per fleet doctrine, not a founder-action signal; ' +
      'harness-level retry/failover is AUR-4363\'s scope, not this ' +
      'detector\'s — this only makes sure the outcome-level miss gets ' +
      'tracked.',
  ].join('\n');
}

/**
 * Send the audit-log signal via the fleet's one founder-notification
 * chokepoint, at INFO severity.
 *
 * Under the default TELEGRAM_MIN_SEVERITY=SEV2, telegram-alert.sh's
 * severity filter (`sev_rank(INFO)=0 < sev_rank(SEV2)=1`) exits 0 with
 * empty stdout BEFORE ever calling its own `log_send` — so no Telegram
 * message is sent and no line is written to ~/bot/logs/telegram-alert.log
 * for a plain INFO call. notify_founder.sh then sees non-"sent" output and
 * exits 1 with a diagnostic identifying that as a severity-filtered
 * no-send, not a transport failure. That IS the correct, intended INFO
 * doctrine outcome — "do NOT send SEV2 Telegram for stranded/status work" —
 * so it is classified as 'confirmed' here, distinguished from a genuine
 * delivery failure (missing creds, API/network error) by matching
 * notify_founder.sh's own "filtered" diagnostic on stderr. The durable
 * record of this INFO signal is the filed Paperclip issue plus this
 * script's own stdout under whatever log the host-cron wrapper redirects
 * to — not telegram-alert.log, which is reserved for actual sends.
 *
 * @returns {Promise<'confirmed'|'blocked'|'failed'>}
 */
export async function sendAuditLogSignal(message, { cmd = DEFAULT_NOTIFY_FOUNDER_CMD } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, ['INFO', message], { encoding: 'utf8' });
    return stdout.trim().toLowerCase().startsWith('sent') ? 'confirmed' : 'failed';
  } catch (err) {
    if (err && err.code === 2) return 'blocked'; // self-test/policy refusal
    const stderr = (err?.stderr ?? '').toLowerCase();
    if (err?.code === 1 && stderr.includes('telegram_min_severity filtered')) return 'confirmed';
    return 'failed';
  }
}

/**
 * Pure-ish core: given fetched routine details + injected side effects,
 * decide and apply the staleness report for every critical routine.
 * Injected functions make this fully unit-testable without touching the
 * network or the filesystem.
 *
 * @param {object} args
 * @param {Array<{spec: object, routine: object}>} args.fetched - one entry
 *   per critical routine: its declared spec plus the fetched detail payload
 * @param {Date} args.now
 * @param {(message: string) => Promise<'confirmed'|'blocked'|'failed'>} args.sendAuditLog
 * @param {(input: object) => Promise<object>} args.fileIssue
 * @param {Object<string, object>} [args.localState]
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{results: Array<object>, localState: Object<string, object>}>}
 */
export async function tick({ fetched, now, sendAuditLog, fileIssue, localState = {}, dryRun = false }) {
  const results = [];
  const nextLocalState = { ...localState };

  for (const { spec, routine } of fetched) {
    const cronExpression = scheduleCronExpression(routine);
    if (!cronExpression) {
      results.push({ routineId: spec.id, label: spec.label, skipped: true, reason: 'no-schedule-trigger' });
      continue;
    }

    const result = evaluateRoutineStaleness({
      routineId: spec.id,
      label: spec.label,
      cronExpression,
      lastSuccessfulCompletionAt: routine.lastSuccessfulCompletionAt ? new Date(routine.lastSuccessfulCompletionAt) : null,
      createdAt: routine.createdAt ? new Date(routine.createdAt) : null,
      now,
    });

    const prevEntry = localState[spec.id];
    const alertNeeded = result.stale && needsAlert(prevEntry, result.since);

    let auditLogResult = null;
    let filedIssue = null;
    if (alertNeeded && !dryRun) {
      const message = `Critical routine stale: ${result.label} — ${result.missedCount} missed completion(s) since ${result.since}.`;
      auditLogResult = await sendAuditLog(message);
      filedIssue = await fileIssue({ result, routine });
      nextLocalState[spec.id] = {
        alertedForSince: result.since,
        alertedAt: now.toISOString(),
        issueId: filedIssue?.identifier ?? filedIssue?.id ?? null,
      };
    }

    results.push({
      routineId: spec.id,
      label: spec.label,
      stale: result.stale,
      missedCount: result.missedCount,
      since: result.since,
      alertNeeded,
      auditLogResult,
      filedIssueId: filedIssue?.identifier ?? filedIssue?.id ?? null,
    });
  }

  return { results, localState: nextLocalState };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!API_KEY || !companyId) {
    console.error('Missing PAPERCLIP_API_KEY or PAPERCLIP_COMPANY_ID');
    return 2;
  }
  const API_URL = await resolveApiBase();
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  async function apiGet(pathname) {
    const res = await fetch(`${API_URL}${pathname}`, { headers });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(pathname, body) {
    const res = await fetch(`${API_URL}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${pathname} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  const STATE_DIR = process.env.ROUTINE_STALENESS_STATE_DIR || DEFAULT_STATE_DIR;
  const OWNER_AGENT_ID = process.env.ROUTINE_STALENESS_OWNER_AGENT_ID || DEFAULT_OWNER_AGENT_ID;

  let fetched;
  let localState;
  try {
    fetched = await Promise.all(
      CRITICAL_ROUTINES.map(async (spec) => ({
        spec,
        routine: await apiGet(`/api/companies/${companyId}/routines/${spec.id}`),
      })),
    );
    localState = await loadLocalState(STATE_DIR, companyId);
  } catch (err) {
    console.error(`fetch failed: ${err.message ?? err}`);
    return 2;
  }

  const { results, localState: nextLocalState } = await tick({
    fetched,
    now: new Date(),
    dryRun,
    localState,
    sendAuditLog: (message) => sendAuditLogSignal(message),
    fileIssue: ({ result, routine }) =>
      apiPost(`/api/companies/${companyId}/issues`, {
        title: `Critical routine stale: ${result.label} — ${result.missedCount} missed completion(s)`,
        description: buildIssueBody({ result, routine }),
        status: 'todo',
        priority: 'high',
        assigneeAgentId: OWNER_AGENT_ID,
      }),
  });

  if (!dryRun) {
    try {
      await saveLocalState(STATE_DIR, companyId, nextLocalState);
    } catch (err) {
      console.error(`failed to persist routine-staleness local state — REPEAT-ALERT RISK until fixed: ${err.message ?? err}`);
      for (const r of results) {
        console.log(`[${companyId}] ${r.label}: stale=${r.stale} missed=${r.missedCount} alertNeeded=${r.alertNeeded}`);
      }
      return 2;
    }
  }

  let anyError = false;
  for (const r of results) {
    if (r.skipped) {
      console.error(`[${companyId}] ${r.label}: SKIPPED (${r.reason})`);
      anyError = true;
      continue;
    }
    console.log(
      `[${companyId}] ${r.label}: stale=${r.stale} missed=${r.missedCount} since=${r.since} ` +
        `alertNeeded=${r.alertNeeded}${r.alertNeeded ? ` auditLog=${dryRun ? 'dry-run' : r.auditLogResult} issue=${dryRun ? 'dry-run' : r.filedIssueId}` : ''}`,
    );
  }

  return anyError ? 2 : 0;
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
