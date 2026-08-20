import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudeContextOverflowError,
  isClaudeQuotaExhaustedError,
  detectClaudeQuotaExhaustion,
  extractClaudeRateLimitEvents,
  claudeQuotaExhaustionResultJson,
  resolveClaudeFailureErrorCode,
  isClaudeOAuthRefreshFailedError,
  CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE,
  CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE,
  CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE,
} from "./parse.js";

// AUR-4144 changed the contract these tests assert. Quota exhaustion used to be a SUBSET
// of `transient_upstream`; it is now its own class, so `isClaudeTransientUpstreamError`
// returns false for quota wording and `isClaudeQuotaExhaustedError` returns true instead.
// Retry scheduling is unchanged (execute.ts still emits errorFamily "transient_upstream"
// for both), so the property these tests actually protect -- "this failure is retryable
// and carries a reset time" -- is asserted via the quota detector below.
describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as a quota wall", () => {
    expect(
      isClaudeQuotaExhaustedError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeQuotaExhaustedError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    // ...and is no longer lumped in with generic transient upstream errors.
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
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
      isClaudeQuotaExhaustedError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeQuotaExhaustedError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("classifies the live 'session limit' wording as a quota wall (AUR-4055)", () => {
    expect(
      isClaudeQuotaExhaustedError({
        errorMessage: "You've hit your session limit · resets 7:40pm (UTC)",
      }),
    ).toBe(true);
  });

  it("classifies the live 'weekly limit' wording as a quota wall (AUR-4192)", () => {
    // AUR-4144: quota exhaustion is its own class now, disjoint from generic transient.
    // The property AUR-4192 protects — this failure is retryable with a dated reset —
    // is carried by the quota detector (execute.ts still emits transient_upstream family).
    const input = {
      errorMessage: "You've hit your weekly limit · resets Jul 29, 11am (UTC)",
    };
    expect(isClaudeQuotaExhaustedError(input)).toBe(true);
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    const now = new Date("2026-07-27T06:30:00.000Z");
    expect(extractClaudeRetryNotBefore(input, now)?.toISOString()).toBe(
      "2026-07-29T11:00:00.000Z",
    );
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
    "classifies the live production wording as a quota wall: $errorMessage",
    ({ errorMessage }) => {
      expect(isClaudeQuotaExhaustedError({ errorMessage })).toBe(true);
      // AUR-4144: and it must NOT also be tagged generic-transient -- the two classes are
      // disjoint now, which is what makes the quota code observable in the run table.
      expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
      // The same string arriving only on stderr is still recognised as retryable. It is
      // NOT attributed to the quota class, because raw stderr is transcript-contaminated
      // (AUR-4144) -- but the retryable classification, and therefore the retry
      // scheduling, is preserved via the raw fallback that runs when there is no parsed
      // terminal result to trust.
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
        result: "API Error: 529 overloaded_error",
      },
      stdout: "",
      stderr: "",
      errorMessage: "Claude run failed: subtype=error: API Error: 529 overloaded_error",
    };
    expect(isClaudeContextOverflowError(input)).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });

  // AUR-4144: the quota variant of the same control -- still not overflow, still
  // retryable, but now carried by the quota class rather than the transient one.
  it("leaves a quota failure classified as quota, not overflow", () => {
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
    expect(isClaudeQuotaExhaustedError(input)).toBe(true);
  });
});

// The verbatim line from run log
// b26d3647.../371a1b08.../1bde2ebe-3abd-415d-83bf-e7e62b4ba9dd.ndjson. That run emitted NO
// `{"type":"result"}` event at all, so `parsed` is null on this path and the structured
// event is the ONLY evidence of why it died. resetsAt is unix SECONDS
// (1785322800 = 2026-07-29T11:00:00Z) and the lane recovered at exactly that instant.
const LIVE_REJECTED_RATE_LIMIT_EVENT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1785322800,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"1c6dd536-6d74-4e9c-92d6-b172d95f4ffa","session_id":"d8c84a51-da8f-432b-94e5-ffcb5e8b4f44"}';
const LIVE_REJECTED_RESET_ISO = "2026-07-29T11:00:00.000Z";

describe("detectClaudeQuotaExhaustion (AUR-4144)", () => {
  it("exposes a code distinct from the transient and overflow families", () => {
    expect(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE).toBe("claude_quota_exhausted");
    expect(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE).not.toBe("claude_transient_upstream");
    expect(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE).not.toBe(CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE);
  });

  // Case 1. The exact production wording from the AUR-4144 run.
  it("detects the verbatim production session-limit prose and keeps it out of the transient class", () => {
    const input = { errorMessage: "You've hit your session limit · resets 12:40am (UTC)" };
    const now = new Date("2026-07-25T23:33:19.399Z");

    const quota = detectClaudeQuotaExhaustion(input, now);
    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("prose");
    expect(quota!.resetAt).not.toBeNull();
    expect(quota!.resetAt!.toISOString()).toBe("2026-07-26T00:40:00.000Z");
    // Quota is its own class: it must NOT report as a generic transient upstream error.
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  // Case 2. The structured event, off raw stdout, with no parsed terminal result at all.
  it("detects the verbatim structured rate_limit_event with no parsed result present", () => {
    const quota = detectClaudeQuotaExhaustion({
      parsed: null,
      stdout: LIVE_REJECTED_RATE_LIMIT_EVENT,
      stderr: "",
      errorMessage: "Claude exited with code 1",
    });

    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("structured");
    expect(quota!.resetAt?.toISOString()).toBe(LIVE_REJECTED_RESET_ISO);
    expect(quota!.rateLimitType).toBe("seven_day");
    expect(quota!.overageDisabledReason).toBe("out_of_credits");
    expect(quota!.outOfCredits).toBe(true);
  });

  // Case 3. THE false-positive guard, and the actual AUR-4144 root cause: the transient
  // regex was matching the substring `rate_limit` inside unrelated stream JSON (a JSON
  // KEY, or an agent discussing quota wording in the resumed transcript), so failures
  // that had nothing to do with capacity were retried as transient forever.
  it("does not classify a failure as transient or quota because raw stdout mentions rate_limit", () => {
    const input = {
      parsed: null,
      stdout: [
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785322800,"rateLimitType":"seven_day","overageStatus":"allowed","isUsingOverage":false}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"The classifier keys on rate_limit and on session limit wording; both coders hit a session limit yesterday."}]}}',
        '{"type":"system","subtype":"init","session_id":"abc","rate_limits":{"rate_limit_error":null}}',
      ].join("\n"),
      stderr: "",
      errorMessage: "Claude run failed: subtype=error: ENOENT: no such file or directory, open '/tmp/missing'",
    };

    expect(detectClaudeQuotaExhaustion(input)).toBeNull();
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  // Case 4. The PASSING control for the guard above: a genuine capacity failure must still
  // classify as transient. Without this, "return false more often" would look like a fix.
  it("still classifies a genuine overloaded/503/529 failure as transient", () => {
    const parsedInput = {
      parsed: { is_error: true, result: "API Error: 529 {\"type\":\"overloaded_error\"}" },
      stdout: "",
      stderr: "",
      errorMessage: "Claude run failed: subtype=error: API Error: 529 overloaded_error",
    };
    expect(isClaudeTransientUpstreamError(parsedInput)).toBe(true);
    expect(detectClaudeQuotaExhaustion(parsedInput)).toBeNull();

    const stderrOnlyInput = {
      parsed: null,
      stdout: "",
      stderr: "API Error: 503 Service Unavailable",
      errorMessage: null,
    };
    expect(isClaudeTransientUpstreamError(stderrOnlyInput)).toBe(true);
    expect(detectClaudeQuotaExhaustion(stderrOnlyInput)).toBeNull();
  });

  // Case 5. The second live production wording. It must NOT need a fourth regex patch.
  it("detects the weekly-limit production wording with its reset time", () => {
    const now = new Date("2026-07-30T09:00:00.000Z");
    const quota = detectClaudeQuotaExhaustion(
      { errorMessage: "You've hit your weekly limit · resets 11am (UTC)" },
      now,
    );
    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("prose");
    expect(quota!.resetAt?.toISOString()).toBe("2026-07-30T11:00:00.000Z");
  });

  // Case 6. Precedence, not just presence: when BOTH signals are available the structured
  // epoch wins. Prose is a scraped approximation of a number the CLI already gave us
  // exactly, and it is the half that has had to be patched three times.
  it("prefers the structured epoch over a scraped prose clock time when both are present", () => {
    const now = new Date("2026-07-27T06:30:31.718Z");
    const input = {
      parsed: null,
      stdout: LIVE_REJECTED_RATE_LIMIT_EVENT,
      stderr: "",
      errorMessage: "You've hit your session limit · resets 4pm (UTC)",
    };

    const quota = detectClaudeQuotaExhaustion(input, now);
    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("structured");
    expect(quota!.resetAt?.toISOString()).toBe(LIVE_REJECTED_RESET_ISO);
    // The prose path would have produced 4pm on the day of `now`; prove it lost.
    expect(quota!.resetAt?.toISOString()).not.toBe("2026-07-27T16:00:00.000Z");
    // extractClaudeRetryNotBefore keeps its old signature but must agree.
    expect(extractClaudeRetryNotBefore(input, now)?.toISOString()).toBe(LIVE_REJECTED_RESET_ISO);
  });

  it("returns null when neither a rejected event nor quota prose is present", () => {
    expect(detectClaudeQuotaExhaustion({})).toBeNull();
    expect(detectClaudeQuotaExhaustion({ errorMessage: "Claude exited with code 1" })).toBeNull();
    expect(
      detectClaudeQuotaExhaustion({ errorMessage: "Invalid request_error: Unknown parameter 'foo'." }),
    ).toBeNull();
  });

  it("treats a non-rejected rate_limit_event as no wall at all", () => {
    const allowed =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785322800,"rateLimitType":"seven_day","overageStatus":"allowed","isUsingOverage":false}}';
    expect(detectClaudeQuotaExhaustion({ parsed: null, stdout: allowed })).toBeNull();
    expect(extractClaudeRetryNotBefore({ parsed: null, stdout: allowed })).toBeNull();
  });

  it("returns a null resetAt (not a bogus date) when the rejected event carries no resetsAt", () => {
    const quota = detectClaudeQuotaExhaustion({
      parsed: null,
      stdout:
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","overageStatus":"allowed"}}',
    });
    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("structured");
    expect(quota!.resetAt).toBeNull();
    expect(quota!.outOfCredits).toBe(false);
    expect(quota!.rateLimitType).toBe("five_hour");
  });

  it("does not null out a reset instant that is already in the past (the server clamps it)", () => {
    // Same live event, evaluated long after its reset. Discarding it here is how the
    // scheduler ends up back on a blind backoff ladder.
    const quota = detectClaudeQuotaExhaustion(
      { parsed: null, stdout: LIVE_REJECTED_RATE_LIMIT_EVENT },
      new Date("2027-01-01T00:00:00.000Z"),
    );
    expect(quota!.resetAt?.toISOString()).toBe(LIVE_REJECTED_RESET_ISO);
  });
});

describe("extractClaudeRateLimitEvents (AUR-4144)", () => {
  it("returns every rate_limit_event in stream order and ignores other lines", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785322800,"rateLimitType":"seven_day","overageStatus":"allowed","isUsingOverage":true}}',
      "not json at all",
      LIVE_REJECTED_RATE_LIMIT_EVENT,
    ].join("\n");

    const events = extractClaudeRateLimitEvents(stdout);
    expect(events).toHaveLength(2);
    expect(events[0]!.status).toBe("allowed");
    expect(events[0]!.isUsingOverage).toBe(true);
    expect(events[0]!.overageDisabledReason).toBeNull();
    expect(events[1]!.status).toBe("rejected");
    expect(events[1]!.resetsAtEpochSeconds).toBe(1785322800);
    expect(events[1]!.isUsingOverage).toBe(false);
  });

  it("returns nothing for absent or event-free stdout", () => {
    expect(extractClaudeRateLimitEvents(null)).toEqual([]);
    expect(extractClaudeRateLimitEvents(undefined)).toEqual([]);
    expect(extractClaudeRateLimitEvents("")).toEqual([]);
    expect(extractClaudeRateLimitEvents('{"type":"assistant","message":{}}')).toEqual([]);
  });
});

// execute.ts has no cheap unit harness (its only test, execute.remote.test.ts, drives a
// real process target), so the two pure decisions execute.ts now delegates to are asserted
// directly here instead: the errorCode precedence ladder and the persisted metadata shape.
describe("resolveClaudeFailureErrorCode / claudeQuotaExhaustionResultJson (AUR-4144)", () => {
  it("maps a quota wall to claude_quota_exhausted, ahead of the transient catch-all", () => {
    expect(
      resolveClaudeFailureErrorCode({
        requiresLogin: false,
        contextOverflow: false,
        quotaExhausted: true,
        oauthRefreshFailed: false,
        transientUpstream: false,
      }),
    ).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
    // Even if the transient regex also fired, quota is the more specific class.
    expect(
      resolveClaudeFailureErrorCode({
        requiresLogin: false,
        contextOverflow: false,
        quotaExhausted: true,
        oauthRefreshFailed: false,
        transientUpstream: true,
      }),
    ).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
  });

  it("leaves the pre-existing precedence intact", () => {
    const base = {
      requiresLogin: false,
      contextOverflow: false,
      quotaExhausted: false,
      oauthRefreshFailed: false,
      transientUpstream: false,
    };
    expect(resolveClaudeFailureErrorCode({ ...base, requiresLogin: true, quotaExhausted: true }))
      .toBe("claude_auth_required");
    expect(resolveClaudeFailureErrorCode({ ...base, maxTurnsExhausted: true, quotaExhausted: true }))
      .toBe("max_turns_exhausted");
    expect(resolveClaudeFailureErrorCode({ ...base, contextOverflow: true, quotaExhausted: true }))
      .toBe(CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE);
    expect(resolveClaudeFailureErrorCode({ ...base, transientUpstream: true }))
      .toBe("claude_transient_upstream");
    expect(resolveClaudeFailureErrorCode(base)).toBeNull();
  });

  // AUR-5863: the OAuth credential-refresh failure gets its own code, ranked between
  // quota and the transient catch-all.
  it("maps oauthRefreshFailed to claude_oauth_refresh_failed, ahead of the transient catch-all but behind quota", () => {
    expect(
      resolveClaudeFailureErrorCode({
        requiresLogin: false,
        contextOverflow: false,
        quotaExhausted: false,
        oauthRefreshFailed: true,
        transientUpstream: true,
      }),
    ).toBe(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE);
    expect(
      resolveClaudeFailureErrorCode({
        requiresLogin: false,
        contextOverflow: false,
        quotaExhausted: true,
        oauthRefreshFailed: true,
        transientUpstream: false,
      }),
    ).toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
  });

  it("persists the structured quota metadata verbatim, and nothing when there is no wall", () => {
    const quota = detectClaudeQuotaExhaustion({
      parsed: null,
      stdout: LIVE_REJECTED_RATE_LIMIT_EVENT,
    });
    expect(claudeQuotaExhaustionResultJson(quota)).toEqual({
      quotaExhausted: true,
      quotaExhaustion: {
        source: "structured",
        resetAt: LIVE_REJECTED_RESET_ISO,
        rateLimitType: "seven_day",
        overageDisabledReason: "out_of_credits",
        outOfCredits: true,
      },
    });
    expect(claudeQuotaExhaustionResultJson(null)).toEqual({});
  });
});

// AUR-5863: the CLI's own credential-refresh failure (distinct from `claude_auth_required`,
// which needs a human `claude login`, and from ordinary `claude_transient_upstream` weather).
// The positive fixture is the verbatim production string -- specimen run
// 7a0e35c9-035a-4d75-89d0-e192a3189ef3 -- confirmed by AUR-5847 as the sole wording variant
// across every retained AUR-5412 run log.
describe("isClaudeOAuthRefreshFailedError (AUR-5863)", () => {
  it("FIRES on the exact production wording", () => {
    const input = {
      errorMessage: "Failed to authenticate: OAuth session expired and could not be refreshed",
    };
    expect(isClaudeOAuthRefreshFailedError(input)).toBe(true);
    // Not lumped into the generic transient bucket -- it has its own code.
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  it("FIRES when the wording arrives on trusted stderr/stdout instead of errorMessage", () => {
    expect(
      isClaudeOAuthRefreshFailedError({
        stderr: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
    ).toBe(true);
    expect(
      isClaudeOAuthRefreshFailedError({
        stdout: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
    ).toBe(true);
  });

  it("PASS: does not fire on ordinary claude_auth_required wording, and does not regress that classification", () => {
    const input = { stderr: "Please log in. Run `claude login` first." };
    expect(isClaudeOAuthRefreshFailedError(input)).toBe(false);
    // The existing login-required path is untouched by this classifier.
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  it("PASS: does not fire on unrelated transient or quota wording", () => {
    expect(
      isClaudeOAuthRefreshFailedError({ stderr: "HTTP 429: Too Many Requests" }),
    ).toBe(false);
    expect(
      isClaudeOAuthRefreshFailedError({
        errorMessage: "You've hit your session limit · resets 7:40pm (UTC)",
      }),
    ).toBe(false);
  });

  it("resolves to CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE via resolveClaudeFailureErrorCode, and the code is disjoint from every existing code", () => {
    expect(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE).toBe("claude_oauth_refresh_failed");
    expect(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE).not.toBe("claude_auth_required");
    expect(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE).not.toBe("claude_transient_upstream");
    expect(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE).not.toBe(CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE);
    expect(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE).not.toBe(CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE);
    expect(
      resolveClaudeFailureErrorCode({
        requiresLogin: false,
        contextOverflow: false,
        quotaExhausted: false,
        oauthRefreshFailed: true,
        transientUpstream: false,
      }),
    ).toBe(CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE);
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
