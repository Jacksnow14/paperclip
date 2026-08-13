// AUR-4674: the out-of-band send reconciler must FIRE (critical incident) on a
// gated send that bypassed the chokepoint with no approved matching scope, and
// must PASS (no incident) when a covering approval exists or the send is
// benign. A gate that can never clear is as broken as one that never fires.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, approvals, gmailOutboundRecords } from "@paperclipai/db";

const mockListMessages = vi.fn();
const mockGetMessage = vi.fn();

vi.mock("../services/gmail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/gmail.js")>();
  return {
    ...actual,
    createGmailService: () => ({
      listMessages: mockListMessages,
      getMessage: mockGetMessage,
    }),
  };
});

const mockIssueCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: mockIssueCreate,
  }),
}));

const { createGmailOutboundReconciler, approvalScopeCovers } = await import(
  "../services/gmail-outbound-reconciler.js"
);

interface DbMockData {
  outboundRows?: Record<string, unknown>[];
  approvalRows?: Record<string, unknown>[];
  agentRows?: Record<string, unknown>[];
  /** gmailMessageIds whose insert loses the ON CONFLICT race (returns no row). */
  conflicts?: Set<string>;
}

function buildDbMock(data: DbMockData = {}) {
  const inserted: Record<string, unknown>[] = [];
  const deleted: unknown[] = [];
  const pick = (table: unknown): Record<string, unknown>[] => {
    if (table === gmailOutboundRecords) return data.outboundRows ?? [];
    if (table === approvals) return data.approvalRows ?? [];
    if (table === agents) return data.agentRows ?? [];
    return [];
  };
  const select = vi.fn(() => {
    let rows: Record<string, unknown>[] = [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: vi.fn((table: unknown) => {
        rows = pick(table);
        return chain;
      }),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (resolve: (rows: unknown) => unknown, reject: (err: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    });
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn((v: Record<string, unknown>) => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(() => {
          if (data.conflicts?.has(v.gmailMessageId as string)) return Promise.resolve([]);
          inserted.push(v);
          return Promise.resolve([{ id: `row-${v.gmailMessageId}` }]);
        }),
      })),
    })),
  }));
  const del = vi.fn(() => ({
    where: vi.fn((cond: unknown) => {
      deleted.push(cond);
      return Promise.resolve(undefined);
    }),
  }));
  return { db: { select, insert, delete: del } as unknown as Db, inserted, deleted };
}

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function makeSentMessage(
  id: string,
  opts: { to: string; cc?: string; subject: string; body: string; ageMs?: number; sentAtMs?: number },
) {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: opts.body.slice(0, 50),
    // Default age: past the settle window but after the activation floor at
    // any wall-clock time this suite can run.
    internalDate: String(opts.sentAtMs ?? Date.now() - (opts.ageMs ?? 10 * 60 * 1000)),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "To", value: opts.to },
        ...(opts.cc ? [{ name: "Cc", value: opts.cc }] : []),
        { name: "Subject", value: opts.subject },
      ],
      body: { data: b64url(opts.body) },
    },
  };
}

const COMPANY = "11111111-1111-1111-1111-111111111111";

const FRAUD_BODY =
  "We are reporting an unauthorized account takeover by an attacker; please hold the payout and provide the audit log.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gmail-outbound-reconciler", () => {
  it("FIRES: files a critical incident and records out_of_band_gated for a bypassed gated send with no approval", async () => {
    const { db, inserted } = buildDbMock({ agentRows: [{ id: "cto-agent" }] });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-fraud" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-fraud", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(summary.gatedUnapproved).toBe(1);
    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const [companyArg, issueArg] = mockIssueCreate.mock.calls[0];
    expect(companyArg).toBe(COMPANY);
    expect(issueArg.title).toContain("OUT-OF-BAND GATED SEND");
    expect(issueArg.title).toContain("m-fraud");
    expect(issueArg.priority).toBe("critical");
    expect(issueArg.assigneeAgentId).toBe("cto-agent");
    // The incident must reference the message id, never quote the body (PII).
    expect(issueArg.description).toContain("m-fraud");
    expect(issueArg.description).not.toContain(FRAUD_BODY);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("out_of_band_gated");
    expect(inserted[0].gmailMessageId).toBe("m-fraud");
  });

  it("PASSES: no incident when an approved gmailOutbound approval covers the send", async () => {
    const { db, inserted } = buildDbMock({
      approvalRows: [
        {
          id: "ap-1",
          payload: {
            gmailOutbound: {
              mailbox: "alex",
              to: "trust@shopify.com, account-security@shopify.com",
            },
          },
        },
      ],
    });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-approved" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-approved", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(summary.gatedUnapproved).toBe(0);
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("out_of_band_approved");
  });

  it("skips messages already recorded by the chokepoint", async () => {
    const { db, inserted } = buildDbMock({ outboundRows: [{ id: "existing-row" }] });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-tracked" }] });
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(summary.scanned).toBe(0);
  });

  it("records a benign out-of-band send without filing an incident", async () => {
    const { db, inserted } = buildDbMock();
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-benign" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-benign", {
        to: "friend@example.com",
        subject: "Lunch on Friday",
        body: "See you at noon.",
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(summary.gatedUnapproved).toBe(0);
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("out_of_band");
  });

  it("does not file an incident when the tracking insert loses the conflict (dedup guard)", async () => {
    const { db, inserted } = buildDbMock({
      agentRows: [{ id: "cto-agent" }],
      conflicts: new Set(["m-fraud"]),
    });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-fraud" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-fraud", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(summary.recorded).toBe(0);
    expect(summary.gatedUnapproved).toBe(0);
  });

  it("releases the tracking row when incident filing fails, so the next pass retries", async () => {
    const { db, inserted, deleted } = buildDbMock({ agentRows: [{ id: "cto-agent" }] });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-fraud" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-fraud", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
      }),
    );
    mockIssueCreate.mockRejectedValue(new Error("issue create failed"));
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(inserted).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    expect(summary.errors).toBe(1);
  });

  it("records pre-activation-floor messages without classifying or filing incidents", async () => {
    const { db, inserted } = buildDbMock({ agentRows: [{ id: "cto-agent" }] });
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-old" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-old", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
        // Before the chokepoint tracking insert was fixed: absence of a row
        // proves nothing, so even a fraud-class send must not mint a critical.
        sentAtMs: Date.parse("2026-08-12T00:00:00Z"),
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("pre_activation");
    expect(summary.preActivation).toBe(1);
    expect(summary.gatedUnapproved).toBe(0);
  });

  it("leaves messages younger than the settle window for the next pass (no chokepoint race)", async () => {
    const { db, inserted } = buildDbMock();
    mockListMessages.mockResolvedValue({ messages: [{ id: "m-young" }] });
    mockGetMessage.mockResolvedValue(
      makeSentMessage("m-young", {
        to: "account-security@shopify.com",
        subject: "Re: Suspicious Activity",
        body: FRAUD_BODY,
        ageMs: 10_000,
      }),
    );
    const reconciler = createGmailOutboundReconciler(db);
    const summary = await reconciler.reconcileMailbox(COMPANY, "alex");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(summary.scanned).toBe(0);
  });
});

describe("approvalScopeCovers", () => {
  const RECIPIENT = ["account-security@shopify.com"];

  it("covers when mailbox and recipient match a multi-recipient scope list", () => {
    expect(
      approvalScopeCovers(
        { mailbox: "alex", to: "trust@shopify.com, Account-Security@shopify.com" },
        "alex",
        RECIPIENT,
        "any subject",
      ),
    ).toBe(true);
  });

  it("rejects a different mailbox", () => {
    expect(
      approvalScopeCovers(
        { mailbox: "board", to: "account-security@shopify.com" },
        "alex",
        RECIPIENT,
        "s",
      ),
    ).toBe(false);
  });

  it("rejects when any recipient is outside the approved scope", () => {
    expect(
      approvalScopeCovers(
        { mailbox: "alex", to: "trust@shopify.com" },
        "alex",
        ["trust@shopify.com", "legal@shopify.com"],
        "s",
      ),
    ).toBe(false);
  });

  it("rejects a pinned subject that does not match", () => {
    expect(
      approvalScopeCovers(
        { mailbox: "alex", to: "account-security@shopify.com", subject: "the approved subject" },
        "alex",
        RECIPIENT,
        "a different subject",
      ),
    ).toBe(false);
  });

  it("rejects an empty or missing scope recipient list", () => {
    expect(approvalScopeCovers({ mailbox: "alex" }, "alex", RECIPIENT, "s")).toBe(false);
    expect(approvalScopeCovers({ mailbox: "alex", to: "" }, "alex", RECIPIENT, "s")).toBe(false);
  });
});
