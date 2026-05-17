import { describe, it, expect } from "vitest";
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
    expect(isRateLimitError("server returned RateLimit error")).toBe(true);
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

  it("parses 'retry after N seconds'", () => {
    const t = parseRateLimitResetTime("rate limit hit, retry after 30 seconds", now);
    expect(t?.toISOString()).toBe("2026-05-17T10:00:30.000Z");
  });

  it("parses 'try again in N minutes'", () => {
    const t = parseRateLimitResetTime("usage limit reached, try again in 15 minutes", now);
    expect(t?.toISOString()).toBe("2026-05-17T10:15:00.000Z");
  });

  it("parses 'retry-after: 120' header-style", () => {
    const t = parseRateLimitResetTime("Retry-After: 120", now);
    expect(t?.toISOString()).toBe("2026-05-17T10:02:00.000Z");
  });

  it("parses 'try again at HH:MM' UTC", () => {
    const t = parseRateLimitResetTime("usage limit reached, try again at 14:30", now);
    expect(t?.toISOString()).toBe("2026-05-17T14:30:00.000Z");
  });

  it("rolls past midnight when the clock time is earlier than now", () => {
    const lateNow = new Date("2026-05-17T23:30:00.000Z");
    const t = parseRateLimitResetTime("try again at 00:30", lateNow);
    expect(t?.toISOString()).toBe("2026-05-18T00:30:00.000Z");
  });

  it("parses ISO 8601 reset timestamps", () => {
    const t = parseRateLimitResetTime("rate limit: reset 2026-05-17T11:00:00Z", now);
    expect(t?.toISOString()).toBe("2026-05-17T11:00:00.000Z");
  });

  it("ignores rate-limit phrases without a numeric reset hint", () => {
    expect(parseRateLimitResetTime("you have exceeded your quota", now)).toBeNull();
  });
});

describe("computeBackoffRetryAfter", () => {
  const now = new Date("2026-05-17T10:00:00.000Z");

  it("returns 5 minutes for first retry (count = 0)", () => {
    const t = computeBackoffRetryAfter(0, now);
    expect(t.getTime() - now.getTime()).toBe(5 * 60 * 1000);
  });

  it("doubles each retry", () => {
    expect(computeBackoffRetryAfter(1, now).getTime() - now.getTime()).toBe(10 * 60 * 1000);
    expect(computeBackoffRetryAfter(2, now).getTime() - now.getTime()).toBe(20 * 60 * 1000);
    expect(computeBackoffRetryAfter(3, now).getTime() - now.getTime()).toBe(40 * 60 * 1000);
  });

  it("caps at 60 minutes", () => {
    expect(computeBackoffRetryAfter(4, now).getTime() - now.getTime()).toBe(60 * 60 * 1000);
    expect(computeBackoffRetryAfter(99, now).getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });

  it("clamps negative retry counts", () => {
    expect(computeBackoffRetryAfter(-1, now).getTime() - now.getTime()).toBe(5 * 60 * 1000);
  });
});

describe("RATE_LIMIT_MAX_RETRY_COUNT", () => {
  it("is 5", () => {
    expect(RATE_LIMIT_MAX_RETRY_COUNT).toBe(5);
  });
});
