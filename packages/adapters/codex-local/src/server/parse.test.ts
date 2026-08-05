import { describe, expect, it } from "vitest";
import {
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "./parse.js";

describe("parseCodexJsonl", () => {
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: "resume failed",
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: null,
    });
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("isCodexTransientUpstreamError", () => {
  it("classifies the remote-compaction high-demand failure as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage:
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
    expect(
      isCodexTransientUpstreamError({
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
  });

  it("classifies usage-limit windows as transient and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("parses explicit timezone hints on usage-limit retry windows", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).";
    const now = new Date("2026-04-23T03:29:02.000Z");

    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("classifies the account-level usage-limit wording and extracts the dated retry time (AUR-4139)", () => {
    const errorMessage =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 18th, 2026 2:13 AM.";
    const now = new Date(2026, 5, 17, 10, 0, 0);

    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 5, 18, 2, 13, 0, 0).getTime(),
    );
  });

  it("classifies the account-level usage-limit wording with a bare (undated) retry time", () => {
    const errorMessage =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  // AUR-4531 AC6. A bare throttle signal is transient BY DEFINITION -- waiting and
  // re-sending is the documented remedy. Before this, the narrowing return at the bottom of
  // isCodexTransientUpstreamError additionally demanded the remote-compaction or
  // high-demand wording, so a bare `429` matched the transient regex and was then thrown
  // away: no errorFamily, no bounded retry, no quota pause, no breaker.
  it.each([
    { channel: "errorMessage" as const, text: "429" },
    { channel: "errorMessage" as const, text: "Codex request failed: HTTP 429" },
    { channel: "stderr" as const, text: "429 Too Many Requests" },
    { channel: "stderr" as const, text: "rate limit exceeded" },
    { channel: "stderr" as const, text: "stream error: 503 Service Unavailable" },
  ])("classifies a bare throttle signal on $channel as transient: $text", ({ channel, text }) => {
    expect(isCodexTransientUpstreamError({ [channel]: text })).toBe(true);
  });

  // THE regression guard that `buildCodexFailureChannelHaystack` exists for. codex `stdout`
  // is the agent's own JSONL transcript, and AUR-4513 is the 2,394-run demonstration of
  // what happens when a transient classifier is fed the conversation it is resuming: our
  // agents constantly *discuss* quota wording. Widening to bare `429`/bare `rate limit`
  // would have made every such transcript "transient" if the widened test read stdout.
  it("does not classify quota wording that appears only in the stdout transcript", () => {
    const contaminatedStdout = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "LANE HEALTH: two codex coders saw 429 Too Many Requests and a rate limit exceeded error; quota exceeded on the shared key.",
        },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "tool call rejected" } }),
    ].join("\n");

    const input = {
      stdout: contaminatedStdout,
      // A genuinely deterministic failure on the real failure channels.
      stderr: "Error: tool call rejected by policy",
      errorMessage: "Codex exited with code 1",
    };

    expect(isCodexTransientUpstreamError(input)).toBe(false);
  });

  // Control for the guard above: the SAME contaminated transcript with a real throttle on a
  // real failure channel must still classify transient, so the guard cannot be a blanket
  // suppressor.
  it("still classifies a real throttle even when the stdout transcript is contaminated", () => {
    const contaminatedStdout = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "discussing 429 rate limit wording" },
    });

    expect(
      isCodexTransientUpstreamError({
        stdout: contaminatedStdout,
        stderr: "429 Too Many Requests",
        errorMessage: "Codex request failed",
      }),
    ).toBe(true);
  });

  it("does not classify deterministic compaction errors as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: [
          "Error running remote compact task: {",
          '  "error": {',
          '    "message": "Unknown parameter: \'prompt_cache_retention\'.",',
          '    "type": "invalid_request_error",',
          '    "param": "prompt_cache_retention",',
          '    "code": "unknown_parameter"',
          "  }",
          "}",
        ].join("\n"),
      }),
    ).toBe(false);
  });
});
