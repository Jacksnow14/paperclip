import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchWindowedRecords,
  aggregateScores,
  quartileThreshold,
  hasLoopCRecord,
  withinCooldown,
  isoWeekYear,
  evaluateGates,
} from './sgi-loop-f2-retire-watchdog.mjs';

const REF_DATE = new Date('2026-07-06T00:00:00Z');

function daysAgoIso(refDate, days) {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function makeRecord(agentId, daysAgo, overrides = {}) {
  return {
    id: `${agentId}-${daysAgo}-${Math.random()}`,
    createdAt: daysAgoIso(REF_DATE, daysAgo),
    metadata: {
      category: 'scorecard_adjusted',
      agent_id: agentId,
      score_adjusted: 1,
      quality_signal: 3,
      task_type: 'feature',
      ...overrides,
    },
  };
}

// ── fetchWindowedRecords: pagination stops at the window boundary ──────────

test('fetchWindowedRecords pages until it sees a record past the fetch window, then stops', async () => {
  // 60 records, 1 per day, newest first (descending createdAt) — matches API sort order.
  const allRecords = Array.from({ length: 60 }, (_, i) => makeRecord('agent-a', i));
  const pageLimit = 5;
  const calls = [];

  const get = async (path) => {
    calls.push(path);
    const offsetMatch = /offset=(\d+)/.exec(path);
    const offset = Number(offsetMatch[1]);
    return { records: allRecords.slice(offset, offset + pageLimit) };
  };

  // windowDays=10, cooldownDays=10 → fetch boundary is 10 days back.
  const result = await fetchWindowedRecords(get, 'co-1', {
    refDate: REF_DATE, windowDays: 10, cooldownDays: 10, pageLimit, maxPages: 20,
  });

  // Records 0..9 are within 10 days; page containing day 10 (the 3rd page,
  // offset=10..14) triggers the stop condition once its oldest record (day 14)
  // is older than the boundary.
  assert.ok(result.pages < 20, 'must stop before hitting the page cap');
  assert.ok(!result.hitPageCap);
  assert.ok(result.accumulated.length < allRecords.length, 'must not accumulate the full 60-day history');
  assert.ok(result.accumulated.length >= 10, 'must accumulate at least the full window');

  // windowed set only keeps records inside the 10-day scoring window. The
  // cutoff is inclusive (>=), so day 0..10 (11 records) fall inside it —
  // only a record strictly older than the cutoff is excluded.
  assert.equal(result.windowed.length, 11);
  for (const r of result.windowed) {
    assert.ok(r.createdAt >= result.scoreCutoffIso);
  }
});

test('fetchWindowedRecords fetches out to cooldownDays even when windowDays is smaller', async () => {
  // 45 daily records; windowDays=28 but cooldownDays=30 — fetch must reach day 30.
  const allRecords = Array.from({ length: 45 }, (_, i) => makeRecord('agent-a', i));
  const pageLimit = 10;
  const get = async (path) => {
    const offset = Number(/offset=(\d+)/.exec(path)[1]);
    return { records: allRecords.slice(offset, offset + pageLimit) };
  };

  const result = await fetchWindowedRecords(get, 'co-1', {
    refDate: REF_DATE, windowDays: 28, cooldownDays: 30, pageLimit, maxPages: 20,
  });

  // Accumulated set must reach at least 30 days back (fetchCutoffIso uses max(28,30)=30).
  const oldestAccumulated = allRecords[allRecords.length - 1] ? result.accumulated.at(-1) : null;
  assert.ok(result.accumulated.length >= 30, 'accumulated set must cover at least the 30-day cooldown window');
  // Scoring window stays bounded to 28 days (inclusive cutoff → days 0..28 = 29 records).
  assert.equal(result.windowed.length, 29);
});

test('fetchWindowedRecords stops on a short (final) page even before the boundary', async () => {
  // Only 5 records total, well within any window — API returns a short page and stops.
  const allRecords = Array.from({ length: 5 }, (_, i) => makeRecord('agent-a', i));
  const get = async (path) => {
    const offset = Number(/offset=(\d+)/.exec(path)[1]);
    return { records: allRecords.slice(offset, offset + 200) };
  };

  const result = await fetchWindowedRecords(get, 'co-1', {
    refDate: REF_DATE, windowDays: 28, cooldownDays: 30, pageLimit: 200, maxPages: 20,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.accumulated.length, 5);
  assert.equal(result.windowed.length, 5);
});

test('fetchWindowedRecords hits MAX_PAGES cap and reports it (no silent truncation)', async () => {
  // windowDays/cooldownDays (1000) must exceed maxPages*pageLimit (3*50=150)
  // so the cap — not the window boundary — is what stops the loop.
  const allRecords = Array.from({ length: 2000 }, (_, i) => makeRecord('agent-a', i));
  const pageLimit = 50;
  const get = async (path) => {
    const offset = Number(/offset=(\d+)/.exec(path)[1]);
    return { records: allRecords.slice(offset, offset + pageLimit) };
  };

  const result = await fetchWindowedRecords(get, 'co-1', {
    refDate: REF_DATE, windowDays: 1000, cooldownDays: 1000, pageLimit, maxPages: 3,
  });

  assert.equal(result.pages, 3);
  assert.ok(result.hitPageCap);
  assert.equal(result.accumulated.length, 3 * pageLimit);
});

test('fetchWindowedRecords returns empty sets when the API has no records', async () => {
  const get = async () => ({ records: [] });
  const result = await fetchWindowedRecords(get, 'co-1', { refDate: REF_DATE, windowDays: 28 });
  assert.equal(result.accumulated.length, 0);
  assert.equal(result.windowed.length, 0);
  assert.equal(result.pages, 0);
  assert.ok(!result.hitPageCap);
});

test('fetchWindowedRecords treats a 404 (_notFound) response as an empty page', async () => {
  const get = async () => ({ _notFound: true });
  const result = await fetchWindowedRecords(get, 'co-1', { refDate: REF_DATE, windowDays: 28 });
  assert.equal(result.accumulated.length, 0);
  assert.equal(result.pages, 0);
});

// ── evaluateGates: fire-path exercised via fixtures (AUR-3287 requirement) ─

test('evaluateGates fires a proposal for a sustained bottom-quartile, low-quality, n>=8 agent', () => {
  // "bad-agent": 8 samples, low quality (<3.5), low score_adjusted -> bottom quartile.
  const badAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('bad-agent', i, { score_adjusted: 0.01, quality_signal: 2 })
  );
  // A higher-scoring peer group to establish a meaningful Q1 threshold above bad-agent's score.
  const goodAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('good-agent', i, { score_adjusted: 5, quality_signal: 4.5 })
  );
  const midAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('mid-agent', i, { score_adjusted: 2, quality_signal: 2.5 })
  );

  const windowed = [...badAgentRecords, ...goodAgentRecords, ...midAgentRecords];

  // Loop C approved record + no cooldown record for bad-agent, in the accumulated set.
  const accumulated = [
    ...windowed,
    {
      id: 'loop-c-bad-agent',
      createdAt: daysAgoIso(REF_DATE, 5),
      title: 'prompt-improvement-proposal/bad-agent/2026-06-01',
      metadata: { outcome: 'approved' },
    },
  ];

  const result = evaluateGates(windowed, accumulated, REF_DATE);

  assert.equal(result.proposals.length, 1, 'exactly one agent should clear all 5 gates');
  assert.equal(result.proposals[0].agentId, 'bad-agent');
  assert.equal(result.proposals[0].idempotencyKey, `f2-retire-bad-agent-${result.isoYear}-W${String(result.isoWeek).padStart(2, '0')}`);
  assert.ok(!result.exemptedByQuality.some(a => a.agentId === 'bad-agent'));
  assert.ok(result.bottomQ.some(a => a.agentId === 'bad-agent'));
});

test('evaluateGates skips a qualifying bottom-quartile agent without an approved Loop C record', () => {
  const badAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('bad-agent-no-loop-c', i, { score_adjusted: 0.01, quality_signal: 2 })
  );
  const goodAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('good-agent', i, { score_adjusted: 5, quality_signal: 4.5 })
  );

  const windowed = [...badAgentRecords, ...goodAgentRecords];
  const result = evaluateGates(windowed, windowed, REF_DATE);

  assert.equal(result.proposals.length, 0);
  assert.ok(result.skipped.some(s => s.agentId === 'bad-agent-no-loop-c' && s.reason.includes('Loop C')));
});

test('evaluateGates skips a qualifying agent within the 30-day cooldown', () => {
  const badAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('bad-agent-cooldown', i, { score_adjusted: 0.01, quality_signal: 2 })
  );
  const goodAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('good-agent', i, { score_adjusted: 5, quality_signal: 4.5 })
  );
  const windowed = [...badAgentRecords, ...goodAgentRecords];
  const accumulated = [
    ...windowed,
    {
      id: 'loop-c',
      createdAt: daysAgoIso(REF_DATE, 5),
      title: 'prompt-improvement-proposal/bad-agent-cooldown/2026-06-01',
      metadata: { outcome: 'approved' },
    },
    {
      id: 'cooldown',
      createdAt: daysAgoIso(REF_DATE, 10),
      title: `capacity-decisions/bad-agent-cooldown/${REF_DATE.toISOString().slice(0,10)}`,
      metadata: { category: 'capacity_decisions' },
    },
  ];

  const result = evaluateGates(windowed, accumulated, REF_DATE);
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skipped.some(s => s.agentId === 'bad-agent-cooldown' && s.reason.includes('capacity-decisions record exists within last')));
});

test('evaluateGates exempts a low-scoring agent whose mean quality is >= 3.5 (value-signal bias guard)', () => {
  const exemptRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('exempt-agent', i, { score_adjusted: 0.01, quality_signal: 4 })
  );
  const goodAgentRecords = Array.from({ length: 8 }, (_, i) =>
    makeRecord('good-agent', i, { score_adjusted: 5, quality_signal: 4.5 })
  );
  const windowed = [...exemptRecords, ...goodAgentRecords];
  const result = evaluateGates(windowed, windowed, REF_DATE);

  assert.equal(result.proposals.length, 0);
  assert.ok(result.exemptedByQuality.some(a => a.agentId === 'exempt-agent'));
});

test('evaluateGates does not qualify an agent with fewer than 8 samples', () => {
  const smallAgentRecords = Array.from({ length: 3 }, (_, i) =>
    makeRecord('small-agent', i, { score_adjusted: 0.01, quality_signal: 1 })
  );
  const result = evaluateGates(smallAgentRecords, smallAgentRecords, REF_DATE);
  assert.equal(result.qualifying.length, 0);
  assert.equal(result.proposals.length, 0);
});

// ── existing pure helpers, sanity-checked in isolation ─────────────────────

test('aggregateScores groups by agent_id and computes means', () => {
  const records = [
    makeRecord('a1', 0, { score_adjusted: 2, quality_signal: 4 }),
    makeRecord('a1', 1, { score_adjusted: 4, quality_signal: 2 }),
  ];
  const agents = aggregateScores(records);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].n, 2);
  assert.equal(agents[0].meanScore, 3);
  assert.equal(agents[0].meanQuality, 3);
});

test('quartileThreshold returns the value at the 25th percentile index', () => {
  assert.equal(quartileThreshold([4, 3, 2, 1]), 2); // sorted [1,2,3,4], idx=floor(4*0.25)=1 -> 2
});

test('hasLoopCRecord requires outcome approved', () => {
  const records = [
    { title: 'prompt-improvement-proposal/a1/x', metadata: { outcome: 'rejected' } },
  ];
  assert.ok(!hasLoopCRecord(records, 'a1'));
  records.push({ title: 'prompt-improvement-proposal/a1/y', metadata: { outcome: 'approved' } });
  assert.ok(hasLoopCRecord(records, 'a1'));
});

test('withinCooldown detects a recent capacity-decisions record', () => {
  const records = [
    { title: 'capacity-decisions/a1/2026-06-20', createdAt: daysAgoIso(REF_DATE, 10) },
  ];
  assert.ok(withinCooldown(records, 'a1', REF_DATE));
  assert.ok(!withinCooldown(records, 'a2', REF_DATE));
});

test('withinCooldown ignores a capacity-decisions record older than 30 days', () => {
  const records = [
    { title: 'capacity-decisions/a1/2026-05-01', createdAt: daysAgoIso(REF_DATE, 40) },
  ];
  assert.ok(!withinCooldown(records, 'a1', REF_DATE));
});

test('isoWeekYear returns the ISO week for a known date', () => {
  const { year, week } = isoWeekYear(new Date('2026-07-06T00:00:00Z'));
  assert.equal(year, 2026);
  assert.equal(typeof week, 'number');
});
