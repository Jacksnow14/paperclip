process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTH_REQUIRED_ERROR_CODE,
  CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
  claudeAuthQuotaReclassificationResultJson,
  decideClaudeAuthQuotaReclassification,
  usageProvesModelWasReached,
  type ClaudeAuthQuotaLaneHistory,
} from "./quota-auth-reclassification.js";
import { classifyAgentCapacity } from "./fleet-capacity.js";

/**
 * AUR-5038 both-ways proof, replayed on the recorded incident timeline
 * (live-DB derivation, 2026-08-06):
 *
 *   2026-08-02T09:58:42Z  newest honest zero-token quota row before the lies:
 *                         "You've hit your weekly limit · resets Aug 5, 11am (UTC)"
 *   2026-08-02T09:59:08Z  first "Not logged in · Please run /login" (zero tokens)
 *   2026-08-05T11:32:59Z  last of 1,326 such rows; zero Anthropic-credential
 *                         successes anywhere in between
 *   2026-08-05T11:56:51Z  first Anthropic success (CTO), 57 min past the reset
 *                         the honest wording had predicted
 */

const ANCHOR_AT = new Date("2026-08-02T09:58:42.864Z");
const PREDICTED_RESET = new Date("2026-08-05T11:00:00.000Z");
const ZERO_USAGE = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

const STANDING_WALL: ClaudeAuthQuotaLaneHistory = {
  anchor: { runId: "f6354ce6-anchor", createdAt: ANCHOR_AT, resetAt: PREDICTED_RESET },
  anthropicSuccessAfterAnchor: false,
};

describe("decideClaudeAuthQuotaReclassification — FIRES on the Aug 2–5 signature", () => {
  it("reclassifies a zero-token auth failure on a lane whose last wall has no success since", () => {
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: ZERO_USAGE,
      history: STANDING_WALL,
      now: new Date("2026-08-03T12:00:00Z"),
    });
    expect(decision).not.toBeNull();
    expect(decision?.errorCode).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
    expect(decision?.errorFamily).toBe("transient_upstream");
    // Parks at the reset the honest wording predicted — the AUR-4144/AUR-4679
    // machinery then suppresses the blind retry ladder that produced 197
    // wall-slams in the incident.
    expect(decision?.retryNotBefore?.toISOString()).toBe(PREDICTED_RESET.toISOString());
    expect(decision?.anchorRunId).toBe("f6354ce6-anchor");
  });

  it("fires with null usage too — a refused run may persist no usage at all", () => {
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: null,
      history: STANDING_WALL,
      now: new Date("2026-08-03T12:00:00Z"),
    });
    expect(decision?.errorCode).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
  });

  it("still reclassifies past the predicted reset while nothing has succeeded, but stops naming a park time", () => {
    // Aug 5 11:20Z: reset instant passed, wall factually still standing
    // (last lie 11:32Z, first success 11:56Z). The class stays quota — the lane
    // has proven nothing — but an elapsed reset must not park anything.
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: ZERO_USAGE,
      history: STANDING_WALL,
      now: new Date("2026-08-05T11:20:00Z"),
    });
    expect(decision?.errorCode).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
    expect(decision?.retryNotBefore).toBeNull();
  });
});

describe("decideClaudeAuthQuotaReclassification — CLEARS on a genuine auth failure", () => {
  it("leaves auth alone once an Anthropic success exists after the wall (discriminator b)", () => {
    // Post-2026-08-05T11:56Z shape: the credential proved itself, so a
    // subsequent "Not logged in" is real and may follow the auth path.
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: ZERO_USAGE,
      history: { ...STANDING_WALL, anthropicSuccessAfterAnchor: true },
      now: new Date("2026-08-05T13:00:00Z"),
    });
    expect(decision).toBeNull();
  });

  it("leaves auth alone when the lane has no quota wall in the lookback at all", () => {
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: ZERO_USAGE,
      history: { anchor: null, anthropicSuccessAfterAnchor: false },
      now: new Date("2026-08-03T12:00:00Z"),
    });
    expect(decision).toBeNull();
  });

  it("leaves auth alone when the run actually reached the model", () => {
    const decision = decideClaudeAuthQuotaReclassification({
      errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
      usage: { inputTokens: 5098, cachedInputTokens: 0, outputTokens: 210 },
      history: STANDING_WALL,
      now: new Date("2026-08-03T12:00:00Z"),
    });
    expect(decision).toBeNull();
  });

  it("touches no other error code", () => {
    for (const errorCode of ["claude_transient_upstream", "timeout", "adapter_failed", null]) {
      const decision = decideClaudeAuthQuotaReclassification({
        errorCode,
        usage: ZERO_USAGE,
        history: STANDING_WALL,
        now: new Date("2026-08-03T12:00:00Z"),
      });
      expect(decision).toBeNull();
    }
  });
});

describe("usageProvesModelWasReached", () => {
  it("treats null/zero/absent counts as not-reached", () => {
    expect(usageProvesModelWasReached(null)).toBe(false);
    expect(usageProvesModelWasReached({})).toBe(false);
    expect(usageProvesModelWasReached(ZERO_USAGE)).toBe(false);
    expect(usageProvesModelWasReached({ inputTokens: null, outputTokens: null })).toBe(false);
  });

  it("treats any positive count as reached — cached-only reads included", () => {
    expect(usageProvesModelWasReached({ inputTokens: 1 })).toBe(true);
    expect(usageProvesModelWasReached({ cachedInputTokens: 40_000 })).toBe(true);
    expect(usageProvesModelWasReached({ outputTokens: 7 })).toBe(true);
  });
});

describe("claudeAuthQuotaReclassificationResultJson", () => {
  const decision = decideClaudeAuthQuotaReclassification({
    errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE,
    usage: ZERO_USAGE,
    history: STANDING_WALL,
    now: new Date("2026-08-03T12:00:00Z"),
  })!;
  const payload = claudeAuthQuotaReclassificationResultJson(decision);

  it("mirrors the AUR-4144 quota shape so every existing quota consumer sees the run as quota", () => {
    expect(payload.quotaExhausted).toBe(true);
    expect((payload.quotaExhaustion as Record<string, unknown>).resetAt).toBe(
      PREDICTED_RESET.toISOString(),
    );
  });

  it("can never trip the out-of-credits founder escalation (AC3)", () => {
    // quota-founder-escalation.ts pages the founder iff quotaExhaustion.outOfCredits
    // is true; a lane-history reclassification proves nothing about credits.
    expect((payload.quotaExhaustion as Record<string, unknown>).outOfCredits).toBe(false);
  });

  it("preserves provenance of the rewrite", () => {
    const marker = payload.authRenderedQuotaWall as Record<string, unknown>;
    expect(marker.originalErrorCode).toBe(CLAUDE_AUTH_REQUIRED_ERROR_CODE);
    expect(marker.anchorRunId).toBe("f6354ce6-anchor");
  });
});

describe("fleet capacity sees a reclassified tail as quota, not consecutive_failures", () => {
  const agent = { id: "a1", name: "CC Max", adapterType: "claude_local" };
  const now = new Date("2026-08-03T12:00:00Z");
  const reclassifiedTail = [
    // Newest first is not required — classify sorts — but keep it realistic.
    {
      status: "failed",
      createdAt: "2026-08-03T11:00:00Z",
      error: "Claude run failed: subtype=success: Not logged in · Please run /login",
      errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
    },
    {
      status: "failed",
      createdAt: "2026-08-03T10:00:00Z",
      error: "Claude run failed: subtype=success: Not logged in · Please run /login",
      errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
    },
    {
      status: "failed",
      createdAt: "2026-08-03T09:00:00Z",
      error: "Claude run failed: subtype=success: Not logged in · Please run /login",
      errorCode: CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
    },
    { status: "succeeded", createdAt: "2026-07-31T06:59:18Z" },
  ];

  it("classifies by errorCode even though the error text carries no quota wording", () => {
    const row = classifyAgentCapacity(agent, reclassifiedTail, now);
    expect(row.canExecuteNow).toBe(false);
    expect(row.reason).toBe("quota_exhausted");
  });

  it("negative control: the same tail WITHOUT the reclassified code stays consecutive_failures", () => {
    const row = classifyAgentCapacity(
      agent,
      reclassifiedTail.map((run) => ({ ...run, errorCode: undefined })),
      now,
    );
    expect(row.reason).toBe("consecutive_failures");
  });
});
