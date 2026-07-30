// AUR-4689: unit tests for the model-availability check and the periodic
// sweep over existing agents (the half of the guard that would have caught
// the Junior Coder incident, where a valid-at-config-time model was retired
// by the provider afterwards).

import { describe, expect, it, vi } from "vitest";
import {
  checkConfiguredModelAvailability,
  formatInvalidModelMessage,
  sweepAgentConfiguredModels,
  type AgentModelSweepRow,
} from "../services/agent-model-validation.js";

const codexListing = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

describe("checkConfiguredModelAvailability", () => {
  it("reports valid when the model is in the list", async () => {
    const result = await checkConfiguredModelAvailability("codex_local", "gpt-5.4-mini", {
      listModels: async () => codexListing,
    });
    expect(result).toEqual({ outcome: "valid", validIds: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"] });
  });

  it("reports invalid with the valid ids when the model is absent", async () => {
    const result = await checkConfiguredModelAvailability("codex_local", "gpt-5.3-codex", {
      listModels: async () => codexListing,
    });
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") throw new Error("unreachable");
    expect(result.validIds).toContain("gpt-5.4-mini");
    const message = formatInvalidModelMessage("codex_local", "gpt-5.3-codex", result.validIds);
    expect(message).toContain("'gpt-5.3-codex'");
    expect(message).toContain("not in the available model list");
    expect(message).toContain("gpt-5.4, gpt-5.4-mini, gpt-5.5");
  });

  it("fails open (unvalidated) when the model list fetch throws", async () => {
    const result = await checkConfiguredModelAvailability("codex_local", "anything", {
      listModels: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.outcome).toBe("unvalidated");
    if (result.outcome !== "unvalidated") throw new Error("unreachable");
    expect(result.reason).toBe("model-list-unavailable");
  });

  it("fails open (unvalidated) when the adapter has no model list", async () => {
    const result = await checkConfiguredModelAvailability("process", "anything", {
      listModels: async () => [],
    });
    expect(result).toEqual({ outcome: "unvalidated", reason: "empty-model-list" });
  });
});

describe("sweepAgentConfiguredModels", () => {
  const baseRow: Omit<AgentModelSweepRow, "id" | "name" | "model"> = {
    companyId: "company-1",
    status: "idle",
    adapterType: "codex_local",
  };

  it("flags an agent whose stored model is absent from the current list (seeded bad value)", async () => {
    const result = await sweepAgentConfiguredModels(
      [
        // The exact incident shape: value was valid when set, retired later.
        { ...baseRow, id: "a1", name: "Junior Coder", model: "gpt-5.3-codex" },
        { ...baseRow, id: "a2", name: "CFO", model: "gpt-5.5" },
      ],
      { listModels: async () => codexListing },
    );

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      agentId: "a1",
      agentName: "Junior Coder",
      adapterType: "codex_local",
      model: "gpt-5.3-codex",
      validIds: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
    });
    expect(result.checkedCount).toBe(2);
  });

  it("fetches each adapter's model list once, not per agent", async () => {
    const listModels = vi.fn(async () => codexListing);
    await sweepAgentConfiguredModels(
      [
        { ...baseRow, id: "a1", name: "A", model: "gpt-5.4" },
        { ...baseRow, id: "a2", name: "B", model: "gpt-5.5" },
        { ...baseRow, id: "a3", name: "C", model: "gpt-5.4-mini" },
      ],
      { listModels },
    );
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("skips terminated agents and agents without a configured model", async () => {
    const result = await sweepAgentConfiguredModels(
      [
        { ...baseRow, id: "a1", name: "Retired", status: "terminated", model: "gpt-5.3-codex" },
        { ...baseRow, id: "a2", name: "No Model", model: null },
        { ...baseRow, id: "a3", name: "Blank Model", model: "   " },
      ],
      { listModels: async () => codexListing },
    );
    expect(result.flagged).toHaveLength(0);
    expect(result.checkedCount).toBe(0);
  });

  it("fails open per adapter type when the list cannot be fetched", async () => {
    const result = await sweepAgentConfiguredModels(
      [
        { ...baseRow, id: "a1", name: "Codex OK", model: "gpt-5.4" },
        {
          ...baseRow,
          id: "a2",
          name: "Unlistable",
          adapterType: "broken_adapter",
          model: "whatever",
        },
      ],
      {
        listModels: async (adapterType: string) => {
          if (adapterType === "broken_adapter") throw new Error("provider down");
          return codexListing;
        },
      },
    );

    expect(result.flagged).toHaveLength(0);
    expect(result.checkedCount).toBe(1);
    expect(result.unvalidatedAdapterTypes).toEqual(["broken_adapter"]);
  });

  it("treats an empty model list as unvalidatable rather than flagging everything", async () => {
    const result = await sweepAgentConfiguredModels(
      [{ ...baseRow, id: "a1", name: "HTTP Bot", adapterType: "http", model: "some-model" }],
      { listModels: async () => [] },
    );
    expect(result.flagged).toHaveLength(0);
    expect(result.unvalidatedAdapterTypes).toEqual(["http"]);
  });
});
