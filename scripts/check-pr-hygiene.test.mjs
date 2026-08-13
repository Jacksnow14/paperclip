import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collisionKey,
  decideTerminalIssueAction,
  extractIssueRefs,
  findMigrationIdxCollisions,
  migrationCollisionCommentBody,
  migrationIssueBody,
  migrationIssueTitle,
  needsMigrationAlert,
  terminalIssueBody,
  terminalIssueTitle,
  terminalPrCommentBody,
} from './check-pr-hygiene.mjs';

const NOW = Date.parse('2026-08-12T12:00:00Z');
const REPO = 'Jacksnow14/paperclip';
const pr = (n, over = {}) => ({ number: n, title: `t${n}`, body: '', headSha: `sha${n}`, ...over });

// ---------------------------------------------------------------------------
// extractIssueRefs
// ---------------------------------------------------------------------------

test('extractIssueRefs finds and dedupes AUR-NNNN references, case-insensitive', () => {
  const refs = extractIssueRefs('fix(aur-5097): thing\n\nFollow-up to AUR-5097 and AUR-5465.');
  assert.deepEqual(refs, ['AUR-5097', 'AUR-5465']);
});

test('extractIssueRefs returns empty for text with no reference', () => {
  assert.deepEqual(extractIssueRefs('just a plain PR title'), []);
  assert.deepEqual(extractIssueRefs(''), []);
  assert.deepEqual(extractIssueRefs(undefined), []);
});

// ---------------------------------------------------------------------------
// Check A: decideTerminalIssueAction — FIRE and PASS
// ---------------------------------------------------------------------------

test('FIRE: cancelled issue with open PR needs both a comment and a CTO issue', () => {
  const action = decideTerminalIssueAction({
    repo: REPO,
    pr: pr(242),
    ref: 'AUR-5097',
    status: 'cancelled',
    state: {},
    nowMs: NOW,
  });
  assert.ok(action);
  assert.equal(action.needsComment, true);
  assert.equal(action.needsIssue, true);
});

test('FIRE: done issue with open PR needs only a comment, not a CTO issue (weaker signal)', () => {
  const action = decideTerminalIssueAction({
    repo: REPO,
    pr: pr(1),
    ref: 'AUR-1000',
    status: 'done',
    state: {},
    nowMs: NOW,
  });
  assert.ok(action);
  assert.equal(action.needsComment, true);
  assert.equal(action.needsIssue, false);
});

test('PASS: a non-terminal status (issue with a merged PR, still in_progress/open) produces nothing', () => {
  for (const status of ['in_progress', 'todo', 'in_review', 'blocked', null]) {
    const action = decideTerminalIssueAction({
      repo: REPO,
      pr: pr(1),
      ref: 'AUR-1',
      status,
      state: {},
      nowMs: NOW,
    });
    assert.equal(action, null, `status=${status} should not fire`);
  }
});

test('PASS: already commented and issue filed, still inside cooldown — no re-fire', () => {
  const key = `${REPO}#242:AUR-5097:cancelled`;
  const state = {
    actions: {
      [key]: { commentedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(), filedIssue: 'AUR-9999' },
    },
  };
  const action = decideTerminalIssueAction({
    repo: REPO,
    pr: pr(242),
    ref: 'AUR-5097',
    status: 'cancelled',
    state,
    nowMs: NOW,
  });
  assert.equal(action, null);
});

test('cooldown expired re-arms the comment but never re-files an already-filed issue', () => {
  const key = `${REPO}#242:AUR-5097:cancelled`;
  const state = {
    actions: {
      [key]: { commentedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(), filedIssue: 'AUR-9999' },
    },
  };
  const action = decideTerminalIssueAction({
    repo: REPO,
    pr: pr(242),
    ref: 'AUR-5097',
    status: 'cancelled',
    state,
    nowMs: NOW,
  });
  assert.ok(action);
  assert.equal(action.needsComment, true);
  assert.equal(action.needsIssue, false);
});

test('check-A message bodies never suggest auto-closing the PR', () => {
  const comment = terminalPrCommentBody({ ref: 'AUR-5097', status: 'cancelled' });
  assert.match(comment, /do not auto-close/i);
  assert.match(comment, /AUR-5097/);
  const body = terminalIssueBody({ repo: REPO, pr: pr(242, { title: 'fix thing' }), ref: 'AUR-5097' });
  assert.match(body, /do not auto-close/i);
  assert.match(body, /AUR-5097/);
  assert.equal(terminalIssueTitle({ repo: REPO, pr: pr(242), ref: 'AUR-5097' }), 'pr-hygiene/paperclip#242: AUR-5097 cancelled with PR still open');
});

// ---------------------------------------------------------------------------
// Check B: findMigrationIdxCollisions — FIRE and PASS
// ---------------------------------------------------------------------------

test('FIRE: two open PRs independently claim the same idx (the actual #264/#266 incident)', () => {
  const masterEntries = [
    { idx: 101, tag: '0101_issues_work_class' },
    { idx: 102, tag: '0102_approvals_withdrawal' },
  ];
  const prJournals = [
    {
      repo: REPO,
      number: 264,
      entries: [...masterEntries, { idx: 103, tag: '0103_recovery_action_terminal_trigger' }],
    },
    {
      repo: REPO,
      number: 266,
      entries: [...masterEntries, { idx: 103, tag: '0103_some_other_migration' }],
    },
  ];
  const collisions = findMigrationIdxCollisions({ masterEntries, prJournals });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].idx, 103);
  assert.equal(collisions[0].onMaster, false);
  assert.deepEqual(
    collisions[0].claims.map((c) => c.source).sort(),
    [`${REPO}#264`, `${REPO}#266`],
  );
});

test('FIRE: a PR claims an idx master already uses with a different tag (stale, needs rebase)', () => {
  const masterEntries = [{ idx: 103, tag: '0103_recovery_action_terminal_trigger' }];
  const prJournals = [
    { repo: REPO, number: 242, entries: [{ idx: 103, tag: '0103_stale_orphaned_pr' }] },
  ];
  const collisions = findMigrationIdxCollisions({ masterEntries, prJournals });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].onMaster, true);
  assert.equal(collisions[0].masterTag, '0103_recovery_action_terminal_trigger');
});

test('PASS: two open PRs add distinct new idx values — no collision', () => {
  const masterEntries = [{ idx: 103, tag: '0103_recovery_action_terminal_trigger' }];
  const prJournals = [
    { repo: REPO, number: 270, entries: [...masterEntries, { idx: 104, tag: '0104_a' }] },
    { repo: REPO, number: 271, entries: [...masterEntries, { idx: 105, tag: '0105_b' }] },
  ];
  assert.deepEqual(findMigrationIdxCollisions({ masterEntries, prJournals }), []);
});

test('PASS: a PR rebased onto current master (identical entries) never collides with itself', () => {
  const masterEntries = [
    { idx: 101, tag: '0101_a' },
    { idx: 102, tag: '0102_b' },
    { idx: 103, tag: '0103_c' },
  ];
  const prJournals = [{ repo: REPO, number: 300, entries: [...masterEntries] }];
  assert.deepEqual(findMigrationIdxCollisions({ masterEntries, prJournals }), []);
});

test('collisionKey is stable regardless of claim discovery order', () => {
  const a = { idx: 103, claims: [{ source: 'r#264' }, { source: 'r#266' }] };
  const b = { idx: 103, claims: [{ source: 'r#266' }, { source: 'r#264' }] };
  assert.equal(collisionKey('r', a), collisionKey('r', b));
});

test('needsMigrationAlert: no prior alert fires, inside cooldown suppresses, past cooldown re-fires', () => {
  const key = 'r:idx103:r#264,r#266';
  assert.equal(needsMigrationAlert({ state: {}, key, nowMs: NOW }), true);
  const insideCooldown = { collisions: { [key]: { alertedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() } } };
  assert.equal(needsMigrationAlert({ state: insideCooldown, key, nowMs: NOW }), false);
  const pastCooldown = { collisions: { [key]: { alertedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() } } };
  assert.equal(needsMigrationAlert({ state: pastCooldown, key, nowMs: NOW }), true);
});

test('check-B message bodies demand renumbering, never dropping a side', () => {
  const collision = {
    idx: 103,
    onMaster: false,
    masterTag: null,
    claims: [
      { source: `${REPO}#264`, tag: '0103_a' },
      { source: `${REPO}#266`, tag: '0103_b' },
    ],
  };
  const comment = migrationCollisionCommentBody(collision);
  assert.match(comment, /renumber/i);
  assert.match(comment, /264/);
  assert.match(comment, /266/);
  const body = migrationIssueBody(REPO, collision);
  assert.match(body, /renumber/i);
  assert.match(body, /not by dropping/i);
  assert.equal(migrationIssueTitle(REPO, collision), `pr-hygiene/paperclip: duplicate migration idx 103 across ${REPO}#264, ${REPO}#266`);
});
