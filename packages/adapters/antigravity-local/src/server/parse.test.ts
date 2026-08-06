import { describe, expect, it } from "vitest";
import { isAntigravityUnknownConversationError, parseAntigravityStream } from "./parse.js";

// Captured from `agy --output-format stream-json` v1.1.10 on 2026-08-06.
const STREAM_SAMPLE = [
  `{"event":"init","conversation_id":"54e90ae8-1665-40db-bf41-0d93788be728","init":{"cwd":"/tmp/x","tools":["run_command"],"permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"54e90ae8-1665-40db-bf41-0d93788be728","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"54e90ae8-1665-40db-bf41-0d93788be728","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-adapter-test"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"54e90ae8-1665-40db-bf41-0d93788be728","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"The command output is hello-adapter-test.","duration_seconds":0.7,"usage":{"input_tokens":5237,"output_tokens":40,"thinking_tokens":24,"cache_read_tokens":12208,"total_tokens":5277}}}`,
  `{"event":"result","result":{"conversation_id":"54e90ae8-1665-40db-bf41-0d93788be728","status":"SUCCESS","response":"The command output is hello-adapter-test.","duration_seconds":1.94,"num_turns":1,"usage":{"input_tokens":14151,"output_tokens":457,"thinking_tokens":364,"cache_read_tokens":20350,"total_tokens":14608}}}`,
].join("\n");

describe("parseAntigravityStream", () => {
  it("parses conversation id, summary, status, and usage from a stream-json run", () => {
    const parsed = parseAntigravityStream(STREAM_SAMPLE);
    expect(parsed.conversationId).toBe("54e90ae8-1665-40db-bf41-0d93788be728");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe("The command output is hello-adapter-test.");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.numTurns).toBe(1);
    expect(parsed.usage).toEqual({
      inputTokens: 14151,
      outputTokens: 457,
      thinkingTokens: 364,
      cachedInputTokens: 20350,
      totalTokens: 14608,
    });
  });

  it("falls back to agent_response deltas when the final response is empty", () => {
    const stdout = [
      `{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"agent_response","text_delta":"Partial answer."}}`,
      `{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"","num_turns":1}}`,
    ].join("\n");
    const parsed = parseAntigravityStream(stdout);
    expect(parsed.summary).toBe("Partial answer.");
  });

  it("parses the plain --output-format json result object", () => {
    const stdout = `{"conversation_id":"95c703ca","status":"SUCCESS","response":"ok\\n","duration_seconds":1.51,"num_turns":1,"usage":{"input_tokens":17032,"output_tokens":22,"thinking_tokens":17,"cache_read_tokens":0,"total_tokens":17054}}`;
    const parsed = parseAntigravityStream(stdout);
    expect(parsed.conversationId).toBe("95c703ca");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe("ok");
    expect(parsed.usage?.inputTokens).toBe(17032);
  });

  it("synthesizes an error message for non-SUCCESS status", () => {
    const stdout = `{"event":"result","result":{"conversation_id":"c2","status":"FAILED","response":""}}`;
    const parsed = parseAntigravityStream(stdout);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.errorMessage).toMatch(/status FAILED/);
  });

  it("ignores non-JSON noise lines", () => {
    const stdout = [
      "Ripgrep is not available. Falling back to GrepTool.",
      `{"event":"result","result":{"conversation_id":"c3","status":"SUCCESS","response":"done"}}`,
    ].join("\n");
    const parsed = parseAntigravityStream(stdout);
    expect(parsed.summary).toBe("done");
  });
});

describe("isAntigravityUnknownConversationError", () => {
  it("detects unknown-conversation failures", () => {
    expect(isAntigravityUnknownConversationError("error: conversation abc-123 not found", "")).toBe(true);
    expect(isAntigravityUnknownConversationError("", "failed to resume conversation")).toBe(true);
    expect(isAntigravityUnknownConversationError("some other failure", "")).toBe(false);
  });
});
