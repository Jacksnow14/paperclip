import assert from "node:assert/strict";
import test from "node:test";

import {
  measureExperiment,
  decideAdopt,
  scorecardsForAgent,
  measuredDeltaPct,
} from "./sgi-loop-h-experiment-watchdog.mjs";

// A scorecard fixture mirroring a raw performance/{agent}/{task_type}/{date} record.
function sc(agentId, taskType, tokenCost, createdAt, extra = {}) {
  return {
    createdAt,
    metadata: {
      category: "performance_scorecard",
      agent_id: agentId,
      task_type: taskType,
      token_cost: tokenCost,
      quality_signal: 4,
      ...extra,
    },
  };
}

function exp(overrides = {}) {
  return {
    id: "rec-1",
    metadata: {
      category: "experiment",
      id: "exp-1",
      status: "running",
      target_agent_id: "agent-1",
      task_type: "ops",
      run_start_date: "2026-07-01",
      horizon_tasks: 5,
      budget_cap_tokens: 0,
      expected_metric: "quality_signal",
      expected_delta: "+10%",
      ...overrides,
    },
  };
}

test("scope gate parks needs_scope BEFORE any cap-sanity/horizon/budget computation", () => {
  const record = exp({ task_type: undefined });
  // Give it a horizon that's trivially met and a budget that's trivially blown —
  // if the scope gate didn't run first, this would fall through to measured or
  // rejected_budget instead of needs_scope.
  const period = Array.from({ length: 20 }, (_, i) => sc("agent-1", "ops", 100000, "2026-07-02", { task_type: undefined }));
  const result = measureExperiment(record, period, []);
  assert.equal(result.action, "needs_scope");
  assert.equal(result.recalibration, null);
  assert.match(result.reason, /needs_scope/);
});

test("gate order: horizon reached wins over an already-exceeded budget cap (AUR-2471)", () => {
  const record = exp({ horizon_tasks: 3, budget_cap_tokens: 100, p95_per_task_cost: 100 });
  // 3 in-scope tasks, well past horizon; tokens_spent (300000) is also way past
  // the tiny cap of 100 — but horizon-first must still win.
  const period = [
    sc("agent-1", "ops", 100000, "2026-07-02"),
    sc("agent-1", "ops", 100000, "2026-07-03"),
    sc("agent-1", "ops", 100000, "2026-07-04"),
  ];
  const baseline = [sc("agent-1", "ops", 50000, "2026-06-20", { quality_signal: 3 })];
  const result = measureExperiment(record, period, baseline);
  assert.equal(result.action, "measured");
  assert.equal(result.tasksMeasured, 3);
  assert.equal(result.tokensSpent, 300000);
});

test("cap-sanity guard recalibrates a mis-set (unset) cap instead of rejecting on budget", () => {
  // budget_cap_tokens=0 (unset) with horizon=20, p95=55000 default -> reachable=1,100,000.
  // Only 2 tasks measured so far, well under horizon; spend so far (200000) is
  // below even the OLD flat cap semantics would matter, but the key assertion is
  // that recalibration happened and status stayed accruing, not rejected.
  const record = exp({ horizon_tasks: 20, budget_cap_tokens: 0 });
  const period = [
    sc("agent-1", "ops", 100000, "2026-07-02"),
    sc("agent-1", "ops", 100000, "2026-07-03"),
  ];
  const result = measureExperiment(record, period, []);
  assert.equal(result.action, "accruing");
  assert.ok(result.recalibration, "expected a recalibration to be computed");
  assert.equal(result.recalibration.oldCap, 0);
  assert.equal(result.recalibration.reachable, 20 * 55000);
  assert.equal(result.recalibration.newCap, Math.ceil(20 * 55000 * 1.5));
});

test("cap-sanity guard rescues a legacy flat 50000 cap that would otherwise trip before the horizon", () => {
  const record = exp({ horizon_tasks: 20, budget_cap_tokens: 50000, p95_per_task_cost: 55000 });
  // Spend already exceeds the legacy flat cap but not the recalibrated one.
  const period = [sc("agent-1", "ops", 60000, "2026-07-02")];
  const result = measureExperiment(record, period, []);
  assert.equal(result.action, "accruing");
  assert.ok(result.recalibration);
  assert.equal(result.recalibration.oldCap, 50000);
  assert.ok(result.recalibration.newCap > 60000, "recalibrated cap must clear current spend");
});

test("runaway ceiling fires only when horizon is NOT reached and cap is properly calibrated", () => {
  const record = exp({ horizon_tasks: 20, budget_cap_tokens: 1650000, p95_per_task_cost: 55000 });
  // Only 3 of 20 tasks measured, but token spend blew way past a correctly
  // calibrated cap -> genuine runaway, not a mis-set cap.
  const period = [
    sc("agent-1", "ops", 900000, "2026-07-02"),
    sc("agent-1", "ops", 900000, "2026-07-03"),
    sc("agent-1", "ops", 900000, "2026-07-04"),
  ];
  const result = measureExperiment(record, period, []);
  assert.equal(result.action, "rejected_budget");
  assert.equal(result.recalibration, null);
  assert.equal(result.tokensSpent, 2700000);
});

test("measured_delta is computed ONLY from isolation-scoped scorecards (AUR-3202 confound guard)", () => {
  const record = exp({ task_type: "design", horizon_tasks: 2, budget_cap_tokens: 1650000, expected_metric: "quality_signal" });
  const period = [
    // in-scope (design): quality 5, 5
    sc("agent-1", "design", 40000, "2026-07-02", { quality_signal: 5 }),
    sc("agent-1", "design", 40000, "2026-07-03", { quality_signal: 5 }),
    // out-of-scope (ops) — must NOT count toward tasksMeasured or the delta
    sc("agent-1", "ops", 200, "2026-07-02", { quality_signal: 1 }),
    sc("agent-1", "ops", 200, "2026-07-03", { quality_signal: 1 }),
  ];
  const baseline = [
    sc("agent-1", "design", 35000, "2026-06-20", { quality_signal: 4 }),
  ];
  const result = measureExperiment(record, period, baseline);
  assert.equal(result.action, "measured");
  assert.equal(result.tasksMeasured, 2); // NOT 4
  assert.equal(result.isolation.key, "task_type");
  // baseline quality 4 -> period quality 5 -> +25%, not dragged down by ops quality=1.
  assert.equal(result.delta.pct, 25);
});

test("decideAdopt: measured delta must meet or exceed expected", () => {
  assert.equal(decideAdopt("+10%", "+10%"), true);
  assert.equal(decideAdopt("+11%", "+10%"), true);
  assert.equal(decideAdopt("+9%", "+10%"), false);
  assert.equal(decideAdopt(null, "+10%"), false);
  assert.equal(decideAdopt("+10%", null), false);
});

test("scorecardsForAgent splits by run_start_date and filters by agent_id", () => {
  const all = [
    sc("agent-1", "ops", 100, "2026-06-25"), // baseline
    sc("agent-1", "ops", 200, "2026-07-01"), // period (on run_start_date)
    sc("agent-1", "ops", 300, "2026-07-05"), // period
    sc("agent-2", "ops", 999, "2026-07-05"), // different agent — excluded
  ];
  const { period, baseline } = scorecardsForAgent(all, "agent-1", "2026-07-01");
  assert.equal(period.length, 2);
  assert.equal(baseline.length, 1);
});

test("measuredDeltaPct inverts sign for rework_rate (lower is better)", () => {
  const baseline = [{ rework_required: true }, { rework_required: false }]; // 50% rework
  const period = [{ rework_required: false }, { rework_required: false }]; // 0% rework
  const d = measuredDeltaPct("rework_rate", baseline, period);
  // rework dropped from 50% to 0% — an improvement, so pct must be POSITIVE.
  assert.equal(d.pct, 100);
});
