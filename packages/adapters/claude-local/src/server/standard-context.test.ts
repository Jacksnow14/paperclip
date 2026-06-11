import { describe, expect, it } from "vitest";

import { resolveDisable1mContextEnv } from "./execute.js";

describe("resolveDisable1mContextEnv (AUR-2092)", () => {
  it("pins the standard 200K context by default", () => {
    // No operator/host override present → force the standard-context lever on.
    expect(resolveDisable1mContextEnv({}, {})).toBe("1");
  });

  it("does not override an explicit adapter config.env value", () => {
    // config.env values are merged into `env` before this runs; operator wins.
    expect(resolveDisable1mContextEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }, {})).toBeNull();
    expect(resolveDisable1mContextEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, {})).toBeNull();
  });

  it("does not override a host process.env value", () => {
    expect(
      resolveDisable1mContextEnv({}, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }),
    ).toBeNull();
  });

  it("prefers the adapter env over the host env when both are set", () => {
    // env override is checked first; either way an explicit value short-circuits.
    expect(
      resolveDisable1mContextEnv(
        { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" },
        { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      ),
    ).toBeNull();
  });
});
