#!/usr/bin/env node
/**
 * check-routing-rationale.mjs
 *
 * Self-cleaning, deterministic watchdog for the routing-rationale convention
 * (AGENTS.md § "Routing rationale capture (enforcement)"). Runs as a
 * scheduled routine every 6 hours with --apply.
 *
 * AUR-3994/AUR-3987a root cause: the old Phase B only ever looked at issues
 * updated within --window-minutes on the OPEN-status working set. High/
 * critical issues usually close within a day, so a gap routinely closed
 * before the next 6h fire ever saw it — a measured ~2% detection rate
 * (86 high/critical assigned issues, 55 eligible, 21 missing a record, 20 of
 * those already done/cancelled by the time the watchdog looked). Fix: the
 * measurement pass below scans the FULL population (all statuses, paginated)
 * every run instead of a recency window, so a gap is counted the moment it
 * exists rather than only while it happens to be "recently updated" and
 * open. --window-minutes is still accepted for CLI back-compat with the
 * existing routine invocation but is no longer used to filter anything.
 *
 * Lifecycle:
 *   Phase A — Auto-resolve stale legacy per-gap flags (always runs):
 *     Cancel open flag issues (title matches FLAG_REGEX, from the pre-
 *     AUR-3994 one-issue-per-gap era) whose target is done/cancelled,
 *     already has a routing/{id} memory record, or is now exempt. Posts a
 *     one-line reason. Kept so legacy flags already on the board drain.
 *
 *   Full-population measurement (paginated, all statuses):
 *     Compute eligible / have-record / missing counts across every
 *     high/critical assigned manual-routing issue the company has ever had,
 *     not just the open ones. Missing gaps on done/cancelled issues are
 *     counted and listed in the console report ONLY — their rationale is
 *     unrecoverable, and filing on them would just manufacture retro-
 *     fabricated records (the AUR-3956 pattern).
 *
 *   Phase B — Sync rolling gap-aggregate issue (open gaps only):
 *     Find-or-create a single issue titled `routing-rationale gaps —
 *     YYYY-MM-DD` for today, rewrite its body with the current outstanding
 *     OPEN-and-missing list (anti-flood capped, drops logged), and auto-
 *     close it once the list is empty. Replaces the old one-issue-per-gap
 *     filing so the board doesn't accumulate a flag issue per gap.
 *
 * Usage:
 *   node scripts/check-routing-rationale.mjs [--window-minutes N] [--apply]
 *
 *   Without --apply: dry-run — prints full plan, writes nothing.
 *   With --apply:    executes cancellations and syncs the rolling gap issue
 *                     (idempotent).
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exemption rules (isExempt — no gap listed/filed; existing open legacy
 * flags auto-resolved):
 *   0. isRoutingDecision(issue) is false — no createdByAgentId, a non-manual
 *      originKind, or assigneeAgentId === createdByAgentId (self-assigned).
 *      These are issues where no routing decision was actually made, so no
 *      rationale is owed (AUR-3994/AUR-3987a).
 *   1. Issue description contains token `exec.routing-rationale: skip`
 *   2. Issue title matches /content slot/i (and content-pipeline children)
 *   3. Recurring daily-brief publication tasks
 *   4. Single-owner role-routed approval/sign-off gates (title framed as
 *      "{subject} sign-off: ..." / "... approval gate — ...") — no candidate
 *      pool, so no routing decision to document (AUR-1632)
 *
 * Separately (isPreRule, AUR-4006 — not part of isExempt, tracked as its own
 * pool bucket so the run summary shows exempt_nondecision and exempt_prerule
 * as distinct counts):
 *   5. issue.createdAt is strictly before RULE_EFFECTIVE_DATE (default
 *      2026-06-15T00:00:00Z, commit b78456e6/AUR-2301) — the requirement did
 *      not exist yet, so a faithful routing/{id} record is unrecoverable.
 *      Override the cutoff with --rule-effective-date. The boundary is
 *      inclusive of the rule date: an issue created exactly at the cutoff
 *      IS owed a rationale.
 *
 * Exit codes:
 *   0 — clean (nothing to do, or all intended actions applied — a partial
 *       run where SOME mutations failed still exits 0; see the Failed count
 *       in the run summary for what to retry)
 *   1 — dry-run with pending actions (apply to execute)
 *   2 — configuration/API error
 *   3 — BLOCKED: Memory API unavailable (watchdog cannot run this cycle)
 *   4 — every intended mutation this run failed (e.g. all targets locked by
 *       a stale checkout) — nothing was accomplished, surface it as an error
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Exported core utilities (used in tests) ──────────────────────────────────

/** Matches both flag title formats produced in the wild. */
export const FLAG_REGEX = /routing-rationale[- ]gap:\s*(AUR-\d+)/i;

/**
 * The issues LIST endpoint truncates `description` to this many chars
 * (server: ISSUE_LIST_DESCRIPTION_MAX_CHARS in services/issues.ts). The
 * `exec.routing-rationale: skip` exemption token can sit past this boundary,
 * so a list-fetched description at or above this length may be truncated and
 * must be re-fetched in full before evaluating exemption.
 */
export const LIST_DESC_TRUNCATION = 1200;

/** A list-fetched description this long may be truncated — fetch the full issue. */
export function mayBeTruncated(description) {
  return (description ?? '').length >= LIST_DESC_TRUNCATION;
}

/**
 * Returns true when a routing DECISION was actually made for this issue —
 * an agent created it, routed it through the normal manual-assignment path,
 * and handed it to someone other than itself. False means there is no
 * decision to document, so no routing/{id} rationale is owed:
 *   - `createdByAgentId` is missing — no agent filed it, so no agent routed
 *     it (e.g. user-filed issues).
 *   - `originKind` is set and isn't 'manual' — routine/system-generated
 *     (e.g. `routine_execution`, plugin operations); nobody compared
 *     candidates.
 *   - `assigneeAgentId === createdByAgentId` — self-assigned; the creator
 *     kept the work, no candidate pool was compared.
 *
 * Extracted as its own predicate (AUR-3994/AUR-3987a) from checks that used
 * to be split between an inline pool filter and isExempt's tail, so it is
 * independently unit-testable. The CTO's 2026-07-22..25 measurement found
 * 12 self-assigned + 20 routine/no-creator issues in the eligible pool that
 * this predicate correctly excludes.
 *
 * @param {{ createdByAgentId?: string|null, originKind?: string|null, assigneeAgentId?: string|null }} issue
 */
export function isRoutingDecision(issue) {
  if (!issue.createdByAgentId) return false;
  if (issue.originKind && issue.originKind !== 'manual') return false;
  if (issue.assigneeAgentId && issue.assigneeAgentId === issue.createdByAgentId) return false;
  return true;
}

/**
 * Exemption reasons that are intrinsic to the issue's content (title/description)
 * and therefore hold regardless of who is currently assigned. Safe to re-check at
 * any time, including when re-evaluating a flag filed in the past (AUR-3854).
 */
function isStaticallyExempt(issue) {
  if (issue.description && issue.description.includes('exec.routing-rationale: skip')) return true;
  if (/content slot/i.test(issue.title ?? '')) return true;
  // Recurring daily-brief publication tasks (e.g. "Post 2026-05-29 daily AI brief
  // to AUR-27") are content publication, not technical-routing decisions, so a
  // routing/{id} rationale is meaningless. They recur daily and would otherwise be
  // flagged-then-auto-resolved every day — a known false-positive class (AUR-1550).
  if (/daily\b.*\bbrief/i.test(issue.title ?? '')) return true;
  // Content-pipeline children (Content Slot → "Write script" → "Render & Upload")
  // are short-form video production tasks, not technical-routing decisions, so a
  // routing/{id} rationale is meaningless. Their Content-Slot parents match
  // /content slot/i above, but the generated children carry plain titles and slip
  // through, recurring every slot. Pair each child title with a content-pipeline
  // marker in the description so genuine technical tasks (e.g. "Write script to
  // migrate DB") are NOT exempted (AUR-1595, AUR-1550 false-positive class).
  const title = issue.title ?? '';
  const description = issue.description ?? '';
  if (/^\s*write script\b/i.test(title) && /workflow signal/i.test(description)) return true;
  if (/^\s*render & upload\b/i.test(title) && /video editor render task/i.test(description)) return true;
  // Single-owner role-routed approval/sign-off gates (e.g. "CFO sign-off: Standard
  // ~$160/mo subscription tier", "Legal approval gate — vendor X") route to the sole
  // owner of a role. There is no candidate pool to compare via performance
  // scorecards, so a routing/{id} rationale is meaningless — filing one would be
  // no-signal DB spam (AUR-1632, false-positive class of AUR-1630/AUR-1631).
  // Anchor on the gate framing: "sign-off" / "approval" (optionally "approval gate")
  // immediately followed by a ':' or '—' separator. This matches the "{subject}
  // sign-off: {what}" gate title form while NOT exempting genuine engineering tasks
  // that merely BUILD such a feature ("Add approval gate to deploy pipeline",
  // "Implement sign-off flow") — those have no gate delimiter after the phrase.
  if (/\b(?:sign[-\s]?off|approval(?:\s+gate)?)\s*[:—]/i.test(title)) return true;
  return false;
}

/**
 * Returns true if an issue is exempt from the routing-rationale convention.
 * Exempt issues are never flagged. Used by the measurement pass / Phase B
 * candidate-pool filter, where isRoutingDecision's self-assigned check
 * reflects the CURRENT assignee and is a valid no-delegation signal.
 * (Self-assigned / no-creator / routine-origin issues are covered by
 * isRoutingDecision — recurring false-positive class: AUR-869, AUR-1829,
 * AUR-801/802, AUR-1550.)
 *
 * Do NOT use this to auto-resolve an EXISTING flag (see isExemptForResolvedFlag):
 * the self-assigned check is assignee-snapshot-dependent, and an issue that was
 * delegated then handed back to its creator for review is NOT retroactively
 * exempt just because the current assignee matches the creator again (AUR-3854).
 */
export function isExempt(issue) {
  if (!isRoutingDecision(issue)) return true;
  return isStaticallyExempt(issue);
}

/**
 * Exemption check for Phase A re-evaluation of an ALREADY-FILED flag. Excludes
 * isRoutingDecision's self-assigned rule: a flag only ever gets filed for a
 * genuinely delegated issue (the pool filter already applied `isExempt`), so
 * the flag's mere existence proves delegation happened. A later handback to
 * the creator for review (assigneeAgentId reverting to createdByAgentId)
 * doesn't undo that — only immutable properties (createdByAgentId, originKind)
 * and the static, content-based exemptions can still legitimately apply
 * (e.g. the issue was edited to add the skip token after filing) (AUR-3854).
 */
export function isExemptForResolvedFlag(issue) {
  // Stable (non-assignee-snapshot) parts of isRoutingDecision: creator and
  // origin are immutable, so re-checking them can never retroactively void a
  // flag the way the self-assigned check can.
  if (!issue.createdByAgentId) return true;
  if (issue.originKind && issue.originKind !== 'manual') return true;
  return isStaticallyExempt(issue);
}

/**
 * Returns a cancel reason string if the flag should be resolved, or null if
 * the flag is still valid and should remain open.
 *
 * @param {{ target: object|null, targetId: string, hasRecord: boolean, recordScope?: 'org'|'project'|null, ruleEffectiveDate?: Date }} opts
 */
export function resolveCancelReason({ target, targetId, hasRecord, recordScope = null, ruleEffectiveDate = RULE_EFFECTIVE_DATE }) {
  if (!target || ['done', 'cancelled'].includes(target.status)) {
    return target
      ? `Auto-resolved by routing-rationale-watchdog: ${targetId} is ${target.status} — routing rationale moot.`
      : `Auto-resolved by routing-rationale-watchdog: ${targetId} not found among open issues — routing rationale moot.`;
  }
  // Check hasRecord before exemption so a captured record is reported as the
  // resolution reason instead of being misattributed to exemption when both
  // happen to be true at once (AUR-3854 secondary defect).
  if (hasRecord) {
    const scopeTag = recordScope === 'project' ? ' — project-scoped (hidden from org reads)' : '';
    return `Auto-resolved by routing-rationale-watchdog: routing/${targetId} record now exists.${scopeTag}`;
  }
  // Use isExemptForResolvedFlag, not isExempt: this flag was only ever filed for
  // a genuinely delegated issue, so a handback-to-creator reassignment must not
  // retroactively exempt it via the self-assigned rule (AUR-3854).
  if (isExemptForResolvedFlag(target)) {
    return `Auto-resolved by routing-rationale-watchdog: ${targetId} is exempt from routing rationale (no routing decision made, exec.routing-rationale: skip, content-slot, daily-brief, or single-owner sign-off/approval gate).`;
  }
  if (isPreRule(target, ruleEffectiveDate)) {
    return `Auto-resolved by routing-rationale-watchdog: ${targetId} was created before the routing-rationale rule took effect (${ruleEffectiveDate.toISOString()}) — rationale is unrecoverable and not owed (AUR-4006).`;
  }
  return null;
}

/**
 * The routing-rationale requirement itself did not exist before this date —
 * scripts/check-routing-rationale.mjs first landed in commit b78456e6
 * (AUR-2301), which is also when the AGENTS.md § "Routing rationale capture
 * (enforcement)" section arrived. A routing decision made before this date
 * was made under a regime with no performance/scorecard-adjusted registry to
 * compare candidates against, so a faithful routing/{id} record for it is
 * unrecoverable — demanding one only teaches agents to fabricate one (the
 * AUR-3993 pattern: 44 fabricated TEST-* scorecards). AUR-4006: measured
 * 2026-07-25, 5 of 6 outstanding gaps in the AUR-4000 sweep were 4-7 weeks
 * pre-rule. Override via --rule-effective-date; do not hardcode a second
 * copy of this date elsewhere.
 */
export const RULE_EFFECTIVE_DATE = new Date('2026-06-15T00:00:00Z');

/**
 * Parses a --rule-effective-date override into a Date, throwing on an
 * unparseable value so a typo'd override fails loudly at startup instead of
 * silently degrading: an invalid Date's getTime() is NaN, and every `<`
 * comparison against NaN is false, which would make isPreRule() silently
 * exempt nothing rather than erroring.
 */
export function parseRuleEffectiveDate(value) {
  if (value == null) return RULE_EFFECTIVE_DATE;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--rule-effective-date: could not parse "${value}" as a date`);
  }
  return parsed;
}

/**
 * Returns true when the issue was created before the routing-rationale rule
 * took effect, so no routing/{id} record is owed regardless of whether a
 * routing decision was made (AUR-4006). The boundary is INCLUSIVE of the
 * rule date: an issue created exactly at ruleEffectiveDate was created the
 * instant the rule was already in force, so rationale is owed for it — this
 * uses strict `<`, not `<=`.
 */
export function isPreRule(issue, ruleEffectiveDate = RULE_EFFECTIVE_DATE) {
  if (!issue?.createdAt) return false;
  const created = new Date(issue.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  return created.getTime() < ruleEffectiveDate.getTime();
}

/**
 * The CEO routes virtually all high/critical work, so it is the correct default
 * owner for a routing-rationale gap when the target issue does not name an
 * assigning agent.
 */
export const CEO_AGENT_ID = '3823a155-b4d4-4b06-b7d3-b3a55c6cbc1b';

/**
 * Resolve the agent that owes the routing/{id} rationale for a gap, i.e. the
 * manager/router that assigned the underlying issue. Gap issues filed without
 * an assignee become orphans that no agent ever picks up (AUR-1817/AUR-1818),
 * so this MUST always return a non-null agentId.
 *
 * Preference order:
 *   1. The target issue's creator (`createdByAgentId`) — the agent that filed
 *      and routed it, hence owes its rationale.
 *   2. The CEO — high/critical routing is almost always CEO-routed, and the
 *      board fallback guarantees no orphan even when the creator is a user or
 *      unknown.
 *
 * @param {{ createdByAgentId?: string|null, assigneeAgentId?: string|null }} issue
 * @returns {{ agentId: string, source: string }}
 */
export function resolveGapOwner(issue) {
  const creator = issue?.createdByAgentId;
  if (typeof creator === 'string' && creator.length > 0) {
    return { agentId: creator, source: 'target.createdByAgentId' };
  }
  return { agentId: CEO_AGENT_ID, source: 'fallback:CEO' };
}

/**
 * `titlePrefix` is a true PREFIX match server-side, so a short identifier
 * collides with longer ones that merely start with it: `titlePrefix=routing/
 * AUR-27` also matches `routing/AUR-2756`, `routing/AUR-2749`, etc. With
 * `limit=1` the first (arbitrary) hit could be one of those collisions, so
 * the watchdog would report "found" for a record that doesn't actually exist
 * (AUR-3855 — the same class of wrong-question lookup bug AUR-3852 fixed for
 * org/project scope). Fetch a generous batch under the prefix and assert an
 * EXACT `title === 'routing/{targetId}'` match client-side — never
 * `startsWith`.
 */
export const ROUTING_RECORD_LOOKUP_LIMIT = 50;

function extractRecords(response) {
  return Array.isArray(response) ? response : (response?.records ?? []);
}

/**
 * A routing rationale is keyed either `routing/{issueId}` (legacy flat shape)
 * or `routing/{issueId}/{ownerId}` (forward shape — one row per decider, so a
 * re-route records the new owner's rationale without clobbering the previous
 * owner's). BOTH satisfy AGENTS.md §12, so the watchdog must accept both or a
 * re-routed issue reads as an unrouted gap forever (AUR-4280).
 *
 * Accept an exact match, or a match under the `{exact}/` boundary — never a
 * bare `startsWith(exact)`, which would let `routing/AUR-2756` satisfy a lookup
 * for `routing/AUR-27` (the AUR-3855 collision class this guard exists to stop).
 */
export function matchesRoutingKey(title, targetId) {
  if (typeof title !== 'string') return false;
  const exact = `routing/${targetId}`;
  return title === exact || title.startsWith(`${exact}/`);
}

/** Epoch millis for ordering, with unparseable/missing timestamps sorting oldest. */
function createdAtMillis(record) {
  const parsed = new Date(record?.createdAt ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Picks the operative rationale among the rows matching an issue. Several rows
 * legitimately coexist: a legacy flat `routing/{id}` alongside a new
 * `routing/{id}/{ownerId}`, or one row per decider after a re-route. Resolve by
 * `max(createdAt)` — the most recent routing decision is the operative one.
 *
 * Deliberately NOT resolved by "does the record's `chosen_agent` equal the
 * issue's CURRENT assignee": that reports a gap on every re-route, because the
 * pre-route owner's row is the only one an assignee-matched read can see. That
 * mismatch IS the AUR-4280 defect.
 *
 * Returns null when nothing matches.
 */
export function pickNewestRoutingRecord(records, targetId) {
  const matches = extractRecords(records).filter(r => matchesRoutingKey(r?.title, targetId));
  if (matches.length === 0) return null;
  return matches.reduce((best, r) => (createdAtMillis(r) > createdAtMillis(best) ? r : best));
}

/**
 * The Paperclip memory list route returns ONLY org-scoped records unless
 * `projectId=<uuid>` is passed. A `routing/{id}` record captured with
 * `scope.projectId` (per AGENTS.md § "Routing rationale capture
 * (enforcement)") is therefore invisible to an org-wide
 * query alone. Query org scope first (cheap, covers the common case), then
 * fall back to a project-scoped query only when the target issue has a
 * `projectId` and the org query missed — this avoids a wasted second call for
 * the (majority) org-scoped/no-project case. Either scope hitting counts as
 * "found": the rationale exists, it was just written to a narrower scope.
 *
 * @param {{ companyId: string, targetId: string, projectId?: string|null, apiGet: (path: string) => Promise<any> }} opts
 * @returns {Promise<{ found: boolean, scope: 'org'|'project'|null, record: object|null }>}
 */
export async function lookupRoutingRecord({ companyId, targetId, projectId, apiGet }) {
  const orgRecords = await apiGet(
    `/api/companies/${companyId}/memory/records?titlePrefix=routing/${targetId}&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`
  );
  const orgWinner = pickNewestRoutingRecord(orgRecords, targetId);
  if (orgWinner) {
    return { found: true, scope: 'org', record: orgWinner };
  }

  if (projectId) {
    const projectRecords = await apiGet(
      `/api/companies/${companyId}/memory/records?titlePrefix=routing/${targetId}&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=${projectId}`
    );
    const projectWinner = pickNewestRoutingRecord(projectRecords, targetId);
    if (projectWinner) {
      return { found: true, scope: 'project', record: projectWinner };
    }
  }

  return { found: false, scope: null, record: null };
}

// ── API helpers ───────────────────────────────────────────────────────────────

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Probe an endpoint for availability. Returns { available: false } on 404
   * (Memory routes not mounted). Throws for all other non-ok statuses.
   */
  async function apiProbe(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (res.status === 404) return { available: false };
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return { available: true };
  }

  async function apiPatch(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  return { apiGet, apiProbe, apiPatch, apiPost };
}

// ── Main routine ──────────────────────────────────────────────────────────────

/**
 * Status filter for the working-issue fetch. MUST include `backlog`: flags
 * filed by Phase B (and any other issue) default to `backlog` status server-side
 * (services/issues.ts: `status: values.status ?? "backlog"`). If `backlog` is
 * omitted here, Phase A never sees stale backlog flags (they never auto-resolve)
 * and Phase B never counts them as open (it files duplicates). See AUR-1581.
 */
export const ISSUE_STATUS_FILTER = 'backlog,todo,in_progress,in_review,blocked';

/**
 * Safety cap on pagination: 50 pages * 500/page = 25,000 issues. A real run
 * should never get near this; it exists so a pagination bug degrades to a
 * loud warning (population undercounted) instead of an infinite loop.
 */
export const FETCH_ALL_ISSUES_MAX_PAGES = 50;

/**
 * Pages through the issues LIST endpoint with `limit`/`offset` until a short
 * page is returned, instead of a single `limit=500` fetch. A single fetch is
 * a silent cliff: it happens to fit today (open-only is 146 issues, well
 * under 500) but truncates without warning the moment the matched set grows
 * past the page size — and the full-population scan below can match
 * thousands (AUR-3994/AUR-3987a). `status` is passed through verbatim
 * (comma-joined list, or omitted entirely to fetch every status).
 *
 * @param {{ companyId: string, apiGet: (path: string) => Promise<any>, status?: string|null, pageSize?: number }} opts
 * @returns {Promise<object[]>}
 */
export async function fetchAllIssues({ companyId, apiGet, status = null, pageSize = 500 }) {
  const all = [];
  let offset = 0;
  const statusParam = status ? `&status=${status}` : '';
  for (let page = 0; page < FETCH_ALL_ISSUES_MAX_PAGES; page++) {
    const batch = await apiGet(
      `/api/companies/${companyId}/issues?limit=${pageSize}${statusParam}&offset=${offset}`
    );
    const rows = Array.isArray(batch) ? batch : (batch?.issues ?? []);
    all.push(...rows);
    if (rows.length < pageSize) return all;
    offset += pageSize;
  }
  console.error(
    `  WARNING: fetchAllIssues hit the ${FETCH_ALL_ISSUES_MAX_PAGES}-page safety cap ` +
    `(offset=${offset}) — population may be undercounted. Investigate before trusting this run's counts.`
  );
  return all;
}

/**
 * Extracts the HTTP status code apiPatch/apiPost embed in their thrown error
 * message (`METHOD path → STATUS statusText`), falling back to 'unknown' for
 * network-level failures that never reached a response.
 */
export function extractStatusCode(errorMessage) {
  const match = /→\s*(\d+)/.exec(errorMessage ?? '');
  return match ? match[1] : 'unknown';
}

/**
 * Runs one mutation (a cancel or a file) in isolation: a failure — most
 * commonly a 409 from a stale checkout lock on the target issue (see
 * ops_stale_checkout_lock_after_transient_retry) — is logged and recorded,
 * not thrown, so one locked/conflicting issue never aborts the rest of the
 * run (AUR-3855). `label` identifies the mutation for the run summary.
 */
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

// ── Phase B v2: rolling gap-aggregate issue ──────────────────────────────────

/** Title prefix for the rolling daily gap-aggregate issue. */
export const ROLLING_ISSUE_TITLE_PREFIX = 'routing-rationale gaps — ';

/** Search across every status so a same-day auto-closed rolling issue is still found (and reopened if needed). */
export const ROLLING_ISSUE_ALL_STATUSES = 'backlog,todo,in_progress,in_review,blocked,done,cancelled';

export function rollingIssueTitle(dateKey) {
  return `${ROLLING_ISSUE_TITLE_PREFIX}${dateKey}`;
}

/** UTC date key (YYYY-MM-DD) — stable across a single day regardless of firing time. */
export function todayDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Renders the rolling issue body from the current outstanding open-gap list.
 * `maxListed` bounds how many individual gaps are named (anti-flood guard);
 * anything beyond that is summarized as a held-back count, never silently
 * dropped. `closedGapCount` (from the full-population measurement) is
 * surfaced for visibility only — those gaps are unrecoverable and never
 * listed individually here. `preruleCount` (AUR-4006) is the count of
 * issues excluded from the eligible pool entirely because they predate
 * RULE_EFFECTIVE_DATE — also report-only, so the compliance number never
 * silently shrinks without an explanation of why.
 */
export function buildRollingIssueBody(missingOpen, { maxListed, closedGapCount, preruleCount = 0, ruleEffectiveDate = RULE_EFFECTIVE_DATE }) {
  const listed = missingOpen.slice(0, maxListed);
  const held = missingOpen.length - listed.length;
  const lines = [
    '## Routing-rationale gaps — outstanding',
    '',
    `${missingOpen.length} open eligible issue(s) currently missing a \`routing/{id}\` rationale record.`,
    '',
  ];
  if (listed.length === 0) {
    lines.push('_No outstanding open gaps._');
  } else {
    for (const issue of listed) {
      const id = issue.identifier ?? issue.id;
      const owner = resolveGapOwner(issue);
      lines.push(
        `- **${id}** (\`${issue.priority}\`, assignee \`${issue.assigneeAgentId}\`) — "${issue.title}" — rationale owed by \`${owner.agentId}\` (${owner.source})`
      );
    }
  }
  if (held > 0) {
    lines.push('', `_...and ${held} more held back by the anti-flood cap (max-listed=${maxListed}). Re-run once the list drains to surface the rest._`);
  }
  if (closedGapCount > 0) {
    lines.push(
      '',
      `${closedGapCount} additional gap(s) exist on already-closed (done/cancelled) issues. Their rationale is unrecoverable, so they are intentionally NOT listed or filed here — see the watchdog run's console summary for the list.`
    );
  }
  if (preruleCount > 0) {
    lines.push(
      '',
      `${preruleCount} additional issue(s) were excluded from the eligible pool entirely: created before the routing-rationale rule took effect (${ruleEffectiveDate.toISOString()}, commit b78456e6/AUR-2301), so no routing/{id} record is owed or ever demanded for them (AUR-4006).`
    );
  }
  lines.push(
    '',
    'The manager that assigned each issue above must capture a `routing/{id}` rationale record per AGENTS.md § "Routing rationale capture (enforcement)".',
    '',
    'This issue is rewritten in place every watchdog run and auto-closes once the list empties.',
    '',
    'exec.preflight: skip',
    'exec.routing-rationale: skip',
  );
  return lines.join('\n');
}

/** Finds today's rolling issue by exact title match (search is a loose ILIKE contains — assert exact client-side, same pattern as lookupRoutingRecord). */
export async function findRollingIssue({ companyId, apiGet, title }) {
  const results = await apiGet(
    `/api/companies/${companyId}/issues?q=${encodeURIComponent(title)}&status=${ROLLING_ISSUE_ALL_STATUSES}&limit=20`
  );
  const rows = Array.isArray(results) ? results : (results?.issues ?? []);
  return rows.find(issue => issue.title === title) ?? null;
}

/**
 * Find-or-create + rewrite-in-place for the rolling gap issue, replacing the
 * old one-issue-per-gap filing. Priority is deliberately 'medium' (not
 * high/critical) so the rolling issue never becomes a routing-rationale
 * target of itself.
 */
async function syncRollingGapIssue({
  companyId, apiGet, apiPatch, apiPost, apply, missingOpen, closedGapCount, preruleCount, ruleEffectiveDate, maxListed, dateKey, failedMutations,
}) {
  const title = rollingIssueTitle(dateKey);
  const existing = await findRollingIssue({ companyId, apiGet, title });
  const body = buildRollingIssueBody(missingOpen, { maxListed, closedGapCount, preruleCount, ruleEffectiveDate });

  if (missingOpen.length === 0) {
    if (existing && !['done', 'cancelled'].includes(existing.status)) {
      console.log(`  ROLLING-ISSUE: CLOSE ${existing.identifier ?? existing.id} — no outstanding open gaps.`);
      if (apply) {
        const ok = await runMutation(
          `close rolling issue ${existing.identifier ?? existing.id}`,
          async () => {
            await apiPatch(`/api/issues/${existing.id}`, { status: 'done' });
            await apiPost(`/api/issues/${existing.id}/comments`, {
              body: 'Auto-closed by routing-rationale-watchdog: no outstanding open gaps.',
            });
          },
          failedMutations,
        );
        if (ok) console.log('    → closed.');
      }
      return { action: 'close', issue: existing };
    }
    console.log('  ROLLING-ISSUE: no outstanding open gaps, nothing to sync.');
    return { action: 'none', issue: existing };
  }

  if (existing) {
    console.log(`  ROLLING-ISSUE: UPDATE ${existing.identifier ?? existing.id} (${missingOpen.length} outstanding).`);
    if (apply) {
      const patch = { description: body };
      if (['done', 'cancelled'].includes(existing.status)) patch.status = 'todo';
      const ok = await runMutation(
        `update rolling issue ${existing.identifier ?? existing.id}`,
        async () => { await apiPatch(`/api/issues/${existing.id}`, patch); },
        failedMutations,
      );
      if (ok) console.log('    → updated.');
    }
    return { action: 'update', issue: existing };
  }

  console.log(`  ROLLING-ISSUE: FILE "${title}" (${missingOpen.length} outstanding) → owner ${CEO_AGENT_ID}.`);
  if (apply) {
    const ok = await runMutation(
      `file rolling issue ${title}`,
      async () => {
        await apiPost(`/api/companies/${companyId}/issues`, {
          title,
          description: body,
          status: 'todo',
          priority: 'medium',
          assigneeAgentId: CEO_AGENT_ID,
        });
      },
      failedMutations,
    );
    if (ok) console.log('    → filed.');
  }
  return { action: 'file', issue: null };
}

export async function main({ windowMinutes, apply, apiUrl, apiKey, companyId, maxNewFlags = 20, now = new Date(), ruleEffectiveDate = RULE_EFFECTIVE_DATE }) {
  // windowMinutes is accepted for CLI back-compat with the existing routine
  // invocation but is no longer used to filter anything — the full-
  // population measurement pass below scans every status every run instead
  // (AUR-3994/AUR-3987a: window-based filtering was the root cause of the
  // ~2% detection rate).
  void windowMinutes;

  console.log(`Rule effective date: ${ruleEffectiveDate.toISOString()} (routing decisions created before this are exempt — commit b78456e6/AUR-2301, AUR-4006). Override with --rule-effective-date.\n`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiProbe, apiPatch, apiPost } = makeApiHelpers(apiUrl, headers);

  // The issues LIST endpoint truncates descriptions, which can hide the
  // exemption token. Re-fetch the full issue (cached) only when the
  // list-fetched description is long enough to possibly be truncated.
  const fullDescCache = new Map();
  async function withFullDescription(issue) {
    if (!mayBeTruncated(issue.description)) return issue;
    const key = issue.id ?? issue.identifier;
    if (!fullDescCache.has(key)) {
      const full = await apiGet(`/api/issues/${key}`);
      fullDescCache.set(key, full?.description ?? issue.description ?? '');
    }
    return { ...issue, description: fullDescCache.get(key) };
  }

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  // ── Memory API availability probe (must pass before any mutation) ──────────
  // A 404 here means the server process is stale and /memory routes are not
  // mounted. Abort immediately — proceeding would either crash mid-Phase-A or
  // silently skip all checks and exit 0 (false "clean"). Exit 3 so the
  // routine/heartbeat surfaces an honest BLOCKED signal.
  const memProbe = await apiProbe(`/api/companies/${companyId}/memory/records?limit=1`);
  if (!memProbe.available) {
    console.error('BLOCKED: Memory API unavailable — watchdog cannot run.');
    console.error('  /api/companies/:id/memory/records → 404 Not Found');
    console.error('  Root cause: stale server process without memory routes mounted.');
    console.error('  Resolution: operator must rebuild and restart the Paperclip server.');
    return 3;
  }

  // Fetch all open issues once, paginated — used by Phase A and to dedupe
  // Phase B's rolling issue against still-valid legacy flags.
  const rawIssues = await fetchAllIssues({ companyId, apiGet, status: ISSUE_STATUS_FILTER });

  // Build lookup by identifier
  const issueByIdentifier = new Map();
  for (const issue of rawIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue);
  }

  // ── Phase A: Auto-resolve stale flags ──────────────────────────────────────
  console.log('── Phase A: Auto-resolve stale flags ──');

  const flagIssues = rawIssues.filter(issue => FLAG_REGEX.test(issue.title ?? ''));
  const openFlagTargets = new Set(); // target identifiers with still-valid open flags

  const toCancel = [];
  // Tracks routing/{id} records only visible via a project-scoped lookup —
  // surfaced in the summary so the org/project scoping drift stays visible
  // rather than being silently papered over (AUR-3852).
  const projectScopedHits = [];
  // Per-mutation failures (e.g. a 409 from a stale checkout lock) — collected
  // rather than thrown so one bad issue never aborts the rest of the run
  // (AUR-3855). Surfaced in the run summary with issue id + status code.
  const failedMutations = [];

  for (const flag of flagIssues) {
    const match = FLAG_REGEX.exec(flag.title);
    if (!match) continue;
    const targetId = match[1];
    const rawTarget = issueByIdentifier.get(targetId) ?? null;
    const target = rawTarget ? await withFullDescription(rawTarget) : null;

    // Check routing record only when target is open and non-exempt. Uses
    // isExemptForResolvedFlag (not isExempt) so a handback-to-creator
    // reassignment doesn't short-circuit the lookup via the self-assigned
    // rule — we still need to know whether the rationale was captured (AUR-3854).
    let hasRecord = false;
    let recordScope = null;
    if (
      target && !['done', 'cancelled'].includes(target.status) &&
      !isExemptForResolvedFlag(target) && !isPreRule(target, ruleEffectiveDate)
    ) {
      const lookup = await lookupRoutingRecord({
        companyId, targetId, projectId: target.projectId, apiGet,
      });
      hasRecord = lookup.found;
      recordScope = lookup.scope;
    }

    if (recordScope === 'project') {
      projectScopedHits.push({ targetId, source: 'phase-a' });
    }

    const cancelReason = resolveCancelReason({ target, targetId, hasRecord, recordScope, ruleEffectiveDate });

    if (cancelReason) {
      toCancel.push({ flag, targetId, reason: cancelReason });
    } else {
      openFlagTargets.add(targetId);
    }
  }

  if (toCancel.length === 0) {
    console.log('  No stale flags to resolve.\n');
  } else {
    for (const { flag, targetId, reason } of toCancel) {
      const flagId = flag.id ?? flag.identifier;
      const flagLabel = flag.identifier ?? flagId;
      console.log(`  CANCEL ${flagLabel} → ${targetId}: ${reason}`);
      if (apply) {
        const ok = await runMutation(
          `cancel ${flagLabel} (target ${targetId})`,
          async () => {
            await apiPatch(`/api/issues/${flagId}`, { status: 'cancelled' });
            await apiPost(`/api/issues/${flagId}/comments`, { body: reason });
          },
          failedMutations,
        );
        if (ok) console.log(`    → cancelled + commented.`);
      }
    }
    console.log();
  }

  if (openFlagTargets.size > 0) {
    console.log(`  Keeping ${openFlagTargets.size} flag(s) still valid: ${[...openFlagTargets].join(', ')}\n`);
  }

  // ── Full-population measurement (paginated, ALL statuses) ──────────────────
  // Fixes the AUR-3994/AUR-3987a blind spot: the old Phase B only ever looked
  // at the open-status working set within a recency window, so a gap that
  // closed between 6h fires was never counted. Scan every high/critical
  // assigned manual-routing issue the company has ever had instead.
  console.log('── Full-population measurement (all statuses, paginated) ──');

  const allIssuesEver = await fetchAllIssues({ companyId, apiGet, status: null });

  const priorityPool = allIssuesEver.filter(issue =>
    ['high', 'critical'].includes(issue.priority) && issue.assigneeAgentId
  );
  // Hydrate full descriptions only for the (bounded) priority pool so the
  // exemption token isn't missed due to list-endpoint truncation, without
  // paying that cost for the entire company's issue history.
  const hydratedPool = await Promise.all(priorityPool.map(withFullDescription));

  // AUR-4006: split the old single "exempt" bucket into WHY an issue is
  // exempt. exempt_nondecision covers the AUR-3994 reasons (no routing
  // decision made, skip-token, content-slot, daily-brief, sign-off gate).
  // exempt_prerule is new: a genuine routing decision that predates
  // RULE_EFFECTIVE_DATE, for which a faithful record is unrecoverable. Order
  // matters — a pre-rule issue that also happens to match a classic
  // exemption is counted once, under exempt_nondecision, not double-counted.
  const exemptNondecision = [];
  const exemptPrerule = [];
  const eligible = [];
  for (const issue of hydratedPool) {
    if (isExempt(issue)) {
      exemptNondecision.push(issue);
    } else if (isPreRule(issue, ruleEffectiveDate)) {
      exemptPrerule.push(issue);
    } else {
      eligible.push(issue);
    }
  }

  const missing = [];
  let hasRecordCount = 0;
  await Promise.all(eligible.map(async (issue) => {
    const id = issue.identifier ?? issue.id;
    const lookup = await lookupRoutingRecord({
      companyId, targetId: id, projectId: issue.projectId, apiGet,
    });
    if (lookup.found) {
      hasRecordCount += 1;
      if (lookup.scope === 'project') projectScopedHits.push({ targetId: id, source: 'measurement' });
    } else {
      missing.push(issue);
    }
  }));

  const missingClosed = missing.filter(issue => ['done', 'cancelled'].includes(issue.status));
  // Of the still-open missing gaps, exclude any target that already has a
  // still-valid open legacy per-gap flag (Phase A kept it) — otherwise the
  // same gap would be reported twice (once via the legacy flag, once via the
  // rolling issue).
  const missingOpenAll = missing.filter(issue => !['done', 'cancelled'].includes(issue.status));
  const missingOpenDedupSkipped = missingOpenAll.filter(issue => openFlagTargets.has(issue.identifier ?? issue.id));
  const missingOpen = missingOpenAll.filter(issue => !openFlagTargets.has(issue.identifier ?? issue.id));

  // Real post-cutoff compliance rate: `eligible` already excludes both
  // exempt_nondecision and exempt_prerule, so this is the only number that
  // means anything post-AUR-4006 — the board should never be shown the
  // pre-cutoff eligible/have-record ratio again.
  const complianceRate = eligible.length > 0 ? hasRecordCount / eligible.length : 1;

  console.log(`  Total issues scanned:  ${allIssuesEver.length}`);
  console.log(`  Priority pool (high/critical, assigned): ${hydratedPool.length}`);
  console.log(`  Exempt (no routing decision / skip-token / content-slot / daily-brief / sign-off): ${exemptNondecision.length}`);
  console.log(`  Exempt (created before rule effective date ${ruleEffectiveDate.toISOString()}, unrecoverable — AUR-4006): ${exemptPrerule.length}`);
  console.log(`  Eligible (post-rule, routing decision made): ${eligible.length}`);
  console.log(`  Have routing/{id} record: ${hasRecordCount}`);
  console.log(`  Missing:                ${missing.length} (open: ${missingOpenAll.length}, closed/unrecoverable: ${missingClosed.length})`);
  console.log(`  True post-cutoff compliance rate: ${(complianceRate * 100).toFixed(1)}% (${hasRecordCount}/${eligible.length} post-rule eligible issues have a routing/{id} record)`);
  console.log(`  pool=${hydratedPool.length} eligible=${eligible.length} exempt_nondecision=${exemptNondecision.length} exempt_prerule=${exemptPrerule.length} have_record=${hasRecordCount} missing_open=${missingOpenAll.length} missing_closed=${missingClosed.length}`);
  if (missingOpenDedupSkipped.length > 0) {
    console.log(`  SKIPPED-DEDUP — open legacy flag already covers this target (${missingOpenDedupSkipped.length}):`);
    for (const issue of missingOpenDedupSkipped) {
      console.log(`    - ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
  }
  if (missingClosed.length > 0) {
    console.log(`  CLOSED GAPS (unrecoverable — counted here only, never filed):`);
    for (const issue of missingClosed) {
      console.log(`    - ${issue.identifier ?? issue.id} (${issue.status}): ${issue.title}`);
    }
  }
  console.log();

  // ── Phase B: Sync rolling gap-aggregate issue (open gaps only) ─────────────
  console.log('── Phase B: Sync rolling gap-aggregate issue ──');

  const dateKey = todayDateKey(now);
  const rollingResult = await syncRollingGapIssue({
    companyId, apiGet, apiPatch, apiPost, apply,
    missingOpen, closedGapCount: missingClosed.length,
    preruleCount: exemptPrerule.length, ruleEffectiveDate,
    maxListed: maxNewFlags, dateKey, failedMutations,
  });
  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('── Summary ──');
  console.log(`  Legacy flags resolved: ${toCancel.length}`);
  console.log(`  pool=${hydratedPool.length} eligible=${eligible.length} exempt_nondecision=${exemptNondecision.length} exempt_prerule=${exemptPrerule.length} have_record=${hasRecordCount} missing_open=${missingOpenAll.length} missing_closed=${missingClosed.length}`);
  console.log(`  True post-cutoff compliance rate: ${(complianceRate * 100).toFixed(1)}%`);
  console.log(`  Missing open (listed in rolling issue): ${missingOpen.length}`);
  console.log(`  Missing closed (unrecoverable, report-only): ${missingClosed.length}`);
  console.log(`  Rolling issue action: ${rollingResult.action}`);
  console.log(`  Project-scoped hits (hidden from org reads): ${projectScopedHits.length}`);
  console.log(`  Failed:        ${failedMutations.length}`);
  if (failedMutations.length > 0) {
    for (const { label, status } of failedMutations) {
      console.log(`    - ${label} → ${status}`);
    }
    console.log(`  Re-run the watchdog to retry the above (idempotent).`);
  }

  const hasPendingActions = toCancel.length > 0 || rollingResult.action !== 'none';
  if (!apply && hasPendingActions) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above actions.');
    return 1;
  }

  // Every intended mutation failed this run — nothing was accomplished, so
  // surface it distinctly from the normal "some things failed, rest went
  // through" case (which still exits 0; see Failed count above) (AUR-3855).
  const attemptedMutations = apply ? toCancel.length + (rollingResult.action !== 'none' ? 1 : 0) : 0;
  if (attemptedMutations > 0 && failedMutations.length === attemptedMutations) {
    console.log('\nERROR: every intended mutation failed this run — see Failed list above.');
    return 4;
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Run only when invoked directly (not imported by tests)
const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      'window-minutes': { type: 'string', default: '1440' },
      'max-new-flags': { type: 'string', default: '20' },
      'rule-effective-date': { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/check-routing-rationale.mjs [--window-minutes N] [--max-new-flags N] [--rule-effective-date ISO_DATE] [--apply]');
    console.log('  --window-minutes N       Accepted for CLI back-compat; NO LONGER USED (AUR-3994 — the');
    console.log('                           measurement pass now scans the full population every run,');
    console.log('                           not just issues updated within a window).');
    console.log('  --max-new-flags N        Cap how many outstanding gaps are individually listed in the');
    console.log('                           rolling gap-aggregate issue body (default: 20, anti-flood guard).');
    console.log('  --rule-effective-date D  ISO 8601 date/time. Routing decisions created before this are');
    console.log('                           exempt — no rationale is owed for them (default: 2026-06-15T00:00:00Z,');
    console.log('                           commit b78456e6/AUR-2301, AUR-4006). The boundary is inclusive of');
    console.log('                           the date itself: an issue created exactly at this instant IS owed a');
    console.log('                           rationale.');
    console.log('  --apply                  Execute changes (default: dry-run, exit 1 if actions pending)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  let ruleEffectiveDate;
  try {
    ruleEffectiveDate = parseRuleEffectiveDate(args['rule-effective-date']);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }

  resolveApiBase().then(API_URL => main({
    windowMinutes: parseInt(args['window-minutes'], 10),
    maxNewFlags: parseInt(args['max-new-flags'], 10),
    apply: args.apply,
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
    ruleEffectiveDate,
  })).then(code => process.exit(code)).catch(err => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
