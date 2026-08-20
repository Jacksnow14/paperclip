// Reset-clock parsing in the adapter extractors resolves e.g. "resets 9pm"
// against the host-local clock; fixtures below are authored in UTC, so pin
// it before any Date is constructed. Same convention as fleet-capacity.test.ts.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
  AGENT_QUOTA_BLOCKING_REASONS,
  deriveAgentQuotaState,
} from "./agent-quota-state.js";
import type { FleetCapacityAgentInput, FleetCapacityRunInput } from "./fleet-capacity.js";

const CLAUDE_SESSION_LIMIT_RESET = "You've hit your session limit ∙ resets 9pm";
const CODEX_QUOTA_NO_RESET = "You've hit your usage limit for gpt-5.5.";
const PROMPT_TOO_LONG = "Prompt is too long";
const ORG_BLOCK_0806 =
  "Claude run failed: subtype=success: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

function run(status: string, createdAt: string, error?: string): FleetCapacityRunInput {
  return { status, createdAt, finishedAt: createdAt, error: error ?? null };
}

function runSeries(n: number, status: string, newestIso: string, error?: string): FleetCapacityRunInput[] {
  const newest = Date.parse(newestIso);
  return Array.from({ length: n }, (_, i) => run(status, new Date(newest - i * 60_000).toISOString(), error));
}

function agent(id: string, adapterType: string, pausedAt: string | null = null): FleetCapacityAgentInput {
  return { id, name: id, adapterType, pausedAt };
}

// AUR-4604 acceptance criteria: an agent whose last run failed on quota must
// not report plain idle/pauseReason:null, and the reported state must carry
// the reset time.
describe("deriveAgentQuotaState — quota_exhausted does not read as plain idle", () => {
  it("quota-signature failure tail, reset boundary still in the future -> non-null state carrying resetAt", () => {
    // Failure at 09:00Z with a Claude "resets 9pm" hint parses to a same-day
    // 21:00Z boundary; NOW (10:00Z) is well before that, so the wall is still
    // up and quota_exhausted (not yet quota_reset_unverified).
    const failedAt = "2026-08-19T09:00:00Z";
    const now = new Date("2026-08-19T10:00:00Z");
    const walled = agent("agent-quota-1", "claude_local");
    const runs = [
      ...runSeries(4, "failed", failedAt, CLAUDE_SESSION_LIMIT_RESET),
      run("succeeded", "2026-08-17T05:05:00Z"),
    ];

    const state = deriveAgentQuotaState(walled, runs, now);

    expect(state).not.toBeNull();
    expect(state?.reason).toBe("quota_exhausted");
    expect(state?.resetAt).not.toBeNull();
    expect(new Date(state!.resetAt!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("quota-signature failure with no parseable reset hint -> non-null state, resetAt null (not a synonym for healthy)", () => {
    const now = new Date("2026-08-19T10:00:00Z");
    const walled = agent("agent-quota-2", "codex_local");
    const runs = [...runSeries(13, "failed", "2026-08-18T09:00:00Z", CODEX_QUOTA_NO_RESET)];

    const state = deriveAgentQuotaState(walled, runs, now);

    expect(state).not.toBeNull();
    expect(state?.reason).toBe("quota_exhausted");
    expect(state?.resetAt).toBeNull();
    expect(state?.detail).toBeTruthy();
  });

  it("entitlement revocation also reports non-null state (no reset boundary, by design)", () => {
    const now = new Date("2026-08-19T10:00:00Z");
    const revoked = agent("agent-quota-3", "claude_local");
    const runs = [run("failed", "2026-08-19T09:00:00Z", ORG_BLOCK_0806)];

    const state = deriveAgentQuotaState(revoked, runs, now);

    expect(state).not.toBeNull();
    expect(state?.reason).toBe("entitlement_revoked");
    expect(state?.resetAt).toBeNull();
  });

  it("a healthy agent (no failures) reports null — this module never invents a false positive", () => {
    const now = new Date("2026-08-19T10:00:00Z");
    const healthy = agent("agent-healthy", "claude_local");
    const runs = [run("succeeded", "2026-08-19T08:00:00Z")];

    expect(deriveAgentQuotaState(healthy, runs, now)).toBeNull();
  });

  it("a non-quota failure tail (e.g. 'Prompt is too long') reports null — consecutive_failures is not a quota-blocking reason", () => {
    const now = new Date("2026-08-19T10:00:00Z");
    const struggling = agent("agent-nonquota", "claude_local");
    const runs = [
      ...runSeries(5, "failed", "2026-08-19T09:00:00Z", PROMPT_TOO_LONG),
      run("succeeded", "2026-08-19T05:00:00Z"),
    ];

    expect(deriveAgentQuotaState(struggling, runs, now)).toBeNull();
  });

  it("a manually paused agent reports null — pauseReason already surfaces that state; this field must not duplicate it", () => {
    const now = new Date("2026-08-19T10:00:00Z");
    const paused = agent("agent-paused", "claude_local", "2026-08-19T08:00:00Z");
    const runs = [run("succeeded", "2026-08-19T07:00:00Z")];

    expect(deriveAgentQuotaState(paused, runs, now)).toBeNull();
  });
});

// AUR-4604 acceptance criteria: the state clears on a subsequent successful run.
describe("deriveAgentQuotaState — clears on a subsequent successful run", () => {
  it("a succeeded run strictly after the quota-signature failures clears the state, no manual intervention", () => {
    const walled = agent("agent-recovers", "claude_local");
    const beforeRecovery = [...runSeries(6, "failed", "2026-08-19T09:00:00Z", CLAUDE_SESSION_LIMIT_RESET)];
    const now = new Date("2026-08-19T10:00:00Z");
    expect(deriveAgentQuotaState(walled, beforeRecovery, now)).not.toBeNull();

    const afterRecovery = [run("succeeded", "2026-08-19T09:30:00Z"), ...beforeRecovery];
    expect(deriveAgentQuotaState(walled, afterRecovery, now)).toBeNull();
  });

  it("a succeeded run after an entitlement revocation clears it (the only legitimate re-arm)", () => {
    const revoked = agent("agent-revoked-recovers", "claude_local");
    const now = new Date("2026-08-19T10:00:00Z");
    const history = [run("succeeded", "2026-08-19T09:30:00Z"), run("failed", "2026-08-19T09:00:00Z", ORG_BLOCK_0806)];

    expect(deriveAgentQuotaState(revoked, history, now)).toBeNull();
  });
});

// AUR-4604 acceptance criteria: the state clears once the reset time passes,
// with no manual intervention (relies on classifyAgentCapacity's own
// quota_reset_unverified branch, which reports canExecuteNow: true).
describe("deriveAgentQuotaState — clears once the reset time passes, unattended", () => {
  it("same failure history, evaluated before vs after the parsed reset boundary", () => {
    const walled = agent("agent-clock", "claude_local");
    const runs = [...runSeries(6, "failed", "2026-08-19T09:00:00Z", CLAUDE_SESSION_LIMIT_RESET)];

    const beforeReset = new Date("2026-08-19T15:00:00Z"); // before the same-day 21:00Z boundary
    const afterReset = new Date("2026-08-19T22:00:00Z"); // after it, nobody touched anything

    const stateBefore = deriveAgentQuotaState(walled, runs, beforeReset);
    expect(stateBefore).not.toBeNull();
    expect(stateBefore?.reason).toBe("quota_exhausted");

    const stateAfter = deriveAgentQuotaState(walled, runs, afterReset);
    expect(stateAfter).toBeNull();
  });
});

describe("AGENT_QUOTA_BLOCKING_REASONS", () => {
  it("deliberately excludes lane_down — classifyAgentCapacity alone can never produce it here", () => {
    expect(AGENT_QUOTA_BLOCKING_REASONS.has("lane_down")).toBe(false);
    expect(AGENT_QUOTA_BLOCKING_REASONS.has("quota_exhausted")).toBe(true);
    expect(AGENT_QUOTA_BLOCKING_REASONS.has("entitlement_revoked")).toBe(true);
  });
});
