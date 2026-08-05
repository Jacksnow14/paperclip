import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
// AUR-4531: an explicit throttle/quota signal is transient BY DEFINITION -- waiting and
// re-sending the same request is the documented remedy. The narrowing return at the bottom
// of isCodexTransientUpstreamError additionally required the remote-compaction or
// high-demand wording, so a bare `429` or a bare `rate limit` matched
// CODEX_TRANSIENT_UPSTREAM_RE and was then thrown away: no errorFamily, no bounded retry,
// no quota pause, no breaker. Checked on its own below and short-circuits to transient.
const CODEX_EXPLICIT_THROTTLE_RE =
  /(?:\b429\b|rate[-\s]?limit(?:ed|ing|s)?|rate_limit(?:_error)?|too\s+many\s+requests|quota\s+exceeded|throttl(?:ed|ing)|throttlingexception|\b503\b|\b529\b|server\s+overloaded|overloaded_error|service\s+unavailable)/i;
// Matches both the model-scoped wording ("...usage limit for GPT-5.3-Codex-Spark.
// Switch to another model now, or try again at ...") and the account-level wording
// ("...usage limit. Upgrade to Pro (...), visit ... to purchase more credits or try
// again at ...") observed in production codex_local runs (AUR-4139).
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit\b[\s\S]{0,400}?\bor try again at\s+([^.!\n]+?)(?:[.!]|\n|$)/i;

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    errorMessage,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

function buildCodexErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// AUR-4531 / AUR-4513 discipline: `stdout` for codex_local is the agent's own JSONL
// transcript, so any wording an agent merely *discusses* lands in the haystack above.
// AUR-4513 showed exactly how that goes wrong: 2,394 runs were mis-tagged transient
// because agents talk about quota wording. The widened bare-`429`/bare-`rate limit` test
// therefore reads only the adapter's genuine failure channels -- the harness-supplied
// errorMessage and the process's stderr -- never the transcript.
function buildCodexFailureChannelHaystack(input: {
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [input.errorMessage ?? "", input.stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

const MONTH_ABBREVIATIONS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

// Handles both a bare clock time ("11:31 PM", "11:31 PM (America/Chicago)") and a
// date-prefixed clock time ("Jun 18th, 2026 2:13 AM") — the account-level usage-limit
// wording observed in production always includes the full reset date (AUR-4139).
function parseLocalClockTime(clockText: string, now: Date): Date | null {
  const normalized = clockText.trim();
  const match = normalized.match(
    /^(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?$/i,
  );
  if (!match) return null;

  const monthName = match[1];
  const day = match[2] != null ? Number.parseInt(match[2], 10) : null;
  const year = match[3] != null ? Number.parseInt(match[3], 10) : null;
  const hour12 = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[6] ?? "").toLowerCase() === "p") hour24 += 12;

  const timeZoneHint = match[7] ?? match[8];

  if (monthName != null && day != null && year != null) {
    if (day < 1 || day > 31) return null;
    const monthIndex = MONTH_ABBREVIATIONS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (monthIndex === -1) return null;

    const timeZone = normalizeResetTimeZone(timeZoneHint);
    if (timeZone) {
      return dateFromTimeZoneWallClock({ year, month: monthIndex + 1, day, hour: hour24, minute, timeZone });
    }

    const retryAt = new Date(year, monthIndex, day, hour24, minute, 0, 0);
    return Number.isNaN(retryAt.getTime()) ? null : retryAt;
  }

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractCodexRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildCodexErrorHaystack(input);
  const usageLimitMatch = haystack.match(CODEX_USAGE_LIMIT_RE);
  if (!usageLimitMatch) return null;
  return parseLocalClockTime(usageLimitMatch[1] ?? "", now);
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);

  if (extractCodexRetryNotBefore(input) != null) return true;
  // AUR-4531: a bare `429` / bare `rate limit` on a real failure channel is transient on
  // its own and must not have to also carry the remote-compaction or high-demand wording
  // demanded by the narrowing return below.
  if (CODEX_EXPLICIT_THROTTLE_RE.test(buildCodexFailureChannelHaystack(input))) return true;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape, plus explicit usage-limit windows that tell us when retrying
  // becomes safe again.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}
