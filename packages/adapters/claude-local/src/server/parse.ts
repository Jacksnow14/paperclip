import { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE, type UsageSummary } from "@paperclipai/adapter-utils";
import {
  CLAUDE_CONTEXT_OVERFLOW_RE,
  CLAUDE_FAILURE_WRAPPER_RE,
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

// AUR-4531: the quota-exhaustion wording, factored into ONE source of truth shared by
// the transient classifier and the reset-time extractor below. Production emits this in
// two grammatically different shapes:
//
//   "Claude usage limit reached"                        <- "<kind> limit reached"
//   "You've hit your weekly limit"                      <- "hit your <kind> limit"
//   "You've hit your weekly limit · resets Aug 1"
//   "You've hit your weekly limit · resets Jul 29, 11am (UTC)"   (AUR-4192)
//   "You've hit your session limit · resets 4pm (UTC)"
//
// The pre-AUR-4192/AUR-4531 regexes only covered the first shape (and `session limit` as
// a bare literal, which is why the session variant happened to match). Every
// "You've hit your weekly limit" failure therefore classified as NON-transient: no
// `errorFamily`, no `retryNotBefore`, no quota pause. That is the root of AUR-4336,
// which burned 72h of fleet quota against a wall nothing was watching.
//
// Keeping both regexes derived from this one fragment is deliberate: the previous
// duplicated-literal arrangement is exactly how the two lists drifted apart (AUR-4055
// had to patch the same omission once already, and AUR-4192 a second time). A string
// that classifies transient but yields no reset time silently degrades the scheduler
// back to the bounded-ladder behaviour this issue exists to kill.
const CLAUDE_QUOTA_LIMIT_KIND = String.raw`(?:\d+[-\s]?hour|weekly|session|usage|extra\s+usage|opus)`;
const CLAUDE_QUOTA_EXHAUSTION_SOURCE = [
  String.raw`out\s+of\s+extra\s+usage`,
  String.raw`extra\s+usage\b`,
  // "<kind> limit reached" / "<kind> cap reached", optionally brand-prefixed.
  String.raw`(?:claude\s+)?${CLAUDE_QUOTA_LIMIT_KIND}\s+(?:limit|cap)\s+reached`,
  // AUR-4531 / AUR-4192: "You've hit your weekly limit" — the word "reached" never
  // appears in this shape.
  String.raw`hit\s+your\s+${CLAUDE_QUOTA_LIMIT_KIND}\s+(?:limit|cap)`,
  // Retained as bare literals for back-compatibility with the pre-AUR-4531 wording set.
  String.raw`session\s+limit`,
  String.raw`usage\s+limit\s+reached`,
].join("|");

// AUR-4144: the quota wall gets its own error CODE (the family stays
// `transient_upstream` -- see execute.ts for why), so the class is observable in the
// run table without having to re-derive it from prose after the fact.
export const CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE = "claude_quota_exhausted";

// AUR-4144: a dedicated matcher over the SAME shared wording fragment as the transient
// classifier and the reset-hint extractor. Built here rather than re-listing the
// literals, because a fourth copy of the list is a fourth thing to forget to patch
// (AUR-4055 -> AUR-4192 -> AUR-4531 each patched one copy and missed another).
const CLAUDE_QUOTA_EXHAUSTION_RE = new RegExp(`(?:${CLAUDE_QUOTA_EXHAUSTION_SOURCE})`, "i");

/**
 * AUR-4524: anchored form of the quota wording, mirroring `isClaudeContextOverflowMessage`
 * (AUR-4557). The phrase must OPEN the (wrapper-stripped) payload and be followed by
 * end-of-string or punctuation, so a genuine CLI quota message ("You've hit your weekly
 * limit · resets Aug 1") still matches, but the same words merely QUOTED mid-report by an
 * agent ("...the run failed; I noticed it logged 'You've hit your weekly limit' before
 * dying...") do not. This is the AUR-4524 defect: `parsed.result` is the agent's OWN final
 * text on a `subtype=success` result, and an unanchored substring test over it let quoting
 * the wording self-inflict the classification (and, since AUR-4192 widened the regex, a
 * real quota pause parked at a reset time the agent only mentioned). A leading
 * "you're"/"you've" is part of the genuine wording itself (see the production specimens
 * above), not prose to reject.
 */
const CLAUDE_QUOTA_EXHAUSTION_ANCHORED_RE = new RegExp(
  `^(?:you(?:'re|'ve)\\s+)?(?:${CLAUDE_QUOTA_EXHAUSTION_SOURCE})(?=\\s*(?:$|[-\u2013\u2014:.,;!?\u00b7]))`,
  "i",
);

function stripClaudeFailureWrapper(value: string): string {
  return value.trim().replace(CLAUDE_FAILURE_WRAPPER_RE, "").trim();
}

/** Anchored quota-wording test for text the model CAN author. See the regex doc above. */
function isClaudeQuotaExhaustionMessage(value: string | null | undefined): boolean {
  if (!value) return false;
  const payload = stripClaudeFailureWrapper(value);
  if (!payload) return false;
  return CLAUDE_QUOTA_EXHAUSTION_ANCHORED_RE.test(payload);
}

// AUR-4524: quota-free core, safe to test UNANCHORED against text the model can author
// (parsed.result/errorMessage) -- see isClaudeTransientUpstreamError. Quota wording is
// deliberately excluded here: once the quota check above has correctly rejected
// contaminated prose for not anchoring the payload, this regex must not re-catch the same
// wording as generic transient via a bare substring match.
const CLAUDE_TRANSIENT_UPSTREAM_CORE_SOURCE =
  "rate[-\\s]?limit(?:ed)?|rate_limit_error|too\\s+many\\s+requests|\\b429\\b|overloaded(?:_error)?|server\\s+overloaded|service\\s+unavailable|\\b503\\b|\\b529\\b|high\\s+demand|try\\s+again\\s+later|temporarily\\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception";
const CLAUDE_TRANSIENT_UPSTREAM_CORE_RE = new RegExp(
  `(?:${CLAUDE_TRANSIENT_UPSTREAM_CORE_SOURCE})`,
  "i",
);

// Full form (core + quota wording). Only safe on text the model cannot author (trusted
// `parsed.errors[]`), or on the raw stdout/stderr fallback used when there is no parsed
// terminal result to trust at all (see buildClaudeRawHaystack) -- retained for that path
// and for the legacy combined haystack `extractClaudeRetryNotBefore` reads.
const CLAUDE_TRANSIENT_UPSTREAM_RE = new RegExp(
  `(?:${CLAUDE_TRANSIENT_UPSTREAM_CORE_SOURCE}|${CLAUDE_QUOTA_EXHAUSTION_SOURCE})`,
  "i",
);

// Prefixes recognized ahead of a "resets <time>" hint. Shares
// CLAUDE_QUOTA_EXHAUSTION_SOURCE with the classifier above so the two can no longer
// drift (AUR-4055: "You've hit your session limit" carries a live reset timestamp but
// was falling outside the old hand-maintained list, so the retry scheduler never learned
// when it was safe to try again and fell back to the generic bounded-backoff ladder.
// AUR-4192/AUR-4531: the same happened again for the weekly/5-hour "hit your ... limit"
// wording).
const CLAUDE_EXTRA_USAGE_RESET_RE = new RegExp(
  `(?:${CLAUDE_QUOTA_EXHAUSTION_SOURCE})[\\s\\S]{0,80}?\\bresets?\\s+(?:at\\s+)?([^\\n()]+?)(?:\\s*\\(([^)]+)\\))?(?:[.!]|\\n|$)`,
  "i",
);

// AUR-4513: a prompt-size rejection is DETERMINISTIC -- the same prompt re-sent
// unchanged can never succeed, so it must never share the transient/retryable
// family. Live wording (2,394 rows, 2026-07-26..29) is exactly
// `Claude run failed: subtype=success: Prompt is too long`.
// AUR-4557: both forms of the wording test now live in adapter-utils, shared with the
// heartbeat service. The substring form is only ever applied to text the model cannot
// author; anything that can carry model prose goes through the anchored form.
export { CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE };

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

interface ClaudeFailureFields {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}

function normalizeHaystack(parts: string[]): string {
  return parts
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The adapter's OWN account of the failure: the harness error message plus whatever the
 * CLI put in its terminal `result` event. Trustworthy, because none of it is transcript.
 */
function buildClaudePrimaryHaystack(input: ClaudeFailureFields): string {
  const parsed = input.parsed ?? null;
  return normalizeHaystack([
    input.errorMessage ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ]);
}

/**
 * AUR-4524: the trusted/contaminable split from `isClaudeContextOverflowError` (AUR-4557),
 * applied to the quota/transient classifiers. `parsed.errors[].message` is a structured API
 * error object the model cannot author, so it stays safe for unanchored substring matching.
 * `errorMessage` and `parsed.result` CAN be the model's own final report on a
 * `subtype=success` result -- callers that need to test this text against wording the model
 * might legitimately discuss (quota phrasing) must anchor it; callers testing wording the
 * model has no reason to discuss (429/503/529/overloaded) may still use it unanchored.
 */
function buildClaudeTrustedHaystack(input: ClaudeFailureFields): string {
  const parsed = input.parsed ?? null;
  return normalizeHaystack(parsed ? extractClaudeErrorMessages(parsed) : []);
}

function claudeContaminableTexts(input: ClaudeFailureFields): string[] {
  const parsed = input.parsed ?? null;
  return [input.errorMessage ?? "", parsed ? asString(parsed.result, "") : ""];
}

/**
 * AUR-4144: raw stdout/stderr with every structured stream event dropped.
 *
 * Raw stdout is the entire resumed conversation transcript plus the CLI's own
 * stream-JSON. Both are contaminated sources for a prose classifier: the original
 * AUR-4144 run failed on `session limit` yet matched the transient regex only via an
 * incidental `rate_limit` JSON key, and agents in this fleet routinely *discuss* quota
 * wording in the conversation being resumed. Any line that parses as JSON with a `type`
 * field is a stream event -- it is handled STRUCTURALLY now
 * (`extractClaudeRateLimitEvents`), so folding its text into a regex haystack buys
 * nothing and costs false positives.
 */
function buildClaudeRawHaystack(input: ClaudeFailureFields): string {
  const lines: string[] = [];
  for (const rawLine of [input.stdout ?? "", input.stderr ?? ""].join("\n").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = line.startsWith("{") ? parseJson(line) : null;
    if (event && typeof event === "object" && !Array.isArray(event) && "type" in event) {
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Legacy combined haystack (primary + raw, stream events included). Retained ONLY for
 * `extractClaudeRetryNotBefore`, whose exported behaviour predates AUR-4144: scraping a
 * `resets <time>` hint out of stderr is not a classification decision, so the
 * contamination risk that motivated the split does not apply to it.
 */
function buildClaudeTransientHaystack(input: ClaudeFailureFields): string {
  return normalizeHaystack([
    buildClaudePrimaryHaystack(input),
    input.stdout ?? "",
    input.stderr ?? "",
  ]);
}

export interface ClaudeRateLimitInfo {
  status: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  rateLimitType: string | null;
  resetsAtEpochSeconds: number | null;
  isUsingOverage: boolean;
}

/**
 * AUR-4144: the Claude CLI stream emits an AUTHORITATIVE, machine-readable quota event
 * that nothing parsed until now. Verbatim from a production run log:
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
 *    "resetsAt":1785322800,"rateLimitType":"seven_day","overageStatus":"rejected",
 *    "overageDisabledReason":"out_of_credits","isUsingOverage":false}, ...}
 *
 * `resetsAt` is unix SECONDS, and the lane recovered at exactly that instant. Note such
 * a run can end with no `{"type":"result"}` line at all, so this must work off the raw
 * stream, not off the parsed terminal result.
 *
 * Returned in stream order.
 */
export function extractClaudeRateLimitEvents(
  stdout: string | null | undefined,
): ClaudeRateLimitInfo[] {
  const events: ClaudeRateLimitInfo[] = [];
  if (!stdout) return events;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    const event = parseJson(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    if (asString(event.type, "") !== "rate_limit_event") continue;

    const info = parseObject(event.rate_limit_info);
    const resetsAt = asNumber(info.resetsAt, Number.NaN);
    events.push({
      status: asString(info.status, "") || null,
      overageStatus: asString(info.overageStatus, "") || null,
      overageDisabledReason: asString(info.overageDisabledReason, "") || null,
      rateLimitType: asString(info.rateLimitType, "") || null,
      resetsAtEpochSeconds: Number.isFinite(resetsAt) ? resetsAt : null,
      isUsingOverage: info.isUsingOverage === true,
    });
  }

  return events;
}

// A `rate_limit_event` is emitted for allowed requests too; only a rejection is a wall.
function isRejectedRateLimit(info: ClaudeRateLimitInfo): boolean {
  return info.status === "rejected" || info.overageStatus === "rejected";
}

// LAST rejection wins: a resumed session can carry an earlier, already-expired wall.
function findLastRejectedRateLimit(input: ClaudeFailureFields): ClaudeRateLimitInfo | null {
  const events = extractClaudeRateLimitEvents(
    [input.stdout ?? "", input.stderr ?? ""].join("\n"),
  );
  let last: ClaudeRateLimitInfo | null = null;
  for (const event of events) {
    if (isRejectedRateLimit(event)) last = event;
  }
  return last;
}

function rateLimitResetDate(info: ClaudeRateLimitInfo): Date | null {
  const seconds = info.resetsAtEpochSeconds;
  // Only absent/non-finite/non-positive values are rejected. A reset that looks stale or
  // implausibly distant is NOT nulled here -- the server clamps it, and silently
  // discarding the one authoritative timestamp is how we end up back on the blind ladder.
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
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

const RESET_MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// AUR-4192: the weekly-cap wording can carry an explicit calendar date ahead of
// the clock time ("resets Jul 29, 11am (UTC)"), which the clock-only parser
// below rejects because it anchors on the hour. Peel the date off so the clock
// parser sees what it expects, and report which day was named so the reset can
// be pinned to it instead of guessing the next occurrence of the clock time.
function splitResetDatePrefix(normalized: string): {
  monthDay: { month: number; day: number } | null;
  clockText: string;
} {
  const match = normalized.match(
    /^(?:([a-z]{3,9})\.?\s+(\d{1,2})|(\d{1,2})\s+([a-z]{3,9})\.?)(?:st|nd|rd|th)?,?\s+(.*)$/i,
  );
  if (!match) return { monthDay: null, clockText: normalized };

  const month = RESET_MONTH_NUMBERS[(match[1] ?? match[4] ?? "").slice(0, 3).toLowerCase()];
  const day = Number.parseInt(match[2] ?? match[3] ?? "", 10);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) {
    return { monthDay: null, clockText: normalized };
  }
  return { monthDay: { month, day }, clockText: match[5] ?? "" };
}

// Resolve a month/day that carries no year against `now`, picking whichever
// candidate year lands closest to it so a reset stated near a year boundary
// does not resolve twelve months away. A resolved instant in the past is
// returned as-is: the caller only ever uses `retryNotBefore` to push a retry
// later, so an already-elapsed quota window correctly imposes no extra pause.
function resolveDatedResetTime(input: {
  now: Date;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZoneHint?: string | null;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  const baseYear = timeZone
    ? readTimeZoneParts(input.now, timeZone).year
    : input.now.getFullYear();

  let best: Date | null = null;
  for (const year of [baseYear - 1, baseYear, baseYear + 1]) {
    const candidate = timeZone
      ? dateFromTimeZoneWallClock({
          year,
          month: input.month,
          day: input.day,
          hour: input.hour,
          minute: input.minute,
          timeZone,
        })
      : new Date(year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
    if (!candidate || Number.isNaN(candidate.getTime())) continue;
    if (
      !best ||
      Math.abs(candidate.getTime() - input.now.getTime()) <
        Math.abs(best.getTime() - input.now.getTime())
    ) {
      best = candidate;
    }
  }
  return best;
}

// AUR-4531: a *weekly* limit resets on a calendar day, not at a clock time, so its
// wording carries no am/pm at all: "You've hit your weekly limit · resets Aug 1".
// The clock-time parser below requires an am/pm match (even after the AUR-4192
// date-prefix split) and returns null for this shape, so even once the classifier was
// widened the reset time stayed null — and a null reset time is precisely what
// collapses the scheduler back onto the bounded retry ladder. A bare date is
// interpreted as midnight at the start of that day (the earliest instant the quota
// could plausibly be back), which errs toward re-probing early rather than
// over-suppressing.
function parseClaudeResetCalendarDate(
  normalized: string,
  now: Date,
  timeZoneHint?: string | null,
): Date | null {
  // "Aug 1", "Aug 1, 2026", "August 1 2026", "1 Aug" — plus an optional trailing time.
  const match = normalized.match(
    /^(?:([a-z]{3,9})\.?\s+(\d{1,2})|(\d{1,2})\s+([a-z]{3,9})\.?)(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?)?$/i,
  );
  if (!match) return null;

  const monthName = (match[1] ?? match[4] ?? "").toLowerCase();
  const day = Number.parseInt(match[2] ?? match[3] ?? "", 10);
  const month = RESET_MONTH_NUMBERS[monthName.slice(0, 3)];
  if (!month) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  let hour = 0;
  let minute = 0;
  if (match[6]) {
    const hour12 = Number.parseInt(match[6], 10);
    minute = Number.parseInt(match[7] ?? "0", 10);
    if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    hour = hour12 % 12;
    if ((match[8] ?? "").toLowerCase() === "p") hour += 12;
  }

  const timeZone = normalizeResetTimeZone(timeZoneHint);
  const explicitYear = match[5] ? Number.parseInt(match[5], 10) : null;
  // No year in the wording: pick the year that puts the reset in the FUTURE. A weekly
  // limit hit on Dec 28 that "resets Jan 3" is next year's Jan 3, and resolving it to a
  // date already past would impose no pause at all.
  const candidateYears = explicitYear != null
    ? [explicitYear]
    : timeZone
      ? [readTimeZoneParts(now, timeZone).year, readTimeZoneParts(now, timeZone).year + 1]
      : [now.getFullYear(), now.getFullYear() + 1];

  for (const year of candidateYears) {
    const resolved = timeZone
      ? dateFromTimeZoneWallClock({ year, month, day, hour, minute, timeZone })
      : (() => {
          const local = new Date(year, month - 1, day, hour, minute, 0, 0);
          return Number.isNaN(local.getTime()) ? null : local;
        })();
    if (!resolved) continue;
    if (explicitYear != null || resolved.getTime() > now.getTime()) return resolved;
  }
  return null;
}

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const calendarDate = parseClaudeResetCalendarDate(normalized, now, timeZoneHint);
  if (calendarDate) return calendarDate;
  const { monthDay, clockText: clockOnly } = splitResetDatePrefix(normalized);
  const match = clockOnly.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (monthDay) {
    const datedRetryAt = resolveDatedResetTime({
      now,
      month: monthDay.month,
      day: monthDay.day,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (datedRetryAt) return datedRetryAt;
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

export function extractClaudeRetryNotBefore(
  input: ClaudeFailureFields,
  now = new Date(),
): Date | null {
  // AUR-4144: prefer the structured epoch. Prose is a scraped approximation of a number
  // the CLI already told us exactly; when both exist the number wins.
  const rejected = findLastRejectedRateLimit(input);
  if (rejected) {
    const structuredReset = rateLimitResetDate(rejected);
    if (structuredReset) return structuredReset;
  }
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export interface ClaudeQuotaExhaustion {
  resetAt: Date | null;
  rateLimitType: string | null;
  overageDisabledReason: string | null;
  outOfCredits: boolean;
  source: "structured" | "prose";
}

/**
 * AUR-4144: detect a QUOTA WALL -- structured event first, human prose only as fallback.
 *
 * The prose regex has now needed patching three separate times (AUR-4055, AUR-4192,
 * AUR-4531) because it reads marketing copy that Anthropic is free to reword. The
 * `rate_limit_event` stream event is a contract, so it is the primary discriminator and
 * prose is demoted to a fallback for the (real) case where the CLI dies before emitting
 * one.
 *
 * The prose fallback deliberately reads the PRIMARY haystack only -- never raw
 * stdout/stderr. That is the whole defect: raw stdout is the resumed transcript.
 *
 * AUR-4524: within the primary haystack, `parsed.errors[]` is trusted and substring
 * matched, but `errorMessage`/`parsed.result` can be the model's own final report -- an
 * agent that merely quotes the wording while describing a run must not self-inflict a
 * quota wall, so that half is anchored (see `isClaudeQuotaExhaustionMessage`).
 */
export function detectClaudeQuotaExhaustion(
  input: ClaudeFailureFields,
  now = new Date(),
): ClaudeQuotaExhaustion | null {
  const rejected = findLastRejectedRateLimit(input);
  if (rejected) {
    return {
      resetAt: rateLimitResetDate(rejected),
      rateLimitType: rejected.rateLimitType,
      overageDisabledReason: rejected.overageDisabledReason,
      outOfCredits: rejected.overageDisabledReason === "out_of_credits",
      source: "structured",
    };
  }

  const parsed = input.parsed ?? null;
  const trusted = parsed ? extractClaudeErrorMessages(parsed) : [];
  const trustedSource = trusted.find((text) => CLAUDE_QUOTA_EXHAUSTION_RE.test(text)) ?? null;

  const contaminableSource =
    claudeContaminableTexts(input)
      .map((text) => stripClaudeFailureWrapper(text))
      .find((text) => text && CLAUDE_QUOTA_EXHAUSTION_ANCHORED_RE.test(text)) ?? null;

  const sourceText = trustedSource ?? contaminableSource;
  if (!sourceText) return null;

  const match = sourceText.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  const resetAt = match ? parseClaudeResetClockTime(match[1] ?? "", now, match[2]) : null;
  return {
    resetAt,
    rateLimitType: null,
    overageDisabledReason: null,
    outOfCredits: false,
    source: "prose",
  };
}

export function isClaudeQuotaExhaustedError(input: ClaudeFailureFields): boolean {
  return detectClaudeQuotaExhaustion(input) !== null;
}

// AUR-5863: the CLI's own credential-refresh failure, distinct from both
// `claude_auth_required` (needs a human to run `claude login`) and ordinary
// transient upstream weather. Verbatim production wording -- specimen run
// 7a0e35c9-035a-4d75-89d0-e192a3189ef3 (2026-08-16T06:30:02Z), and identical
// across every AUR-5412 run log that retains one (grepped 2026-08-20 against
// instances/default/data/run-logs/: no other variant observed):
//
//   "Failed to authenticate: OAuth session expired and could not be refreshed"
//
// This self-heals on its own schedule (the credential recovers without human
// action, typically by ~12:00 UTC) rather than needing a human `claude
// login`, so it must NOT be folded into CLAUDE_AUTH_REQUIRED_RE -- doing so
// would route it to a founder-escalation path that does not apply here, and
// conversely widening CLAUDE_AUTH_REQUIRED_RE itself would risk suppressing a
// genuine login-required case. Broaden this regex only against a second
// confirmed production sample, not speculatively.
const CLAUDE_OAUTH_REFRESH_FAILED_RE =
  /failed\s+to\s+authenticate:?\s*oauth\s+session\s+expired(?:\s+and\s+could\s+not\s+be\s+refreshed)?/i;

export const CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE = "claude_oauth_refresh_failed";

export function isClaudeOAuthRefreshFailedError(input: ClaudeFailureFields): boolean {
  const parsed = input.parsed ?? null;
  const haystack = normalizeHaystack([
    input.errorMessage ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
    input.stdout ?? "",
    input.stderr ?? "",
  ]);
  return CLAUDE_OAUTH_REFRESH_FAILED_RE.test(haystack);
}

/**
 * AUR-4144: the `resultJson` payload for a quota wall. A follow-up issue reads this to
 * surface quota state on the agent record and to escalate `out_of_credits` (which is NOT
 * self-healing at the reset instant -- it needs a human to add credit), so it is
 * persisted verbatim rather than re-derived from prose later.
 */
export function claudeQuotaExhaustionResultJson(
  quota: ClaudeQuotaExhaustion | null,
): Record<string, unknown> {
  if (!quota) return {};
  return {
    quotaExhausted: true,
    quotaExhaustion: {
      source: quota.source,
      resetAt: quota.resetAt ? quota.resetAt.toISOString() : null,
      rateLimitType: quota.rateLimitType,
      overageDisabledReason: quota.overageDisabledReason,
      outOfCredits: quota.outOfCredits,
    },
  };
}

/**
 * The failure-code precedence ladder, extracted as a pure function so it can be tested
 * without standing up a CLI harness. Most specific class first; `transient_upstream` is
 * the catch-all and therefore last.
 */
export function resolveClaudeFailureErrorCode(input: {
  requiresLogin: boolean;
  maxTurnsExhausted?: boolean;
  contextOverflow: boolean;
  quotaExhausted: boolean;
  oauthRefreshFailed: boolean;
  transientUpstream: boolean;
}): string | null {
  if (input.requiresLogin) return "claude_auth_required";
  if (input.maxTurnsExhausted) return "max_turns_exhausted";
  if (input.contextOverflow) return CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE;
  if (input.quotaExhausted) return CLAUDE_QUOTA_EXHAUSTED_ERROR_CODE;
  if (input.oauthRefreshFailed) return CLAUDE_OAUTH_REFRESH_FAILED_ERROR_CODE;
  if (input.transientUpstream) return "claude_transient_upstream";
  return null;
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
  // AUR-4144 note: this deliberately does NOT use buildClaudePrimaryHaystack — the
  // AUR-4557 split below is stricter (anchored matching for model-authorable text),
  // and collapsing it into a substring test over the joined haystack would regress it.
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

  // AUR-5863: the OAuth credential-refresh failure gets its own error code (see
  // `isClaudeOAuthRefreshFailedError`) so it must not also match here as an
  // undifferentiated `claude_transient_upstream`.
  if (isClaudeOAuthRefreshFailedError(input)) return false;

  // AUR-4144: QUOTA WINS. A quota wall is not a transient upstream hiccup -- it is a
  // deterministic wall with a known reset instant, and conflating the two is what made
  // 145+99 zero-token runs indistinguishable from ordinary 529s. execute.ts still assigns
  // it `errorFamily: "transient_upstream"` (see the comment there) so scheduling is
  // unchanged; the distinction lives in the error CODE and the structured metadata.
  if (detectClaudeQuotaExhaustion(input)) return false;

  // AUR-4524: same trusted/contaminable split as the quota check above. Trusted text
  // (`parsed.errors[]`) cannot be model prose, so it keeps matching the full wording list
  // (redundant with the quota check, which already returned above for a trusted quota hit,
  // but harmless). The contaminable half (`errorMessage`/`parsed.result`) must use the
  // quota-free core regex -- otherwise quota wording the check above just (correctly)
  // rejected for not anchoring the payload would re-enter here as generic transient via an
  // unanchored substring match, reclassifying the same contaminated prose under a
  // different error code instead of excluding it.
  const trustedPrimary = buildClaudeTrustedHaystack(input);
  if (trustedPrimary && CLAUDE_TRANSIENT_UPSTREAM_RE.test(trustedPrimary)) return true;

  const contaminablePrimary = normalizeHaystack(claudeContaminableTexts(input));
  if (contaminablePrimary && CLAUDE_TRANSIENT_UPSTREAM_CORE_RE.test(contaminablePrimary)) {
    return true;
  }

  // AUR-4144: only reach for raw stdout/stderr when there is NO parsed terminal result to
  // trust. When `parsed` exists, the CLI told us why it failed, and the resumed transcript
  // can only add false positives (`rate_limit` appearing as a JSON key, or an agent
  // discussing quota wording). Stream-event lines are stripped from the raw haystack
  // because they are consumed structurally instead.
  if (input.parsed != null) return false;

  const raw = buildClaudeRawHaystack(input);
  if (!raw) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(raw);
}
