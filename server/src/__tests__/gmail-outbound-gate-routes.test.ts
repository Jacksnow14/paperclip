import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock googleapis so the real gmail service + outbound guard run end-to-end
// against a fake Gmail client, exercising the actual chokepoint wiring.
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();

const mockGmailFactory = vi.fn(() => ({
  users: {
    messages: {
      get: mockMessagesGet,
      send: mockMessagesSend,
    },
  },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: vi.fn() },
    gmail: mockGmailFactory,
  },
}));

vi.mock("../services/gmail-intake.js", () => ({
  createGmailIntakeService: () => ({ pollAllMailboxes: vi.fn() }),
}));

const mockIssueCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "inc-1" }));
vi.mock("../services/index.js", () => ({
  issueService: () => ({ create: mockIssueCreate }),
}));

const FAKE_SA_KEY = JSON.stringify({
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
});

// Minimal drizzle-shaped db double: only the approvals SELECT path used by
// verifyCeoApproval() in routes/gmail.ts is exercised here.
let approvalRow: Record<string, unknown> | null = null;
function buildDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(approvalRow ? [approvalRow] : []).then((rows) => rows),
      }),
    }),
  } as any;
}

async function createApp(db = buildDb()) {
  const [{ errorHandler }, { gmailRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/gmail.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", agentId: "agent-1", companyId: "company-1" };
    next();
  });
  app.use("/api", gmailRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("Gmail outbound guard — route enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalRow = null;
    process.env.GOOGLE_WORKSPACE_SA_KEY = FAKE_SA_KEY;
    mockMessagesSend.mockResolvedValue({ data: { id: "sent-1" } });
  });

  afterEach(() => {
    delete process.env.GOOGLE_WORKSPACE_SA_KEY;
  });

  describe("POST .../messages", () => {
    it("blocks a gated send without an approval and returns 403", async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({
          to: "report@bunq.com",
          subject: "URGENT fraud report",
          body: "We are reporting an account takeover.",
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/BLOCKED/);
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("files a blocked-send incident issue assigned to the calling agent", async () => {
      const app = await createApp();
      await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({
          to: "report@bunq.com",
          subject: "URGENT fraud report",
          body: "We are reporting an account takeover.",
        });
      await new Promise((r) => setTimeout(r, 20));
      expect(mockIssueCreate).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          title: expect.stringContaining("BLOCKED"),
          priority: "high",
          assigneeAgentId: "agent-1",
        }),
      );
    });

    it("allows the gated send when a valid, approved ceoApprovalId is attached", async () => {
      approvalRow = { id: "appr-ok", companyId: "company-1", status: "approved" };
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({
          to: "report@bunq.com",
          subject: "URGENT fraud report",
          body: "We are reporting an account takeover.",
          ceoApprovalId: "appr-ok",
        });
      expect(res.status).toBe(201);
      expect(mockMessagesSend).toHaveBeenCalledOnce();
    });

    it("still blocks when the approval exists but is only pending", async () => {
      approvalRow = { id: "appr-pending", companyId: "company-1", status: "pending" };
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({
          to: "report@bunq.com",
          subject: "URGENT fraud report",
          body: "We are reporting an account takeover.",
          ceoApprovalId: "appr-pending",
        });
      expect(res.status).toBe(403);
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("allows a non-gated send without any approval", async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/messages")
        .send({ to: "customer@example.com", subject: "Order confirmation", body: "Thanks!" });
      expect(res.status).toBe(201);
      expect(mockMessagesSend).toHaveBeenCalledOnce();
    });
  });

  describe("POST .../reply", () => {
    beforeEach(() => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Subject", value: "Hi" },
              { name: "From", value: "report@bunq.com" },
            ],
          },
        },
      });
    });

    it("blocks a gated reply without an approval and files an incident issue", async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/reply")
        .send({ replyToMessageId: "msg1", body: "We are reporting an account takeover." });
      expect(res.status).toBe(403);
      expect(mockMessagesSend).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 20));
      expect(mockIssueCreate).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ priority: "high", assigneeAgentId: "agent-1" }),
      );
    });

    it("allows a gated reply when a valid, approved ceoApprovalId is attached", async () => {
      approvalRow = { id: "appr-ok", companyId: "company-1", status: "approved" };
      mockMessagesSend.mockResolvedValue({ data: { id: "reply-1" } });
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/gmail/mailboxes/board/reply")
        .send({
          replyToMessageId: "msg1",
          body: "We are reporting an account takeover.",
          ceoApprovalId: "appr-ok",
        });
      expect(res.status).toBe(201);
      expect(mockMessagesSend).toHaveBeenCalledOnce();
    });
  });
});
