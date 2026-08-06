import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printAntigravityStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const eventName = asString(parsed.event).trim();

  if (eventName === "init") {
    const conversationId = asString(parsed.conversation_id);
    console.log(pc.blue(`Antigravity conversation started${conversationId ? ` (${conversationId})` : ""}`));
    return;
  }

  if (eventName === "step_update") {
    const step = asRecord(parsed.step_update);
    if (!step) return;
    const stepType = asString(step.step_type).trim();
    if (stepType === "agent_response") {
      const text = asString(step.text_delta);
      if (text) console.log(pc.green(`assistant: ${text}`));
      return;
    }
    if (stepType === "tool" && asString(step.state) === "DONE") {
      const toolName = asString(step.tool_name) || "tool";
      console.log(pc.gray(`tool: ${toolName}`));
    }
    return;
  }

  if (eventName === "result") {
    const result = asRecord(parsed.result);
    const status = result ? asString(result.status) : "";
    console.log(pc.blue(`Antigravity run completed${status ? ` (${status})` : ""}`));
    return;
  }

  if (eventName === "error") {
    const text =
      asString(parsed.data) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Antigravity error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(pc.gray(`event: ${eventName || "unknown"}`));
}
