import { describe, expect, it } from "vitest";
import { parseAntigravityStdoutLine } from "./parse-stdout.js";

describe("parseAntigravityStdoutLine", () => {
  it("maps agent_response deltas to assistant entries", () => {
    const entries = parseAntigravityStdoutLine(
      `{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"Hello"}}`,
      "ts",
    );
    expect(entries).toEqual([{ kind: "assistant", ts: "ts", text: "Hello", delta: true }]);
  });

  it("maps completed tool steps to tool_call + tool_result entries", () => {
    const entries = parseAntigravityStdoutLine(
      `{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","step_index":3,"tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\\n"}}}`,
      "ts",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "run_command",
      toolUseId: "step-3",
      input: { CommandLine: "echo hi" },
    });
    expect(entries[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "step-3",
      content: "hi\n",
      isError: false,
    });
  });

  it("skips ACTIVE tool steps to avoid duplicates", () => {
    const entries = parseAntigravityStdoutLine(
      `{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}`,
      "ts",
    );
    expect(entries).toEqual([]);
  });

  it("renders init and result with structured entries", () => {
    expect(parseAntigravityStdoutLine(`{"event":"init","conversation_id":"c1","init":{}}`, "ts")[0])
      .toMatchObject({ kind: "init", sessionId: "c1" });
    const result = parseAntigravityStdoutLine(
      `{"event":"result","result":{"status":"SUCCESS","conversation_id":"c1","response":"done","usage":{"input_tokens":10,"output_tokens":4,"thinking_tokens":2,"cache_read_tokens":8,"total_tokens":14}}}`,
      "ts",
    )[0];
    expect(result).toMatchObject({
      kind: "result",
      text: "done",
      inputTokens: 10,
      outputTokens: 6,
      cachedTokens: 8,
      subtype: "SUCCESS",
      isError: false,
    });
  });

  it("passes through non-JSON lines as stdout", () => {
    expect(parseAntigravityStdoutLine("plain text", "ts")).toEqual([
      { kind: "stdout", ts: "ts", text: "plain text" },
    ]);
  });
});
