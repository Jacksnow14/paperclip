import { describe, expect, it } from "vitest";
import { parseAntigravityModelsOutput } from "./test.js";

describe("parseAntigravityModelsOutput", () => {
  it("parses one model id per line", () => {
    const stdout = [
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium",
      "",
    ].join("\n");
    expect(parseAntigravityModelsOutput(stdout).models).toEqual([
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium",
    ]);
  });

  it("ignores prose lines and dedupes", () => {
    const stdout = [
      "Some banner text with spaces",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-high",
    ].join("\n");
    expect(parseAntigravityModelsOutput(stdout).models).toEqual(["gemini-3.6-flash-high"]);
  });
});
