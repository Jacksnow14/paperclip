import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  isCodexLocalKnownModel,
  modelProfiles,
  models,
} from "./index.js";

describe("codex_local model profiles", () => {
  it("exports a cheap profile", () => {
    const cheap = modelProfiles.find((p) => p.key === "cheap");
    expect(cheap).toBeDefined();
  });

  it("cheap profile does not resolve to gpt-5.3-codex-spark", () => {
    const cheap = modelProfiles.find((p) => p.key === "cheap");
    expect(cheap?.adapterConfig?.model).not.toBe("gpt-5.3-codex-spark");
  });

  it("cheap profile resolves to DEFAULT_CODEX_LOCAL_MODEL (gpt-5.3-codex)", () => {
    const cheap = modelProfiles.find((p) => p.key === "cheap");
    expect(cheap?.adapterConfig?.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.3-codex");
  });

  it("cheap profile has low reasoning effort", () => {
    const cheap = modelProfiles.find((p) => p.key === "cheap");
    expect(cheap?.adapterConfig?.modelReasoningEffort).toBe("low");
  });
});

describe("codex_local model catalog", () => {
  it("includes gpt-5.5", () => {
    expect(models.some((m) => m.id === "gpt-5.5")).toBe(true);
  });

  it("gpt-5.5 is a known model", () => {
    expect(isCodexLocalKnownModel("gpt-5.5")).toBe(true);
  });

  it("gpt-5.5 supports fast mode", () => {
    expect(isCodexLocalFastModeSupported("gpt-5.5")).toBe(true);
    expect(CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS).toContain("gpt-5.5");
  });

  it("gpt-5.5 is listed before gpt-5.4", () => {
    const idx55 = models.findIndex((m) => m.id === "gpt-5.5");
    const idx54 = models.findIndex((m) => m.id === "gpt-5.4");
    expect(idx55).toBeGreaterThanOrEqual(0);
    expect(idx54).toBeGreaterThanOrEqual(0);
    expect(idx55).toBeLessThan(idx54);
  });
});
