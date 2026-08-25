import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_REPOS,
  api,
  applyFileCap,
  assessLaneHealth,
  decideActions,
  distributeReviewers,
  escalationMessage,
  extractAurToken,
  isStarvedRun,
  issueBody,
  issueTitle,
  migrateState,
  pickReviewer,
  refileCapMessage,
  stateKey,
} from './check-pr-backlog.mjs';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const REPO = 'Jacksnow14/paperclip';
const pr = (n, over = {}) => ({
  number: n,
  title: `fix(AUR-${9000 + n}): thing ${n}`,
  draft: false,
  headSha: `abcdef${n}00000000`,
  createdAt: '2026-08-06T10:00:00Z',
  ...over,
});

test('files a review issue for a PR never seen before', () => {
  const { file, escalate } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: {} },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].number, 1);
  assert.equal(file[0].sha7, 'abcdef1');
  assert.equal(escalate.length, 0);
});

test('does not re-file for an already-dispatched head sha', () => {
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 0);
});

test('a new push (new head sha) re-arms dispatch for the same PR', () => {
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1, { headSha: 'fffffff000' })],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].sha7, 'fffffff');
});

test('cross-repo PR-number collision: repo A state never suppresses repo B (AUR-5111)', () => {
  // Same PR number, same head sha, two different repos. Before (repo, pr)
  // keying, the second repo's PR was silently skipped as "already filed".
  const state = { prs: { [stateKey('Jacksnow14/paperclip', 79)]: { filedSha: 'abcdef7' } } };
  const suppressed = decideActions({
    repo: 'Jacksnow14/paperclip',
    prs: [pr(79, { headSha: 'abcdef70000000' })],
    state,
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(suppressed.file.length, 0);

  const otherRepo = decideActions({
    repo: 'Jacksnow14/Auranode',
    prs: [pr(79, { headSha: 'abcdef70000000' })],
    state,
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(otherRepo.file.length, 1);
  assert.equal(otherRepo.file[0].number, 79);
});

test('legacy bare-number state rows migrate to the paperclip repo key (AUR-5111)', () => {
  const migrated = migrateState({
    prs: {
      214: { filedSha: 'f49a25d', issue: 'AUR-5004' },
      'Jacksnow14/Auranode#9': { filedSha: 'aaaaaaa' },
    },
  });
  assert.equal(migrated.version, 2);
  assert.deepEqual(Object.keys(migrated.prs).sort(), [
    'Jacksnow14/Auranode#9',
    'Jacksnow14/paperclip#214',
  ]);
  assert.equal(migrated.prs['Jacksnow14/paperclip#214'].issue, 'AUR-5004');
  // Idempotent: migrating a migrated state is a no-op.
  assert.deepEqual(migrateState(migrated), migrated);
});

test('draft PRs are skipped entirely', () => {
  const { file, escalate } = decideActions({
    repo: REPO,
    prs: [pr(1, { draft: true, createdAt: '2026-07-01T00:00:00Z' })],
    state: { prs: {} },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(file.length, 0);
  assert.equal(escalate.length, 0);
});

test('PR open past stale-hours escalates, rate-limited to 24h', () => {
  const old = pr(2, { createdAt: '2026-08-01T00:00:00Z' });
  const first = decideActions({
    repo: REPO,
    prs: [old],
    state: { prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2' } } },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(first.escalate.length, 1);
  assert.ok(first.escalate[0].ageHours >= 72);

  const recentlyEscalated = decideActions({
    repo: REPO,
    prs: [old],
    state: {
      prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2', escalatedAt: '2026-08-06T02:00:00Z' } },
    },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(recentlyEscalated.escalate.length, 0);

  const dayLater = decideActions({
    repo: REPO,
    prs: [old],
    state: {
      prs: { [stateKey(REPO, 2)]: { filedSha: 'abcdef2', escalatedAt: '2026-08-05T02:00:00Z' } },
    },
    nowMs: NOW,
    staleHours: 72,
  });
  assert.equal(dayLater.escalate.length, 1);
});

test('escalation batches into one message per repo, capped listing, oldest first', () => {
  const escalate = Array.from({ length: 11 }, (_, i) => ({
    number: i + 1,
    ageHours: 100 + i,
    title: `t${i}`,
  }));
  const msg = escalationMessage('Jacksnow14/Auranode', escalate, 72);
  assert.match(msg, /^pr-backlog\[Jacksnow14\/Auranode\]: 11 PR\(s\) open >72h/);
  assert.match(msg, /oldest 110h/);
  assert.match(msg, /#11\(110h\)/);
  assert.match(msg, /\(\+3 more\)/);
  assert.match(msg, /pipeline alarm, not a code-review request/);
});

test('pickReviewer prefers running, refuses error/terminated instances', () => {
  const agents = [
    { id: 'a', name: 'Claude Code Max', status: 'error' },
    { id: 'b', name: 'Claude Code Max', status: 'idle' },
    { id: 'c', name: 'Claude Code Max', status: 'running' },
    { id: 'd', name: 'CEO', status: 'running' },
  ];
  assert.equal(pickReviewer(agents, 'Claude Code Max').id, 'c');
  assert.equal(pickReviewer(agents.slice(0, 2), 'Claude Code Max').id, 'b');
  assert.equal(pickReviewer([agents[0]], 'Claude Code Max'), null);
  assert.equal(pickReviewer(agents, 'Nonexistent'), null);
});

test('issue title is per-repo-per-PR-per-sha (the idempotency key)', () => {
  assert.equal(
    issueTitle({ number: 7, sha7: 'abc1234' }, 'Jacksnow14/Auranode'),
    'pr-review/Auranode#7@abc1234: review, correct and land',
  );
  assert.equal(
    issueTitle({ number: 7, sha7: 'abc1234' }, 'Jacksnow14/paperclip'),
    'pr-review/paperclip#7@abc1234: review, correct and land',
  );
});

test('issue body forbids founder code review and demands loop closure', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'o/r', true);
  assert.match(body, /never ask the founder to review/i);
  assert.match(body, /FINAL review authority/);
  assert.match(body, /never batch/i);
  assert.match(body, /merged or closed/);
  assert.match(body, /check-trunk-ci-red/);
});

// ---------------------------------------------------------------------------
// AUR-5995: check-trunk-ci-red.mjs is Paperclip-only. Step 1 must not
// unconditionally reference it for a repo (e.g. Auranode) that doesn't have
// it — that 404s the reviewer's very first step.
// ---------------------------------------------------------------------------

test('issue body step 1 falls back to a repo-agnostic gh command when check-trunk-ci-red.mjs is absent', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'Jacksnow14/Auranode', false);
  assert.doesNotMatch(body, /node scripts\/check-trunk-ci-red\.mjs/);
  assert.match(body, /gh pr checks --repo Jacksnow14\/Auranode/);
  // The rest of the procedure (mandate, verdict/act, loop closure) is unaffected.
  assert.match(body, /FINAL review authority/);
  assert.match(body, /merged or closed/);
});

test('issue body defaults to referencing check-trunk-ci-red.mjs when hasTrunkCiScript is omitted', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'Jacksnow14/paperclip');
  assert.match(body, /check-trunk-ci-red/);
});

// ---------------------------------------------------------------------------
// AUR-6102: reviewer must flag (not auto-block) diff anomalies unexplained by
// the PR/issue title — secrets/credential access, new/modified git remotes,
// unusual outbound network calls.
// ---------------------------------------------------------------------------

test('issue body instructs the reviewer to flag unexplained diff anomalies rather than auto-block', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'o/r', true);
  assert.match(body, /flag, don.t auto-block/i);
  assert.match(body, /secrets\/credential access/i);
  assert.match(body, /new or modified git remotes/i);
  assert.match(body, /unusual outbound network calls/i);
});

// ---------------------------------------------------------------------------
// AUR-6150: a changes_requested execution-review decision places nothing on
// the PR by itself — the reviewer must run the draft-conversion gate so the
// merge command actually refuses, and must not force a refused merge ready.
// ---------------------------------------------------------------------------

test('issue body wires the changes_requested decision to the execution-review draft gate', () => {
  const body = issueBody({ number: 7, sha7: 'abc1234', title: 't' }, 'o/r', true);
  assert.match(body, /enforce-execution-review-gate\.mjs --issue/);
  assert.match(body, /Pull Request is still a draft/);
});

// ---------------------------------------------------------------------------
// Defect 4 (AUR-5370): a cancelled/missing review issue must not permanently
// suppress a PR. filedSha matching is no longer sufficient — the previously
// filed issue's terminal state decides.
// ---------------------------------------------------------------------------

test('a cancelled review issue causes the PR to be re-filed on the next sweep (FIRING case)', () => {
  const filedIssueId = 'issue-uuid-1';
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId } } },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: { [filedIssueId]: 'cancelled' },
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].number, 1);
  assert.equal(file[0].refileReason, 'cancelled');
  assert.equal(file[0].refileCount, 1);
});

test('an open review issue does NOT cause a re-file (PASSING case)', () => {
  for (const status of ['todo', 'in_progress', 'in_review', 'blocked']) {
    const filedIssueId = 'issue-uuid-2';
    const { file } = decideActions({
      repo: REPO,
      prs: [pr(1)],
      state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId } } },
      nowMs: NOW,
      staleHours: 72,
      issueStatuses: { [filedIssueId]: status },
    });
    assert.equal(file.length, 0, `status ${status} must not re-file`);
  }
});

test('a missing (not found) review issue re-files, same as cancelled', () => {
  const filedIssueId = 'issue-uuid-3';
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId } } },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: {}, // looked up, absent from the map => not found
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].refileReason, 'not-found');
});

test('a done review issue while the PR is still open re-files as a pipeline defect', () => {
  const filedIssueId = 'issue-uuid-4';
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId } } },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: { [filedIssueId]: 'done' },
  });
  assert.equal(file.length, 1);
  assert.equal(file[0].refileReason, 'done-but-open');
});

test('a legacy entry with no filedIssueId is left alone (nothing to verify)', () => {
  const { file } = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: { prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1' } } },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: {},
  });
  assert.equal(file.length, 0);
});

test('re-files are capped at 3; the 4th would-be re-file escalates instead of filing a 5th issue', () => {
  const filedIssueId = 'issue-uuid-5';
  const capped = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: {
      prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId, refileCount: 3 } },
    },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: { [filedIssueId]: 'cancelled' },
  });
  assert.equal(capped.file.length, 0);
  assert.equal(capped.refileCapped.length, 1);
  assert.equal(capped.refileCapped[0].number, 1);
  assert.equal(capped.refileCapped[0].refileCount, 3);

  const underCap = decideActions({
    repo: REPO,
    prs: [pr(1)],
    state: {
      prs: { [stateKey(REPO, 1)]: { filedSha: 'abcdef1', filedIssueId, refileCount: 2 } },
    },
    nowMs: NOW,
    staleHours: 72,
    issueStatuses: { [filedIssueId]: 'cancelled' },
  });
  assert.equal(underCap.file.length, 1);
  assert.equal(underCap.refileCapped.length, 0);
  assert.equal(underCap.file[0].refileCount, 3);
});

test('refileCapMessage names the PRs and their re-file counts', () => {
  const msg = refileCapMessage('Jacksnow14/Auranode', [
    { number: 9, refileCount: 3, reason: 'cancelled' },
  ]);
  assert.match(msg, /Jacksnow14\/Auranode/);
  assert.match(msg, /#9\(3x cancelled\)/);
  assert.match(msg, /pipeline alarm, not a code-review request/);
});

// ---------------------------------------------------------------------------
// Defect 2 (AUR-5370): reviewer fan-out — lane health read from runs, not
// the `status` field, and least-loaded distribution across healthy lanes.
// ---------------------------------------------------------------------------

test('isStarvedRun detects the quota-starved-failure signature', () => {
  assert.equal(
    isStarvedRun({
      status: 'failed',
      error: "You've hit your session limit for this billing period.",
      usageJson: null,
    }),
    true,
  );
  assert.equal(
    isStarvedRun({ status: 'failed', error: 'Process lost -- child pid gone', usageJson: null }),
    false,
  );
  assert.equal(
    isStarvedRun({
      status: 'failed',
      error: 'hit usage limit',
      usageJson: { inputTokens: 100, outputTokens: 50 },
    }),
    false, // billed tokens => not a starved-before-it-ran failure
  );
});

test('assessLaneHealth: most-recent starved failure marks the lane unhealthy (FIRING case)', () => {
  const runs = [
    { status: 'failed', error: 'hit your session limit', usageJson: null },
    { status: 'succeeded', error: null, usageJson: { inputTokens: 1, outputTokens: 1 } },
  ];
  const health = assessLaneHealth(runs);
  assert.equal(health.healthy, false);
});

test('assessLaneHealth: healthy lane with an older (recovered-from) starved run stays healthy (PASSING case)', () => {
  const runs = [
    { status: 'succeeded', error: null, usageJson: { inputTokens: 1, outputTokens: 1 } },
    { status: 'failed', error: 'hit your session limit', usageJson: null },
  ];
  const health = assessLaneHealth(runs);
  assert.equal(health.healthy, true);
});

test('assessLaneHealth counts queued runs for load-based distribution', () => {
  const runs = [
    { status: 'queued' },
    { status: 'queued' },
    { status: 'succeeded', usageJson: { inputTokens: 1, outputTokens: 1 } },
  ];
  assert.equal(assessLaneHealth(runs).queuedCount, 2);
});

test('distributeReviewers spreads items least-loaded-first across N healthy lanes', () => {
  const items = [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }];
  const candidates = [
    { id: 'max', name: 'Claude Code Max', queuedCount: 0 },
    { id: 'fast', name: 'Claude Code Fast', queuedCount: 2 },
  ];
  const assigned = distributeReviewers(items, candidates);
  // max starts at 0 load, fast at 2: max should absorb more of the early items.
  assert.deepEqual(
    assigned.map((a) => a.reviewerId),
    ['max', 'max', 'max', 'fast'],
  );
});

test('distributeReviewers excludes the given agent per-item, but falls back if exclusion empties the pool', () => {
  const candidates = [
    { id: 'max', name: 'Claude Code Max', queuedCount: 0 },
    { id: 'fast', name: 'Claude Code Fast', queuedCount: 0 },
  ];
  const withExclusion = distributeReviewers([{ number: 1, excludeAgentId: 'max' }], candidates);
  assert.equal(withExclusion[0].reviewerId, 'fast');

  // Excluding the only candidate must not leave the item unassigned.
  const singleCandidate = [{ id: 'max', name: 'Claude Code Max', queuedCount: 0 }];
  const fallback = distributeReviewers([{ number: 1, excludeAgentId: 'max' }], singleCandidate);
  assert.equal(fallback[0].reviewerId, 'max');
});

// ---------------------------------------------------------------------------
// Author exclusion (AUR-5370): AUR-NNNN token in the PR title is the only
// usable signal since every PR shares one GitHub author.
// ---------------------------------------------------------------------------

test('extractAurToken finds the AUR-NNNN token in a PR title, or null', () => {
  assert.equal(extractAurToken('fix(AUR-5370): harden the dispatcher'), 'AUR-5370');
  assert.equal(extractAurToken('chore: bump deps'), null);
  assert.equal(extractAurToken(undefined), null);
});

// ---------------------------------------------------------------------------
// Defect 3 (AUR-5370): --max-file cap, safety/guardrail PRs prioritized,
// overflow explicitly dropped (never silently truncated).
// ---------------------------------------------------------------------------

test('applyFileCap keeps safety/guardrail PRs first, then oldest-first, dropping the overflow', () => {
  const items = [
    { number: 1, title: 'chore: cleanup', createdAt: '2026-08-05T00:00:00Z' },
    { number: 2, title: 'fix(AUR-1): email safety guardrail', createdAt: '2026-08-06T00:00:00Z' },
    { number: 3, title: 'chore: older cleanup', createdAt: '2026-08-01T00:00:00Z' },
  ];
  const { kept, dropped } = applyFileCap(items, 2);
  assert.deepEqual(kept.map((k) => k.number), [2, 3]); // safety-critical first, then oldest chore
  assert.deepEqual(dropped.map((d) => d.number), [1]);
});

test('api() throws with the response body on failure (AUR-5790)', async () => {
  // A 403/400 with no body logged costs the next responder a full diagnosis
  // loop re-deriving the server's stated reason from scratch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":"Missing permission: tasks:assign"}', { status: 403 });
  try {
    await assert.rejects(
      () => api({ apiBase: 'http://example.invalid' }, 'POST', '/api/companies/x/issues'),
      (err) => {
        assert.match(err.message, /POST \/api\/companies\/x\/issues → 403/);
        assert.match(err.message, /Missing permission: tasks:assign/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api() throws a plain status line when the body is empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 500 });
  try {
    await assert.rejects(
      () => api({ apiBase: 'http://example.invalid' }, 'GET', '/api/issues/x'),
      (err) => {
        assert.equal(err.message, 'GET /api/issues/x → 500');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyFileCap keeps everything when under the cap', () => {
  const items = [{ number: 1, title: 't', createdAt: '2026-08-01T00:00:00Z' }];
  const { kept, dropped } = applyFileCap(items, 6);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('entrypoint fires when invoked through a release symlink (AUR-5111)', () => {
  // Reproduce the production layout that killed the dispatcher:
  //   root/releases/abc123/scripts/check-pr-backlog.mjs   (real file)
  //   root/current -> releases/abc123                     (symlink, as in ExecStart)
  // The old string-compare guard exits 0 with ZERO output on this layout; the
  // realpath guard must run main() and print one summary line per default repo.
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-backlog.mjs');
  const root = mkdtempSync(join(tmpdir(), 'prb-symlink-'));
  try {
    const releaseScripts = join(root, 'releases', 'abc123', 'scripts');
    mkdirSync(releaseScripts, { recursive: true });
    copyFileSync(script, join(releaseScripts, 'check-pr-backlog.mjs'));
    symlinkSync(join(root, 'releases', 'abc123'), join(root, 'current'));

    // Stub `gh` on PATH so the sweep is hermetic: every enumeration returns [].
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho []\n');
    chmodSync(join(bin, 'gh'), 0o755);

    const out = execFileSync(
      process.execPath,
      [
        join(root, 'current', 'scripts', 'check-pr-backlog.mjs'),
        '--dry-run',
        '--state-dir',
        join(root, 'state'),
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );

    const lines = out.trim().split('\n');
    assert.equal(lines.length, DEFAULT_REPOS.length);
    for (const [i, repo] of DEFAULT_REPOS.entries()) {
      assert.match(lines[i], new RegExp(`^repo=${repo.replace('/', '\\/')} open=0 to-file=0`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
