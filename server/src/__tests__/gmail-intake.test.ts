import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// Mock the Gmail service and issue service before importing intake
const mockListMessages = vi.fn();
const mockGetMessage = vi.fn();
const mockListLabels = vi.fn();
const mockCreateLabel = vi.fn();
const mockModifyMessageLabels = vi.fn();

vi.mock("../services/gmail.js", () => ({
  GMAIL_SUPPORTED_ALIASES: ["board", "alex", "leo", "adrian", "billing"],
  createGmailService: () => ({
    listMessages: mockListMessages,
    getMessage: mockGetMessage,
    listLabels: mockListLabels,
    createLabel: mockCreateLabel,
    modifyMessageLabels: mockModifyMessageLabels,
  }),
}));

const mockIssueCreate = vi.fn();
const mockAddComment = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: mockIssueCreate,
    addComment: mockAddComment,
  }),
}));

const { createGmailIntakeService, INTAKE_LABELS } = await import(
  "../services/gmail-intake.js"
);

// Minimal Drizzle-like db mock that supports select/insert chaining.
// leftJoin and orderBy are added to support the cross-thread sender+subject
// dedupe query (AUR-2674) which uses .leftJoin(issues, ...).orderBy(desc(...)).
function buildDbMock(
  overrides: {
    selectRows?: Record<string, unknown>[];
  } = {},
) {
  const selectRows = overrides.selectRows ?? [];
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(selectRows),
  };
  const insertChain = {
    values: vi.fn().mockResolvedValue(undefined),
  };
  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    _selectChain: selectChain,
    _insertChain: insertChain,
  } as unknown as Db & {
    _selectChain: typeof selectChain;
    _insertChain: typeof insertChain;
  };
}

function makeMessage(id: string, threadId: string, subject = "Hello world") {
  return {
    id,
    threadId,
    snippet: "Message body preview",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Sat, 24 May 2026 12:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: {
        data: Buffer.from("Hello, this is the message body.").toString("base64url"),
      },
      parts: null,
    },
  };
}

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

describe("INTAKE_LABELS", () => {
  it("exports the three canonical label names", () => {
    expect(INTAKE_LABELS.TRIAGED).toBe("paperclip/triaged");
    expect(INTAKE_LABELS.NEEDS_REPLY).toBe("paperclip/needs-reply");
    expect(INTAKE_LABELS.REPLIED).toBe("paperclip/replied");
  });
});

describe("createGmailIntakeService.processMailbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zeros when no messages are returned", async () => {
    mockListMessages.mockResolvedValue({ messages: [] });
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");
    expect(result).toEqual({ processed: 0, created: 0, updated: 0, skipped: 0, errors: 0 });
  });

  it("creates a new issue for an unseen message", async () => {
    const msg = makeMessage("msg1", "thread1");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-triaged", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-new-1" });
    mockAddComment.mockResolvedValue({});

    // No existing record for message, no existing thread record either
    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    const createCall = mockIssueCreate.mock.calls[0];
    expect(createCall[0]).toBe(COMPANY_ID);
    expect(createCall[1]).toMatchObject({
      title: expect.stringContaining("[board@]"),
      // Routed inbound issues must land in an actionable status, not backlog,
      // so the assignee actually picks them up.
      status: "todo",
      priority: "medium",
      originKind: "inbound_email",
    });
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);

    // A first-class structured Gmail reference comment is attached to the new
    // issue so the reply workflow does not have to parse prose.
    expect(mockAddComment).toHaveBeenCalledOnce();
    const newIssueCommentOpts = mockAddComment.mock.calls[0][3];
    expect(newIssueCommentOpts.authorType).toBe("system");
    const newIssueMeta = newIssueCommentOpts.metadata;
    expect(newIssueMeta.version).toBe(1);
    const newIssueRows = newIssueMeta.sections[0].rows;
    const threadRow = newIssueRows.find((r: { label?: string }) => r.label === "Gmail thread ID");
    const messageRow = newIssueRows.find((r: { label?: string }) => r.label === "Gmail message ID");
    expect(threadRow.value).toBe("thread1");
    expect(messageRow.value).toBe("msg1");
    expect(newIssueRows.some((r: { label?: string }) => r.label === "Subject")).toBe(true);
  });

  it("skips messages that already have an intake record", async () => {
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg1" }] });
    // Return a row for the message-level dedup check
    const db = buildDbMock({ selectRows: [{ id: "existing-record" }] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("adds a comment when the Gmail thread already has an intake record with issueId", async () => {
    const msg = makeMessage("msg2", "thread1", "Re: Hello world");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-new" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockAddComment.mockResolvedValue({});

    // First select (message-level dedup): no record → proceed.
    // Second select (thread-level lookup): return an existing issue ID.
    // (Cross-thread sender+subject lookup is inside the else branch, not reached when thread match found.)
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        const rows = selectCallCount === 1
          ? []
          : [{ issueId: "issue-existing-1" }];
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(rows),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as unknown as Db;

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).toHaveBeenCalledOnce();
    const replyCall = mockAddComment.mock.calls[0];
    const commentBody = replyCall[1] as string;
    expect(commentBody).toContain("New reply in Gmail thread");
    expect(commentBody).toContain("msg2");

    // The reply comment also carries structured Gmail refs as metadata so the
    // same thread's message id is recoverable without prose parsing.
    const replyOpts = replyCall[3];
    expect(replyOpts.authorType).toBe("system");
    const replyRows = replyOpts.metadata.sections[0].rows;
    expect(replyRows.find((r: { label?: string }) => r.label === "Gmail thread ID").value).toBe("thread1");
    expect(replyRows.find((r: { label?: string }) => r.label === "Gmail message ID").value).toBe("msg2");
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });

  it("applies paperclip/triaged label after processing", async () => {
    const msg = makeMessage("msg3", "thread3");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg3" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-new-3" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "leo");

    expect(mockModifyMessageLabels).toHaveBeenCalledWith(
      "leo",
      "msg3",
      expect.objectContaining({ addLabelIds: ["lbl-t"] }),
    );
  });

  it("creates the triaged label if it does not exist", async () => {
    const msg = makeMessage("msg4", "thread4");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg4" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-created" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-4" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    expect(mockCreateLabel).toHaveBeenCalledWith("board", "paperclip/triaged");
    expect(mockModifyMessageLabels).toHaveBeenCalledWith(
      "board",
      "msg4",
      expect.objectContaining({ addLabelIds: ["lbl-created"] }),
    );
  });

  it("excludes the invoicing@ alias from the Gmail poll query", async () => {
    mockListMessages.mockResolvedValue({ messages: [] });
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "leo");

    const query = mockListMessages.mock.calls[0][1].query as string;
    expect(query).toContain("newer_than:2d");
    expect(query).toContain("-to:invoicing@tryauranode.com");
    expect(query).toContain("-deliveredto:invoicing@tryauranode.com");
  });

  it("does NOT create a generic issue for mail delivered to the invoicing@ alias", async () => {
    // Simulates an invoicing@ message that slipped past the query exclusion
    // (e.g. alias only in Delivered-To). The dedicated invoicing-intake worker
    // owns this message; the generic poller must skip it, not duplicate it.
    const msg = makeMessage("msg-inv-alias", "thread-inv-alias", "Invoice INV-9001 due");
    msg.payload.headers.push({ name: "Delivered-To", value: "invoicing@tryauranode.com" });
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-inv-alias" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-should-not-exist" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "leo");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
  });

  it("still creates an issue for a normal To header on the polled mailbox", async () => {
    const msg = makeMessage("msg-normal-to", "thread-normal-to");
    msg.payload.headers.push({ name: "To", value: "leo@tryauranode.com" });
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-normal-to" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-normal" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "leo");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
  });

  it("records errors and does not throw when listMessages fails", async () => {
    mockListMessages.mockRejectedValue(new Error("network error"));
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");
    expect(result.errors).toBe(1);
  });

  it("sanitizes header values: strips newlines from from/subject in description", async () => {
    const msg = makeMessage("msg5", "thread5");
    // Inject newline into the From header value
    msg.payload.headers[0].value = "Evil\r\nUser <evil@example.com>";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg5" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-ok" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-5" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const createCall = mockIssueCreate.mock.calls[0];
    const description = createCall[1].description as string;
    // The From line must not contain raw CR or LF — the injected newlines are stripped.
    const fromLine = description.split("\n").find((l) => l.startsWith("- **From:**")) ?? "";
    expect(fromLine).not.toContain("\r");
    expect(fromLine).not.toContain("\n");
    expect(fromLine).toContain("Evil  User <evil@example.com>");
  });

  it("sanitizes injected newlines from issue title (subject) at parse time", async () => {
    const msg = makeMessage("msg6", "thread6");
    // Inject CRLF into the Subject header
    msg.payload.headers[1].value = "Legit Subject\r\nX-Injected: header";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg6" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-ok" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-6" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const createCall = mockIssueCreate.mock.calls[0];
    const title = createCall[1].title as string;
    expect(title).not.toMatch(/[\r\n\0]/);
    expect(title).toContain("[board@]");
  });

  it("sanitizes sender and subject stored in the DB insert at parse time", async () => {
    const msg = makeMessage("msg7", "thread7");
    // Inject null bytes and newlines into both From and Subject
    msg.payload.headers[0].value = "Bad\0Sender\r\n <bad@example.com>";
    msg.payload.headers[1].value = "Subject\nWith\0Injection";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg7" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-ok" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-7" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    // Verify the DB insert received sanitized values
    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    const storedSender = insertValues.sender as string;
    const storedSubject = insertValues.subject as string;
    expect(storedSender).not.toMatch(/[\r\n\0]/);
    expect(storedSubject).not.toMatch(/[\r\n\0]/);
  });
});

describe("cross-thread sender+subject dedupe (AUR-2674)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMessageWithHeaders(
    id: string,
    threadId: string,
    subject: string,
    extraHeaders: Array<{ name: string; value: string }> = [],
  ) {
    const msg = makeMessage(id, threadId, subject);
    msg.payload.headers.push(...extraHeaders);
    return msg;
  }

  // Build a db mock that tracks call count and returns different rows per call.
  // The select chain must include leftJoin and orderBy for the dedupe query.
  function buildCountingDb(rowsByCall: Record<number, unknown[]>) {
    let selectCallCount = 0;
    return {
      select: vi.fn(() => {
        selectCallCount++;
        const rows = rowsByCall[selectCallCount] ?? [];
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(rows),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as unknown as Db;
  }

  it("folds N identical acks across different thread IDs into exactly ONE issue with N-1 comments", async () => {
    const msgs = [
      makeMessage("ack1", "thread-ack-1", "We received your notification"),
      makeMessage("ack2", "thread-ack-2", "We received your notification"),
      makeMessage("ack3", "thread-ack-3", "We received your notification"),
    ];

    mockListMessages.mockResolvedValue({ messages: [{ id: "ack1" }, { id: "ack2" }, { id: "ack3" }] });
    mockGetMessage
      .mockResolvedValueOnce(msgs[0])
      .mockResolvedValueOnce(msgs[1])
      .mockResolvedValueOnce(msgs[2]);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "ack-issue-1" });
    mockAddComment.mockResolvedValue({});

    // ack1: calls 1(dedup)→empty, 2(thread)→empty, 3(sender+subj)→empty, 4(agent)→agent
    // ack2: calls 5(dedup)→empty, 6(thread)→empty, 7(sender+subj)→open match
    // ack3: calls 8(dedup)→empty, 9(thread)→empty, 10(sender+subj)→open match
    const openMatch = [{ issueId: "ack-issue-1", issueStatus: "todo" }];
    const db = buildCountingDb({
      4: [{ id: "agent-1" }],
      7: openMatch,
      10: openMatch,
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(2);
    // 1 reference comment for the new issue + 2 fold comments
    expect(mockAddComment).toHaveBeenCalledTimes(3);
  });

  it("creates a fresh issue when the matched issue is closed (no reopen) for non-auto-reply", async () => {
    const msgs = [
      makeMessage("closed-1", "thread-c1", "Notification"),
      makeMessage("closed-2", "thread-c2", "Notification"),
    ];

    mockListMessages.mockResolvedValue({ messages: [{ id: "closed-1" }, { id: "closed-2" }] });
    mockGetMessage.mockResolvedValueOnce(msgs[0]).mockResolvedValueOnce(msgs[1]);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "fresh-issue-1" });
    mockAddComment.mockResolvedValue({});

    // closed-1: call 3 sender+subj → closed match (no match via INNER JOIN semantics — db returns empty)
    //           call 4 agent → agent
    // closed-2: call 7 sender+subj → fresh-issue-1 now open
    const db = buildCountingDb({
      4: [{ id: "agent-1" }],
      7: [{ issueId: "fresh-issue-1", issueStatus: "todo" }],
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
  });

  it("skips creating a new issue when auto-reply matches a closed issue", async () => {
    const msg = makeMessageWithHeaders("ar-1", "thread-ar-1", "We received your report", [
      { name: "Auto-Submitted", value: "auto-replied" },
    ]);

    mockListMessages.mockResolvedValue({ messages: [{ id: "ar-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "should-not-be-called" });
    mockAddComment.mockResolvedValue({});

    // call 1 dedup → empty; call 2 thread → empty; call 3 sender+subj → closed match
    const db = buildCountingDb({
      3: [{ issueId: "old-closed-issue", issueStatus: "done" }],
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("detects Auto-Submitted: auto-generated as auto-reply", async () => {
    const msg = makeMessageWithHeaders("ag-1", "thread-ag-1", "Auto ack", [
      { name: "Auto-Submitted", value: "auto-generated" },
    ]);
    mockListMessages.mockResolvedValue({ messages: [{ id: "ag-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "x" });
    mockAddComment.mockResolvedValue({});

    const db = buildCountingDb({
      3: [{ issueId: "closed-iss", issueStatus: "cancelled" }],
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("detects Precedence: bulk as auto-reply", async () => {
    const msg = makeMessageWithHeaders("bulk-1", "thread-bulk-1", "Newsletter", [
      { name: "Precedence", value: "bulk" },
    ]);
    mockListMessages.mockResolvedValue({ messages: [{ id: "bulk-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "y" });
    mockAddComment.mockResolvedValue({});

    const db = buildCountingDb({
      3: [{ issueId: "closed-iss", issueStatus: "done" }],
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("does NOT skip auto-reply when there is no historical match (first occurrence)", async () => {
    const msg = makeMessageWithHeaders("ar-new", "thread-ar-new", "First ack", [
      { name: "Auto-Submitted", value: "auto-replied" },
    ]);
    mockListMessages.mockResolvedValue({ messages: [{ id: "ar-new" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "first-ar-issue" });
    mockAddComment.mockResolvedValue({});

    // call 1 dedup → empty; call 2 thread → empty; call 3 sender+subj → empty (no history)
    // call 4 agent → agent
    const db = buildCountingDb({ 4: [{ id: "agent-1" }] });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });

  it("stores normalized subject in the intake record (strips Re: prefix)", async () => {
    const msg = makeMessage("re-1", "thread-re-1", "Re: We received your notification");
    mockListMessages.mockResolvedValue({ messages: [{ id: "re-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "re-issue-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    const storedSubject = insertValues.subject as string;
    // Normalized: no "Re: " prefix, lowercase
    expect(storedSubject).not.toMatch(/^re\s*:/i);
    expect(storedSubject).toBe("we received your notification");
  });

  it("same-thread folding is unchanged (existing thread-ID path still works)", async () => {
    const msg = makeMessage("same-thread-2", "thread-existing", "Re: Hello");
    mockListMessages.mockResolvedValue({ messages: [{ id: "same-thread-2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockAddComment.mockResolvedValue({});

    // call 1 message dedup → empty (proceed); call 2 thread lookup → existing issue
    const db = buildCountingDb({
      2: [{ issueId: "thread-issue-1" }],
    });

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).toHaveBeenCalledOnce();
    const commentBody = mockAddComment.mock.calls[0][1] as string;
    expect(commentBody).toContain("New reply in Gmail thread");
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });
});

describe("createGmailIntakeService.pollAllMailboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls all five mailboxes and returns per-mailbox results", async () => {
    mockListMessages.mockResolvedValue({ messages: [] });
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(5);
    const mailboxes = results.map((r) => r.mailbox);
    expect(mailboxes).toContain("board");
    expect(mailboxes).toContain("alex");
    expect(mailboxes).toContain("leo");
    expect(mailboxes).toContain("adrian");
    expect(mailboxes).toContain("billing");
  });

  it("continues polling remaining mailboxes when one fails", async () => {
    mockListMessages
      .mockRejectedValueOnce(new Error("board failed"))
      .mockResolvedValue({ messages: [] });

    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(5);
    const boardResult = results.find((r) => r.mailbox === "board");
    expect(boardResult?.errors).toBe(1);
    const alexResult = results.find((r) => r.mailbox === "alex");
    expect(alexResult?.errors).toBe(0);
  });
});

describe("buildIssueTitle — sender in title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes display-name sender when From has 'Name <email>' format", async () => {
    const msg = makeMessage("msg-sender1", "thread-s1", "Confirm your business email");
    msg.payload.headers[0].value = "Facebook Business Manager <noreply@facebookmail.com>";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-sender1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-s1" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const title = mockIssueCreate.mock.calls[0][1].title as string;
    expect(title).toContain("[board@]");
    expect(title).toContain("Facebook Business Manager");
    expect(title).toContain("Confirm your business email");
    expect(title).toMatch(/\[board@\] Facebook Business Manager — Confirm your business email/);
  });

  it("uses bare email address in title when From has no display name", async () => {
    const msg = makeMessage("msg-sender2", "thread-s2", "Hello");
    msg.payload.headers[0].value = "bare@example.com";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-sender2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-s2" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const title = mockIssueCreate.mock.calls[0][1].title as string;
    expect(title).toContain("[board@]");
    expect(title).toContain("bare@example.com");
    expect(title).toContain("Hello");
  });
});

describe("routing: mailbox → agent role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["board", "ceo"],
    ["alex", "cmo"],
    ["leo", "cto"],
    ["adrian", "cfo"],
    ["billing", "cfo"],
  ] as const)("%s mailbox resolves to %s agent role", async (mailbox, _role) => {
    const msg = makeMessage("msg-r", "thread-r");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-r" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-r" });

    // Simulate agent lookup returning an id.
    // Call order (after AUR-2674 dedupe): 1=msg-dedup, 2=thread-lookup,
    // 3=sender+subject-lookup (returns {id} no issueId → no match), 4=agent-lookup.
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        const rows = selectCallCount >= 3 ? [{ id: "agent-ceo-1" }] : [];
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(rows),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as unknown as Db;

    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, mailbox);

    expect(mockIssueCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ assigneeAgentId: "agent-ceo-1" }),
    );
  });
});

describe("content-based routing: invoice subjects route to CFO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildAgentLookupDb(agentId: string) {
    let selectCallCount = 0;
    return {
      select: vi.fn(() => {
        selectCallCount++;
        // Call 1=msg-dedup, 2=thread-lookup, 3=sender+subject-lookup (returns {id} no issueId → no match), 4=agent-lookup.
        const rows = selectCallCount >= 3 ? [{ id: agentId }] : [];
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(rows),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as unknown as Db;
  }

  it.each([
    "[INVOICE-TEST] Acme Supplies invoice #INV-1234",
    "Your receipt from Stripe",
    "INV-5678 — payment due 2026-07-01",
    "Monthly bill for cloud hosting",
    "VAT invoice attached",
    "Billing statement for May 2026",
    "Payment due: hosting renewal",
  ])("subject '%s' on alex@ routes to CFO, not CMO", async (subject) => {
    const msg = makeMessage("msg-inv", "thread-inv", subject);
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-inv" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-inv" });

    const db = buildAgentLookupDb("agent-cfo-override");
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ assigneeAgentId: "agent-cfo-override" }),
    );
  });

  it("non-invoice subject on alex@ still routes to CMO (default)", async () => {
    const msg = makeMessage("msg-mktg", "thread-mktg", "Q3 marketing campaign draft");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-mktg" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-mktg" });

    const db = buildAgentLookupDb("agent-cmo-default");
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ assigneeAgentId: "agent-cmo-default" }),
    );
  });
});
