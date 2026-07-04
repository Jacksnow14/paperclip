import assert from "node:assert/strict";
import test from "node:test";

import {
  validateExperimentScope,
  getExperimentIsolation,
  filterScorecardsByScope,
  measureExperimentScoped,
  scorecardMatchesScope,
} from "./sgi-loop-h-experiment-scope.mjs";

// A scorecard fixture mirroring performance/{agent}/{task_type}/{date} records.
function sc(task_type, token_cost, extra = {}) {
  return { metadata: { category: "performance_scorecard", task_type, token_cost, ...extra } };
}

test("experiment without any isolation key is refused (needs_scope)", () => {
  const record = {
    metadata: {
      category: "experiment",
      id: "9f073e41",
      status: "running",
      change_type: "prompt_edit",
      // NOTE: no task_type / target_routine / scope_selector — the AUR-3202 bug
    },
  };
  const v = validateExperimentScope(record);
  assert.equal(v.ok, false);
  assert.match(v.reason, /needs_scope/);
  // filtering must hard-refuse rather than measure the wrong workload
  assert.throws(() => filterScorecardsByScope([sc("ops", 100)], record), /needs_scope/);
  // and the measurement step parks it as needs_scope without computing anything
  const m = measureExperimentScoped(record, [sc("ops", 100), sc("design", 5000)]);
  assert.equal(m.status, "needs_scope");
  assert.equal(m.tasksMeasured, 0);
  assert.equal(m.tokensSpent, 0);
  assert.deepEqual(m.scopedScorecards, []);
});

test("task_type isolation prevents the 9f073e41 confounded-workload adoption", () => {
  // The change targeted `design` work, but the agent's window is dominated by
  // cheap ops/heartbeat tasks. Without scope, all 12 count (composition inflates
  // quality-per-token); with task_type isolation only the 2 design tasks count.
  const record = {
    metadata: { category: "experiment", id: "9f073e41", status: "running", task_type: "design" },
  };
  const window = [
    sc("ops", 200), sc("ops", 180), sc("ops", 210), sc("ops", 190),
    sc("ops", 175), sc("ops", 205), sc("ops", 195), sc("ops", 188),
    sc("heartbeat", 90), sc("heartbeat", 95),
    sc("design", 42000), sc("design", 38000),
  ];
  const m = measureExperimentScoped(record, window);
  assert.equal(m.status, "measurable");
  assert.equal(m.isolation.key, "task_type");
  // ONLY the two in-scope design scorecards are measured — not all 12.
  assert.equal(m.tasksMeasured, 2);
  assert.equal(m.tokensSpent, 80000);
  assert.ok(m.scopedScorecards.every((s) => s.metadata.task_type === "design"));
});

test("target_routine isolation matches routine-scoped scorecards", () => {
  const record = {
    metadata: {
      category: "experiment",
      status: "running",
      target_routine: "556eb4c3-aeb2-4dd3-8fcc-e8ac34ce31cf",
    },
  };
  const iso = getExperimentIsolation(record.metadata);
  assert.deepEqual(iso, { key: "target_routine", value: "556eb4c3-aeb2-4dd3-8fcc-e8ac34ce31cf" });
  assert.equal(
    scorecardMatchesScope(sc("infra", 1000, { routine_id: "556eb4c3-aeb2-4dd3-8fcc-e8ac34ce31cf" }), iso),
    true,
  );
  assert.equal(scorecardMatchesScope(sc("infra", 1000, { routine_id: "other" }), iso), false);
});

test("scope_selector isolation matches an arbitrary metadata field", () => {
  const record = {
    metadata: {
      category: "experiment",
      status: "running",
      scope_selector: { field: "project_id", value: "593af91d-6e65-47fe-9db2-cd39469548f8" },
    },
  };
  const m = measureExperimentScoped(record, [
    sc("research", 5000, { project_id: "593af91d-6e65-47fe-9db2-cd39469548f8" }),
    sc("research", 5000, { project_id: "other-project" }),
  ]);
  assert.equal(m.status, "measurable");
  assert.equal(m.tasksMeasured, 1);
  assert.equal(m.tokensSpent, 5000);
});

test("isolation-key precedence: task_type wins over the others", () => {
  const iso = getExperimentIsolation({
    task_type: "bug",
    target_routine: "r1",
    scope_selector: { field: "x", value: "y" },
  });
  assert.equal(iso.key, "task_type");
});

test("empty-string / whitespace isolation values do not satisfy the guard", () => {
  assert.equal(validateExperimentScope({ metadata: { task_type: "" } }).ok, false);
  assert.equal(validateExperimentScope({ metadata: { task_type: "   " } }).ok, false);
  assert.equal(validateExperimentScope({ metadata: { scope_selector: {} } }).ok, false);
});
