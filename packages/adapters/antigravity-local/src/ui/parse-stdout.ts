import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extractErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  return asString(record.message) || asString(record.detail) || asString(record.code);
}

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventName = asString(parsed.event).trim();

  if (eventName === "init") {
    return [{
      kind: "init",
      ts,
      model: "",
      sessionId: asString(parsed.conversation_id).trim(),
    }];
  }

  if (eventName === "step_update") {
    const step = asRecord(parsed.step_update);
    if (!step) return [];
    const stepType = asString(step.step_type).trim();
    const state = asString(step.state).trim();

    if (stepType === "agent_response") {
      const text = asString(step.text_delta);
      if (!text) return [];
      return [{ kind: "assistant", ts, text, delta: true }];
    }

    if (stepType === "tool" && state === "DONE") {
      const toolInfo = asRecord(step.tool_info);
      const name = asString(step.tool_name).trim() || (toolInfo ? asString(toolInfo.name).trim() : "") || "tool";
      const toolUseId = `step-${asNumber(step.step_index, -1)}`;
      const entries: TranscriptEntry[] = [{
        kind: "tool_call",
        ts,
        name,
        input: toolInfo?.parameters ?? null,
        toolUseId,
      }];
      const output = toolInfo ? asString(toolInfo.output) : "";
      if (output) {
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId,
          toolName: name,
          content: output,
          isError: false,
        });
      }
      return entries;
    }

    return [];
  }

  if (eventName === "error") {
    const text =
      asString(parsed.data) ||
      asString(parsed.message) ||
      extractErrorText(parsed.error);
    return [{ kind: "stderr", ts, text: text || "Antigravity error" }];
  }

  if (eventName === "result") {
    const result = asRecord(parsed.result);
    if (!result) return [{ kind: "system", ts, text: "run completed" }];
    const status = asString(result.status).trim();
    const usage = asRecord(result.usage);
    return [{
      kind: "result",
      ts,
      text: asString(result.response),
      inputTokens: usage ? asNumber(usage.input_tokens, 0) : 0,
      outputTokens: usage
        ? asNumber(usage.output_tokens, 0) + asNumber(usage.thinking_tokens, 0)
        : 0,
      cachedTokens: usage ? asNumber(usage.cache_read_tokens, 0) : 0,
      costUsd: 0,
      subtype: status,
      isError: Boolean(status && status !== "SUCCESS"),
      errors: [],
    }];
  }

  return [{ kind: "system", ts, text: `event: ${eventName || "unknown"}` }];
}

export function createAntigravityStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts);
    },
    reset() {},
  };
}

export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
