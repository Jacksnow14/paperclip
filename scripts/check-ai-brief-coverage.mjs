#!/usr/bin/env node
/**
 * check-ai-brief-coverage.mjs
 *
 * Daily production-coverage detector for the AI opportunity brief pipeline
 * (AUR-5468). Root incident: the weekly AUR-5463 mirror-gap audit answers
 * "was every brief that was produced also mirrored?" — it cannot answer "was
 * a brief produced at all?" On 2026-08-19 that gap let a pipeline that
 * produced no brief on 10 of the prior 14 days (07-30, 07-31, 08-03..08-05,
 * 08-07..08-11) read as a clean, zero-gap audit. Same class as AUR-3930
 * (Telegram `sent` on HTTP 401), AUR-4136 (memory capture `succeeded` for an
 * unreadable row), AUR-4613 (delivery-claim handoff notes): the success
 * signal is not the same object as the outcome.
 *
 * Detection rule (per day, default target = yesterday UTC):
 *   1. Resolve run issue(s) titled "Daily AI opportunity research brief for
 *      <date>" via GET /api/companies/{companyId}/issues?search=Daily AI
 *      opportunity&limit=60 (the canonical lookup — do not re-derive).
 *   2. HEALTHY  if any matched run issue carries a comment >= 2000 chars.
 *      NO_RUN_ISSUE if zero run issues matched the date (routine never fired).
 *      FIRED_NO_BRIEF if run issue(s) exist but none clears the threshold.
 *   NO_RUN_ISSUE and FIRED_NO_BRIEF are both "dark", but reported distinctly
 *   per spec — they point at different root causes (routine wiring vs.
 *   in-flight failure).
 *
 * On FAIL: comment on the current run issue naming the date, the matched run
 * issue(s) + status, the largest comment size found, and — quoted verbatim,
 * never paraphrased — the best-matching adapter_failed/cancellation-reason
 * comment if one exists.
 *
 * Consecutive dark-day counter: walks backward day-by-day from the target
 * date (recomputed fresh every run — no persisted state to drift) until a
 * HEALTHY day is found or MAX_STREAK_LOOKBACK_DAYS is hit. At >= 2
 * consecutive dark days, files (or updates) a dark-day alarm issue against
 * the CTO lane instead of only commenting — a single dark day is noise, two
 * is a pattern. The alarm auto-resolves once coverage returns to healthy
 * (mirrors the Phase A/B shape of scripts/check-delivery-claims.mjs).
 *
 * No Telegram. Per fleet doctrine this is a status condition, not a
 * founder-action — board only.
 *
 * Blindness guard (mandatory — AUR-4234 class): a wrong field name, wrong
 * date-format, or wrong endpoint returns HTTP 200 + [], which reads
 * identically to "no violations". Every invocation re-runs two REAL
 * fixtures through the full classification path before any scan result is
 * reported:
 *   - 2026-08-09 (AUR-5422, cancelled) MUST classify FIRED_NO_BRIEF (largest
 *     comment 755 chars) and MUST find an adapter/cancellation reason to quote.
 *   - 2026-08-06 (AUR-5123, done) MUST classify HEALTHY (largest comment
 *     16,311 chars, comment 41b34007).
 * If either control misbehaves, the script prints DETECTOR BLIND and exits 3
 * WITHOUT reporting a coverage verdict. A check that can never return FAIL is
 * as broken as one that never clears — both controls are exercised every run.
 *
 * Usage:
 *   node scripts/check-ai-brief-coverage.mjs [--apply] [--date YYYY-MM-DD] [--issue-id ID]
 *
 *   Without --apply: dry-run — prints the report, writes nothing.
 *   With --apply:    posts the FAIL comment (when --issue-id or
 *                     PAPERCLIP_TASK_ID is set) and files/updates/resolves
 *                     the dark-day alarm issue.
 *   --date defaults to yesterday (UTC). Pass an explicit date to replay
 *   historical coverage (used by the controls above).
 *
 * Env vars required:
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *   (PAPERCLIP_API_URL resolved via scripts/lib/paperclip-api-base.mjs)
 *
 * Exit codes:
 *   0 — controls passed, coverage healthy (or all intended actions applied)
 *   1 — dry-run with pending actions (dark day found; --apply to act)
 *   2 — configuration/API error
 *   3 — DETECTOR BLIND: a control fixture did not come back with the
 *       expected verdict
 *   4 — every intended mutation this run failed
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Classification (exported, pure — used in tests) ─────────────────────────

export const MIN_COMMENT_CHARS = 2000;
export const MAX_STREAK_LOOKBACK_DAYS = 30;
export const DARK_DAY_ALARM_THRESHOLD = 2;

export const TITLE_DATE_RE = /Daily AI opportunity research brief for (\d{4}-\d{2}-\d{2})/;

export function extractDateFromTitle(title) {
  const m = TITLE_DATE_RE.exec(title ?? '');
  return m ? m[1] : null;
}

/** Rule (1): match run issues to a target date by title, not creation time. */
export function runIssuesForDate(issues, date) {
  return (issues ?? []).filter((issue) => extractDateFromTitle(issue.title) === date);
}

/** Largest comment across every matched run issue for the date, with provenance. */
export function largestCommentAcrossBundles(bundles) {
  let best = { chars: 0, issueId: null, issueIdentifier: null, commentId: null };
  for (const { issue, comments } of bundles ?? []) {
    for (const c of comments ?? []) {
      const len = (c.body ?? '').length;
      if (len > best.chars) {
        best = { chars: len, issueId: issue.id, issueIdentifier: issue.identifier, commentId: c.id };
      }
    }
  }
  return best;
}

export const COVERAGE_STATUS = {
  HEALTHY: 'HEALTHY',
  FIRED_NO_BRIEF: 'FIRED_NO_BRIEF',
  NO_RUN_ISSUE: 'NO_RUN_ISSUE',
};

/**
 * Rule (2): classify one day. `bundles` is [{issue, comments}] for the
 * matched run issue(s) only (empty when matchedIssues is empty).
 */
export function classifyDayCoverage({ date, matchedIssues, bundles, minChars = MIN_COMMENT_CHARS }) {
  if (!matchedIssues || matchedIssues.length === 0) {
    return { date, status: COVERAGE_STATUS.NO_RUN_ISSUE, healthy: false, matchedIssues: [], largest: { chars: 0 } };
  }
  const largest = largestCommentAcrossBundles(bundles);
  const healthy = largest.chars >= minChars;
  return {
    date,
    status: healthy ? COVERAGE_STATUS.HEALTHY : COVERAGE_STATUS.FIRED_NO_BRIEF,
    healthy,
    matchedIssues,
    largest,
  };
}

/**
 * Rule (3): find the best system adapter_failed/cancellation-reason comment
 * to quote verbatim. Never paraphrase — return the comment, the caller quotes
 * its body directly. Priority: explicit "adapter_failed" token > a comment
 * that both mentions cancellation and states a "Reason:" > any comment
 * mentioning cancellation (longest first) > none found.
 */
export function extractFailureReason(bundles) {
  const flat = [];
  for (const { issue, comments } of bundles ?? []) {
    for (const c of comments ?? []) flat.push({ ...c, issueIdentifier: issue.identifier });
  }
  const adapterFailed = flat.find((c) => /adapter_failed/i.test(c.body ?? ''));
  if (adapterFailed) return { rule: 'adapter_failed', comment: adapterFailed };

  const reasonStated = flat.find((c) => /cancel/i.test(c.body ?? '') && /reason:/i.test(c.body ?? ''));
  if (reasonStated) return { rule: 'cancellation-reason', comment: reasonStated };

  const anyCancel = flat
    .filter((c) => /cancel/i.test(c.body ?? ''))
    .sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0))[0];
  if (anyCancel) return { rule: 'cancel-mention', comment: anyCancel };

  return null;
}

/** Real fixtures exercised on EVERY invocation (see header). */
export const CONTROLS = [
  {
    date: '2026-08-09',
    mustBeHealthy: false,
    mustHaveReason: true,
    note: 'AUR-5422, cancelled, max comment 755ch — must FIRE and quote a reason',
  },
  {
    date: '2026-08-06',
    mustBeHealthy: true,
    note: 'AUR-5123, done, comment 41b34007 = 16,311ch — must report healthy',
  },
];

/**
 * Verdict for one control fixture: null when it behaved, otherwise a
 * human-readable blindness reason.
 */
export function controlVerdict(control, coverage, reason) {
  if (coverage.healthy !== control.mustBeHealthy) {
    return (
      `control ${control.date} classified ${coverage.status}, expected ` +
      `${control.mustBeHealthy ? 'HEALTHY' : 'dark'} (largest=${coverage.largest.chars}ch) — ${control.note}`
    );
  }
  if (control.mustHaveReason && !reason) {
    return `control ${control.date} classified dark correctly but found no quotable adapter/cancellation reason — ${control.note}`;
  }
  return null;
}

// ── Consecutive dark-day streak (recomputed fresh every run — no state) ────

export function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Walk backward from `targetDate` while each day is dark. `getCoverage` is
 * async (date) => coverage result (same shape as classifyDayCoverage output).
 * Stops at the first HEALTHY day or after maxDays.
 */
export async function computeDarkStreak(targetDate, getCoverage, maxDays = MAX_STREAK_LOOKBACK_DAYS) {
  const days = [];
  let cursor = targetDate;
  for (let i = 0; i < maxDays; i++) {
    const coverage = await getCoverage(cursor);
    if (coverage.healthy) break;
    days.push(coverage);
    cursor = shiftDate(cursor, -1);
  }
  return days; // oldest-to-newest is reversed; days[0] === targetDate, most recent first
}

// ── Dark-day alarm issue plumbing ────────────────────────────────────────────

export const ALARM_TITLE = 'AI opportunity brief dark-day alarm';
export const CTO_AGENT_ID = '371a1b08-0286-4a12-a516-f587f42df5eb';

export function buildAlarmBody(streakDays) {
  const newest = streakDays[0];
  const oldest = streakDays[streakDays.length - 1];
  const lines = [
    `## Daily brief production coverage — ${streakDays.length} consecutive dark day(s)`,
    '',
    `**Window:** ${oldest.date} → ${newest.date} (${streakDays.length} day(s), all dark)`,
    '',
    'Per day:',
    '',
  ];
  for (const day of [...streakDays].reverse()) {
    const runList =
      day.matchedIssues.length === 0
        ? 'no run issue found'
        : day.matchedIssues.map((i) => `${i.identifier} [${i.status}]`).join(', ');
    lines.push(`- **${day.date}**: \`${day.status}\` — ${runList}, largest comment ${day.largest.chars}ch`);
  }
  lines.push(
    '',
    'Detected by scripts/check-ai-brief-coverage.mjs (AUR-5468). Two distinct root causes have already ' +
      'recurred here: queue starvation ([AUR-5055](/AUR/issues/AUR-5055)) and provider outage ' +
      '([AUR-5431](/AUR/issues/AUR-5431)). Investigate today\'s failure mode before assuming it is either of those.',
    '',
    'exec.routing-rationale: skip',
  );
  return lines.join('\n');
}

// ── API helpers ───────────────────────────────────────────────────────────────

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPatch(path, body) {
    const res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function searchBriefIssues(companyId) {
    const body = await apiGet(`/api/companies/${companyId}/issues?search=Daily AI opportunity&limit=60`);
    return Array.isArray(body) ? body : (body?.issues ?? body?.items ?? []);
  }

  async function fetchBundle(issue) {
    const comments = await apiGet(`/api/issues/${issue.id}/comments`).then(
      (b) => (Array.isArray(b) ? b : (b?.comments ?? b?.items ?? []))
    );
    return { issue, comments };
  }

  /** Coverage for one date: resolve matches, fetch comment bundles, classify. */
  async function coverageForDate(companyId, date, allIssuesCache) {
    const issues = allIssuesCache ?? (await searchBriefIssues(companyId));
    const matchedIssues = runIssuesForDate(issues, date);
    const bundles = await Promise.all(matchedIssues.map((issue) => fetchBundle(issue)));
    return { coverage: classifyDayCoverage({ date, matchedIssues, bundles }), bundles };
  }

  return { apiGet, apiPost, apiPatch, searchBriefIssues, fetchBundle, coverageForDate };
}

function extractStatusCode(errorMessage) {
  const match = /→\s*(\d+)/.exec(errorMessage ?? '');
  return match ? match[1] : 'unknown';
}

async function runMutation(label, fn, failures) {
  try {
    await fn();
    return true;
  } catch (err) {
    const status = extractStatusCode(err.message);
    console.error(`    FAILED (${status}): ${label} — ${err.message}`);
    failures.push({ label, status, message: err.message });
    return false;
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ── Main routine ──────────────────────────────────────────────────────────────

export async function main({ apply, targetDate, issueId, apiUrl, apiKey, companyId }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const { apiGet, apiPost, apiPatch, coverageForDate } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  // ── Blindness controls: run BEFORE any scan result is reported ─────────────
  console.log('── Controls (run every invocation — a clean pass from a blind query is worse than a crash) ──');
  for (const control of CONTROLS) {
    let verdict;
    let coverage;
    let reason;
    try {
      const result = await coverageForDate(companyId, control.date);
      coverage = result.coverage;
      reason = extractFailureReason(result.bundles);
      verdict = controlVerdict(control, coverage, reason);
    } catch (err) {
      verdict = `control ${control.date} fetch failed: ${err.message}`;
    }
    if (verdict) {
      console.error(`\nDETECTOR BLIND: ${verdict}`);
      console.error('Refusing to report a coverage verdict from an unvalidated query. Fix the detector first.');
      return 3;
    }
    console.log(
      `  OK: ${control.date} → ${coverage.status} as expected (largest=${coverage.largest.chars}ch)` +
        (reason ? ` — reason quoted: "${reason.comment.body.slice(0, 120)}${reason.comment.body.length > 120 ? '…' : ''}"` : '')
    );
  }

  // ── Today's check (default: yesterday UTC) ──────────────────────────────────
  const date = targetDate ?? shiftDate(todayUTC(), -1);
  console.log(`\n── Coverage check for ${date} ──\n`);

  const { coverage, bundles } = await coverageForDate(companyId, date);
  console.log(
    `  ${coverage.status}: ${coverage.matchedIssues.length} run issue(s) matched, ` +
      `largest comment ${coverage.largest.chars}ch` +
      (coverage.largest.issueIdentifier ? ` (${coverage.largest.issueIdentifier} / ${coverage.largest.commentId})` : '')
  );
  for (const issue of coverage.matchedIssues) {
    console.log(`    - ${issue.identifier} [${issue.status}] "${issue.title}"`);
  }

  let reason = null;
  if (!coverage.healthy) {
    reason = extractFailureReason(bundles);
    if (reason) {
      console.log(`  Reason (${reason.rule}, ${reason.comment.issueIdentifier}/${reason.comment.id}):`);
      console.log(`    "${reason.comment.body}"`);
    } else {
      console.log('  No adapter_failed/cancellation-reason comment found to quote.');
    }
  }
  console.log();

  const failedMutations = [];
  let attemptedMutations = 0;
  let streakDays = [];

  if (!coverage.healthy) {
    // ── Consecutive streak (recomputed fresh, walking backward from `date`) ──
    console.log('── Consecutive dark-day streak ──');
    streakDays = await computeDarkStreak(date, async (d) => (await coverageForDate(companyId, d)).coverage);
    console.log(`  ${streakDays.length} consecutive dark day(s) ending ${date}: ${streakDays.map((d) => d.date).reverse().join(', ')}\n`);

    // ── Post the FAIL comment on the current run issue ──────────────────────
    const targetIssueId = issueId ?? process.env.PAPERCLIP_TASK_ID ?? null;
    if (targetIssueId) {
      const lines = [
        `## AI brief coverage FAIL — ${date}`,
        '',
        `**Status:** \`${coverage.status}\``,
        `**Run issue(s):** ${
          coverage.matchedIssues.length === 0
            ? 'none found'
            : coverage.matchedIssues.map((i) => `${i.identifier} [${i.status}]`).join(', ')
        }`,
        `**Largest comment found:** ${coverage.largest.chars}ch` +
          (coverage.largest.issueIdentifier ? ` (${coverage.largest.issueIdentifier} / ${coverage.largest.commentId})` : ''),
        `**Consecutive dark days ending ${date}:** ${streakDays.length}`,
        '',
      ];
      if (reason) {
        lines.push(`**Quoted reason (${reason.rule}, ${reason.comment.issueIdentifier}):**`, '', '> ' + reason.comment.body.replace(/\n/g, '\n> '), '');
      } else {
        lines.push('No adapter_failed/cancellation-reason comment found on the run issue(s).', '');
      }
      lines.push('Detected by scripts/check-ai-brief-coverage.mjs (AUR-5468).');
      console.log(`  Posting FAIL comment on ${targetIssueId}${apply ? '' : ' (dry-run — not posted)'}.`);
      if (apply) {
        attemptedMutations++;
        await runMutation(
          `comment FAIL on ${targetIssueId}`,
          () => apiPost(`/api/issues/${targetIssueId}/comments`, { body: lines.join('\n') }),
          failedMutations
        );
      }
    } else {
      console.log('  No target issue id (--issue-id / PAPERCLIP_TASK_ID) — skipping FAIL comment.');
    }

    // ── Dark-day alarm (>= threshold) ────────────────────────────────────────
    if (streakDays.length >= DARK_DAY_ALARM_THRESHOLD) {
      console.log(`\n── Dark-day alarm (streak ${streakDays.length} >= ${DARK_DAY_ALARM_THRESHOLD}) ──`);
      const openAlarms = (
        await apiGet(`/api/companies/${companyId}/issues?status=backlog,todo,in_progress,in_review,blocked&search=${encodeURIComponent(ALARM_TITLE)}`)
      );
      const openAlarmRows = (Array.isArray(openAlarms) ? openAlarms : (openAlarms?.issues ?? openAlarms?.items ?? [])).filter(
        (i) => i.title === ALARM_TITLE
      );
      const body = buildAlarmBody(streakDays);
      if (openAlarmRows.length > 0) {
        const existing = openAlarmRows[0];
        console.log(`  UPDATE existing alarm ${existing.identifier ?? existing.id}.`);
        if (apply) {
          attemptedMutations++;
          await runMutation(
            `update alarm ${existing.identifier ?? existing.id}`,
            () => apiPost(`/api/issues/${existing.id}/comments`, { body }),
            failedMutations
          );
        }
      } else {
        console.log(`  FILE new alarm "${ALARM_TITLE}" → CTO.`);
        if (apply) {
          attemptedMutations++;
          await runMutation(
            'file dark-day alarm',
            () =>
              apiPost(`/api/companies/${companyId}/issues`, {
                title: ALARM_TITLE,
                description: body,
                status: 'todo',
                priority: 'high',
                assigneeAgentId: CTO_AGENT_ID,
              }),
            failedMutations
          );
        }
      }
    }
  } else {
    // ── Auto-resolve a standing alarm once coverage returns to healthy ─────
    const openAlarms = await apiGet(
      `/api/companies/${companyId}/issues?status=backlog,todo,in_progress,in_review,blocked&search=${encodeURIComponent(ALARM_TITLE)}`
    );
    const openAlarmRows = (Array.isArray(openAlarms) ? openAlarms : (openAlarms?.issues ?? openAlarms?.items ?? [])).filter(
      (i) => i.title === ALARM_TITLE
    );
    if (openAlarmRows.length > 0) {
      console.log('── Auto-resolve ──');
      for (const alarm of openAlarmRows) {
        console.log(`  RESOLVE alarm ${alarm.identifier ?? alarm.id} — coverage healthy again as of ${date}.`);
        if (apply) {
          attemptedMutations++;
          await runMutation(
            `resolve alarm ${alarm.identifier ?? alarm.id}`,
            async () => {
              await apiPatch(`/api/issues/${alarm.id}`, { status: 'done' });
              await apiPost(`/api/issues/${alarm.id}/comments`, {
                body: `Auto-resolved by check-ai-brief-coverage.mjs: coverage healthy again as of ${date}.`,
              });
            },
            failedMutations
          );
        }
      }
    }
  }

  console.log('\n── Summary ──');
  console.log(`  Controls:      2/2 passed`);
  console.log(`  Date checked:  ${date}`);
  console.log(`  Status:        ${coverage.status}`);
  console.log(`  Dark streak:   ${streakDays.length}`);
  console.log(`  Failed:        ${failedMutations.length}`);
  if (failedMutations.length > 0) {
    for (const { label, status } of failedMutations) console.log(`    - ${label} → ${status}`);
    console.log('  Re-run the detector to retry the above (idempotent).');
  }

  const hasPendingActions =
    !coverage.healthy && (streakDays.length >= DARK_DAY_ALARM_THRESHOLD || (issueId ?? process.env.PAPERCLIP_TASK_ID));
  if (!apply && hasPendingActions) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above actions.');
    return 1;
  }

  if (attemptedMutations > 0 && failedMutations.length === attemptedMutations) {
    console.log('\nERROR: every intended mutation failed this run — see Failed list above.');
    return 4;
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      date: { type: 'string' },
      'issue-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-ai-brief-coverage.mjs [--apply] [--date YYYY-MM-DD] [--issue-id ID]');
    console.log('  --apply     Execute changes (default: dry-run, exit 1 if actions pending)');
    console.log('  --date      Target date to check (default: yesterday UTC)');
    console.log('  --issue-id  Issue to post the FAIL comment on (default: $PAPERCLIP_TASK_ID)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('ERROR: --date must be YYYY-MM-DD.');
    process.exit(2);
  }

  resolveApiBase()
    .then((API_URL) =>
      main({
        apply: args.apply,
        targetDate: args.date,
        issueId: args['issue-id'],
        apiUrl: API_URL,
        apiKey: API_KEY,
        companyId: COMPANY_ID,
      })
    )
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FATAL:', err.message);
      process.exit(2);
    });
}
