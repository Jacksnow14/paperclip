import { describe, expect, it } from "vitest";
import {
  assertAgentLaneAdmissible,
  isAgentLaneStale,
  STALE_LANE_HEARTBEAT_THRESHOLD_MS,
} from "../services/agent-lane-admission.ts";

const NOW = new Date("2026-08-25T00:00:00.000Z");

describe("isAgentLaneStale (AUR-4512)", () => {
  it("treats status: error as stale regardless of heartbeat recency", () => {
    expect(
      isAgentLaneStale(
        { id: "a1", status: "error", lastHeartbeatAt: new Date(NOW.getTime() - 60_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("does NOT treat a null lastHeartbeatAt as stale (Wake Watchdog Bot / http adapter shape)", () => {
    expect(
      isAgentLaneStale({ id: "a1", status: "idle", lastHeartbeatAt: null }, NOW),
    ).toBe(false);
  });

  it("treats a heartbeat older than the threshold as stale", () => {
    const staleHeartbeat = new Date(NOW.getTime() - STALE_LANE_HEARTBEAT_THRESHOLD_MS - 60_000);
    expect(
      isAgentLaneStale({ id: "a1", status: "idle", lastHeartbeatAt: staleHeartbeat }, NOW),
    ).toBe(true);
  });

  it("does not treat a heartbeat within the threshold as stale", () => {
    const freshHeartbeat = new Date(NOW.getTime() - 5 * 60_000);
    expect(
      isAgentLaneStale({ id: "a1", status: "idle", lastHeartbeatAt: freshHeartbeat }, NOW),
    ).toBe(false);
  });
});

describe("assertAgentLaneAdmissible (AUR-4512)", () => {
  it("throws a conflict naming agent id, heartbeat age, and threshold for a stale lane", () => {
    const staleHeartbeat = new Date(NOW.getTime() - 82 * 60 * 60 * 1000);
    expect(() =>
      assertAgentLaneAdmissible(
        { id: "69dca828-b5f4-4802-aae6-f28ae0ab3f65", status: "idle", lastHeartbeatAt: staleHeartbeat },
        { now: NOW },
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 409,
        details: expect.objectContaining({
          agentId: "69dca828-b5f4-4802-aae6-f28ae0ab3f65",
          agentStatus: "idle",
          heartbeatAgeMs: 82 * 60 * 60 * 1000,
          staleLaneThresholdMs: STALE_LANE_HEARTBEAT_THRESHOLD_MS,
        }),
      }),
    );
  });

  it("allows a stale lane when allowStaleLane is set (blocked-issue escape hatch)", () => {
    const staleHeartbeat = new Date(NOW.getTime() - 82 * 60 * 60 * 1000);
    expect(() =>
      assertAgentLaneAdmissible(
        { id: "a1", status: "idle", lastHeartbeatAt: staleHeartbeat },
        { now: NOW, allowStaleLane: true },
      ),
    ).not.toThrow();
  });

  it("does not throw for a fresh lane", () => {
    const freshHeartbeat = new Date(NOW.getTime() - 5 * 60_000);
    expect(() =>
      assertAgentLaneAdmissible(
        { id: "441a5729-1a2c-4f2e-83d4-1bdd65982872", status: "active", lastHeartbeatAt: freshHeartbeat },
        { now: NOW },
      ),
    ).not.toThrow();
  });
});
