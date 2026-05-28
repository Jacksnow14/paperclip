import { describe, expect, it } from "vitest";
import {
  computeBackoffRetryAfter,
  isRateLimitError,
  parseRateLimitResetTime,
  RATE_LIMIT_MAX_RETRY_COUNT,
} from "../services/rate-limit-parser.ts";

describe("isRateLimitError", () => {
  it("matches common rate-limit phrases", () => {
    expect(isRateLimitError("Codex CLI: usage limit reached, try again at 14:00")).toBe(true);
    expect(isRateLimitError("rate limit exceeded")).toBe(true);
    expect(isRateLimitError("Rate-limit window expired")).toBe(true);
    expect(isRateLimitError("quota exhausted")).toBe(true);
    expect(isRateLimitError("Too Many Requests")).toBe(true);
    expect(isRateLimitError("HTTP 429: please slow down")).toBe(true);
  });

  it("matches Claude and Codex hit-your-limit phrasing", () => {
    expect(isRateLimitError("You've hit your limit · resets 1am (UTC)")).toBe(true);
    expect(isRateLimitError("You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRateLimitError("ECONNREFUSED")).toBe(false);
    expect(isRateLimitError("session expired")).toBe(false);
    expect(isRateLimitError("")).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("parseRateLimitResetTime", () => {
  const now = new Date("2026-05-17T10:00:00.000Z");

  it("returns null for empty input", () => {
    expect(parseRateLimitResetTime(null, now)).toBeNull();
    expect(parseRateLimitResetTime("", now)).toBeNull();
    expect(parseRateLimitResetTime("nothing to see here", now)).toBeNull();
  });

  it("parses relative retry windows", () => {
    expect(parseRateLimitResetTime("rate limit hit, retry after 30 seconds", now)?.toISOString())
      .toBe("2026-05-17T10:00:30.000Z");
    expect(parseRateLimitResetTime("usage limit reached, try again in 15 minutes", now)?.toISOString())
      .toBe("2026-05-17T10:15:00.000Z");
    expect(parseRateLimitResetTime("Retry-After: 120", now)?.toISOString())
      .toBe("2026-05-17T10:02:00.000Z");
  });

  it("parses absolute clock windows", () => {
    expect(parseRateLimitResetTime("usage limit reached, try again at 14:30", now)?.toISOString())
      .toBe("2026-05-17T14:30:00.000Z");
    expect(parseRateLimitResetTime("resets 14:30 (UTC)", now)?.toISOString())
      .toBe("2026-05-17T14:30:00.000Z");
    expect(parseRateLimitResetTime("reset 3pm", now)?.toISOString())
      .toBe("2026-05-17T15:00:00.000Z");
  });

  it("rolls past midnight when needed", () => {
    const lateNow = new Date("2026-05-17T23:30:00.000Z");
    expect(parseRateLimitResetTime("try again at 00:30", lateNow)?.toISOString())
      .toBe("2026-05-18T00:30:00.000Z");
    expect(parseRateLimitResetTime("You've hit your limit · resets 1am (UTC)", lateNow)?.toISOString())
      .toBe("2026-05-18T01:00:00.000Z");
  });

  it("parses ISO timestamps", () => {
    expect(parseRateLimitResetTime("rate limit: reset 2026-05-17T11:00:00Z", now)?.toISOString())
      .toBe("2026-05-17T11:00:00.000Z");
  });
});

describe("computeBackoffRetryAfter", () => {
  const now = new Date("2026-05-17T10:00:00.000Z");

  it("starts at five minutes and doubles up to one hour", () => {
    expect(computeBackoffRetryAfter(0, now).getTime() - now.getTime()).toBe(5 * 60 * 1000);
    expect(computeBackoffRetryAfter(1, now).getTime() - now.getTime()).toBe(10 * 60 * 1000);
    expect(computeBackoffRetryAfter(2, now).getTime() - now.getTime()).toBe(20 * 60 * 1000);
    expect(computeBackoffRetryAfter(3, now).getTime() - now.getTime()).toBe(40 * 60 * 1000);
    expect(computeBackoffRetryAfter(4, now).getTime() - now.getTime()).toBe(60 * 60 * 1000);
    expect(computeBackoffRetryAfter(99, now).getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });
});

describe("RATE_LIMIT_MAX_RETRY_COUNT", () => {
  it("caps retries at five", () => {
    expect(RATE_LIMIT_MAX_RETRY_COUNT).toBe(5);
  });
});
