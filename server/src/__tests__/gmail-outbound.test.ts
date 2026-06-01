import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

const { createGmailOutboundService } = await import("../services/gmail-outbound.js");

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

// Drizzle db mock
function buildDbMock(executeRows: Record<string, unknown>[] = []) {
  const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
  return {
    insert: vi.fn(() => insertChain),
    execute: vi.fn().mockResolvedValue({ rows: executeRows }),
    _insertChain: insertChain,
  } as unknown as Db & {
    _insertChain: typeof insertChain;
    execute: ReturnType<typeof vi.fn>;
  };
}

describe("createGmailOutboundService.persistSend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a row with all provided fields", async () => {
    const db = buildDbMock();
    const svc = createGmailOutboundService(db);
    await svc.persistSend({
      companyId: COMPANY_ID,
      mailbox: "alex",
      gmailThreadId: "thread1",
      gmailMessageId: "msg1",
      recipient: "customer@example.com",
      subject: "Hello",
      campaign: "outreach-q2",
      sentByAgentId: "agent-1",
      issueId: "issue-1",
    });

    expect(db.insert).toHaveBeenCalledOnce();
    const values = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.companyId).toBe(COMPANY_ID);
    expect(values.mailbox).toBe("alex");
    expect(values.gmailThreadId).toBe("thread1");
    expect(values.gmailMessageId).toBe("msg1");
    expect(values.recipient).toBe("customer@example.com");
    expect(values.subject).toBe("Hello");
    expect(values.campaign).toBe("outreach-q2");
    expect(values.sentByAgentId).toBe("agent-1");
    expect(values.issueId).toBe("issue-1");
    expect(values.status).toBe("sent");
  });

  it("does not throw when insert fails", async () => {
    const db = buildDbMock();
    (db as ReturnType<typeof buildDbMock>)._insertChain.values.mockRejectedValue(new Error("db error"));
    const svc = createGmailOutboundService(db);
    await expect(svc.persistSend({
      companyId: COMPANY_ID,
      mailbox: "leo",
      gmailThreadId: "t1",
      gmailMessageId: "m1",
      recipient: "x@y.com",
    })).resolves.toBeUndefined();
  });
});

describe("createGmailOutboundService.queryConversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when no rows", async () => {
    const db = buildDbMock([]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID);
    expect(result).toEqual([]);
  });

  it("maps a needs-pickup row (no outbound)", async () => {
    const db = buildDbMock([{
      mailbox: "leo",
      thread_id: "thread-abc",
      contact: "vendor@example.com",
      out_subject: null,
      sent_at: null,
      in_subject: "Invoice #42",
      who_replied: "vendor@example.com",
      received_at: new Date("2026-05-30T10:00:00Z"),
      campaign: null,
      response_status: "needs-pickup",
    }]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID);

    expect(result).toHaveLength(1);
    expect(result[0].responseStatus).toBe("needs-pickup");
    expect(result[0].owner).toBe("cto");
    expect(result[0].lastOutbound).toBeNull();
    expect(result[0].lastInbound?.subject).toBe("Invoice #42");
    expect(result[0].whoReplied).toBe("vendor@example.com");
    expect(result[0].threadId).toBe("thread-abc");
  });

  it("maps an awaiting-reply row (outbound sent, no inbound after)", async () => {
    const db = buildDbMock([{
      mailbox: "alex",
      thread_id: "thread-xyz",
      contact: "lead@acme.com",
      out_subject: "Partnership proposal",
      sent_at: new Date("2026-05-29T08:00:00Z"),
      in_subject: null,
      who_replied: null,
      received_at: null,
      campaign: "sales-q2",
      response_status: "awaiting-reply",
    }]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID);

    expect(result[0].responseStatus).toBe("awaiting-reply");
    expect(result[0].owner).toBe("cmo");
    expect(result[0].campaign).toBe("sales-q2");
    expect(result[0].lastOutbound?.subject).toBe("Partnership proposal");
    expect(result[0].lastInbound).toBeNull();
  });

  it("maps a replied row (they replied after our outbound)", async () => {
    const db = buildDbMock([{
      mailbox: "board",
      thread_id: "thread-board-1",
      contact: "investor@vc.com",
      out_subject: "Follow-up on meeting",
      sent_at: new Date("2026-05-28T09:00:00Z"),
      in_subject: "Re: Follow-up on meeting",
      who_replied: "investor@vc.com",
      received_at: new Date("2026-05-29T14:00:00Z"),
      campaign: null,
      response_status: "replied",
    }]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID);

    expect(result[0].responseStatus).toBe("replied");
    expect(result[0].owner).toBe("ceo");
    expect(result[0].whoReplied).toBe("investor@vc.com");
    expect(result[0].lastInbound?.subject).toBe("Re: Follow-up on meeting");
    expect(result[0].lastOutbound?.subject).toBe("Follow-up on meeting");
  });

  it("filters by mailbox", async () => {
    const db = buildDbMock([
      {
        mailbox: "leo",
        thread_id: "t1",
        contact: "a@b.com",
        out_subject: null,
        sent_at: null,
        in_subject: "Tech request",
        who_replied: "a@b.com",
        received_at: new Date("2026-05-30"),
        campaign: null,
        response_status: "needs-pickup",
      },
      {
        mailbox: "alex",
        thread_id: "t2",
        contact: "c@d.com",
        out_subject: "Outreach",
        sent_at: new Date("2026-05-29"),
        in_subject: null,
        who_replied: null,
        received_at: null,
        campaign: null,
        response_status: "awaiting-reply",
      },
    ]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID, { mailbox: "leo" });
    expect(result).toHaveLength(1);
    expect(result[0].mailbox).toBe("leo");
  });

  it("filters by owner", async () => {
    const db = buildDbMock([
      {
        mailbox: "leo",
        thread_id: "t1",
        contact: "a@b.com",
        out_subject: null,
        sent_at: null,
        in_subject: "Tech request",
        who_replied: "a@b.com",
        received_at: new Date("2026-05-30"),
        campaign: null,
        response_status: "needs-pickup",
      },
      {
        mailbox: "alex",
        thread_id: "t2",
        contact: "c@d.com",
        out_subject: "Outreach",
        sent_at: new Date("2026-05-29"),
        in_subject: null,
        who_replied: null,
        received_at: null,
        campaign: null,
        response_status: "awaiting-reply",
      },
    ]);
    const svc = createGmailOutboundService(db);
    const ctoResult = await svc.queryConversations(COMPANY_ID, { owner: "cto" });
    expect(ctoResult).toHaveLength(1);
    expect(ctoResult[0].owner).toBe("cto");
  });

  it("filters by response status", async () => {
    const db = buildDbMock([
      {
        mailbox: "leo",
        thread_id: "t1",
        contact: null,
        out_subject: null,
        sent_at: null,
        in_subject: "inbound",
        who_replied: "x@y.com",
        received_at: new Date(),
        campaign: null,
        response_status: "needs-pickup",
      },
      {
        mailbox: "alex",
        thread_id: "t2",
        contact: "c@d.com",
        out_subject: "Hey",
        sent_at: new Date(),
        in_subject: null,
        who_replied: null,
        received_at: null,
        campaign: null,
        response_status: "awaiting-reply",
      },
    ]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID, { status: "needs-pickup" });
    expect(result).toHaveLength(1);
    expect(result[0].responseStatus).toBe("needs-pickup");
  });

  it("filters by campaign", async () => {
    const db = buildDbMock([
      {
        mailbox: "alex",
        thread_id: "t1",
        contact: "a@b.com",
        out_subject: "Hello",
        sent_at: new Date(),
        in_subject: null,
        who_replied: null,
        received_at: null,
        campaign: "outreach-q2",
        response_status: "awaiting-reply",
      },
      {
        mailbox: "alex",
        thread_id: "t2",
        contact: "c@d.com",
        out_subject: "World",
        sent_at: new Date(),
        in_subject: null,
        who_replied: null,
        received_at: null,
        campaign: "cold-q3",
        response_status: "awaiting-reply",
      },
    ]);
    const svc = createGmailOutboundService(db);
    const result = await svc.queryConversations(COMPANY_ID, { campaign: "outreach-q2" });
    expect(result).toHaveLength(1);
    expect(result[0].campaign).toBe("outreach-q2");
  });
});
