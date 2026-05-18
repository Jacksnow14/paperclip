const RATE_LIMIT_KEYWORDS = [
  "usage limit",
  "rate limit",
  "rate-limit",
  "ratelimit",
  "quota",
  "too many requests",
  "429",
  "try again at",
  "try again in",
  "retry after",
  "retry-after",
  "hit your limit",
  "hit the limit",
  "reached your limit",
  "exceeded your limit",
] as const;

const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function isRateLimitError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return RATE_LIMIT_KEYWORDS.some((kw) => lower.includes(kw));
}

export function parseRateLimitResetTime(
  errorMessage: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!errorMessage) return null;
  const lower = errorMessage.toLowerCase();

  const secondsMatch =
    lower.match(/retry[- ]after[^\d]{0,16}(\d+)\s*(s|sec|secs|second|seconds)?\b/) ??
    lower.match(/try again in[^\d]{0,16}(\d+)\s*(s|sec|secs|second|seconds)\b/) ??
    lower.match(/(\d+)\s*seconds?\s+(?:until|before)\s+(?:retry|reset)/);
  if (secondsMatch?.[1]) {
    const seconds = parseInt(secondsMatch[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(now.getTime() + seconds * 1000);
    }
  }

  const minutesMatch =
    lower.match(/retry[- ]after[^\d]{0,16}(\d+)\s*(m|min|mins|minute|minutes)\b/) ??
    lower.match(/try again in[^\d]{0,16}(\d+)\s*(m|min|mins|minute|minutes)\b/) ??
    lower.match(/(\d+)\s*minutes?\s+(?:until|before)\s+(?:retry|reset)/);
  if (minutesMatch?.[1]) {
    const minutes = parseInt(minutesMatch[1], 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return new Date(now.getTime() + minutes * 60 * 1000);
    }
  }

  const hoursMatch =
    lower.match(/retry[- ]after[^\d]{0,16}(\d+)\s*(h|hr|hrs|hour|hours)\b/) ??
    lower.match(/try again in[^\d]{0,16}(\d+)\s*(h|hr|hrs|hour|hours)\b/);
  if (hoursMatch?.[1]) {
    const hours = parseInt(hoursMatch[1], 10);
    if (Number.isFinite(hours) && hours > 0) {
      return new Date(now.getTime() + hours * 60 * 60 * 1000);
    }
  }

  const clockMatch =
    lower.match(
      /try again at\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?(?:\s*\(?\s*([a-z+\-0-9_/]+))?/,
    ) ??
    lower.match(
      /resets?\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?(?:\s*\(?\s*([a-z+\-0-9_/]+))?/,
    ) ??
    lower.match(
      /resets?\s+(\d{1,2})()(am|pm)(?:\s*\(?\s*([a-z+\-0-9_/]+))?/,
    );
  if (clockMatch) {
    const hourRaw = parseInt(clockMatch[1]!, 10);
    const minute = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
    const ampm = clockMatch[3];
    if (
      Number.isFinite(hourRaw) &&
      Number.isFinite(minute) &&
      hourRaw >= 0 &&
      hourRaw <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      let hour = hourRaw;
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      const target = new Date(now.getTime());
      target.setUTCHours(hour, minute, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
      const delta = target.getTime() - now.getTime();
      if (delta > 0 && delta <= 26 * 60 * 60 * 1000) {
        return target;
      }
    }
  }

  const isoMatch = errorMessage.match(
    /(?:retry|reset|try again)[^\d]{0,32}(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)/i,
  );
  if (isoMatch?.[1]) {
    const parsed = new Date(isoMatch[1].replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed;
    }
  }

  const epochMatch =
    lower.match(/retry[- ]after[^\d]{0,8}(\d{10,13})\b/) ??
    lower.match(/reset[^\d]{0,8}(\d{10,13})\b/);
  if (epochMatch?.[1]) {
    let value = parseInt(epochMatch[1], 10);
    if (Number.isFinite(value)) {
      if (value < 1e12) value *= 1000;
      if (value > now.getTime()) return new Date(value);
    }
  }

  return null;
}

export function computeBackoffRetryAfter(retryCount: number, now: Date = new Date()): Date {
  const safeCount = Math.max(0, Math.floor(retryCount));
  const ms = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** safeCount);
  return new Date(now.getTime() + ms);
}

export const RATE_LIMIT_MAX_RETRY_COUNT = 5;
