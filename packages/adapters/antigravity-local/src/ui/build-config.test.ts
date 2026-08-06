import { describe, expect, it } from "vitest";
import { buildAntigravityLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

describe("buildAntigravityLocalConfig", () => {
  it("builds a config with defaults", () => {
    const config = buildAntigravityLocalConfig({
      cwd: "/work",
      instructionsFilePath: "/inst/AGENTS.md",
      model: "",
      envVars: "",
      envBindings: {},
      command: "",
      extraArgs: "",
      thinkingEffort: "",
    } as unknown as CreateConfigValues);
    expect(config.model).toBe("gemini-3.6-flash-high");
    expect(config.cwd).toBe("/work");
    expect(config.instructionsFilePath).toBe("/inst/AGENTS.md");
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(20);
  });

  it("passes model, effort, env, and extra args through", () => {
    const config = buildAntigravityLocalConfig({
      cwd: "",
      instructionsFilePath: "",
      model: "gemini-3.1-pro-high",
      envVars: "FOO=bar",
      envBindings: {},
      command: "agy",
      extraArgs: "--sandbox, --agent,coder",
      thinkingEffort: "high",
    } as unknown as CreateConfigValues);
    expect(config.model).toBe("gemini-3.1-pro-high");
    expect(config.effort).toBe("high");
    expect(config.command).toBe("agy");
    expect(config.extraArgs).toEqual(["--sandbox", "--agent", "coder"]);
    expect(config.env).toEqual({ FOO: { type: "plain", value: "bar" } });
  });
});
