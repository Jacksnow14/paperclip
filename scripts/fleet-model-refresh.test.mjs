import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeId,
  parseCodexId,
  bestClaude,
  latestClaudeFamily,
  latestCodexTier,
  bumpCandidates,
  resolveTarget,
  shouldTune,
  buildTuningIssuePayload,
  PLATFORM_LABEL_ID,
} from './fleet-model-refresh.mjs';

const CLAUDE = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5'];
const CODEX = ['gpt-5-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'];

test('id parsing handles both single and dashed/dotted versions', () => {
  assert.deepEqual(parseClaudeId('claude-opus-4-8'), { family: 'opus', ver: [4, 8] });
  assert.deepEqual(parseClaudeId('claude-fable-5'), { family: 'fable', ver: [5] });
  assert.equal(parseClaudeId('claude-bogus-9'), null);
  assert.deepEqual(parseCodexId('gpt-5.4-mini'), { ver: [5, 4], tier: 'mini' });
  assert.deepEqual(parseCodexId('gpt-6'), { ver: [6], tier: 'full' });
});

test('frontier ranking: fable outranks opus regardless of version', () => {
  assert.equal(bestClaude(CLAUDE), 'claude-fable-5');
  assert.equal(bestClaude(['claude-opus-5', 'claude-opus-4-8']), 'claude-opus-5');
  assert.equal(latestClaudeFamily(CLAUDE, 'opus'), 'claude-opus-5');
  assert.equal(latestCodexTier(CODEX, 'full'), 'gpt-5.5');
  assert.equal(latestCodexTier(CODEX, 'mini'), 'gpt-5.4-mini');
});

test('a newly released fable-6 immediately becomes the frontier', () => {
  assert.equal(bestClaude([...CLAUDE, 'claude-fable-6']), 'claude-fable-6');
  assert.equal(latestClaudeFamily([...CLAUDE, 'claude-fable-6'], 'fable'), 'claude-fable-6');
});

test('bumpCandidates proposes plausible next releases, never known ids', () => {
  const c = bumpCandidates(CLAUDE);
  assert.ok(c.includes('claude-fable-6'));
  assert.ok(c.includes('claude-opus-6'));
  assert.ok(c.includes('claude-opus-4-9'));
  assert.ok(c.includes('claude-opus-5-1'));
  assert.ok(c.includes('claude-opus-5.1'));
  for (const known of CLAUDE) assert.ok(!c.includes(known));
  const g = bumpCandidates(CODEX);
  assert.ok(g.includes('gpt-5.6'));
  assert.ok(g.includes('gpt-6'));
  assert.ok(g.includes('gpt-5.5-mini'));
});

test('policy: CEO=latest opus, CCM=latest fable, CCF=latest sonnet, default keeps family/tier', () => {
  const policy = {
    agents: {
      CEO: { rule: 'latest-family:opus', effort: 'xhigh' },
      'Claude Code Max': { rule: 'latest-family:fable', effort: 'xhigh' },
      'Claude Code Fast': { rule: 'latest-family:sonnet', effort: 'keep' },
    },
    default: { rule: 'latest-same-tier', effort: 'keep' },
  };
  const available = { claude_local: CLAUDE, codex_local: CODEX };
  const ceo = resolveTarget(
    { name: 'CEO', adapterType: 'claude_local', model: 'claude-fable-5', adapterConfig: {} },
    policy,
    available,
  );
  assert.deepEqual(ceo, { model: 'claude-opus-5', effort: 'xhigh' });
  const ccf = resolveTarget(
    { name: 'Claude Code Fast', adapterType: 'claude_local', model: 'claude-sonnet-4-6', adapterConfig: {} },
    policy,
    available,
  );
  assert.deepEqual(ccf, { model: 'claude-sonnet-5', effort: null });
  const opus51 = resolveTarget(
    { name: 'CEO', adapterType: 'claude_local', model: 'claude-opus-5', adapterConfig: {} },
    policy,
    { claude_local: [...CLAUDE, 'claude-opus-5.1'], codex_local: CODEX },
  );
  assert.deepEqual(opus51, { model: 'claude-opus-5.1', effort: 'xhigh' });
  const ccm = resolveTarget(
    { name: 'Claude Code Max', adapterType: 'claude_local', model: 'claude-fable-5', adapterConfig: {} },
    policy,
    available,
  );
  assert.equal(ccm.model, 'claude-fable-5');
  const junior = resolveTarget(
    { name: 'Junior Coder', adapterType: 'codex_local', model: 'gpt-5.4-mini', adapterConfig: {} },
    policy,
    available,
  );
  assert.deepEqual(junior, { model: 'gpt-5.4-mini', effort: null });
  const cmo = resolveTarget(
    { name: 'CMO', adapterType: 'codex_local', model: 'gpt-5.4', adapterConfig: {} },
    policy,
    available,
  );
  assert.equal(cmo.model, 'gpt-5.5');
});

test('tuning dispatch: on new models immediately, otherwise every N days', () => {
  const now = Date.parse('2026-08-06T06:30:00Z');
  assert.equal(
    shouldTune({ modelsChanged: true, lastTuningAt: '2026-08-06T00:00:00Z', nowMs: now, minDaysBetween: 6 }),
    true,
  );
  assert.equal(
    shouldTune({ modelsChanged: false, lastTuningAt: '2026-08-05T06:00:00Z', nowMs: now, minDaysBetween: 6 }),
    false,
  );
  assert.equal(
    shouldTune({ modelsChanged: false, lastTuningAt: '2026-07-30T06:00:00Z', nowMs: now, minDaysBetween: 6 }),
    true,
  );
  assert.equal(
    shouldTune({ modelsChanged: false, lastTuningAt: null, nowMs: now, minDaysBetween: 6 }),
    true,
  );
});

// ---------------------------------------------------------------------------
// AUR-6215: the daily fleet-tuning issue is self-improvement/platform work,
// never critical, so it must file as backlog + platform label, not todo.
// ---------------------------------------------------------------------------

test('fleet-tuning issue is created as backlog with the platform label, not todo', () => {
  const payload = buildTuningIssuePayload({
    reviewerId: 'agent-1',
    newModels: [],
    minDays: 6,
    nowIso: '2026-08-26T00:00:00Z',
  });
  assert.equal(payload.status, 'backlog');
  assert.deepEqual(payload.labelIds, [PLATFORM_LABEL_ID]);
  assert.notEqual(payload.status, 'todo');
  assert.equal(payload.priority, 'medium');
});

test('fleet-tuning issue payload still carries title, description and assignee', () => {
  const payload = buildTuningIssuePayload({
    reviewerId: 'agent-1',
    newModels: ['claude-fable-5'],
    minDays: 6,
    nowIso: '2026-08-26T00:00:00Z',
  });
  assert.match(payload.title, /fleet-tuning: re-evaluate agent models\/effort\/prompts.*2026-08-26/);
  assert.match(payload.description, /newly available model\(s\): claude-fable-5/);
  assert.equal(payload.assigneeAgentId, 'agent-1');
});
