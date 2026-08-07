import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

// AUR-5344. State-machine guards for requester-initiated withdrawal.
//
// Per the artifact-provenance doctrine every guard is proven twice: once on the
// case it must REFUSE and once on the case it must ALLOW. A guard shown only to
// refuse could be refusing everything, which is as broken as one that never
// fires.

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  })),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: vi.fn(),
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
  supersededByApprovalId?: string | null;
  withdrawnByAgentId?: string | null;
  withdrawnAt?: Date | null;
  withdrawalReason?: string | null;
};

function approvalRow(status: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status,
    payload: { title: "Approve ONE email" },
    requestedByAgentId: "requester-1",
    ...overrides,
  };
}

/**
 * `selectResults` is consumed in call order: first entry answers the initial
 * status read, the next answers either the superseding-row lookup or the
 * post-update re-read, depending on the path under test.
 */
function createDbStub(selectResults: unknown[][], updateResults: unknown[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn((values: Record<string, unknown>) => {
    setValues.push(values);
    return { where: updateWhere };
  });
  const setValues: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({ set }));

  return { db: { select, update }, setValues, update, selectWhere };
}

describe("approvalService.withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- PASSES: the legitimate cases must actually go through ----------------

  it("withdraws a pending approval and records requester-side provenance", async () => {
    const withdrawn = approvalRow("withdrawn", { supersededByApprovalId: "approval-2" });
    const dbStub = createDbStub(
      [[approvalRow("pending")], [{ id: "approval-2", companyId: "company-1" }]],
      [withdrawn],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw(
      "approval-1",
      { agentId: "requester-1", userId: null },
      { reason: "recipient list is unusable", supersededByApprovalId: "approval-2" },
    );

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("withdrawn");

    const [values] = dbStub.setValues;
    expect(values.status).toBe("withdrawn");
    expect(values.withdrawnByAgentId).toBe("requester-1");
    expect(values.withdrawalReason).toBe("recipient list is unusable");
    expect(values.supersededByApprovalId).toBe("approval-2");
    expect(values.withdrawnAt).toBeInstanceOf(Date);
    // A withdrawal must never look like a board decision.
    expect(values).not.toHaveProperty("decidedByUserId");
    expect(values).not.toHaveProperty("decidedAt");
    expect(values).not.toHaveProperty("decisionNote");
  });

  it("withdraws a revision_requested approval", async () => {
    const dbStub = createDbStub([[approvalRow("revision_requested")]], [approvalRow("withdrawn")]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", { agentId: "requester-1" });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("withdrawn");
  });

  it("withdraws without a superseding pointer when none is supplied", async () => {
    const dbStub = createDbStub([[approvalRow("pending")]], [approvalRow("withdrawn")]);

    const svc = approvalService(dbStub.db as any);
    await svc.withdraw("approval-1", { agentId: "requester-1" });

    expect(dbStub.setValues[0].supersededByApprovalId).toBeNull();
  });

  it("is idempotent on an already-withdrawn row without re-writing it", async () => {
    const dbStub = createDbStub([[approvalRow("withdrawn")]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", { agentId: "requester-1" });

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("withdrawn");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  // ---- FIRES: the guard must refuse every board-decided row ----------------

  it.each(["approved", "rejected"])("refuses to withdraw a %s approval", async (status) => {
    const dbStub = createDbStub([[approvalRow(status)]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", { agentId: "requester-1" })).rejects.toThrow(
      /Only pending or revision requested approvals can be withdrawn/,
    );
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("fails closed when the board decides the row between the read and the update", async () => {
    // Status read says pending, the conditional UPDATE matches nothing because a
    // board approve landed first, and the re-read confirms it. Withdrawal must
    // NOT silently report success — the row now carries granted authority.
    const dbStub = createDbStub([[approvalRow("pending")], [approvalRow("approved")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", { agentId: "requester-1" })).rejects.toThrow(
      /Only pending or revision requested approvals can be withdrawn/,
    );
  });

  it("treats a lost race against a concurrent withdrawal as a no-op", async () => {
    const dbStub = createDbStub([[approvalRow("pending")], [approvalRow("withdrawn")]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", { agentId: "requester-1" });

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("withdrawn");
  });

  it("refuses a self-referential supersession pointer", async () => {
    const dbStub = createDbStub([[approvalRow("pending")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(
      svc.withdraw("approval-1", { agentId: "requester-1" }, { supersededByApprovalId: "approval-1" }),
    ).rejects.toThrow(/cannot supersede itself/);
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("refuses a supersession pointer at an approval in another company", async () => {
    const dbStub = createDbStub(
      [[approvalRow("pending")], [{ id: "approval-9", companyId: "company-2" }]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    await expect(
      svc.withdraw("approval-1", { agentId: "requester-1" }, { supersededByApprovalId: "approval-9" }),
    ).rejects.toThrow(/Superseding approval not found in this company/);
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("refuses a supersession pointer at an approval that does not exist", async () => {
    const dbStub = createDbStub([[approvalRow("pending")], []], []);

    const svc = approvalService(dbStub.db as any);
    await expect(
      svc.withdraw("approval-1", { agentId: "requester-1" }, { supersededByApprovalId: "approval-9" }),
    ).rejects.toThrow(/Superseding approval not found in this company/);
    expect(dbStub.update).not.toHaveBeenCalled();
  });
});
