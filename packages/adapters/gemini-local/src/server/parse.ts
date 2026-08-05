import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text, "").trim() || asString(part.content, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    asString(event.checkpoint_id, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  target.inputTokens += asNumber(
    source.input_tokens,
    asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)),
  );
  target.cachedInputTokens += asNumber(
    source.cached_input_tokens,
    asNumber(
      source.cachedInputTokens,
      asNumber(source.cachedContentTokenCount, asNumber(source.cached, 0)),
    ),
  );
  target.outputTokens += asNumber(
    source.output_tokens,
    asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)),
  );
}

export function parseGeminiJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let question: { prompt: string; choices: Array<{ key: string; label: string; description?: string }> } | null = null;
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

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectMessageText(event.message));
      const messageObj = parseObject(event.message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      for (const partRaw of content) {
        const part = parseObject(partRaw);
        if (asString(part.type, "").trim() === "question") {
          question = {
            prompt: asString(part.prompt, "").trim(),
            choices: (Array.isArray(part.choices) ? part.choices : []).map((choiceRaw) => {
              const choice = parseObject(choiceRaw);
              return {
                key: asString(choice.key, "").trim(),
                label: asString(choice.label, "").trim(),
                description: asString(choice.description, "").trim() || undefined,
              };
            }),
          };
          break; // only one question per message
        }
      }
      continue;
    }

    // Gemini CLI v0.38+ stream-json schema emits assistant turns as:
    // {"type":"message","role":"assistant","content":"...","delta":true}
    // These are discrete final messages (one per assistant turn), not
    // cumulative streaming tokens, so collecting all of them produces the
    // expected concatenated turn-by-turn summary rather than duplicated text.
    if (type === "message") {
      const role = asString(event.role, "").trim().toLowerCase();
      if (role === "assistant") {
        messages.push(...collectMessageText(event.content));
      }
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      accumulateUsage(usage, event.usage ?? event.usageMetadata ?? event.stats);
      const resultText =
        asString(event.result, "").trim() ||
        asString(event.text, "").trim() ||
        asString(event.response, "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      const status = asString(event.status, "").toLowerCase();
      const isError =
        event.is_error === true ||
        asString(event.subtype, "").toLowerCase() === "error" ||
        status === "error" ||
        status === "failed";
      if (isError) {
        const text = asErrorText(event.error ?? event.message ?? event.result).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
      if (text) errorMessage = text;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish" || event.usage || event.usageMetadata) {
      accumulateUsage(usage, event.usage ?? event.usageMetadata);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage,
    resultEvent,
    question,
  };
}

export function isGeminiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume/i.test(
    haystack,
  );
}

function extractGeminiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
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

export function describeGeminiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractGeminiErrorMessages(parsed);

  const detail = errors[0] ?? "";
  const parts = ["Gemini run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

const GEMINI_AUTH_REQUIRED_RE = /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?gemini\s+auth(?:\s+login)?`?\s+first)/i;
// AUR-4531: tightened from a bare `quota` alternative. `detectGeminiQuotaExhausted` is now
// wired into the execute path (it previously had no non-test caller at all), so a
// false positive is no longer harmless: it would tag a deterministic failure as
// `transient_upstream` and park the agent behind a quota breaker it can never clear.
// Bare `quota` matches an agent merely saying the word, which is exactly the AUR-4513
// transcript-contamination shape. Require a quota *verb*.
const GEMINI_QUOTA_EXHAUSTED_RE =
  /(?:resource_exhausted|quota\s+(?:exceeded|exhausted|limit)|exceeded\s+your\s+(?:current\s+)?quota|rate[-\s]?limit(?:ed|ing|s)?|too many requests|\b429\b|billing details)/i;

// AUR-4531: gemini RESOURCE_EXHAUSTED errors carry their backoff as a duration, not as a
// wall-clock reset ("retryDelay":"57s" in the google.rpc.RetryInfo detail, or a
// Retry-After header echoed into the message). Without a reset time the quota breaker has
// no lifetime to key on, so this is what makes Defect B reachable for gemini at all.
const GEMINI_RETRY_DELAY_RE =
  /(?:"?retry[_-]?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?"?|retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?\b|(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b)/i;

export function detectGeminiAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresAuth = messages.some((line) => GEMINI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

export function detectGeminiQuotaExhausted(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { exhausted: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const exhausted = messages.some((line) => GEMINI_QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

/**
 * AUR-4531: extract the provider's own "safe to retry at" instant from a gemini quota
 * rejection, so the quota breaker gets a lifetime derived from the provider rather than
 * from our retry ladder. Returns null when the rejection carries no duration hint — the
 * caller then falls back to the bounded ladder, which is the pre-existing behaviour.
 */
export function extractGeminiRetryNotBefore(
  input: {
    parsed: Record<string, unknown> | null;
    stdout: string;
    stderr: string;
  },
  now = new Date(),
): Date | null {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const haystack = [...errors, input.stdout, input.stderr].join("\n");
  const match = haystack.match(GEMINI_RETRY_DELAY_RE);
  if (!match) return null;

  // Group 1 is the RetryInfo form (always seconds); groups 2/3 and 4/5 carry an
  // explicit unit that may be minutes.
  const rawValue = match[1] ?? match[2] ?? match[4];
  if (!rawValue) return null;
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[1] ? "s" : (match[3] ?? match[5] ?? "s")).toLowerCase();
  const multiplierMs = unit.startsWith("m") ? 60_000 : 1_000;
  const delayMs = value * multiplierMs;
  // Guard against an absurd parse wedging an agent: a gemini backoff hint is minutes, not
  // days. Anything beyond 6h is treated as unparseable rather than honoured.
  if (delayMs > 6 * 60 * 60 * 1000) return null;
  return new Date(now.getTime() + delayMs);
}

export function isGeminiTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  if (!parsed) return false;

  const structuredStopReasons = [
    parsed.status,
    parsed.stopReason,
    parsed.stop_reason,
    parsed.errorCode,
    parsed.error_code,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "turn_limit" ||
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit_exhausted",
  );
}
