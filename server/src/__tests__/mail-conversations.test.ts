import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  gmailIntakeRecords: { companyId: "company_id" },
  gmailOutboundRecords: { companyId: "company_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
}));

// Minimal stub for the gmail service factory — the conversations endpoint
// doesn't call Gmail API, but the route file imports the factory at module load.
vi.mock("../services/gmail.js", () => ({
  createGmailService: vi.fn(() => ({})),
  isSupportedGmailAlias: vi.fn(() => true),
  GMAIL_SUPPORTED_ALIASES: ["board", "alex", "leo", "adrian"],
}));

vi.mock("../services/gmail-intake.js", () => ({
  createGmailIntakeService: vi.fn(() => ({})),
}));

const actor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function makeInbound(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    companyId: "company-1",
    mailbox: "board",
    gmailThreadId: "thread-1",
    gmailMessageId: "msg-1",
    issueId: null,
    sender: "alice@example.com",
    subject: "Hello",
    snippet: "Hi there",
    receivedAt: new Date("2026-05-30T10:00:00Z"),
    createdAt: new Date("2026-05-30T10:00:00Z"),
    ...overrides,
  };
}

function makeOutbound(overrides: Record<string, unknown> = {}) {
  return {
    id: "out-1",
    companyId: "company-1",
    mailbox: "board",
    gmailThreadId: "thread-1",
    gmailMessageId: "out-msg-1",
    recipient: "alice@example.com",
    subject: "Re: Hello",
    snippet: "Thanks",
    sentAt: new Date("2026-05-31T10:00:00Z"),
    createdAt: new Date("2026-05-31T10:00:00Z"),
    ...overrides,
  };
}

// Build a mock db that returns inbound from first select() call, outbound from second.
function makeDbWithTwoSelects(inboundRows: unknown[], outboundRows: unknown[]) {
  let callCount = 0;
  return {
    select: vi.fn(() => {
      const rows = callCount === 0 ? inboundRows : outboundRows;
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      };
    }),
  };
}

async function createApp(db: Record<string, unknown> = mockDb as unknown as Record<string, unknown>) {
  vi.resetModules();
  const [{ errorHandler }, { gmailRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/gmail.js") as Promise<typeof import("../routes/gmail.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor, companyIds: [...actor.companyIds] };
    next();
  });
  app.use("/api", gmailRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("GET /api/companies/:companyId/mail/conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty conversations list when no records", async () => {
    const app = await createApp(makeDbWithTwoSelects([], []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body).toEqual({ conversations: [] });
  });

  it("returns one conversation per thread", async () => {
    const inbound = [
      makeInbound({ gmailThreadId: "t1", sender: "alice@example.com" }),
      makeInbound({ gmailThreadId: "t1", gmailMessageId: "msg-2", sender: "alice@example.com", receivedAt: new Date("2026-05-31T10:00:00Z") }),
      makeInbound({ gmailThreadId: "t2", gmailMessageId: "msg-3", sender: "bob@example.com" }),
    ];
    const app = await createApp(makeDbWithTwoSelects(inbound, []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body.conversations).toHaveLength(2);
  });

  it("uses the most recent inbound message per thread", async () => {
    const older = makeInbound({ receivedAt: new Date("2026-05-29T10:00:00Z"), subject: "Old Subject" });
    const newer = makeInbound({ gmailMessageId: "msg-2", receivedAt: new Date("2026-05-31T10:00:00Z"), subject: "New Subject" });
    const app = await createApp(makeDbWithTwoSelects([older, newer], []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body.conversations[0].lastInbound.subject).toBe("New Subject");
  });

  it("filters by mailbox query param", async () => {
    const inbound = [
      makeInbound({ mailbox: "board", gmailThreadId: "t1" }),
      makeInbound({ mailbox: "alex", gmailThreadId: "t2", gmailMessageId: "msg-2" }),
    ];
    const app = await createApp(makeDbWithTwoSelects(inbound, []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations?mailbox=board@tryauranode.com")
      .expect(200);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].mailbox).toBe("board@tryauranode.com");
  });

  it("sorts needs-pickup conversations first", async () => {
    const inbound = [
      makeInbound({ gmailThreadId: "t1", receivedAt: new Date("2026-05-30T10:00:00Z") }),
      makeInbound({ gmailThreadId: "t2", gmailMessageId: "msg-2", receivedAt: new Date("2026-05-31T10:00:00Z") }),
    ];
    const app = await createApp(makeDbWithTwoSelects(inbound, []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    // Newest should come first within same status
    expect(res.body.conversations[0].lastInbound.receivedAt).toBe("2026-05-31T10:00:00.000Z");
  });

  it("returns 403 for unauthorized company access", async () => {
    const app = await createApp(makeDbWithTwoSelects([], []) as any);
    const res = await request(app)
      .get("/api/companies/other-company/mail/conversations")
      .expect(403);

    expect(res.status).toBe(403);
  });

  // --- Outbound tracking + reply-state tests ---

  it("status is needs-pickup when there is only inbound (no outbound)", async () => {
    const inbound = [makeInbound({ gmailThreadId: "t1", receivedAt: new Date("2026-05-30T10:00:00Z") })];
    const app = await createApp(makeDbWithTwoSelects(inbound, []) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body.conversations[0].responseStatus).toBe("needs-pickup");
    expect(res.body.conversations[0].lastOutbound).toBeNull();
    expect(res.body.conversations[0].whoReplied).toBeNull();
  });

  it("status is awaiting-reply when our outbound is newer than last inbound", async () => {
    const inbound = [makeInbound({ receivedAt: new Date("2026-05-30T10:00:00Z") })];
    const outbound = [makeOutbound({ sentAt: new Date("2026-05-31T10:00:00Z") })];
    const app = await createApp(makeDbWithTwoSelects(inbound, outbound) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    const conv = res.body.conversations[0];
    expect(conv.responseStatus).toBe("awaiting-reply");
    expect(conv.lastOutbound).not.toBeNull();
    expect(conv.lastOutbound.sentAt).toBe("2026-05-31T10:00:00.000Z");
    expect(conv.whoReplied).toBe("board");
  });

  it("status is replied when inbound came in after our last outbound", async () => {
    const inbound = [makeInbound({ receivedAt: new Date("2026-06-01T10:00:00Z") })];
    const outbound = [makeOutbound({ sentAt: new Date("2026-05-31T10:00:00Z") })];
    const app = await createApp(makeDbWithTwoSelects(inbound, outbound) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    const conv = res.body.conversations[0];
    expect(conv.responseStatus).toBe("replied");
    expect(conv.lastInbound.receivedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(conv.whoReplied).toBe("board");
  });

  it("status is awaiting-reply when there is outbound-only (no inbound yet)", async () => {
    const outbound = [makeOutbound({ gmailThreadId: "t-new", sentAt: new Date("2026-06-01T09:00:00Z") })];
    const app = await createApp(makeDbWithTwoSelects([], outbound) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    const conv = res.body.conversations[0];
    expect(conv.responseStatus).toBe("awaiting-reply");
    expect(conv.lastInbound).toBeNull();
    expect(conv.lastOutbound.sentAt).toBe("2026-06-01T09:00:00.000Z");
  });

  it("uses latest outbound per thread", async () => {
    const inbound = [makeInbound({ receivedAt: new Date("2026-05-28T10:00:00Z") })];
    const outbound = [
      makeOutbound({ gmailMessageId: "out-1", sentAt: new Date("2026-05-29T10:00:00Z"), subject: "First reply" }),
      makeOutbound({ gmailMessageId: "out-2", sentAt: new Date("2026-05-31T10:00:00Z"), subject: "Second reply" }),
    ];
    const app = await createApp(makeDbWithTwoSelects(inbound, outbound) as any);
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    const conv = res.body.conversations[0];
    expect(conv.lastOutbound.subject).toBe("Second reply");
    expect(conv.responseStatus).toBe("awaiting-reply");
  });

  it("filters by status query param", async () => {
    const inbound1 = makeInbound({ gmailThreadId: "t1", receivedAt: new Date("2026-05-30T10:00:00Z") });
    const inbound2 = makeInbound({ gmailThreadId: "t2", gmailMessageId: "msg-2", receivedAt: new Date("2026-05-28T10:00:00Z") });
    const outbound = [makeOutbound({ gmailThreadId: "t2", sentAt: new Date("2026-05-31T10:00:00Z") })];
    const app = await createApp(makeDbWithTwoSelects([inbound1, inbound2], outbound) as any);

    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations?status=needs-pickup")
      .expect(200);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].threadId).toBe("t1");
  });
});
