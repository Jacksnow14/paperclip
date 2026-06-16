import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Pure classifier unit tests ----
import {
  classifyGmailOutbound,
  GmailOutboundBlockedError,
} from "../services/gmail-outbound-guard.js";

describe("classifyGmailOutbound — pure classifier", () => {
  describe("gated cases (strong signals)", () => {
    it("flags report@bunq.com with 'account takeover' body", () => {
      const d = classifyGmailOutbound({
        to: "report@bunq.com",
        subject: "URGENT fraud report",
        text: "We have confirmed an account takeover on our merchant account.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("fraud_report");
      expect(d.external).toBe(true);
    });

    it("flags Shopify abuse recipient alone (no body content needed)", () => {
      const d = classifyGmailOutbound({
        to: "abuse@shopify.com",
        subject: "Hello",
        text: "Some text",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("fraud_report");
    });

    it("flags 'we are reporting' strong signal even without report recipient", () => {
      const d = classifyGmailOutbound({
        to: "merchant-trust@shopify.com",
        subject: "Alert",
        text: "We are reporting unauthorized access.",
      });
      expect(d.gated).toBe(true);
    });

    it("flags chargeback keyword", () => {
      const d = classifyGmailOutbound({
        to: "disputes@bank.com",
        subject: "Chargeback notice",
        text: "We will file a chargeback on this transaction.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("chargeback");
    });

    it("flags law enforcement signal", () => {
      const d = classifyGmailOutbound({
        to: "support@example.com",
        subject: "Escalation",
        text: "We are filing a police report with law enforcement.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("law_enforcement");
    });
  });

  describe("not-gated cases", () => {
    it("allows normal transactional email", () => {
      const d = classifyGmailOutbound({
        to: "customer@example.com",
        subject: "Your order is ready",
        text: "Thank you for your purchase.",
      });
      expect(d.gated).toBe(false);
      expect(d.category).toBeNull();
    });

    it("allows internal tryauranode.com recipient even with strong content", () => {
      // Internal recipients are not gated
      const d = classifyGmailOutbound({
        to: "board@tryauranode.com",
        subject: "Account takeover note",
        text: "FYI account takeover was investigated — all clear.",
      });
      // category may be set, but gated is false because recipient is internal
      expect(d.gated).toBe(false);
    });

    it("allows recipient without report-desk address and no strong body signals", () => {
      const d = classifyGmailOutbound({
        to: "info@partner.com",
        subject: "Partnership update",
        text: "Happy to work together.",
      });
      expect(d.gated).toBe(false);
    });
  });

  describe("weak signals — only gated when paired with report recipient", () => {
    it("gates 'freeze account' when sent to report@", () => {
      const d = classifyGmailOutbound({
        to: "report@bank.com",
        subject: "Please freeze account",
        text: "We ask you to freeze the account due to suspicious activity.",
      });
      expect(d.gated).toBe(true);
    });

    it("does NOT gate 'freeze account' to a non-report recipient", () => {
      const d = classifyGmailOutbound({
        to: "support@partner.com",
        subject: "Account issue",
        text: "We ask you to freeze the account due to suspicious activity.",
      });
      expect(d.gated).toBe(false);
    });
  });

  describe("GmailOutboundBlockedError", () => {
    it("carries the decision and has name GmailOutboundBlockedError", () => {
      const d = classifyGmailOutbound({
        to: "fraud@bank.com",
        subject: "fraud report",
        text: "account takeover confirmed",
      });
      const err = new GmailOutboundBlockedError(d);
      expect(err.name).toBe("GmailOutboundBlockedError");
      expect(err.decision).toBe(d);
      expect(err.message).toContain("AUR-2525");
    });
  });
});

// ---- Route integration tests ----

// Mock gmail service
const mockSendMessage = vi.hoisted(() => vi.fn());
vi.mock("../services/gmail.js", () => ({
  GMAIL_SUPPORTED_ALIASES: ["board", "alex", "leo", "adrian"],
  isSupportedGmailAlias: (a: string) =>
    ["board", "alex", "leo", "adrian"].includes(a),
  createGmailService: () => ({ sendMessage: mockSendMessage }),
}));

// Mock gmail intake (required by gmailRoutes constructor)
vi.mock("../services/gmail-intake.js", () => ({
  createGmailIntakeService: () => ({ pollAllMailboxes: vi.fn() }),
}));

// Mock issueService for incident creation
const mockIssueCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "inc-1" }));
vi.mock("../services/index.js", () => ({
  issueService: () => ({ create: mockIssueCreate }),
}));

// DB mock: controls the approvals SELECT return value
let dbApprovalRow: Record<string, unknown> | null = null;

function buildDbMock() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => ({
      then: (fn: (rows: unknown[]) => unknown) =>
        Promise.resolve(fn(dbApprovalRow ? [dbApprovalRow] : [])),
    })),
  };
  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    _selectChain: selectChain,
  };
}

async function createApp(
  actor: Record<string, unknown> = {
    type: "agent",
    agentId: "agent-abc",
    companyId: "company-1",
  },
  db = buildDbMock() as any,
) {
  vi.resetModules();
  const [{ errorHandler }, { gmailRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/gmail.js") as Promise<typeof import("../routes/gmail.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", gmailRoutes(db));
  app.use(errorHandler);
  return { app, db };
}

async function requestApp(
  app: express.Express,
  buildReq: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind to a TCP port");
    }
    return await buildReq(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

// Route-integration tests spin up a real node:http server per case after
// vi.resetModules(); the first one pays a cold-start (express + fresh module
// import) that can exceed the 5s default on a loaded CI box. Bump the suite
// timeout so the gate is deterministically green. (AUR-2525 review fix.)
describe("POST /companies/:companyId/gmail/mailboxes/:mailbox/messages — guard", { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbApprovalRow = null;
    process.env.GOOGLE_WORKSPACE_SA_KEY = JSON.stringify({
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    });
    mockSendMessage.mockResolvedValue({ id: "sent-1" });
  });

  it("blocks send to report@bunq.com with 'account takeover' body — returns 403", async () => {
    const { app } = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/alex/messages")
        .send({
          to: "report@bunq.com",
          subject: "URGENT fraud report",
          body: "We have confirmed an account takeover on our merchant account.",
        }),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/BLOCKED/);
    expect(res.body.error).toMatch(/AUR-2525/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("creates a blocked-send incident issue when caller is an agent", async () => {
    const { app } = await createApp();
    await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/alex/messages")
        .send({
          to: "report@bunq.com",
          subject: "Fraud report",
          body: "account takeover confirmed",
        }),
    );
    // Allow the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(mockIssueCreate).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: expect.stringContaining("BLOCKED"),
        priority: "high",
        assigneeAgentId: "agent-abc",
      }),
    );
  });

  it("allows the send when a valid CEO approval is attached", async () => {
    dbApprovalRow = { id: "appr-ok", companyId: "company-1", status: "approved" };
    const { app } = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/alex/messages")
        .send({
          to: "report@bunq.com",
          subject: "Fraud report",
          body: "account takeover confirmed",
          ceoApprovalId: "appr-ok",
        }),
    );
    expect(res.status).toBe(201);
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });

  it("blocks the send when the approval exists but is only pending (not approved)", async () => {
    dbApprovalRow = { id: "appr-pending", companyId: "company-1", status: "pending" };
    const { app } = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/alex/messages")
        .send({
          to: "report@bunq.com",
          subject: "Fraud report",
          body: "account takeover confirmed",
          ceoApprovalId: "appr-pending",
        }),
    );
    expect(res.status).toBe(403);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("blocks the send when the approval belongs to a different company", async () => {
    // The DB mock's where clause returns nothing because companyId doesn't match
    dbApprovalRow = null; // simulate "no row found" for this companyId
    const { app } = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/alex/messages")
        .send({
          to: "report@bunq.com",
          subject: "Fraud report",
          body: "account takeover confirmed",
          ceoApprovalId: "appr-other-co",
        }),
    );
    expect(res.status).toBe(403);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("allows normal (non-gated) sends without any approval", async () => {
    const { app } = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({
          to: "customer@example.com",
          subject: "Order confirmation",
          body: "Your order has been received. Thank you!",
        }),
    );
    expect(res.status).toBe(201);
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });
});
