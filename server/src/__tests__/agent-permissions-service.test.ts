// AUR-5026: unit tests for the narrow `canUpdateAgentMetadata` permission flag
// on the agent permissions record — defaults, normalization, and the patch
// merge semantics used by PATCH /api/agents/:id/permissions.

import { describe, expect, it } from "vitest";
import {
  defaultPermissionsForRole,
  mergeAgentPermissionsPatch,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("defaultPermissionsForRole", () => {
  it("defaults canUpdateAgentMetadata to false for every role, including ceo", () => {
    expect(defaultPermissionsForRole("ceo")).toEqual({
      canCreateAgents: true,
      canUpdateAgentMetadata: false,
    });
    expect(defaultPermissionsForRole("engineer")).toEqual({
      canCreateAgents: false,
      canUpdateAgentMetadata: false,
    });
  });
});

describe("normalizeAgentPermissions", () => {
  it("preserves a stored boolean canUpdateAgentMetadata", () => {
    expect(
      normalizeAgentPermissions({ canCreateAgents: false, canUpdateAgentMetadata: true }, "engineer"),
    ).toEqual({ canCreateAgents: false, canUpdateAgentMetadata: true });
  });

  it("coerces a non-boolean canUpdateAgentMetadata to the role default", () => {
    expect(
      normalizeAgentPermissions({ canCreateAgents: true, canUpdateAgentMetadata: "yes" }, "engineer"),
    ).toEqual({ canCreateAgents: true, canUpdateAgentMetadata: false });
  });

  it("drops unknown keys from the stored record", () => {
    expect(
      normalizeAgentPermissions({ canCreateAgents: false, canDeleteCompany: true }, "engineer"),
    ).toEqual({ canCreateAgents: false, canUpdateAgentMetadata: false });
  });
});

describe("mergeAgentPermissionsPatch", () => {
  it("keeps an existing grant when the patch omits the key (legacy two-key client)", () => {
    expect(
      mergeAgentPermissionsPatch(
        { canCreateAgents: false, canUpdateAgentMetadata: true },
        { canCreateAgents: false, canAssignTasks: true },
        "engineer",
      ),
    ).toEqual({ canCreateAgents: false, canUpdateAgentMetadata: true });
  });

  it("revokes the grant when the patch sets it explicitly false", () => {
    expect(
      mergeAgentPermissionsPatch(
        { canCreateAgents: false, canUpdateAgentMetadata: true },
        { canCreateAgents: false, canAssignTasks: true, canUpdateAgentMetadata: false },
        "engineer",
      ),
    ).toEqual({ canCreateAgents: false, canUpdateAgentMetadata: false });
  });

  it("issues the grant when the patch sets it true, without leaking non-record keys", () => {
    const merged = mergeAgentPermissionsPatch(
      { canCreateAgents: false },
      { canCreateAgents: false, canAssignTasks: true, canUpdateAgentMetadata: true },
      "engineer",
    );
    expect(merged).toEqual({ canCreateAgents: false, canUpdateAgentMetadata: true });
    expect(merged).not.toHaveProperty("canAssignTasks");
  });

  it("falls back to the existing normalized record for a nullish patch", () => {
    expect(
      mergeAgentPermissionsPatch({ canCreateAgents: true, canUpdateAgentMetadata: true }, null, "engineer"),
    ).toEqual({ canCreateAgents: true, canUpdateAgentMetadata: true });
  });
});
