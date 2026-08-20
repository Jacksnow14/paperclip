import { beforeEach, describe, expect, it, vi } from "vitest";

// Fast unit path for the pure violation function (route-level behavior is
// covered separately in approval-board-approval-guard.test.ts). Mocks
// services/index.js before importing the route module so this test doesn't
// need the full service dependency graph (adapters, db, etc.) built.

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    logActivity: vi.fn(),
    secretService: () => ({}),
  }));
}

async function loadCheckBoardApprovalPayloadViolations() {
  const { checkBoardApprovalPayloadViolations } = await import("../routes/approvals.js");
  return checkBoardApprovalPayloadViolations;
}

describe("checkBoardApprovalPayloadViolations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    registerModuleMocks();
  });

  it("returns no violations for a non-board-approval type regardless of payload", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    expect(check("hire_agent", {})).toEqual([]);
    expect(check("approve_ceo_strategy", undefined)).toEqual([]);
    expect(check("budget_override_required", {})).toEqual([]);
  });

  it("flags all three fields missing from an empty payload", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    const errors = check("request_board_approval", {});
    expect(errors).toHaveLength(3);
    expect(errors.join(" ")).toMatch(/valueAtStake/);
    expect(errors.join(" ")).toMatch(/costOfInaction/);
    expect(errors.join(" ")).toMatch(/title/);
  });

  it("flags whitespace-only values as blank", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    const errors = check("request_board_approval", {
      title: "   ",
      valueAtStake: "$1",
      costOfInaction: "x",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/title/);
  });

  it("flags non-string values", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    const errors = check("request_board_approval", {
      title: 42,
      valueAtStake: "$1",
      costOfInaction: "x",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("payload.title must be a string");
  });

  it("returns no violations for a fully populated payload", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    expect(
      check("request_board_approval", {
        title: "Approve X",
        valueAtStake: "$1",
        costOfInaction: "x",
      }),
    ).toEqual([]);
  });

  it("treats undefined payload as fully missing", async () => {
    const check = await loadCheckBoardApprovalPayloadViolations();
    expect(check("request_board_approval", undefined)).toHaveLength(3);
  });
});
