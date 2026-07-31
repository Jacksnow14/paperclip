import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  CLAUDE_CONTEXT_OVERFLOW_RE,
  isClaudeContextOverflowMessage,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|session\s+limit)/i;
// Prefixes recognized ahead of a "resets <time>" hint. Must stay in sync with
// the quota-exhaustion wording covered by CLAUDE_TRANSIENT_UPSTREAM_RE above
// (AUR-4055: "You've hit your session limit" carries a live reset timestamp
// but was falling outside this list, so the retry scheduler never learned
// when it was safe to try again and fell back to the generic bounded-backoff
// ladder instead).
const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached|session\s+limit)[\s\S]{0,80}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

// AUR-4513: a prompt-size rejection is DETERMINISTIC -- the same prompt re-sent
// unchanged can never succeed, so it must never share the transient/retryable
// family. Live wording (2,394 rows, 2026-07-26..29) is exactly
// `Claude run failed: subtype=success: Prompt is too long`.
// AUR-4557: both forms of the wording test now live in adapter-utils, shared with the
// heartbeat service. The substring form is only ever applied to text the model cannot
// author; anything that can carry model prose goes through the anchored form.
export { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-utils";

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit" ||
    reason === "turn_limit_exhausted",
  );
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    input.stdout ?? "",
    input.stderr ?? "",
  ]
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

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

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

export function extractClaudeRetryNotBefore(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  now = new Date(),
): Date | null {
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

/**
 * AUR-4513: detect a prompt-size rejection.
 *
 * Deliberately does NOT look at `stdout`/`stderr`. `buildClaudeTransientHaystack`
 * folds the whole stream-JSON transcript into its haystack, which is why every one
 * of the 2,394 overflow runs was mis-tagged `claude_transient_upstream`: our agents
 * routinely *discuss* quota wording ("session limit", "usage limit reached") in the
 * conversation being resumed, so the transient regex matched the transcript content
 * rather than the actual failure.
 *
 * AUR-4557: excluding `stdout`/`stderr` was NOT sufficient, and the original fix
 * reproduced the bug class it was written to close. `parsed.result` IS the model's
 * final assistant message on a stream-JSON result event, and `describeClaudeFailure`
 * folds `parsed.result` into `errorMessage` — so a substring test over either one is
 * still reading free-form model prose. An agent that ends a turn summarising "…the
 * prompt is too long…" and then fails for an unrelated reason (or on a genuine 529)
 * was classified as a deterministic overflow: no `errorFamily`, no retry ladder for a
 * transient failure, and a forced session rotation. The rotation handoff itself
 * embeds the reason string, so the mistake could re-seed itself on the next run.
 *
 * Fields are therefore split by who can author them:
 *
 *   TRUSTED      `parsed.errors[].message`, adapter/CLI stderr — the model cannot
 *                write these, so a substring match is safe.
 *   CONTAMINABLE `parsed.result`, `errorMessage` — may be model prose, so the wording
 *                must OPEN the payload (see `isClaudeContextOverflowMessage`) rather
 *                than merely appear somewhere inside it.
 */
export function isClaudeContextOverflowError(input: {
  parsed?: Record<string, unknown> | null;
  /** Adapter-derived failure summary; may embed the model's final message. Anchored. */
  errorMessage?: string | null;
  /** Text the model cannot author (process stderr). Substring-matched. */
  trustedText?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;

  const trusted = [
    input.trustedText ?? "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ].filter(Boolean);
  if (trusted.some((text) => CLAUDE_CONTEXT_OVERFLOW_RE.test(text))) return true;

  const contaminable = [parsed ? asString(parsed.result, "") : "", input.errorMessage ?? ""];
  return contaminable.some((text) => isClaudeContextOverflowMessage(text));
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  // Deterministic failures are handled by their own classifiers.
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed))) {
    return false;
  }
  // AUR-4513: prompt-size rejection is deterministic; it must never be retried as
  // transient. Checked before the haystack test because the haystack includes the
  // resumed transcript and false-positives on quota wording inside it.
  if (isClaudeContextOverflowError({ parsed, errorMessage: input.errorMessage })) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}
