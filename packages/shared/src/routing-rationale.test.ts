import { describe, expect, it } from "vitest";
import { isRoutingRationaleAutoStampEligible } from "./routing-rationale.js";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE = "22222222-2222-4222-8222-222222222222";

describe("isRoutingRationaleAutoStampEligible", () => {
  it("is eligible for a high-priority manual assignment to a different agent", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "high",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: MANAGER,
        originKind: "manual",
      }),
    ).toBe(true);
  });

  it("is eligible when originKind is absent (defaults to manual)", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "critical",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: MANAGER,
        originKind: null,
      }),
    ).toBe(true);
  });

  it("rejects self-assigned issues", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "high",
        assigneeAgentId: MANAGER,
        createdByAgentId: MANAGER,
        originKind: "manual",
      }),
    ).toBe(false);
  });

  it("rejects issues with no creator agent (routine/system origin)", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "high",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: null,
        originKind: "manual",
      }),
    ).toBe(false);
  });

  it("rejects non-manual origin", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "high",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: MANAGER,
        originKind: "routine",
      }),
    ).toBe(false);
  });

  it("rejects medium/low priority", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "medium",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: MANAGER,
        originKind: "manual",
      }),
    ).toBe(false);
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "low",
        assigneeAgentId: ASSIGNEE,
        createdByAgentId: MANAGER,
        originKind: "manual",
      }),
    ).toBe(false);
  });

  it("rejects unassigned issues", () => {
    expect(
      isRoutingRationaleAutoStampEligible({
        priority: "high",
        assigneeAgentId: null,
        createdByAgentId: MANAGER,
        originKind: "manual",
      }),
    ).toBe(false);
  });
});
