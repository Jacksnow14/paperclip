process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  HALF_OPEN_PROBE_INTERVAL_MS,
  LaneBreaker,
  type LaneClassificationLoader,
} from "./lane-breaker.js";
import type { FleetCapacityAgentInput, FleetCapacityRunInput } from "./fleet-capacity.js";

const T0 = Date.parse("2026-08-06T12:00:00Z");
const COMPANY = "company-1";

const ORG_BLOCK_0806 =
  "Claude run failed: subtype=success: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
const CLAUDE_SESSION_LIMIT_RESET = "You've hit your session limit ∙ resets 9pm";

function run(status: string, atMs: number, error?: string): FleetCapacityRunInput {
  const iso = new Date(atMs).toISOString();
  return { status, createdAt: iso, finishedAt: iso, error: error ?? null };
}

const AGENT: FleetCapacityAgentInput & { adapterType: string } = {
  id: "agent-1",
  name: "Claude Code Max",
  adapterType: "claude_local",
  pausedAt: null,
};

/**
 * Test harness: fixtures stand in for the DB loader, and the clock is a
 * mutable cell so half-open cadence can be driven deterministically. The dummy
 * Db only ever reaches logActivity (whose rejection the breaker swallows by
 * design) — classification never touches it because the loader is injected.
 */
function makeBreaker(fixtures: { agents?: FleetCapacityAgentInput[]; runs: FleetCapacityRunInput[] }) {
  const state = { nowMs: T0, runs: fixtures.runs };
  const load: LaneClassificationLoader = async () => ({
    agents: fixtures.agents ?? [AGENT],
    runsByAgent: new Map((fixtures.agents ?? [AGENT]).map((a) => [a.id, state.runs])),
  });
  const breaker = new LaneBreaker({ db: {} as Db, load, now: () => new Date(state.nowMs) });
  return { breaker, state };
}

const HEALTHY_RUNS = [run("succeeded", T0 - 60_000)];
const REVOKED_RUNS = [
  run("failed", T0 - 60_000, ORG_BLOCK_0806),
  run("failed", T0 - 120_000, ORG_BLOCK_0806),
  run("succeeded", T0 - 3_600_000),
];

describe("LaneBreaker — error-stream trip source", () => {
  it("PASS: a healthy lane admits normally (closed)", async () => {
    const { breaker } = makeBreaker({ runs: HEALTHY_RUNS });
    const decision = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(decision.admit).toBe(true);
    expect(decision.halfOpenProbe).toBe(false);
    expect(decision.state).toBe("closed");
  });

  it("FIRE: an entitlement-revoked lane defers admission and leaves nothing admitted", async () => {
    const { breaker } = makeBreaker({ runs: REVOKED_RUNS });
    const decision = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(decision.admit).toBe(false);
    expect(decision.state).toBe("open");
    expect(decision.trippedBy).toEqual(["error_stream"]);
    expect(decision.reason).toBe("entitlement_revoked");
  });

  it("never re-opens on a timer: days later, still only single probes, never full admission", async () => {
    const { breaker, state } = makeBreaker({ runs: REVOKED_RUNS });
    await breaker.evaluateAdmission(COMPANY, AGENT); // trip observed at T0

    // Two days pass with no successful run. The snapshot cache (20s) has long
    // expired, so this is a fresh derivation each time.
    state.nowMs = T0 + 2 * 24 * 60 * 60 * 1000;
    const first = await breaker.evaluateAdmission(COMPANY, AGENT);
    // The interval earns exactly ONE probe...
    expect(first.admit).toBe(true);
    expect(first.halfOpenProbe).toBe(true);
    expect(first.state).toBe("half_open");
    // ...and the fleet behind it stays deferred.
    const second = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(second.admit).toBe(false);
    const third = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(third.admit).toBe(false);
  });

  it("half-open cadence: no probe before the interval, one probe per interval after", async () => {
    const { breaker, state } = makeBreaker({ runs: REVOKED_RUNS });
    await breaker.evaluateAdmission(COMPANY, AGENT); // trip observed; next probe at T0+interval

    state.nowMs = T0 + HALF_OPEN_PROBE_INTERVAL_MS - 60_000;
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);

    state.nowMs = T0 + HALF_OPEN_PROBE_INTERVAL_MS + 1_000;
    const probe = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(probe.halfOpenProbe).toBe(true);
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);
  });

  it("re-arms on PROOF: a succeeded run after the failure closes the breaker", async () => {
    const { breaker, state } = makeBreaker({ runs: REVOKED_RUNS });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);

    // The half-open probe succeeded: a new succeeded run lands in history.
    state.nowMs = T0 + HALF_OPEN_PROBE_INTERVAL_MS + 60_000;
    state.runs = [run("succeeded", state.nowMs - 1_000), ...REVOKED_RUNS];
    const decision = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(decision.admit).toBe(true);
    expect(decision.state).toBe("closed");
  });

  it("a passed quota reset boundary earns an IMMEDIATE probe but not full admission", async () => {
    // Session-limit failure at 10:00 with "resets 9pm": boundary 21:00Z.
    const failAt = Date.parse("2026-08-06T10:00:00Z");
    const { breaker, state } = makeBreaker({
      runs: [run("failed", failAt, CLAUDE_SESSION_LIMIT_RESET), run("succeeded", failAt - 3_600_000)],
    });
    // Before the boundary: plain quota trip, no immediate probe.
    const before = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(before.admit).toBe(false);
    expect(before.reason).toBe("quota_exhausted");

    // After the boundary: classifier says quota_reset_unverified; the breaker
    // converts "the provider claims recovery" into ONE probe, not a flood.
    const fresh = makeBreaker({ runs: state.runs });
    fresh.state.nowMs = Date.parse("2026-08-06T21:30:00Z");
    const probe = await fresh.breaker.evaluateAdmission(COMPANY, AGENT);
    expect(probe.admit).toBe(true);
    expect(probe.halfOpenProbe).toBe(true);
    expect((await fresh.breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);
  });
});

describe("LaneBreaker — provider-probe trip source (AUR-5435 intake)", () => {
  it("an unhealthy probe report trips the lane even when run history is healthy", async () => {
    const { breaker } = makeBreaker({ runs: HEALTHY_RUNS });
    breaker.reportProviderProbe("claude_local", {
      healthy: false,
      reason: "OAuth usage headers report zero remaining",
      observedAt: new Date(T0 - 10_000),
      source: "aur5461-probe",
    });
    const decision = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(decision.admit).toBe(false);
    expect(decision.trippedBy).toEqual(["provider_probe"]);
  });

  it("a newer healthy report clears a probe-sourced trip", async () => {
    const { breaker } = makeBreaker({ runs: HEALTHY_RUNS });
    breaker.reportProviderProbe("claude_local", {
      healthy: false, reason: "down", observedAt: new Date(T0 - 10_000), source: "probe",
    });
    breaker.reportProviderProbe("claude_local", {
      healthy: true, reason: null, observedAt: new Date(T0 - 5_000), source: "probe",
    });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(true);
  });

  it("a succeeded run AFTER the unhealthy report clears it (classifier's proof standard)", async () => {
    const { breaker } = makeBreaker({ runs: [run("succeeded", T0 - 5_000)] });
    breaker.reportProviderProbe("claude_local", {
      healthy: false, reason: "down", observedAt: new Date(T0 - 10_000), source: "probe",
    });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(true);
  });

  it("independence: a HEALTHY probe report can NEVER clear an error-stream trip", async () => {
    const { breaker } = makeBreaker({ runs: REVOKED_RUNS });
    breaker.reportProviderProbe("claude_local", {
      healthy: true, reason: null, observedAt: new Date(T0), source: "probe",
    });
    const decision = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(decision.admit).toBe(false);
    expect(decision.trippedBy).toEqual(["error_stream"]);
  });

  it("independence: error stream trips with no probe report at all (probe may be down)", async () => {
    const { breaker } = makeBreaker({ runs: REVOKED_RUNS });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);
  });

  it("out-of-order reports are ignored (newest observedAt wins)", async () => {
    const { breaker } = makeBreaker({ runs: HEALTHY_RUNS });
    breaker.reportProviderProbe("claude_local", {
      healthy: true, reason: null, observedAt: new Date(T0 - 5_000), source: "probe",
    });
    breaker.reportProviderProbe("claude_local", {
      healthy: false, reason: "stale", observedAt: new Date(T0 - 60_000), source: "probe",
    });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(true);
  });
});

describe("LaneBreaker — manual re-arm", () => {
  it("clears a probe-sourced trip and grants an immediate half-open probe", async () => {
    const { breaker } = makeBreaker({ runs: REVOKED_RUNS });
    breaker.reportProviderProbe("claude_local", {
      healthy: false, reason: "down", observedAt: new Date(T0 - 10_000), source: "probe",
    });
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);

    breaker.manualRearm(COMPANY, "claude_local", { actorType: "user", actorId: "operator" });

    // Probe trip is overridden; error-stream trip remains, but the re-arm
    // makes the very next queued run the probe.
    const probe = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(probe.admit).toBe(true);
    expect(probe.halfOpenProbe).toBe(true);
    expect(probe.trippedBy).toEqual(["error_stream"]);
    // Still not a blind-open: the fleet behind the probe stays deferred.
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);
  });

  it("cannot blind-open a dead lane: after the manual probe fails, the lane stays tripped", async () => {
    const { breaker, state } = makeBreaker({ runs: REVOKED_RUNS });
    await breaker.evaluateAdmission(COMPANY, AGENT);
    breaker.manualRearm(COMPANY, "claude_local", { actorType: "user", actorId: "operator" });
    const probe = await breaker.evaluateAdmission(COMPANY, AGENT);
    expect(probe.halfOpenProbe).toBe(true);

    // The probe run fails with the same revocation. Cache expires; re-derive.
    state.nowMs = T0 + 60_000;
    state.runs = [run("failed", state.nowMs - 1_000, ORG_BLOCK_0806), ...REVOKED_RUNS];
    expect((await breaker.evaluateAdmission(COMPANY, AGENT)).admit).toBe(false);
  });
});

describe("LaneBreaker — describeLanes read surface", () => {
  it("reports open state, trip sources, and next probe time for the board", async () => {
    const { breaker } = makeBreaker({ runs: REVOKED_RUNS });
    // Stub the one direct-db query describeLanes makes (distinct lanes).
    (breaker as unknown as { db: unknown }).db = {
      selectDistinct: () => ({ from: () => ({ where: async () => [{ adapterType: "claude_local" }] }) }),
    };
    await breaker.evaluateAdmission(COMPANY, AGENT); // establish half-open bookkeeping
    const lanes = await breaker.describeLanes(COMPANY);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].lane).toBe("claude_local");
    expect(lanes[0].state).toBe("open");
    expect(lanes[0].trippedBy).toContain("error_stream");
    expect(lanes[0].reason).toBe("entitlement_revoked");
    expect(lanes[0].nextProbeEligibleAt).toBe(new Date(T0 + HALF_OPEN_PROBE_INTERVAL_MS).toISOString());
  });
});
