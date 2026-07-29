import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("classifies the live 'session limit' wording as transient (AUR-4055)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your session limit · resets 7:40pm (UTC)",
      }),
    ).toBe(true);
  });

  it("classifies the live 'weekly limit' wording as transient (AUR-4192)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your weekly limit · resets Jul 29, 11am (UTC)",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });

  it("parses the verbatim 'session limit' reset hint from AUR-4055 in UTC", () => {
    const now = new Date("2026-07-25T19:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your session limit · resets 7:40pm (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-07-25T19:40:00.000Z");
  });

  it("rolls the verbatim 'session limit' reset hint to the next day once it has passed", () => {
    const now = new Date("2026-07-25T23:33:19.399Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your session limit · resets 12:40am (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-07-26T00:40:00.000Z");
  });

  // AUR-4192: both wordings below are verbatim from heartbeat_runs rows. Between
  // 2026-07-22 and 2026-07-29 they accounted for 18,703 failed runs across 11
  // agents — 82% of every fleet run failure — and none carried a retryNotBefore,
  // because the AUR-4055 wording list only covered "<window> limit reached".
  it("parses the verbatim clock-only 'weekly limit' reset hint", () => {
    const now = new Date("2026-07-29T10:41:38.815Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Claude run failed: subtype=success: You've hit your weekly limit · resets 11am (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-07-29T11:00:00.000Z");
  });

  it("parses the verbatim dated 'weekly limit' reset hint", () => {
    const now = new Date("2026-07-28T23:10:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Jul 29, 11am (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-07-29T11:00:00.000Z");
  });

  // A weekly cap can reset days out, so the named day has to be honoured rather
  // than collapsed to the next occurrence of the clock time — otherwise the
  // scheduler resumes early and burns the whole retry ladder against a wall
  // that is still up. Reading the next 11am here would give Jul 29, not Aug 2.
  it("pins a dated reset hint to the named day, not the next matching clock time", () => {
    const now = new Date("2026-07-28T23:10:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Aug 2, 11am (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-08-02T11:00:00.000Z");
  });

  it("does not roll a dated reset hint forward a day once it has passed", () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Jul 29, 11am (UTC)" },
      now,
    );
    // Already elapsed: the caller only uses this to push a retry later, so the
    // correct answer is the real (past) reset, not tomorrow.
    expect(extracted?.toISOString()).toBe("2026-07-29T11:00:00.000Z");
  });

  it("resolves a dated reset hint across a year boundary", () => {
    const now = new Date("2026-12-31T22:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Jan 3, 11am (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2027-01-03T11:00:00.000Z");
  });

  it("ignores a non-date word ahead of the clock rather than mis-parsing it", () => {
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your weekly limit · resets sometime 11am" },
        new Date("2026-07-29T10:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
