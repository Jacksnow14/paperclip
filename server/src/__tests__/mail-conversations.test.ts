import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  gmailIntakeRecords: { companyId: "company_id" },
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

function makeRecord(overrides: Record<string, unknown> = {}) {
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body).toEqual({ conversations: [] });
  });

  it("returns one conversation per thread", async () => {
    const records = [
      makeRecord({ gmailThreadId: "t1", sender: "alice@example.com" }),
      makeRecord({ gmailThreadId: "t1", gmailMessageId: "msg-2", sender: "alice@example.com", receivedAt: new Date("2026-05-31T10:00:00Z") }),
      makeRecord({ gmailThreadId: "t2", gmailMessageId: "msg-3", sender: "bob@example.com" }),
    ];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(records),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body.conversations).toHaveLength(2);
  });

  it("uses the most recent inbound message per thread", async () => {
    const older = makeRecord({ receivedAt: new Date("2026-05-29T10:00:00Z"), subject: "Old Subject" });
    const newer = makeRecord({ gmailMessageId: "msg-2", receivedAt: new Date("2026-05-31T10:00:00Z"), subject: "New Subject" });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([older, newer]),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    expect(res.body.conversations[0].lastInbound.subject).toBe("New Subject");
  });

  it("filters by mailbox query param", async () => {
    const records = [
      makeRecord({ mailbox: "board", gmailThreadId: "t1" }),
      makeRecord({ mailbox: "alex", gmailThreadId: "t2", gmailMessageId: "msg-2" }),
    ];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(records),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations?mailbox=board@tryauranode.com")
      .expect(200);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].mailbox).toBe("board@tryauranode.com");
  });

  it("sorts needs-pickup conversations first", async () => {
    // All records are needs-pickup by default (no outbound tracking)
    const records = [
      makeRecord({ gmailThreadId: "t1", receivedAt: new Date("2026-05-30T10:00:00Z") }),
      makeRecord({ gmailThreadId: "t2", gmailMessageId: "msg-2", receivedAt: new Date("2026-05-31T10:00:00Z") }),
    ];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(records),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/mail/conversations")
      .expect(200);

    // Newest should come first within same status
    expect(res.body.conversations[0].lastInbound.receivedAt).toBe("2026-05-31T10:00:00.000Z");
  });

  it("returns 403 for unauthorized company access", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/other-company/mail/conversations")
      .expect(403);

    expect(res.status).toBe(403);
  });
});
