import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedAntigravityUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface ParsedAntigravityStream {
  conversationId: string | null;
  status: string | null;
  summary: string;
  errorMessage: string | null;
  numTurns: number | null;
  durationSeconds: number | null;
  usage: ParsedAntigravityUsage | null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "").trim() ||
    asString(rec.error, "").trim() ||
    asString(rec.detail, "").trim() ||
    asString(rec.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function readUsage(value: unknown): ParsedAntigravityUsage | null {
  const rec = parseObject(value);
  if (Object.keys(rec).length === 0) return null;
  return {
    inputTokens: asNumber(rec.input_tokens, 0),
    outputTokens: asNumber(rec.output_tokens, 0),
    thinkingTokens: asNumber(rec.thinking_tokens, 0),
    cachedInputTokens: asNumber(rec.cache_read_tokens, 0),
    totalTokens: asNumber(rec.total_tokens, 0),
  };
}

// Antigravity CLI (`agy --output-format stream-json`) emits one JSON object per
// line: {"event":"init","conversation_id",...}, {"event":"step_update",
// "step_update":{step_type, text_delta?, tool_name?, usage?, ...}} and a final
// {"event":"result","result":{conversation_id, status, response, num_turns,
// duration_seconds, usage}}. `--output-format json` emits just the final result
// object without the wrapper; accept both shapes.
export function parseAntigravityStream(stdout: string): ParsedAntigravityStream {
  let conversationId: string | null = null;
  let status: string | null = null;
  let response = "";
  let errorMessage: string | null = null;
  let numTurns: number | null = null;
  let durationSeconds: number | null = null;
  let usage: ParsedAntigravityUsage | null = null;
  const agentTextParts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventName = asString(event.event, "").trim();

    if (eventName === "init") {
      conversationId = asString(event.conversation_id, "").trim() || conversationId;
      continue;
    }

    if (eventName === "step_update") {
      const step = parseObject(event.step_update);
      conversationId = asString(step.conversation_id, "").trim() || conversationId;
      const textDelta = asString(step.text_delta, "");
      if (textDelta && asString(step.step_type, "") === "agent_response") {
        agentTextParts.push(textDelta);
      }
      continue;
    }

    if (eventName === "error") {
      const errorRaw = event.error ?? event.message ?? event.detail ?? event.data;
      if (errorRaw !== undefined && errorRaw !== null) {
        const text = errorText(errorRaw).trim();
        if (text && text !== "{}") errorMessage = text;
      }
      continue;
    }

    const result =
      eventName === "result"
        ? parseObject(event.result)
        : !eventName && typeof event.status === "string"
          ? event
          : null;
    if (result) {
      conversationId = asString(result.conversation_id, "").trim() || conversationId;
      status = asString(result.status, "").trim() || status;
      response = asString(result.response, "") || response;
      const turns = asNumber(result.num_turns, -1);
      if (turns >= 0) numTurns = turns;
      const duration = asNumber(result.duration_seconds, -1);
      if (duration >= 0) durationSeconds = duration;
      usage = readUsage(result.usage) ?? usage;
      const resultErrorRaw = result.error ?? result.error_message;
      if (resultErrorRaw !== undefined && resultErrorRaw !== null) {
        const resultError = errorText(resultErrorRaw).trim();
        if (resultError) errorMessage = resultError;
      }
    }
  }

  const summary = response.trim() || agentTextParts.join("").trim();
  if (status && status !== "SUCCESS" && !errorMessage) {
    errorMessage = `Antigravity run finished with status ${status}`;
  }

  return {
    conversationId,
    status,
    summary,
    errorMessage,
    numTurns,
    durationSeconds,
    usage,
  };
}

export function isAntigravityUnknownConversationError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+conversation|conversation(?:\s+\S+)?\s+not\s+found|no\s+conversation\s+with|invalid\s+conversation|failed\s+to\s+(?:load|resume)\s+conversation/i.test(
    haystack,
  );
}
