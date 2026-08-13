import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasNoBlocker,
  gradeBlockedIssue,
  hoursSince,
  FLAG_REGEX,
  flagTitle,
  resolveCancelReason,
  resolveFlagOwner,
  hasPendingInteractionInList,
  CEO_AGENT_ID,
  HUMAN_GATED_TOKEN,
  WATCHDOG_ROUTINE_ID,
  WATCHDOG_ROUTINE_TITLE,
  isOwnOutput,
  isRoutineDispatchUmbrella,
  UMBRELLA_FLAG_TITLE_PREFIX,
  UMBRELLA_FLAG_SEARCH_STATUSES,
  buildUmbrellaFlagTitle,
  buildUmbrellaFlagDescription,
  findOpenUmbrellaFlag,
  DEFAULT_MAX_FLAGS_PER_RUN,
  resolveMaxFlagsPerRun,
  ISSUE_STATUS_FILTER,
  ROUTINE_EXECUTION_STALE_HOURS,
  NON_TERMINAL_STATUSES,
  isStrandedRoutineExecution,
  extractSourceIssueRef,
  STRANDED_ROUTINE_FLAG_REGEX,
  strandedRoutineFlagTitle,
  buildStrandedRoutineFlagDescription,
  resolveStrandedRoutineCancelReason,
  STRANDED_ROUTINE_FLAG_CAP,
  main,
} from './check-stalled-blocked.mjs';

// ── hasNoBlocker ──────────────────────────────────────────────────────────────

test('hasNoBlocker: true when needs_attention with zero unresolved blockers', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
  }), true);
});

test('hasNoBlocker: false — AUR-4032 sanity check (real covered blocker)', () => {
  // Matches the live AUR-4032 shape: state "covered" with 1 real blocker.
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'covered', reason: 'active_dependency', unresolvedBlockerCount: 1 },
  }), false);
});

test('hasNoBlocker: false when needs_attention but a real blocker itself needs attention', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 1, attentionBlockerCount: 1 },
  }), false);
});

test('hasNoBlocker: false when blockerAttention is absent', () => {
  assert.equal(hasNoBlocker({}), false);
});

test('hasNoBlocker: false for state "stalled" (a blocker chain is itself stalled, not "no blocker")', () => {
  assert.equal(hasNoBlocker({
    blockerAttention: { state: 'stalled', unresolvedBlockerCount: 1 },
  }), false);
});

// ── gradeBlockedIssue ─────────────────────────────────────────────────────────

test('gradeBlockedIssue: stalled by default', () => {
  assert.equal(gradeBlockedIssue({ title: 'Refactor the widget factory', description: 'no reason given' }), 'stalled');
});

test('gradeBlockedIssue: human-gated via founder-gate title (AUR-2209 shape)', () => {
  assert.equal(gradeBlockedIssue({
    title: 'Founder gate: send ONE WhatsApp message to +1555... from your own phone',
    description: '',
  }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via identity docs (AUR-3945 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Verify business identity docs', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via recovery codes (AUR-2162 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Obtain 2FA recovery codes for X', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via payment rail (AUR-1879 shape)', () => {
  assert.equal(gradeBlockedIssue({ title: 'Set up payment rail for vendor Y', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via [alex@]/[board@] inbox marker', () => {
  assert.equal(gradeBlockedIssue({ title: '[alex@] approve renewal', description: '' }), 'human-gated');
});

test('gradeBlockedIssue: human-gated via explicit opt-out token', () => {
  assert.equal(gradeBlockedIssue({
    title: 'Some ordinary-looking title',
    description: `blah blah\n${HUMAN_GATED_TOKEN}\nmore text`,
  }), 'human-gated');
});

test('gradeBlockedIssue: does not false-positive on "manual" alone', () => {
  assert.equal(gradeBlockedIssue({ title: 'Write the manual test plan', description: '' }), 'stalled');
});

// ── hoursSince ────────────────────────────────────────────────────────────────

test('hoursSince: computes elapsed hours against a fixed now', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  assert.equal(hoursSince('2026-07-26T06:00:00Z', now), 6);
});

// ── flagTitle / FLAG_REGEX round-trip ────────────────────────────────────────

test('flagTitle + FLAG_REGEX: stalled title round-trips the target identifier', () => {
  const title = flagTitle('AUR-3347', 'stalled');
  assert.match(title, /^stalled-blocked:/);
  const match = FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-3347');
});

test('flagTitle + FLAG_REGEX: human-gated title round-trips the target identifier', () => {
  const title = flagTitle('AUR-3945', 'human-gated');
  assert.match(title, /^stalled-blocked-mismodelled:/);
  const match = FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-3945');
});

test('FLAG_REGEX: does not match unrelated titles', () => {
  assert.equal(FLAG_REGEX.test('Refactor the widget factory'), false);
});

// ── resolveCancelReason (Phase A auto-resolve) ───────────────────────────────

test('resolveCancelReason: null (stays open) when target is still blocked with no blocker', () => {
  const target = { status: 'blocked', blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 } };
  assert.equal(resolveCancelReason({ target, targetId: 'AUR-3347' }), null);
});

test('resolveCancelReason: cancels when target is done', () => {
  const target = { status: 'done' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /is done/);
});

test('resolveCancelReason: cancels when target is cancelled', () => {
  const target = { status: 'cancelled' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /is cancelled/);
});

test('resolveCancelReason: cancels when target is missing entirely', () => {
  const reason = resolveCancelReason({ target: null, targetId: 'AUR-3347' });
  assert.match(reason, /not found/);
});

test('resolveCancelReason: cancels when target moved off blocked (e.g. re-armed to todo)', () => {
  const target = { status: 'todo' };
  const reason = resolveCancelReason({ target, targetId: 'AUR-3347' });
  assert.match(reason, /no longer `blocked`/);
});

test('resolveCancelReason: cancels when target now has a real blocker attached', () => {
  const target = { status: 'blocked', blockerAttention: { state: 'covered', unresolvedBlockerCount: 1 } };
  const reason = resolveCancelReason({ target, targetId: 'AUR-4032' });
  assert.match(reason, /now has a real blocker/);
});

// ── hasPendingInteractionInList (AUR-4275) ───────────────────────────────────

test('hasPendingInteractionInList: true when a pending interaction is present (AUR-1879 shape)', () => {
  assert.equal(hasPendingInteractionInList([
    { id: '41e09620-0c34-4ccc-a2ea-74743e0f47b3', kind: 'request_confirmation', status: 'pending' },
  ]), true);
});

test('hasPendingInteractionInList: false when interactions exist but none are pending', () => {
  assert.equal(hasPendingInteractionInList([
    { kind: 'ask_user_questions', status: 'answered' },
    { kind: 'request_confirmation', status: 'accepted' },
  ]), false);
});

test('hasPendingInteractionInList: false for an empty list', () => {
  assert.equal(hasPendingInteractionInList([]), false);
});

test('hasPendingInteractionInList: handles a {items: [...]} wrapper response shape', () => {
  assert.equal(hasPendingInteractionInList({ items: [{ kind: 'ask_user_questions', status: 'pending' }] }), true);
});

// ── resolveFlagOwner ──────────────────────────────────────────────────────────

test('resolveFlagOwner: uses the target issue assignee when present', () => {
  assert.equal(resolveFlagOwner({ assigneeAgentId: 'agent-123' }), 'agent-123');
});

test('resolveFlagOwner: falls back to CEO when the target has no assignee', () => {
  assert.equal(resolveFlagOwner({ assigneeAgentId: null }), CEO_AGENT_ID);
});

// ── isOwnOutput / isRoutineDispatchUmbrella (AUR-5000 self-exclusion + grouping) ─

test('isOwnOutput: true for the watchdog\'s own routine dispatch umbrella (originKind + originId match)', () => {
  assert.equal(isOwnOutput({
    originKind: 'routine_execution',
    originId: WATCHDOG_ROUTINE_ID,
    title: 'Stalled-blocked watchdog',
  }), true);
});

test('isOwnOutput: false for a DIFFERENT routine\'s dispatch umbrella (same originKind, different originId)', () => {
  assert.equal(isOwnOutput({
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    title: 'Some other routine dispatch',
  }), false);
});

test('isOwnOutput: true for a stalled-blocked flag the watchdog previously filed (title match)', () => {
  assert.equal(isOwnOutput({
    originKind: 'manual',
    title: 'stalled-blocked: AUR-4932 blocked with no blocker',
  }), true);
});

test('isOwnOutput: true for a mismodelled flag the watchdog previously filed (title match)', () => {
  assert.equal(isOwnOutput({
    originKind: 'manual',
    title: 'stalled-blocked-mismodelled: AUR-4932 blocked with no blocker (human-gated)',
  }), true);
});

test('isOwnOutput: true for the exact watchdog routine title even without routine_execution origin', () => {
  assert.equal(isOwnOutput({ originKind: 'manual', title: WATCHDOG_ROUTINE_TITLE }), true);
});

test('isOwnOutput: false for an ordinary unrelated issue', () => {
  assert.equal(isOwnOutput({ originKind: 'manual', title: 'Refactor the widget factory' }), false);
});

test('isRoutineDispatchUmbrella: true for any routine_execution origin, not just this watchdog\'s', () => {
  assert.equal(isRoutineDispatchUmbrella({ originKind: 'routine_execution', originId: 'other-routine' }), true);
});

test('isRoutineDispatchUmbrella: false for a manually created issue', () => {
  assert.equal(isRoutineDispatchUmbrella({ originKind: 'manual' }), false);
});

// ── buildUmbrellaFlagTitle / buildUmbrellaFlagDescription ────────────────────

test('buildUmbrellaFlagTitle: uses the shared prefix and the count', () => {
  const title = buildUmbrellaFlagTitle(5);
  assert.equal(title, `${UMBRELLA_FLAG_TITLE_PREFIX} 5 routine dispatch umbrellas stranded blocked`);
});

test('buildUmbrellaFlagDescription: lists every member identifier, title, and age', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  const description = buildUmbrellaFlagDescription([
    { identifier: 'AUR-8001', title: 'Daily brief dispatch', updatedAt: '2026-07-26T06:00:00Z' },
    { identifier: 'AUR-8002', title: 'Deliverability dispatch', updatedAt: '2026-07-26T00:00:00Z' },
  ], now);
  assert.match(description, /AUR-8001/);
  assert.match(description, /Daily brief dispatch/);
  assert.match(description, /6h ago/);
  assert.match(description, /AUR-8002/);
  assert.match(description, /Deliverability dispatch/);
  assert.match(description, /12h ago/);
  assert.match(description, /exec\.routing-rationale: skip/);
});

// ── resolveMaxFlagsPerRun ─────────────────────────────────────────────────────

test('resolveMaxFlagsPerRun: defaults to DEFAULT_MAX_FLAGS_PER_RUN when unset', () => {
  assert.equal(resolveMaxFlagsPerRun({}), DEFAULT_MAX_FLAGS_PER_RUN);
});

test('resolveMaxFlagsPerRun: honours a valid MAX_FLAGS_PER_RUN override', () => {
  assert.equal(resolveMaxFlagsPerRun({ MAX_FLAGS_PER_RUN: '3' }), 3);
});

test('resolveMaxFlagsPerRun: falls back to the default on a non-numeric override', () => {
  assert.equal(resolveMaxFlagsPerRun({ MAX_FLAGS_PER_RUN: 'not-a-number' }), DEFAULT_MAX_FLAGS_PER_RUN);
});

test('resolveMaxFlagsPerRun: falls back to the default on a zero/negative override', () => {
  assert.equal(resolveMaxFlagsPerRun({ MAX_FLAGS_PER_RUN: '0' }), DEFAULT_MAX_FLAGS_PER_RUN);
  assert.equal(resolveMaxFlagsPerRun({ MAX_FLAGS_PER_RUN: '-1' }), DEFAULT_MAX_FLAGS_PER_RUN);
});

// ── findOpenUmbrellaFlag ──────────────────────────────────────────────────────

test('findOpenUmbrellaFlag: returns the matching issue when found by title prefix', async () => {
  const apiGet = async (path) => {
    assert.match(path, new RegExp(`q=${encodeURIComponent(UMBRELLA_FLAG_TITLE_PREFIX)}`));
    assert.match(path, new RegExp(`status=${UMBRELLA_FLAG_SEARCH_STATUSES}`));
    return [{ id: 'u1', identifier: 'AUR-9500', title: `${UMBRELLA_FLAG_TITLE_PREFIX} 4 routine dispatch umbrellas stranded blocked` }];
  };
  const result = await findOpenUmbrellaFlag({ companyId: 'c1', apiGet });
  assert.equal(result?.identifier, 'AUR-9500');
});

test('findOpenUmbrellaFlag: null when nothing matches the prefix', async () => {
  const apiGet = async () => [{ id: 'x', title: 'unrelated issue' }];
  const result = await findOpenUmbrellaFlag({ companyId: 'c1', apiGet });
  assert.equal(result, null);
});

test('findOpenUmbrellaFlag: handles a {issues: [...]} wrapper response shape', async () => {
  const apiGet = async () => ({ issues: [{ id: 'u1', title: `${UMBRELLA_FLAG_TITLE_PREFIX} 2 routine dispatch umbrellas stranded blocked` }] });
  const result = await findOpenUmbrellaFlag({ companyId: 'c1', apiGet });
  assert.equal(result?.id, 'u1');
});

// ── resolveCancelReason: own-output / routine-dispatch-umbrella targets (AUR-5000) ─

test('resolveCancelReason: auto-resolves a flag whose target is now the watchdog\'s own output', () => {
  const target = {
    status: 'blocked',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
    originKind: 'routine_execution',
    originId: WATCHDOG_ROUTINE_ID,
    title: 'Stalled-blocked watchdog',
  };
  const reason = resolveCancelReason({ target, targetId: 'AUR-4932' });
  assert.match(reason, /own output/);
});

test('resolveCancelReason: auto-resolves a flag whose target is now a routine dispatch umbrella', () => {
  const target = {
    status: 'blocked',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    title: 'Some other routine dispatch',
  };
  const reason = resolveCancelReason({ target, targetId: 'AUR-8001' });
  assert.match(reason, /aggregate umbrella flag/);
});

// ── extractSourceIssueRef (AUR-5634): title-only, 5 real fixtures ───────────

test('extractSourceIssueRef: extracts AUR-1300 from AUR-5425\'s real title', () => {
  assert.equal(extractSourceIssueRef({
    title: 'Weekly Google Workspace security audit (tryauranode.com) — AUR-1300',
  }), 'AUR-1300');
});

test('extractSourceIssueRef: extracts AUR-5366 from AUR-5430\'s real title', () => {
  assert.equal(extractSourceIssueRef({
    title: 'One-shot 2026-08-12: send PlumbSmart first contact (AUR-5366 pilot acquisition)',
  }), 'AUR-5366');
});

test('extractSourceIssueRef: extracts AUR-5356 from AUR-5416\'s real title', () => {
  assert.equal(extractSourceIssueRef({
    title: 'Telephony-gateway deploy-staleness watchdog — AUR-5356',
  }), 'AUR-5356');
});

test('extractSourceIssueRef: null for AUR-5424\'s real title (no reference)', () => {
  assert.equal(extractSourceIssueRef({ title: 'Etsy Aug-10 2026 kill-gate evaluation (one-shot)' }), null);
});

test('extractSourceIssueRef: null for AUR-5427\'s real title (no reference)', () => {
  assert.equal(extractSourceIssueRef({ title: 'Weekly Etsy Shop Operations — 2026-08-10' }), null);
});

test('extractSourceIssueRef: scans the title only, never the description (regression)', () => {
  // AUR-5424's real description mentions AUR-4510 and AUR-3263/AUR-3264 with no
  // clean single external source — scanning it would produce a false positive.
  assert.equal(extractSourceIssueRef({
    title: 'Etsy Aug-10 2026 kill-gate evaluation (one-shot)',
    description: 'Follows the kill-gate policy from AUR-4510, see also AUR-3263 and AUR-3264 for prior runs.',
  }), null);
});

test('extractSourceIssueRef: picks the FIRST reference when a title has more than one', () => {
  assert.equal(extractSourceIssueRef({ title: 'AUR-100 blocks AUR-200 from proceeding' }), 'AUR-100');
});

// ── isStrandedRoutineExecution (AUR-5634) ────────────────────────────────────

test('isStrandedRoutineExecution: true for a routine_execution issue past the threshold, still backlog (AUR-5416 shape)', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'routine_execution',
    status: 'backlog',
    createdAt: '2026-08-08T09:15:12.230Z',
  }, now), true);
});

test('isStrandedRoutineExecution: true for a routine_execution issue past the threshold, in_review (AUR-5427 shape)', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'routine_execution',
    status: 'in_review',
    createdAt: '2026-08-10T14:00:19.001Z',
  }, now), true);
});

test('isStrandedRoutineExecution: false when originKind is not routine_execution', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'manual',
    status: 'backlog',
    createdAt: '2026-08-08T09:15:12.230Z',
  }, now), false);
});

test('isStrandedRoutineExecution: false when status is terminal (done)', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'routine_execution',
    status: 'done',
    createdAt: '2026-08-08T09:15:12.230Z',
  }, now), false);
});

test('isStrandedRoutineExecution: false when status is terminal (cancelled)', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'routine_execution',
    status: 'cancelled',
    createdAt: '2026-08-08T09:15:12.230Z',
  }, now), false);
});

test('isStrandedRoutineExecution: false when under the threshold', () => {
  const now = new Date('2026-08-08T10:00:00Z');
  assert.equal(isStrandedRoutineExecution({
    originKind: 'routine_execution',
    status: 'backlog',
    createdAt: '2026-08-08T09:15:12.230Z', // 45 minutes old
  }, now), false);
});

test('isStrandedRoutineExecution: boundary — false at exactly threshold minus one hour, true at exactly threshold', () => {
  const created = '2026-08-08T09:00:00.000Z';
  assert.equal(isStrandedRoutineExecution(
    { originKind: 'routine_execution', status: 'todo', createdAt: created },
    new Date(new Date(created).getTime() + (ROUTINE_EXECUTION_STALE_HOURS - 1) * 3600 * 1000),
  ), false);
  assert.equal(isStrandedRoutineExecution(
    { originKind: 'routine_execution', status: 'todo', createdAt: created },
    new Date(new Date(created).getTime() + ROUTINE_EXECUTION_STALE_HOURS * 3600 * 1000),
  ), true);
});

test('isStrandedRoutineExecution: true for every NON_TERMINAL_STATUSES entry', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  for (const status of NON_TERMINAL_STATUSES) {
    assert.equal(isStrandedRoutineExecution({
      originKind: 'routine_execution',
      status,
      createdAt: '2026-08-08T09:15:12.230Z',
    }, now), true, `expected status "${status}" to count as non-terminal/strandable`);
  }
});

// ── STRANDED_ROUTINE_FLAG_REGEX / strandedRoutineFlagTitle round-trip ───────

test('strandedRoutineFlagTitle + STRANDED_ROUTINE_FLAG_REGEX: with-source title round-trips the EXECUTION identifier', () => {
  const title = strandedRoutineFlagTitle('AUR-5416', 'AUR-5356');
  assert.match(title, /^stranded-routine-execution:/);
  assert.match(title, /AUR-5356/);
  const match = STRANDED_ROUTINE_FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-5416', 'capture group is the execution identifier, the stable dedup key');
});

test('strandedRoutineFlagTitle + STRANDED_ROUTINE_FLAG_REGEX: no-source fallback title still round-trips the execution identifier', () => {
  const title = strandedRoutineFlagTitle('AUR-5427', null);
  assert.match(title, /no source reference in title/);
  const match = STRANDED_ROUTINE_FLAG_REGEX.exec(title);
  assert.ok(match);
  assert.equal(match[1], 'AUR-5427');
});

// ── buildStrandedRoutineFlagDescription ──────────────────────────────────────

test('buildStrandedRoutineFlagDescription: with a source reference, names both issues and does not claim no source exists', () => {
  const desc = buildStrandedRoutineFlagDescription({
    id: 'e1',
    identifier: 'AUR-5416',
    title: 'Telephony-gateway deploy-staleness watchdog — AUR-5356',
    status: 'backlog',
    createdAt: '2026-08-08T09:15:12.230Z',
  }, 'AUR-5356', new Date('2026-08-13T00:00:00Z'));
  assert.match(desc, /AUR-5416/);
  assert.match(desc, /AUR-5356/);
  assert.match(desc, /exec\.routing-rationale: skip/);
});

test('buildStrandedRoutineFlagDescription: without a source reference, explicitly says extraction failed (not "no source exists")', () => {
  const desc = buildStrandedRoutineFlagDescription({
    id: 'e2',
    identifier: 'AUR-5427',
    title: 'Weekly Etsy Shop Operations — 2026-08-10',
    status: 'in_review',
    createdAt: '2026-08-10T14:00:19.001Z',
  }, null, new Date('2026-08-13T00:00:00Z'));
  assert.match(desc, /extraction failed/);
  assert.match(desc, /does not mean no source exists/, 'must explicitly disclaim the false "no source exists" reading, not just omit it');
});

// ── resolveStrandedRoutineCancelReason ───────────────────────────────────────

test('resolveStrandedRoutineCancelReason: resolves when the target is no longer found among open issues', () => {
  const reason = resolveStrandedRoutineCancelReason({ target: null, targetId: 'AUR-5416' });
  assert.match(reason, /not found among open issues/);
});

test('resolveStrandedRoutineCancelReason: resolves when the target has flipped to done', () => {
  const reason = resolveStrandedRoutineCancelReason({ target: { status: 'done' }, targetId: 'AUR-5416' });
  assert.match(reason, /is done/);
});

test('resolveStrandedRoutineCancelReason: resolves when the target has flipped to cancelled', () => {
  const reason = resolveStrandedRoutineCancelReason({ target: { status: 'cancelled' }, targetId: 'AUR-5416' });
  assert.match(reason, /is cancelled/);
});

test('resolveStrandedRoutineCancelReason: null (stays open) when the target is still non-terminal', () => {
  const reason = resolveStrandedRoutineCancelReason({ target: { status: 'backlog' }, targetId: 'AUR-5416' });
  assert.equal(reason, null);
});

// ── main() integration (AUR-5000 acceptance bar: FIRES / PASSES / CAPS / GROUPS) ─

const API_URL = 'http://test.local';
const COMPANY_ID = 'c1';

/**
 * Minimal fetch stub keyed by `${method} ${path}` (path relative to API_URL).
 * An unmatched route responds 404 so an unexpected call fails loudly rather
 * than silently returning undefined-shaped data.
 */
function makeFetchStub(routes) {
  const calls = [];
  return {
    calls,
    fetchStub: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(API_URL, '');
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const key = `${method} ${path}`;
      if (!Object.prototype.hasOwnProperty.call(routes, key)) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      }
      const value = routes[key];
      return { ok: true, status: 200, statusText: 'OK', json: async () => value };
    },
  };
}

const BLOCKED_QUERY = `GET /api/companies/${COMPANY_ID}/issues?status=blocked&limit=500`;
const ALL_QUERY = `GET /api/companies/${COMPANY_ID}/issues?status=${ISSUE_STATUS_FILTER}&limit=500`;
const FILE_ISSUE_ROUTE = `POST /api/companies/${COMPANY_ID}/issues`;
const UMBRELLA_FIND_QUERY =
  `GET /api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(UMBRELLA_FLAG_TITLE_PREFIX)}` +
  `&status=${UMBRELLA_FLAG_SEARCH_STATUSES}&limit=20`;

function noBlocker() {
  return { state: 'needs_attention', unresolvedBlockerCount: 0 };
}

let originalFetch;
let originalLog;
let logLines;
test.beforeEach(() => {
  originalFetch = global.fetch;
  originalLog = console.log;
  logLines = [];
  console.log = (...args) => logLines.push(args.join(' '));
});
test.afterEach(() => {
  global.fetch = originalFetch;
  console.log = originalLog;
});

test('main() FIRES: one genuine stalled-blocked issue (not own-output, not a routine umbrella) files exactly one flag', async () => {
  const subject = {
    id: 's1',
    identifier: 'AUR-7001',
    title: 'Refactor the widget factory',
    status: 'blocked',
    priority: 'high',
    originKind: 'manual',
    assigneeAgentId: 'agentX',
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [subject],
    [ALL_QUERY]: [subject],
    [FILE_ISSUE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1, 'expected exactly one flag to be filed');
  assert.match(filed[0].body.title, /^stalled-blocked: AUR-7001/);
  assert.equal(filed[0].body.assigneeAgentId, 'agentX');
});

test('main() PASSES: a fixture containing ONLY the watchdog\'s own prior output files zero new flags', async () => {
  const umbrella = {
    id: 'u1',
    identifier: 'AUR-4932',
    title: WATCHDOG_ROUTINE_TITLE,
    status: 'blocked',
    priority: 'critical',
    originKind: 'routine_execution',
    originId: WATCHDOG_ROUTINE_ID,
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  };
  const ownFlag = {
    id: 'f1',
    identifier: 'AUR-4978',
    title: 'stalled-blocked: AUR-4932 blocked with no blocker',
    status: 'blocked',
    priority: 'critical',
    originKind: 'manual',
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [umbrella, ownFlag],
    [ALL_QUERY]: [umbrella, ownFlag],
    'PATCH /api/issues/f1': { id: 'f1', status: 'cancelled' },
    'POST /api/issues/f1/comments': { id: 'comment1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filedAnyFlag = calls.some((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filedAnyFlag, false, 'no new flag — individual or aggregate — should be filed against the watchdog\'s own output');
  const cancelled = calls.find((c) => c.method === 'PATCH' && c.path === '/api/issues/f1');
  assert.ok(cancelled, 'the stale self-referential flag should be auto-resolved, not left open');
  assert.equal(cancelled.body.status, 'cancelled');
});

test('main() CAPS: MAX_FLAGS_PER_RUN + 3 genuine candidates files exactly the cap and names the 3 dropped identifiers', async () => {
  const subjects = Array.from({ length: DEFAULT_MAX_FLAGS_PER_RUN + 3 }, (_, i) => ({
    id: `s${i + 1}`,
    identifier: `AUR-900${i + 1}`,
    title: `Ordinary stalled issue ${i + 1}`,
    status: 'blocked',
    priority: 'high',
    originKind: 'manual',
    assigneeAgentId: 'agentX',
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  }));
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: subjects,
    [ALL_QUERY]: subjects,
    [FILE_ISSUE_ROUTE]: { id: 'flagN' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: DEFAULT_MAX_FLAGS_PER_RUN });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, DEFAULT_MAX_FLAGS_PER_RUN, 'expected exactly the cap to be filed');

  const filedIds = filed.map((c) => c.body.title.match(/AUR-\d+/)[0]);
  const droppedIds = subjects.slice(DEFAULT_MAX_FLAGS_PER_RUN).map((s) => s.identifier);
  for (const id of droppedIds) assert.equal(filedIds.includes(id), false, `${id} should have been dropped by the cap, not filed`);

  const capLine = logLines.find((l) => l.includes('CAP:'));
  assert.ok(capLine, 'expected a CAP: log line');
  assert.match(capLine, /dropping 3/);
  for (const id of droppedIds) {
    const named = logLines.some((l) => l.includes(id));
    assert.ok(named, `dropped identifier ${id} should be named explicitly in the output`);
  }
});

test('main() GROUPS: 5 routine-execution umbrellas file ONE aggregate flag at priority high, never critical', async () => {
  const umbrellas = Array.from({ length: 5 }, (_, i) => ({
    id: `u${i + 1}`,
    identifier: `AUR-800${i + 1}`,
    title: `Some routine dispatch ${i + 1}`,
    status: 'blocked',
    priority: 'critical',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  }));
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: umbrellas,
    [ALL_QUERY]: umbrellas,
    [UMBRELLA_FIND_QUERY]: [],
    [FILE_ISSUE_ROUTE]: { id: 'umbrella-flag-1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1, 'expected exactly one aggregate flag, not one per umbrella');
  assert.match(filed[0].body.title, new RegExp(`^${UMBRELLA_FLAG_TITLE_PREFIX.replace(':', '\\:')} 5 `));
  assert.equal(filed[0].body.priority, 'high', 'aggregate flags must never inherit critical from their members');
  assert.equal(filed[0].body.assigneeAgentId, CEO_AGENT_ID);
});

test('main() GROUPS: comments on an existing open aggregate flag instead of refiling', async () => {
  const umbrellas = Array.from({ length: 3 }, (_, i) => ({
    id: `u${i + 1}`,
    identifier: `AUR-810${i + 1}`,
    title: `Some routine dispatch ${i + 1}`,
    status: 'blocked',
    priority: 'critical',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    updatedAt: '2026-07-26T00:00:00Z',
    blockerAttention: noBlocker(),
  }));
  const existingUmbrellaFlag = { id: 'ue1', identifier: 'AUR-9600', title: `${UMBRELLA_FLAG_TITLE_PREFIX} 4 routine dispatch umbrellas stranded blocked` };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: umbrellas,
    [ALL_QUERY]: umbrellas,
    [UMBRELLA_FIND_QUERY]: [existingUmbrellaFlag],
    'POST /api/issues/ue1/comments': { id: 'comment1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filedAnyIssue = calls.some((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filedAnyIssue, false, 'should comment on the existing aggregate, not file a new one');
  const commented = calls.find((c) => c.method === 'POST' && c.path === '/api/issues/ue1/comments');
  assert.ok(commented, 'expected a comment on the existing open umbrella aggregate flag');
});

// ── main() integration: stranded-routine-execution path (AUR-5634) ──────────

test('main() FIRES: a stranded routine_execution issue with a source reference in its title fetches the source and flags it', async () => {
  const execIssue = {
    id: 'e1',
    identifier: 'AUR-5416',
    title: 'Telephony-gateway deploy-staleness watchdog — AUR-5356',
    status: 'backlog',
    priority: 'high',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    createdAt: '2020-01-01T00:00:00Z', // far enough in the past to clear the threshold regardless of test run time
    updatedAt: '2020-01-01T00:00:00Z',
  };
  const sourceIssue = { id: 'src1', identifier: 'AUR-5356', title: 'Source issue', status: 'todo', assigneeAgentId: 'sourceOwner' };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: [execIssue],
    'GET /api/issues/AUR-5356': sourceIssue,
    [FILE_ISSUE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1, 'expected exactly one stranded-routine-execution flag');
  assert.match(filed[0].body.title, /^stranded-routine-execution: AUR-5416/);
  assert.match(filed[0].body.title, /AUR-5356/);
  assert.equal(filed[0].body.assigneeAgentId, 'sourceOwner', 'flag routes to the SOURCE issue\'s owner, not the execution issue');
  const sourceFetched = calls.some((c) => c.method === 'GET' && c.path === '/api/issues/AUR-5356');
  assert.ok(sourceFetched, 'expected the source issue to be fetched to resolve its owner');
});

test('main() FIRES: a stranded routine_execution issue with no source reference falls back to flagging the execution issue itself', async () => {
  const execIssue = {
    id: 'e2',
    identifier: 'AUR-5427',
    title: 'Weekly Etsy Shop Operations — 2026-08-10',
    status: 'in_review',
    priority: 'medium',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
    assigneeAgentId: 'execOwner',
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: [execIssue],
    [FILE_ISSUE_ROUTE]: { id: 'flag1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 1);
  assert.match(filed[0].body.title, /^stranded-routine-execution: AUR-5427/);
  assert.match(filed[0].body.title, /no source reference in title/);
  assert.equal(filed[0].body.assigneeAgentId, 'execOwner', 'no source to route to — falls back to the execution issue\'s own owner');
  const sourceFetchAttempted = calls.some((c) => c.method === 'GET' && /^\/api\/issues\/AUR-\d+$/.test(c.path));
  assert.equal(sourceFetchAttempted, false, 'no source ref extracted — no source lookup should be attempted');
});

test('main() PASSES: a routine_execution issue below the staleness threshold is not flagged', async () => {
  const execIssue = {
    id: 'e3',
    identifier: 'AUR-9001',
    title: 'Some fresh routine dispatch — AUR-1000',
    status: 'backlog',
    priority: 'high',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    createdAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h old, under the 24h threshold
    updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: [execIssue],
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 0, 'issue is under threshold — nothing should be filed');
});

test('main() DEDUPES: does not re-file a stranded-routine-execution flag when an open one already targets the execution issue', async () => {
  const execIssue = {
    id: 'e4',
    identifier: 'AUR-5416',
    title: 'Telephony-gateway deploy-staleness watchdog — AUR-5356',
    status: 'backlog',
    priority: 'high',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
  };
  const existingFlag = {
    id: 'flagExisting',
    identifier: 'AUR-9700',
    title: strandedRoutineFlagTitle('AUR-5416', 'AUR-5356'),
    status: 'todo',
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: [execIssue, existingFlag],
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, 0, 'an open flag already targets AUR-5416 — should not refile');
});

test('main() CAPS: STRANDED_ROUTINE_FLAG_CAP + 2 stranded candidates files exactly the cap and names the dropped identifiers', async () => {
  const execIssues = Array.from({ length: STRANDED_ROUTINE_FLAG_CAP + 2 }, (_, i) => ({
    id: `se${i + 1}`,
    identifier: `AUR-920${i + 1}`,
    title: `Some stranded routine dispatch ${i + 1}`,
    status: 'backlog',
    priority: 'high',
    originKind: 'routine_execution',
    originId: 'some-other-routine-id',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
    assigneeAgentId: 'agentX',
  }));
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: execIssues,
    [FILE_ISSUE_ROUTE]: { id: 'flagN' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 50 });

  assert.equal(code, 0);
  const filed = calls.filter((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filed.length, STRANDED_ROUTINE_FLAG_CAP, 'expected exactly STRANDED_ROUTINE_FLAG_CAP flags filed');

  const droppedIds = execIssues.slice(STRANDED_ROUTINE_FLAG_CAP).map((s) => s.identifier);
  const capLine = logLines.find((l) => l.includes('STRANDED_ROUTINE_FLAG_CAP'));
  assert.ok(capLine, 'expected a CAP log line naming STRANDED_ROUTINE_FLAG_CAP');
  for (const id of droppedIds) {
    const named = logLines.some((l) => l.includes(id));
    assert.ok(named, `dropped identifier ${id} should be named explicitly in the output`);
  }
});

test('main() RESOLVES: auto-cancels a stranded-routine-execution flag once its target reaches done', async () => {
  // The execution issue (AUR-5430) is DONE, so it is absent from the ALL_QUERY
  // response, matching real API behavior (ISSUE_STATUS_FILTER excludes terminal
  // statuses) — its absence from issueByIdentifier is exactly what should trigger
  // resolveStrandedRoutineCancelReason's "not found among open issues" branch.
  const staleFlag = {
    id: 'flagStale',
    identifier: 'AUR-9800',
    title: strandedRoutineFlagTitle('AUR-5430', 'AUR-5366'),
    status: 'todo',
  };
  const { fetchStub, calls } = makeFetchStub({
    [BLOCKED_QUERY]: [],
    [ALL_QUERY]: [staleFlag],
    'PATCH /api/issues/flagStale': { id: 'flagStale', status: 'cancelled' },
    'POST /api/issues/flagStale/comments': { id: 'comment1' },
  });
  global.fetch = fetchStub;

  const code = await main({ apply: true, apiUrl: API_URL, apiKey: 'key', companyId: COMPANY_ID, maxFlagsPerRun: 5 });

  assert.equal(code, 0);
  const cancelled = calls.find((c) => c.method === 'PATCH' && c.path === '/api/issues/flagStale');
  assert.ok(cancelled, 'the stale flag should be auto-resolved once its target is not found among open (non-terminal) issues');
  assert.equal(cancelled.body.status, 'cancelled');
  const filedAnyFlag = calls.some((c) => c.method === 'POST' && c.path === `/api/companies/${COMPANY_ID}/issues`);
  assert.equal(filedAnyFlag, false);
});
