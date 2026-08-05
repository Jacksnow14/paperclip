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

  it("classifies the live 'weekly limit' wording as transient (AUR-4192)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your weekly limit · resets Jul 29, 11am (UTC)",
      }),
    ).toBe(true);
  });

  // AUR-4531 AC1. These four strings are the LITERAL production wordings; the fleet burned
  // 72h of quota against a wall nothing was watching because the shipped regex only
  // recognised "<kind> limit reached" and never "You've hit your <kind> limit". A bare
  // `toBe(true)` on the classifier is not enough for the two that carry a reset hint: if
  // the reset time is null the breaker has no lifetime to key on and silently degrades back
  // to the bounded ladder, which is the exact bug AUR-4531 exists to kill. So the table
  // asserts BOTH axes per row.
  const QUOTA_WORDING_TABLE: Array<{
    errorMessage: string;
    expectsResetTime: boolean;
    // Set for the bare-date shape, which carries no clock time at all.
    expectedResetIso?: string;
  }> = [
    { errorMessage: "You've hit your weekly limit", expectsResetTime: false },
    {
      errorMessage: "You've hit your weekly limit · resets Aug 1",
      expectsResetTime: true,
      // A weekly limit resets on a calendar day, not at a clock time: no am/pm anywhere in
      // the string. Interpreted as the start of Aug 1 UTC (no timezone hint given, and the
      // test pins TZ-independence by comparing against a locally-constructed midnight).
      expectedResetIso: undefined,
    },
    {
      errorMessage: "You've hit your session limit · resets 4pm (UTC)",
      expectsResetTime: true,
      expectedResetIso: "2026-07-30T16:00:00.000Z",
    },
    { errorMessage: "Claude usage limit reached", expectsResetTime: false },
  ];

  it.each(QUOTA_WORDING_TABLE)(
    "classifies the live production wording as transient: $errorMessage",
    ({ errorMessage }) => {
      expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(true);
      // Same string arriving on stderr rather than as a harness errorMessage must classify
      // identically -- the adapter does not control which channel the CLI uses.
      expect(isClaudeTransientUpstreamError({ stderr: errorMessage })).toBe(true);
    },
  );

  it.each(QUOTA_WORDING_TABLE)(
    "yields a parsed reset time exactly when the wording carries one: $errorMessage",
    ({ errorMessage, expectsResetTime, expectedResetIso }) => {
      const now = new Date("2026-07-30T09:00:00.000Z");
      const extracted = extractClaudeRetryNotBefore({ errorMessage }, now);
      if (!expectsResetTime) {
        expect(extracted).toBeNull();
        return;
      }
      expect(extracted).not.toBeNull();
      expect(extracted!.getTime()).toBeGreaterThan(now.getTime());
      if (expectedResetIso) {
        expect(extracted!.toISOString()).toBe(expectedResetIso);
      }
    },
  );

  // Called out separately because it is the shape `parseClaudeResetClockTime` used to reject
  // outright: a bare date with no clock time at all. Asserted in local time because the
  // wording carries no timezone hint, so the parser resolves it against the host zone.
  it("parses the bare-date weekly reset hint ('resets Aug 1') as the start of that day", () => {
    const now = new Date("2026-07-30T09:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Aug 1" },
      now,
    );
    expect(extracted?.getTime()).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).getTime());
  });

  it("rolls a bare-date weekly reset into next year when this year's date has passed", () => {
    const now = new Date("2026-12-28T09:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your weekly limit · resets Jan 3" },
      now,
    );
    expect(extracted?.getTime()).toBe(new Date(2027, 0, 3, 0, 0, 0, 0).getTime());
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

// AUR-4557. The AUR-4513 regression test above puts its contaminating text in
// `stdout`, which this classifier never reads -- so it is tautological with respect
// to the live failure mode. The real contamination vector is `parsed.result`, which
// IS the model's final assistant message, and `errorMessage`, into which
// describeClaudeFailure folds `parsed.result`. These are the cases that were missing.
describe("isClaudeContextOverflowError prose contamination (AUR-4557)", () => {
  // The exact failure the ticket describes: an agent working this very issue ends a
  // turn summarising it, then the run fails for an unrelated reason. Pre-fix this
  // returned true -> no errorFamily, no retry ladder, forced session rotation.
  it("does NOT fire when the phrase appears in model prose in parsed.result", () => {
    const prose =
      "I fixed the classifier so a run that fails because the prompt is too long " +
      "is no longer retried as transient.";
    const input = {
      parsed: { is_error: true, subtype: "success", result: prose },
      stdout: "",
      stderr: "",
      errorMessage: `Claude run failed: subtype=success: ${prose}`,
    };
    expect(isClaudeContextOverflowError(input)).toBe(false);
  });

  // A genuine 529 that happens to follow prose about overflow must stay retryable.
  it("leaves a real transient failure retryable when the prose mentions overflow", () => {
    const prose =
      "Notes on the prompt is too long defect. API Error 529 overloaded_error";
    const input = {
      parsed: { is_error: true, subtype: "success", result: prose },
      stdout: "",
      stderr: "",
      errorMessage: `Claude run failed: subtype=success: ${prose}`,
    };
    expect(isClaudeContextOverflowError(input)).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });

  // Self-seeding: the rotation handoff this feature generates embeds the reason
  // string, so an agent that restates it must not re-trigger the classification.
  it("does NOT fire when an agent restates its own rotation-reason handoff", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: {
          is_error: true,
          result:
            "- Rotation reason: latest run failed with a context overflow (prompt is too long)",
        },
      }),
    ).toBe(false);
  });

  // Length is not the discriminator -- a short prose reply must fail too.
  it("does NOT fire on a short prose reply containing the phrase", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: { is_error: true, result: "Done - the prompt is too long fix landed." },
      }),
    ).toBe(false);
  });

  // The other half of the guard: it must still catch the real thing, or it is just a
  // blanket suppressor. One passing and one failing case, per AUR-4185.
  it("still fires on the genuine live wording", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: { is_error: true, subtype: "success", result: "Prompt is too long" },
        errorMessage: "Claude run failed: subtype=success: Prompt is too long",
      }),
    ).toBe(true);
    expect(
      isClaudeContextOverflowError({
        parsed: { is_error: true, result: "Prompt is too long." },
      }),
    ).toBe(true);
    // API detail form: phrase opens the payload, colon-delimited detail follows.
    expect(
      isClaudeContextOverflowError({
        parsed: {
          is_error: true,
          result:
            "input length and `max_tokens` exceed context limit: 203000 + 8192 > 200000",
        },
      }),
    ).toBe(true);
  });

  // parsed.errors[] is adapter/API structured output the model cannot author, so it
  // stays substring-matched -- prose anchoring must not cost us that detection.
  it("still fires on a structured errors[] message the model cannot author", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: {
          is_error: true,
          result: "",
          errors: [{ message: "API error: prompt is too long: 250000 > 200000" }],
        },
      }),
    ).toBe(true);
  });

  // The no-parse path passes process stderr as trustedText, also substring-matched.
  it("still fires on the no-parse stderr path via trustedText", () => {
    expect(
      isClaudeContextOverflowError({
        parsed: null,
        trustedText: "Claude exited with code 1: API Error: 400 prompt is too long",
      }),
    ).toBe(true);
  });
});
