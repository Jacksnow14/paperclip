// AUR-6347 — per-counterparty send-cadence guard.
//
// Incident: two different agent runs, on two different issues, neither aware
// of the other, sent 3 emails to the same real supplier inside 6 minutes on
// the same Gmail thread. A question and its answer crossed by ten seconds.
// Row-level issue checkout doesn't prevent this — it protects the tracker
// row, not the human on the other end. This suite exercises the service-
// layer chokepoint (sendMessage(), which replyInThread() also funnels
// through) directly, the same seam AUR-2682/AUR-5734/AUR-4479 already use.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { gmailOutboundRecords } from "@paperclipai/db";

const mockMessagesSend = vi.fn();
const mockGmailFactory = vi.fn(() => ({
  users: {
    messages: {
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

// This suite is not about the AUR-5734 second-sink guard — force it to
// "unable to verify" (its own fail-open path) so it never interferes with
// cadence-guard assertions, mirroring gmail.test.ts's convention.
vi.mock("../services/gmail-prospect-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../services/gmail-prospect-guard.js")>(
    "../services/gmail-prospect-guard.js",
  );
  return {
    ...actual,
    checkProspectSendability: vi.fn().mockResolvedValue(null),
  };
});

const { createGmailService, GmailRecentSendBlockedError } = await import("../services/gmail.js");

const FAKE_SA_KEY = JSON.stringify({
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
});

const COMPANY = "11111111-1111-1111-1111-111111111111";

interface DbMockData {
  outboundRows?: Record<string, unknown>[];
}

function buildDbMock(data: DbMockData = {}) {
  const inserted: Record<string, unknown>[] = [];
  const pick = (table: unknown): Record<string, unknown>[] => {
    if (table === gmailOutboundRecords) return data.outboundRows ?? [];
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
      where: vi.fn(() => Promise.resolve(rows)),
    });
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn((v: Record<string, unknown>) => ({
      onConflictDoNothing: vi.fn(() => {
        inserted.push(v);
        return Promise.resolve();
      }),
    })),
  }));
  return { db: { select, insert } as unknown as Db, inserted };
}

describe("gmail send-cadence guard (AUR-6347)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_WORKSPACE_SA_KEY = FAKE_SA_KEY;
    mockMessagesSend.mockResolvedValue({ data: { id: "new-msg", threadId: "thread-1" } });
  });

  it("blocks a second send to the same address inside the window, naming the recent message", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-abc",
          gmailMessageId: "prior-msg-1",
          recipient: "will@supplier.example.com",
          sentAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
        },
      ],
    });
    const service = createGmailService(db);

    await expect(
      service.sendMessage(
        "alex",
        { to: "will@supplier.example.com", subject: "v3 proof", body: "Attached." },
        undefined,
        { companyId: COMPANY },
      ),
    ).rejects.toMatchObject({
      name: "GmailRecentSendBlockedError",
      address: "will@supplier.example.com",
      recentSends: [
        expect.objectContaining({ gmailMessageId: "prior-msg-1", gmailThreadId: "thread-abc" }),
      ],
    });
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it("throws a GmailRecentSendBlockedError instance with the message naming the prior send", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-abc",
          gmailMessageId: "prior-msg-1",
          recipient: "will@supplier.example.com",
          sentAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      ],
    });
    const service = createGmailService(db);
    let caught: unknown;
    try {
      await service.sendMessage(
        "alex",
        { to: "will@supplier.example.com", subject: "v3 proof", body: "Attached." },
        undefined,
        { companyId: COMPANY },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GmailRecentSendBlockedError);
    expect((caught as Error).message).toContain("prior-msg-1");
    expect((caught as Error).message).toContain("acknowledgeRecentSend");
  });

  it("allows the send when acknowledgeRecentSend:true is passed explicitly", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-abc",
          gmailMessageId: "prior-msg-1",
          recipient: "will@supplier.example.com",
          sentAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      ],
    });
    const service = createGmailService(db);

    const result = await service.sendMessage(
      "alex",
      {
        to: "will@supplier.example.com",
        subject: "v3 proof",
        body: "Attached.",
        acknowledgeRecentSend: true,
      },
      undefined,
      { companyId: COMPANY },
    );
    expect(result.id).toBe("new-msg");
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });

  it("never blocks an own-domain recipient regardless of cadence", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-internal",
          gmailMessageId: "prior-msg-internal",
          recipient: "teammate@tryauranode.com",
          sentAt: new Date(Date.now() - 60 * 1000), // 1 min ago
        },
      ],
    });
    const service = createGmailService(db);

    const result = await service.sendMessage(
      "alex",
      { to: "teammate@tryauranode.com", subject: "internal note", body: "fyi", allowSelfAddressed: true },
      undefined,
      { companyId: COMPANY },
    );
    expect(result.id).toBe("new-msg");
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });

  it("does not block a send to a different address inside the same window (scoping is per-recipient)", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-abc",
          gmailMessageId: "prior-msg-1",
          recipient: "will@supplier.example.com",
          sentAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      ],
    });
    const service = createGmailService(db);

    const result = await service.sendMessage(
      "alex",
      { to: "someone-else@other.example.com", subject: "unrelated", body: "hi" },
      undefined,
      { companyId: COMPANY },
    );
    expect(result.id).toBe("new-msg");
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });

  it("does not block a send once the prior send has aged out of the window", async () => {
    const { db } = buildDbMock({
      outboundRows: [
        {
          companyId: COMPANY,
          mailbox: "alex",
          gmailThreadId: "thread-abc",
          gmailMessageId: "prior-msg-old",
          recipient: "will@supplier.example.com",
          sentAt: new Date(Date.now() - 45 * 60 * 1000), // 45 min ago — outside the 20-min window
        },
      ],
    });
    const service = createGmailService(db);

    const result = await service.sendMessage(
      "alex",
      { to: "will@supplier.example.com", subject: "follow-up", body: "hi" },
      undefined,
      { companyId: COMPANY },
    );
    expect(result.id).toBe("new-msg");
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });

  it("skips the cadence check entirely when no db/tracking context is available", async () => {
    const service = createGmailService(); // no db — mirrors gmail.test.ts's unit-test style
    const result = await service.sendMessage("alex", {
      to: "will@supplier.example.com",
      subject: "v3 proof",
      body: "Attached.",
    });
    expect(result.id).toBe("new-msg");
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });
});
