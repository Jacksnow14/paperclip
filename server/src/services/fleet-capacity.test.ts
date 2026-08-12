// Reset-clock parsing in the adapter extractors resolves "resets 9pm" against
// the host-local clock; the fixtures below are authored in UTC, so pin it
// before any Date is constructed.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
  applyLaneDownRollup,
  classifyAgentCapacity,
  computeFleetCapacity,
  type FleetCapacityAgentInput,
  type FleetCapacityRunInput,
} from "./fleet-capacity.js";

/**
 * Frozen fixtures recorded from the live fleet at 2026-07-29T23:21Z (AUR-4385
 * issue thread). The fleet is live and moves — these histories are recorded
 * state, deliberately NOT re-derived from the live API, so the classification
 * they encode stays reproducible.
 */
const NOW = new Date("2026-07-29T23:21:39Z");

const CLAUDE_SESSION_LIMIT_RESET =
  "You've hit your session limit ∙ resets 9pm";
const CODEX_QUOTA_NO_RESET = "You've hit your usage limit for gpt-5.5.";
const CODEX_QUOTA_WITH_RESET =
  "You've hit your usage limit for gpt-5.5. Switch to another model now, or try again at 8pm.";
const PROMPT_TOO_LONG = "Prompt is too long";

function run(status: string, createdAt: string, error?: string): FleetCapacityRunInput {
  return { status, createdAt, finishedAt: createdAt, error: error ?? null };
}

/** n runs of `status`, one minute apart, newest at `newestIso`. */
function runSeries(n: number, status: string, newestIso: string, error?: string): FleetCapacityRunInput[] {
  const newest = Date.parse(newestIso);
  return Array.from({ length: n }, (_, i) => run(status, new Date(newest - i * 60_000).toISOString(), error));
}

function agent(id: string, name: string, adapterType: string, pausedAt: string | null = null): FleetCapacityAgentInput {
  return { id, name, adapterType, pausedAt };
}

// --- Discrimination-target fixtures (frozen from the 23:21Z live read) -------

const cmoOps = agent("69dca828", "CMO Ops", "codex_local");
const cmoOpsRuns = [
  ...runSeries(13, "failed", "2026-07-28T09:00:00Z", CODEX_QUOTA_NO_RESET),
  run("succeeded", "2026-07-26T05:05:00Z"),
];

const claudeCodeFast = agent("38c3252d", "Claude Code Fast", "claude_local");
const claudeCodeFastRuns = [
  ...runSeries(51, "queued", "2026-07-29T23:00:00Z"),
  ...runSeries(6, "failed", "2026-07-29T14:00:00Z", CLAUDE_SESSION_LIMIT_RESET),
  run("succeeded", "2026-07-29T10:51:00Z"),
];

const predictor = agent("0c420665", "Predictor", "claude_local");
const predictorRuns = [
  ...runSeries(11, "failed", "2026-07-29T13:30:00Z", CLAUDE_SESSION_LIMIT_RESET),
  run("succeeded", "2026-07-29T09:00:00Z"),
];

const cto = agent("371a1b08", "CTO", "claude_local");
const ctoRuns = [
  ...runSeries(75, "queued", "2026-07-29T23:10:00Z"),
  // Cancelled newer than the last success: must be neutral, not a failure.
  run("cancelled", "2026-07-29T23:05:00Z"),
  run("succeeded", "2026-07-29T23:03:00Z"),
  ...runSeries(4, "failed", "2026-07-29T12:00:00Z", CLAUDE_SESSION_LIMIT_RESET),
];

const ctoOps = agent("441a5729", "CTO Ops", "codex_local");
// The same agent, two recorded histories, two answers — proves the classifier
// reads history, not identity.
const ctoOpsLiveRuns = [
  ...runSeries(9, "queued", "2026-07-29T23:15:00Z"),
  run("running", "2026-07-29T23:00:00Z"),
  run("succeeded", "2026-07-29T21:38:52Z"),
  ...runSeries(37, "failed", "2026-07-26T12:46:00Z", CODEX_QUOTA_NO_RESET),
];
const ctoOpsFrozen0726Runs = [
  ...runSeries(2, "queued", "2026-07-29T11:00:00Z"),
  run("cancelled", "2026-07-28T12:00:00Z"),
  ...runSeries(37, "failed", "2026-07-26T12:46:00Z", CODEX_QUOTA_NO_RESET),
];

const claudeCodeMax = agent("e8f947d2", "Claude Code Max", "claude_local");
const claudeCodeMaxRuns = [
  run("succeeded", "2026-07-29T17:26:00Z"),
  ...runSeries(8, "failed", "2026-07-29T09:30:00Z", CLAUDE_SESSION_LIMIT_RESET),
];

const juniorCoder = agent("81cd7e79", "Junior Coder", "claude_local");
const juniorCoderLiveRuns = [
  run("succeeded", "2026-07-29T22:00:00Z"),
  ...runSeries(38, "failed", "2026-07-29T20:00:00Z", PROMPT_TOO_LONG),
];

const scriptWriter = agent("a7adf6b0", "Script Writer", "claude_local");

describe("classifyAgentCapacity — discrimination target (frozen 23:21Z fleet)", () => {
  it("CMO Ops: quota tail, no reset hint in codex text, no success since -> false/quota_exhausted", () => {
    const row = classifyAgentCapacity(cmoOps, cmoOpsRuns, NOW);
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("quota_exhausted");
    expect(row.consecutiveFailures).toBe(13);
    expect(row.lastSuccessfulRunAt).toBe("2026-07-26T05:05:00.000Z");
  });

  it("Claude Code Fast: quota tail, reset boundary (21:00Z) passed, unproven -> true/quota_reset_unverified", () => {
    const row = classifyAgentCapacity(claudeCodeFast, claudeCodeFastRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("quota_reset_unverified");
    expect(row.queueDepth).toBe(51);
  });

  it("Claude Code Fast history evaluated BEFORE the reset boundary -> false/quota_exhausted", () => {
    const row = classifyAgentCapacity(claudeCodeFast, claudeCodeFastRuns, new Date("2026-07-29T15:00:00Z"));
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("quota_exhausted");
  });

  it("Predictor: 11-deep quota tail past reset -> true/quota_reset_unverified", () => {
    const row = classifyAgentCapacity(predictor, predictorRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("quota_reset_unverified");
    expect(row.consecutiveFailures).toBe(11);
  });

  it("CTO: 75 queued but succeeding -> true/ok (deep-but-healthy control; cancelled run is neutral)", () => {
    const row = classifyAgentCapacity(cto, ctoRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
    expect(row.queueDepth).toBe(75);
    expect(row.consecutiveFailures).toBe(0);
  });

  it("CTO Ops live history: recovered -> true/ok", () => {
    const row = classifyAgentCapacity(ctoOps, ctoOpsLiveRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
    expect(row.lastSuccessfulRunAt).toBe("2026-07-29T21:38:52.000Z");
  });

  it("CTO Ops frozen 07-26 history (the description's regression fixture): -> false/quota_exhausted", () => {
    const row = classifyAgentCapacity(ctoOps, ctoOpsFrozen0726Runs, new Date("2026-07-29T11:35:00Z"));
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("quota_exhausted");
    expect(row.consecutiveFailures).toBe(37);
    expect(row.lastSuccessfulRunAt).toBeNull();
  });

  it("same agent, two histories, two answers", () => {
    const live = classifyAgentCapacity(ctoOps, ctoOpsLiveRuns, NOW);
    const frozen = classifyAgentCapacity(ctoOps, ctoOpsFrozen0726Runs, new Date("2026-07-29T11:35:00Z"));
    expect(live.canExecuteNow).toBe(true);
    expect(frozen.canExecuteNow).toBe(false);
  });

  it("Claude Code Max: succeeded after quota tail -> true/ok (success breaks the tail)", () => {
    const row = classifyAgentCapacity(claudeCodeMax, claudeCodeMaxRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
    expect(row.consecutiveFailures).toBe(0);
  });

  it("Junior Coder live: newest terminal run succeeded -> true/ok", () => {
    const row = classifyAgentCapacity(juniorCoder, juniorCoderLiveRuns, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
  });

  it("Script Writer: zero runs -> true/no_recent_runs (dormant is informational, not a block)", () => {
    const row = classifyAgentCapacity(scriptWriter, [], NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("no_recent_runs");
  });
});

describe("classifyAgentCapacity — negative controls and remaining reasons", () => {
  it("negative control 1: 'Prompt is too long' tail is consecutive_failures, NEVER quota_exhausted", () => {
    const control = [
      ...runSeries(5, "failed", "2026-07-29T22:00:00Z", PROMPT_TOO_LONG),
      run("succeeded", "2026-07-29T10:00:00Z"),
    ];
    const row = classifyAgentCapacity(juniorCoder, control, NOW);
    expect(row.reason).toBe("consecutive_failures");
    expect(row.reason).not.toBe("quota_exhausted");
    expect(row.canExecuteNow).toBe(false);
    expect(row.consecutiveFailures).toBe(5);
  });

  it("fewer than 3 non-quota failures is not a block", () => {
    const history = [
      ...runSeries(2, "failed", "2026-07-29T22:00:00Z", PROMPT_TOO_LONG),
      run("succeeded", "2026-07-29T21:00:00Z"),
    ];
    const row = classifyAgentCapacity(juniorCoder, history, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
  });

  it("paused agent is false/paused even with a healthy history", () => {
    const paused = agent("aaaa1111", "Paused Agent", "claude_local", "2026-07-29T20:00:00Z");
    const row = classifyAgentCapacity(paused, [run("succeeded", "2026-07-29T22:00:00Z")], NOW);
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("paused");
  });

  it("last success older than 14d is dormant (no_recent_runs), not ok", () => {
    const row = classifyAgentCapacity(scriptWriter, [run("succeeded", "2026-07-01T00:00:00Z")], NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("no_recent_runs");
  });

  it("codex reset hint ('try again at 8pm') past the boundary -> quota_reset_unverified", () => {
    const history = [
      ...runSeries(4, "failed", "2026-07-29T15:00:00Z", CODEX_QUOTA_WITH_RESET),
      run("succeeded", "2026-07-29T08:00:00Z"),
    ];
    const row = classifyAgentCapacity(cmoOps, history, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("quota_reset_unverified");
  });

  it("cancelled runs neither break nor extend a failure tail", () => {
    const history = [
      run("cancelled", "2026-07-29T23:00:00Z"),
      ...runSeries(2, "failed", "2026-07-29T22:00:00Z", PROMPT_TOO_LONG),
      run("cancelled", "2026-07-29T21:00:00Z"),
      ...runSeries(2, "failed", "2026-07-29T20:00:00Z", PROMPT_TOO_LONG),
      run("succeeded", "2026-07-29T19:00:00Z"),
    ];
    const row = classifyAgentCapacity(juniorCoder, history, NOW);
    // 4 failures across the cancelled gaps: tail = 4, blocked.
    expect(row.consecutiveFailures).toBe(4);
    expect(row.reason).toBe("consecutive_failures");
  });
});

describe("applyLaneDownRollup", () => {
  it("flags lane_down when every non-dormant agent in a lane is quota_exhausted", () => {
    const a = classifyAgentCapacity(agent("a1", "Codex A", "codex_local"), cmoOpsRuns, NOW);
    const b = classifyAgentCapacity(agent("b2", "Codex B", "codex_local"), cmoOpsRuns, NOW);
    const dormant = classifyAgentCapacity(agent("c3", "Codex Dormant", "codex_local"), [], NOW);
    const healthyOtherLane = classifyAgentCapacity(
      agent("d4", "Claude Healthy", "claude_local"),
      [run("succeeded", "2026-07-29T22:00:00Z")],
      NOW,
    );
    const rows = applyLaneDownRollup([a, b, dormant, healthyOtherLane]);
    expect(rows[0].reason).toBe("lane_down");
    expect(rows[1].reason).toBe("lane_down");
    expect(rows[0].canExecuteNow).toBe(false);
    expect(rows[2].reason).toBe("no_recent_runs");
    expect(rows[3].reason).toBe("ok");
  });

  it("does not flag lane_down for a single quota-exhausted agent or a mixed lane", () => {
    const solo = classifyAgentCapacity(agent("a1", "Codex A", "codex_local"), cmoOpsRuns, NOW);
    expect(applyLaneDownRollup([solo])[0].reason).toBe("quota_exhausted");

    const exhausted = classifyAgentCapacity(agent("a1", "Codex A", "codex_local"), cmoOpsRuns, NOW);
    const healthy = classifyAgentCapacity(
      agent("b2", "Codex B", "codex_local"),
      [run("succeeded", "2026-07-29T22:00:00Z")],
      NOW,
    );
    const rows = applyLaneDownRollup([exhausted, healthy]);
    expect(rows[0].reason).toBe("quota_exhausted");
    expect(rows[1].reason).toBe("ok");
  });
});

describe("computeFleetCapacity — snapshot, rollup, and the all-same-value guard", () => {
  const fleet: FleetCapacityAgentInput[] = [
    cmoOps,
    claudeCodeFast,
    predictor,
    cto,
    ctoOps,
    claudeCodeMax,
    juniorCoder,
    scriptWriter,
  ];
  const runsByAgent = new Map<string, FleetCapacityRunInput[]>([
    [cmoOps.id, cmoOpsRuns],
    [claudeCodeFast.id, claudeCodeFastRuns],
    [predictor.id, predictorRuns],
    [cto.id, ctoRuns],
    [ctoOps.id, ctoOpsLiveRuns],
    [claudeCodeMax.id, claudeCodeMaxRuns],
    [juniorCoder.id, juniorCoderLiveRuns],
    // scriptWriter intentionally absent: missing history must classify, not throw.
  ]);

  it("reproduces the frozen discrimination table", () => {
    const snapshot = computeFleetCapacity(fleet, runsByAgent, NOW);
    const byId = new Map(snapshot.agents.map((row) => [row.agentId, row]));
    expect(byId.get(cmoOps.id)).toMatchObject({ canExecuteNow: false, reason: "quota_exhausted" });
    expect(byId.get(claudeCodeFast.id)).toMatchObject({ canExecuteNow: true, reason: "quota_reset_unverified" });
    expect(byId.get(predictor.id)).toMatchObject({ canExecuteNow: true, reason: "quota_reset_unverified" });
    expect(byId.get(cto.id)).toMatchObject({ canExecuteNow: true, reason: "ok" });
    expect(byId.get(ctoOps.id)).toMatchObject({ canExecuteNow: true, reason: "ok" });
    expect(byId.get(claudeCodeMax.id)).toMatchObject({ canExecuteNow: true, reason: "ok" });
    expect(byId.get(juniorCoder.id)).toMatchObject({ canExecuteNow: true, reason: "ok" });
    expect(byId.get(scriptWriter.id)).toMatchObject({ canExecuteNow: true, reason: "no_recent_runs" });
  });

  it("all-same-value guard: the fleet must NOT share one canExecuteNow value", () => {
    // AUR-4385's own bar: a route that answers true for everyone (or false for
    // everyone) is as broken as no route. The first prototype passed every
    // other check and still returned all-true — this test exists so that
    // failure mode cannot ship again.
    const snapshot = computeFleetCapacity(fleet, runsByAgent, NOW);
    const distinct = new Set(snapshot.agents.map((row) => row.canExecuteNow));
    expect(distinct.size).toBe(2);
  });

  it("rollup counts are consistent with the rows", () => {
    const snapshot = computeFleetCapacity(fleet, runsByAgent, NOW);
    expect(snapshot.window).toEqual({ runs: 200 });
    expect(snapshot.computedAt).toBe(NOW.toISOString());
    expect(snapshot.rollup.executableNow + snapshot.rollup.blockedCount).toBe(fleet.length);
    expect(snapshot.rollup.executableNow).toBe(7);
    expect(snapshot.rollup.blockedCount).toBe(1);
    expect(snapshot.rollup.totalQueued).toBe(
      snapshot.agents.reduce((sum, row) => sum + row.queueDepth, 0),
    );
    expect(snapshot.rollup.byReason).toEqual({
      ok: 4,
      quota_exhausted: 1,
      quota_reset_unverified: 2,
      no_recent_runs: 1,
    });
    // Blocked rows carry human-readable detail; ok rows carry none.
    for (const row of snapshot.agents) {
      if (!row.canExecuteNow) expect(row.reasonDetail).toBeTruthy();
      if (row.reason === "ok") expect(row.reasonDetail).toBeNull();
    }
  });

  it("covers all seven reason values across the suite's fixtures", () => {
    // lane_down + consecutive_failures + paused come from their own tests;
    // this asserts the snapshot path yields the other four, so a refactor
    // cannot silently drop an enum value.
    const snapshot = computeFleetCapacity(fleet, runsByAgent, NOW);
    const reasons = new Set(snapshot.agents.map((row) => row.reason));
    expect(reasons).toEqual(new Set(["ok", "quota_exhausted", "quota_reset_unverified", "no_recent_runs"]));
  });
});

// AUR-5464: entitlement revocation — the failure class the 2026-08-06 org
// block proved missing. The positive fixture is the REAL error text from the
// live DB (84 failed rows, all `errorCode: adapter_failed` — no dedicated
// code exists, the text match is load-bearing).
const ORG_BLOCK_0806 =
  "Claude run failed: subtype=success: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
const TRANSIENT_429 = "Claude run failed: API Error: 429 Too Many Requests";

describe("classifyAgentCapacity — entitlement_revoked (AUR-5464)", () => {
  it("real 08-06 org-block text -> false/entitlement_revoked, even on a single failure", () => {
    const history = [
      run("failed", "2026-07-29T22:00:00Z", ORG_BLOCK_0806),
      run("succeeded", "2026-07-29T10:00:00Z"),
    ];
    const row = classifyAgentCapacity(claudeCodeMax, history, NOW);
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("entitlement_revoked");
    expect(row.reasonDetail).toContain("never auto-clears on a timer");
  });

  it("entitlement wins over quota when both appear in the tail (revocation has no reset boundary)", () => {
    const history = [
      run("failed", "2026-07-29T22:00:00Z", ORG_BLOCK_0806),
      ...runSeries(3, "failed", "2026-07-29T20:00:00Z", CLAUDE_SESSION_LIMIT_RESET),
      run("succeeded", "2026-07-29T10:00:00Z"),
    ];
    const row = classifyAgentCapacity(claudeCodeMax, history, NOW);
    expect(row.reason).toBe("entitlement_revoked");
  });

  it("a succeeded run after the revocation clears it (the only legitimate re-arm)", () => {
    const history = [
      run("succeeded", "2026-07-29T23:00:00Z"),
      run("failed", "2026-07-29T22:00:00Z", ORG_BLOCK_0806),
    ];
    const row = classifyAgentCapacity(claudeCodeMax, history, NOW);
    expect(row.canExecuteNow).toBe(true);
    expect(row.reason).toBe("ok");
  });

  it("negative control: 'Prompt is too long' is NOT entitlement_revoked", () => {
    const history = [...runSeries(5, "failed", "2026-07-29T22:00:00Z", PROMPT_TOO_LONG)];
    const row = classifyAgentCapacity(claudeCodeMax, history, NOW);
    expect(row.reason).not.toBe("entitlement_revoked");
    expect(row.reason).toBe("consecutive_failures");
  });

  it("negative control: a 429 is NOT entitlement_revoked (transient weather stays transient)", () => {
    const history = [
      ...runSeries(2, "failed", "2026-07-29T22:00:00Z", TRANSIENT_429),
      run("succeeded", "2026-07-29T21:00:00Z"),
    ];
    const row = classifyAgentCapacity(claudeCodeMax, history, NOW);
    expect(row.reason).not.toBe("entitlement_revoked");
    expect(row.canExecuteNow).toBe(true);
  });

  it("rollup: entitlement-revoked agents (pure or mixed with quota) roll up to lane_down", () => {
    const revA = classifyAgentCapacity(
      agent("e1", "Claude A", "claude_local"),
      [run("failed", "2026-07-29T22:00:00Z", ORG_BLOCK_0806), run("succeeded", "2026-07-29T10:00:00Z")],
      NOW,
    );
    const quotaB = classifyAgentCapacity(agent("e2", "Claude B", "claude_local"), [
      ...runSeries(3, "failed", "2026-07-28T09:00:00Z", CODEX_QUOTA_NO_RESET),
      run("succeeded", "2026-07-26T05:05:00Z"),
    ], NOW);
    const rows = applyLaneDownRollup([revA, quotaB]);
    expect(rows[0].reason).toBe("lane_down");
    expect(rows[1].reason).toBe("lane_down");
    expect(rows[0].reasonDetail).toContain("entitlement");
  });

  it("rollup control: one revoked + one healthy agent does NOT flag lane_down", () => {
    const revA = classifyAgentCapacity(
      agent("e1", "Claude A", "claude_local"),
      [run("failed", "2026-07-29T22:00:00Z", ORG_BLOCK_0806)],
      NOW,
    );
    const healthy = classifyAgentCapacity(
      agent("e2", "Claude B", "claude_local"),
      [run("succeeded", "2026-07-29T22:00:00Z")],
      NOW,
    );
    const rows = applyLaneDownRollup([revA, healthy]);
    expect(rows[0].reason).toBe("entitlement_revoked");
    expect(rows[1].reason).toBe("ok");
  });
});
