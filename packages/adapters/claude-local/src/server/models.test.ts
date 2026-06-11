import { describe, expect, it } from "vitest";
import { models, modelProfiles } from "../index.js";
import { listClaudeModels, isBedrockModelId } from "./models.js";

describe("claude_local direct model list", () => {
  it("exposes Claude Fable 5 as the most capable (top) option", () => {
    expect(models[0]).toEqual({ id: "claude-fable-5", label: "Claude Fable 5" });
  });

  it("includes the current default Claude Opus 4.8", () => {
    expect(models).toContainEqual({ id: "claude-opus-4-8", label: "Claude Opus 4.8" });
  });

  it("keeps every entry well-formed (non-empty id + label, unique ids)", () => {
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.trim().length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
      expect(m.label.trim().length).toBeGreaterThan(0);
    }
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not leak Bedrock-style ids into the direct (Anthropic API) list", () => {
    for (const m of models) {
      expect(isBedrockModelId(m.id)).toBe(false);
    }
  });
});

describe("listClaudeModels (direct auth mode)", () => {
  it("returns the direct model list including Fable 5 when Bedrock env is absent", async () => {
    const prevUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    const prevBedrockUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    try {
      const list = await listClaudeModels();
      expect(list.map((m) => m.id)).toContain("claude-fable-5");
      expect(list.map((m) => m.id)).toContain("claude-opus-4-8");
    } finally {
      if (prevUseBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = prevUseBedrock;
      if (prevBedrockUrl === undefined) delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
      else process.env.ANTHROPIC_BEDROCK_BASE_URL = prevBedrockUrl;
    }
  });

  it("returns Bedrock-native Fable 5 when Bedrock env is set", async () => {
    const prev = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      const list = await listClaudeModels();
      const ids = list.map((m) => m.id);
      expect(ids).toContain("us.anthropic.claude-fable-5");
      // Bedrock list must only carry Bedrock-native ids.
      for (const id of ids) expect(isBedrockModelId(id)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = prev;
    }
  });
});

describe("claude_local model profiles", () => {
  it("only enumerates a lower-cost lane; no max-capability profile pins a model", () => {
    // There is no max-capability profile that enumerates a top model, so Fable 5 does not
    // need to be wired into modelProfiles. If a max profile is added later, it should point
    // at "claude-fable-5". This test documents that intentional decision.
    const keys = modelProfiles.map((p) => String(p.key));
    expect(keys).not.toContain("max");
  });
});
