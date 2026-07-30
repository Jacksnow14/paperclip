import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudeContextOverflowError,
  CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
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
});

describe("isClaudeContextOverflowError (AUR-4513)", () => {
  // Verbatim wording from all 2,394 live overflow rows, 2026-07-26..29.
  const LIVE_RESULT = "Prompt is too long";
  const LIVE_ERROR_MESSAGE = "Claude run failed: subtype=success: Prompt is too long";

  it("exposes a code distinct from the transient family", () => {
    expect(CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE).toBe("claude_context_overflow");
    expect(CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE).not.toBe("claude_transient_upstream");
  });

  it("classifies the verbatim live overflow wording", () => {
    expect(isClaudeContextOverflowError({ errorMessage: LIVE_ERROR_MESSAGE })).toBe(true);
    expect(
      isClaudeContextOverflowError({
        parsed: { is_error: true, subtype: "success", result: LIVE_RESULT },
      }),
    ).toBe(true);
  });

  it("classifies the API-shaped context-limit rejection", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: {
          is_error: true,
          errors: [
            {
              type: "invalid_request_error",
              message: "input length and `max_tokens` exceed context limit: 203000 + 8192 > 200000",
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("does not fire on an ordinary failure", () => {
    expect(isClaudeContextOverflowError({ errorMessage: "Claude exited with code 1" })).toBe(false);
    expect(isClaudeContextOverflowError({})).toBe(false);
    expect(
      isClaudeContextOverflowError({
        parsed: { is_error: true, result: "You're out of extra usage · resets 4pm" },
      }),
    ).toBe(false);
  });

  // THE regression test for this ticket. `Prompt is too long` matches no transient
  // pattern on its own, yet 2,394/2,394 live overflow rows were tagged
  // `claude_transient_upstream` -- because buildClaudeTransientHaystack folds the whole
  // resumed transcript into its haystack and our agents constantly *discuss* quota
  // wording. Overflow must win even when the transcript is full of that wording.
  it("wins over the transient classifier even when the transcript mentions quota wording", () => {
    const contaminatedStdout = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"LANE HEALTH: all three',
      'claude_local coders hit a session limit; rate limit reached, try again later."}]}}',
    ].join("\n");
    const input = {
      parsed: { is_error: true, subtype: "success", result: LIVE_RESULT },
      stdout: contaminatedStdout,
      stderr: "",
      errorMessage: LIVE_ERROR_MESSAGE,
    };

    expect(isClaudeContextOverflowError(input)).toBe(true);
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  // Control: the same contaminated transcript with a genuinely transient failure must
  // still classify as transient, so the guard above cannot be a blanket suppressor.
  it("leaves a genuinely transient failure transient", () => {
    const input = {
      parsed: {
        is_error: true,
        result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
      },
      stdout: "",
      stderr: "",
      errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
    };
    expect(isClaudeContextOverflowError(input)).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });
});
