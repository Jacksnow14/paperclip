import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// Mock the Gmail service and issue service before importing intake
const mockListMessages = vi.fn();
const mockGetMessage = vi.fn();
const mockListLabels = vi.fn();
const mockCreateLabel = vi.fn();
const mockModifyMessageLabels = vi.fn();
const mockSendMessage = vi.fn();

vi.mock("../services/gmail.js", () => ({
  GMAIL_SUPPORTED_ALIASES: ["board", "alex"],
  createGmailService: () => ({
    listMessages: mockListMessages,
    getMessage: mockGetMessage,
    listLabels: mockListLabels,
    createLabel: mockCreateLabel,
    modifyMessageLabels: mockModifyMessageLabels,
    sendMessage: mockSendMessage,
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

// Spy on drizzle-orm's isNotNull while keeping its real behavior, so tests can
// tell whether a given query actually built its where-clause with isNotNull
// (AUR-5491 finding 2) rather than hardcoding what the mocked db should return.
const { isNotNullCallCount } = vi.hoisted(() => ({ isNotNullCallCount: { count: 0 } }));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    isNotNull: (...args: Parameters<typeof actual.isNotNull>) => {
      isNotNullCallCount.count++;
      return actual.isNotNull(...args);
    },
  };
});

const {
  createGmailIntakeService,
  INTAKE_LABELS,
  repairUtf8Mojibake,
  isDmarcAggregateReport,
  isOwnOutboundCopy,
  isMarketingEmail,
  isColdOutreachOwnSend,
} = await import("../services/gmail-intake.js");

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
    await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockModifyMessageLabels).toHaveBeenCalledWith(
      "alex",
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

describe("DMARC aggregate-report suppression (AUR-4466)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDmarcMessage(id: string, threadId: string, from: string, subject: string) {
    const msg = makeMessage(id, threadId, subject);
    msg.payload.headers[0].value = from;
    return msg;
  }

  it.each([
    ["dmarcreport@microsoft.com", "Report Domain: tryauranode.com Submitter: Outlook.com Report-ID: <abc123>"],
    ["noreply-dmarc-support@google.com", "Report domain: tryauranode.com Submitter: google.com Report-ID: 1234567890"],
    ["noreply@dmarc.yahoo.com", "Report Domain: tryauranode.com Submitter: yahoo.com Report-ID: <xyz>"],
    ["Postmaster <postmaster@mail.protection.outlook.com>", "Report Domain: tryauranode.com Submitter: Outlook.com"],
  ])("skips issue creation for DMARC report from %s", async (from, subject) => {
    const msg = makeDmarcMessage("dmarc-1", "thread-dmarc-1", from, subject);
    mockListMessages.mockResolvedValue({ messages: [{ id: "dmarc-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "should-not-exist" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(1);
  });

  it("classifies by subject shape alone for an unknown submitter address", async () => {
    const msg = makeDmarcMessage(
      "dmarc-unknown",
      "thread-dmarc-u",
      "dmarc_agg@some-new-provider.example",
      "Report Domain: tryauranode.com Submitter: some-new-provider.example Report-ID: r1",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "dmarc-unknown" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockIssueCreate.mockResolvedValue({ id: "should-not-exist" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("leaves the mail untouched (no label) and records the intake with null issueId", async () => {
    const msg = makeDmarcMessage(
      "dmarc-2",
      "thread-dmarc-2",
      "dmarcreport@microsoft.com",
      "Report Domain: tryauranode.com Submitter: Outlook.com Report-ID: <r2>",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "dmarc-2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    // The message must not be labeled, archived, or otherwise modified — the
    // DMARC sensor (AUR-4241) reads the report from the mailbox in place.
    expect(mockModifyMessageLabels).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();

    // The intake record is still written (issueId null) so the report is not
    // reprocessed on the next poll.
    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(insertValues.gmailMessageId).toBe("dmarc-2");
    expect(insertValues.issueId).toBeNull();
  });

  it("still mints an issue for a normal board@ mail (guard does not over-suppress)", async () => {
    const msg = makeDmarcMessage(
      "normal-1",
      "thread-normal-1",
      "Jane Founder <jane@example.com>",
      "Question about the report you sent",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "normal-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-normal-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("classifier: matches known senders and subject shape, rejects lookalikes", () => {
    // Sender-based positives.
    expect(isDmarcAggregateReport("dmarcreport@microsoft.com", "anything")).toBe(true);
    expect(isDmarcAggregateReport("Postmaster <a@b.protection.outlook.com>", "x")).toBe(true);
    // Subject-based positive (unknown sender).
    expect(
      isDmarcAggregateReport("x@y.example", "Report Domain: d.com Submitter: y.example"),
    ).toBe(true);
    // Negatives: a human mail that merely mentions reports, and a subject
    // missing the Submitter: component.
    expect(isDmarcAggregateReport("jane@example.com", "Your weekly report domain ideas")).toBe(false);
    expect(isDmarcAggregateReport("jane@example.com", "Report Domain: d.com is down")).toBe(false);
    expect(isDmarcAggregateReport("jane@example.com", "Re: Report Domain: d.com Submitter: z")).toBe(false);
  });
});

describe("marketing/promotional email suppression (AUR-5831)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMarketingMessage(
    id: string,
    threadId: string,
    from: string,
    subject: string,
    listUnsubscribe: string,
  ) {
    const msg = makeMessage(id, threadId, subject);
    msg.payload.headers[0].value = from;
    if (listUnsubscribe) {
      msg.payload.headers.push({ name: "List-Unsubscribe", value: listUnsubscribe });
    }
    return msg;
  }

  it.each([
    [
      "gappie@glockapps.co",
      "Your inbox placement report is ready",
      "<mailto:unsubscribe@glockapps.co>, <https://glockapps.co/unsubscribe?id=1>",
    ],
    [
      "email@email.shopify.com",
      "New features to grow your store",
      "<https://email.shopify.com/unsubscribe/abc123>",
    ],
  ])(
    "skips issue creation for promotional mail from %s (AUR-5803/AUR-5804)",
    async (from, subject, listUnsubscribe) => {
      const msg = makeMarketingMessage("mkt-1", "thread-mkt-1", from, subject, listUnsubscribe);
      mockListMessages.mockResolvedValue({ messages: [{ id: "mkt-1" }] });
      mockGetMessage.mockResolvedValue(msg);
      mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
      mockModifyMessageLabels.mockResolvedValue({});
      mockIssueCreate.mockResolvedValue({ id: "should-not-exist" });
      mockAddComment.mockResolvedValue({});

      const db = buildDbMock({ selectRows: [] });
      const svc = createGmailIntakeService(db);
      const result = await svc.processMailbox(COMPANY_ID, "alex");

      expect(mockIssueCreate).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.processed).toBe(1);
    },
  );

  it("records the intake with a null issueId so the mail is not reprocessed", async () => {
    const msg = makeMarketingMessage(
      "mkt-2",
      "thread-mkt-2",
      "gappie@glockapps.co",
      "Your inbox placement report is ready",
      "<mailto:unsubscribe@glockapps.co>",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "mkt-2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "alex");

    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock
      .calls[0][0] as Record<string, unknown>;
    expect(insertValues.gmailMessageId).toBe("mkt-2");
    expect(insertValues.issueId).toBeNull();
  });

  it("still mints an issue for a normal reply with no List-Unsubscribe header (guard does not over-suppress)", async () => {
    const msg = makeMarketingMessage(
      "normal-2",
      "thread-normal-2",
      "Jane Prospect <jane@example.com>",
      "Re: quick question about pricing",
      "",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "normal-2" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-normal-2" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("classifier: presence of List-Unsubscribe (any value) is sufficient, blank/whitespace is not", () => {
    expect(isMarketingEmail("<mailto:unsubscribe@example.com>")).toBe(true);
    expect(isMarketingEmail("<https://example.com/unsub>")).toBe(true);
    expect(isMarketingEmail("")).toBe(false);
    expect(isMarketingEmail("   ")).toBe(false);
  });
});

describe("createGmailIntakeService.pollAllMailboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls alex and board mailboxes only (leo/adrian dropped when aliases)", async () => {
    mockListMessages.mockResolvedValue({ messages: [] });
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(2);
    const mailboxes = results.map((r) => r.mailbox);
    expect(mailboxes).toContain("board");
    expect(mailboxes).toContain("alex");
    expect(mailboxes).not.toContain("leo");
    expect(mailboxes).not.toContain("adrian");
  });

  it("continues polling remaining mailboxes when one fails", async () => {
    mockListMessages
      .mockRejectedValueOnce(new Error("board failed"))
      .mockResolvedValue({ messages: [] });

    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(2);
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

describe("sender-based routing: Google Payments → CFO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({ id: "fwd-1" });
  });

  function makeGooglePaymentsMessage(id: string, threadId: string) {
    return {
      id,
      threadId,
      snippet: "Вам выставлен ежемесячный счет",
      payload: {
        headers: [
          { name: "From", value: "Google Payments <payments-noreply@google.com>" },
          { name: "Subject", value: "Google Workspace: вам выставлен счет за использование домена tryauranode.com" },
          { name: "Date", value: "Tue, 01 Jul 2026 22:00:00 +0000" },
        ],
        mimeType: "text/plain",
        body: { data: Buffer.from("Monthly invoice for Google Workspace.").toString("base64url") },
        parts: null,
      },
    };
  }

  function makeAgentLookupDb() {
    let selectCallCount = 0;
    return {
      select: vi.fn(() => {
        selectCallCount++;
        // Call 1=msg-dedup, 2=thread-lookup, 3=sender+subject-lookup (returns {id}, no
        // issueId key → no cross-thread match), 4=agent-lookup (same row, keyed by id).
        const rows = selectCallCount >= 3 ? [{ id: "agent-cfo-1" }] : [];
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

  it("routes payments-noreply@google.com emails to CFO role", async () => {
    const msg = makeGooglePaymentsMessage("msg-gp1", "thread-gp1");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-gp1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-gp1" });

    const db = makeAgentLookupDb();
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ assigneeAgentId: "agent-cfo-1" }),
    );
  });

  it("routes workspace-noreply@google.com emails to CFO role", async () => {
    const msg = makeGooglePaymentsMessage("msg-gw1", "thread-gw1");
    msg.payload.headers[0].value = "Google Workspace <workspace-noreply@google.com>";
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-gw1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-gw1" });

    const db = makeAgentLookupDb();
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ assigneeAgentId: "agent-cfo-1" }),
    );
  });

  it("does not forward google payments/workspace routes now that adrian@ is a board@ alias", async () => {
    const msg = makeGooglePaymentsMessage("msg-fwd1", "thread-fwd1");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-fwd1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-fwd1" });

    const db = makeAgentLookupDb();
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not forward when sender does not match any route", async () => {
    const msg = makeMessage("msg-nofwd", "thread-nofwd");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-nofwd" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-nofwd" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// Helper: produce a double-UTF-8-encoded (mojibaked) version of a string,
// simulating the Gmail API returning UTF-8 header bytes interpreted twice as Latin-1.
function doubleMojibake(input: string): string {
  const singleMojibake = Buffer.from(input, "utf-8").toString("latin1");
  return Buffer.from(singleMojibake, "utf-8").toString("latin1");
}

describe("repairUtf8Mojibake (LAR-570)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("repairs double-encoded Søren Ø. Test subject", () => {
    const original = "Søren Ø. Test";
    const mojibaked = doubleMojibake(original);
    expect(repairUtf8Mojibake(mojibaked)).toBe(original);
  });

  it("repairs double-encoded em-dash", () => {
    const original = "Meeting — follow-up";
    const mojibaked = doubleMojibake(original);
    expect(repairUtf8Mojibake(mojibaked)).toBe(original);
  });

  it("leaves already-correct UTF-8 input unchanged (idempotent)", () => {
    const correct = "Søren Ø.";
    expect(repairUtf8Mojibake(correct)).toBe(correct);
  });

  it("leaves pure ASCII input unchanged", () => {
    const ascii = "Hello world - no special chars";
    expect(repairUtf8Mojibake(ascii)).toBe(ascii);
  });

  it("repairs mixed ASCII + non-ASCII (only the non-ASCII parts change)", () => {
    const original = "Invoice for Søren — due 2026-08-01";
    const mojibaked = doubleMojibake(original);
    expect(repairUtf8Mojibake(mojibaked)).toBe(original);
  });

  it("stores repaired subject in issue title when subject arrives double-encoded", async () => {
    const original = "Søren Ø. Test";
    const mojibaked = doubleMojibake(original);

    const msg = makeMessage("msg-moji", "thread-moji", mojibaked);
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-moji" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-moji" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-moji" });

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    await svc.processMailbox(COMPANY_ID, "board");

    const title = mockIssueCreate.mock.calls[0][1].title as string;
    expect(title).toContain(original);
    expect(title).not.toContain(mojibaked);
  });
});

describe("own-outbound suppression (AUR-5473)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Label sets below are copied from live messages in the alex@ mailbox.
  // Label_1 is paperclip/triaged.
  function makeLabeledMessage(
    id: string,
    threadId: string,
    labelIds: string[],
    from: string,
    subject: string,
  ) {
    const msg = makeMessage(id, threadId, subject) as ReturnType<typeof makeMessage> & {
      labelIds?: string[];
    };
    msg.labelIds = labelIds;
    msg.payload.headers[0].value = from;
    return msg;
  }

  it("mints no issue for our own cold email to a prospect (the AUR-5473 phantom)", async () => {
    // The exact message that produced AUR-5473: our outreach pitch to a
    // prospect, filed as an inbound revenue enquiry and assigned to the CMO.
    const msg = makeLabeledMessage(
      "sent-cold-1",
      "thread-sent-cold-1",
      ["Label_1", "SENT"],
      "alex@tryauranode.com",
      "For Wayne Decker - covering after-hours HVAC calls (business enquiry, not a service request)",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "sent-cold-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "should-not-exist" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);

    // Intake is still recorded (issueId null) so the send is not refetched on
    // every poll, and the outbound mail itself is left unlabeled.
    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock
      .calls[0][0] as Record<string, unknown>;
    expect(insertValues.gmailMessageId).toBe("sent-cold-1");
    expect(insertValues.issueId).toBeNull();
    expect(mockModifyMessageLabels).not.toHaveBeenCalled();
  });

  it("still mints an issue for genuine self-addressed mail (SENT + INBOX)", async () => {
    // alex@ really does receive mail from alex@ — booking confirmations and
    // internal verification sends. Those carry INBOX and must keep working.
    const msg = makeLabeledMessage(
      "self-inbox-1",
      "thread-self-inbox-1",
      ["UNREAD", "Label_1", "INBOX", "SENT"],
      "alex@tryauranode.com",
      "AUR-4065 AC4 env-scrub verification",
    );
    mockListMessages.mockResolvedValue({ messages: [{ id: "self-inbox-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-self-inbox-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still mints an issue for ordinary inbound mail with no label set at all", async () => {
    const msg = makeMessage("plain-1", "thread-plain-1", "Interested in a pilot");
    mockListMessages.mockResolvedValue({ messages: [{ id: "plain-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-plain-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
  });

  it("classifier: SENT without INBOX only", () => {
    // Positive — our own outbound copies.
    expect(isOwnOutboundCopy(["Label_1", "SENT"])).toBe(true);
    expect(isOwnOutboundCopy(["SENT"])).toBe(true);
    // Negative — delivered to us, including self-addressed (both labels).
    expect(isOwnOutboundCopy(["SENT", "INBOX"])).toBe(false);
    expect(isOwnOutboundCopy(["UNREAD", "Label_1", "INBOX"])).toBe(false);
    expect(isOwnOutboundCopy(["INBOX"])).toBe(false);
    // Negative — archived inbound mail (e.g. filtered to a label) is not ours.
    expect(isOwnOutboundCopy(["Label_2"])).toBe(false);
    expect(isOwnOutboundCopy([])).toBe(false);
    expect(isOwnOutboundCopy(null)).toBe(false);
    expect(isOwnOutboundCopy(undefined)).toBe(false);
  });
});

describe("cold-outreach send-only domain suppression (AUR-6042)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints no issue for our own ESP-sent cold outreach landing back in alex@ (the AUR-6041 phantom)", async () => {
    // Exact shape of live message 1a0238337fac560a that caused AUR-6041: no
    // SENT label (ESP-sent mail never gets one), so isOwnOutboundCopy alone
    // cannot catch it.
    const msg = makeMessage(
      "esp-cold-1",
      "thread-esp-cold-1",
      "Following up on after-hours coverage",
    );
    (msg as ReturnType<typeof makeMessage> & { labelIds?: string[] }).labelIds = [
      "UNREAD",
      "Label_1",
      "INBOX",
    ];
    msg.payload.headers[0].value = "Alex at Auranode <alex@auranodehq.com>";
    mockListMessages.mockResolvedValue({ messages: [{ id: "esp-cold-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "should-not-exist" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(1);

    // Intake is still recorded (issueId null) so the mail is not refetched on
    // every poll, and it is left untouched — no label, no archive.
    const insertValues = (db as ReturnType<typeof buildDbMock>)._insertChain.values.mock
      .calls[0][0] as Record<string, unknown>;
    expect(insertValues.gmailMessageId).toBe("esp-cold-1");
    expect(insertValues.issueId).toBeNull();
    expect(mockModifyMessageLabels).not.toHaveBeenCalled();
  });

  it("still mints an issue for genuine tryauranode.com self-addressed mail (AUR-5473 regression guard)", async () => {
    // The single highest-risk regression: tryauranode.com must keep minting
    // issues for real self-addressed sends (booking confirmations, internal
    // verification). This message has no SENT label (so isOwnOutboundCopy
    // does not suppress it) and a tryauranode.com From domain (so the new
    // auranodehq.com check must not touch it either).
    const msg = makeMessage(
      "self-tryauranode-1",
      "thread-self-tryauranode-1",
      "AUR-4065 AC4 env-scrub verification",
    );
    (msg as ReturnType<typeof makeMessage> & { labelIds?: string[] }).labelIds = [
      "UNREAD",
      "INBOX",
    ];
    msg.payload.headers[0].value = "alex@tryauranode.com";
    mockListMessages.mockResolvedValue({ messages: [{ id: "self-tryauranode-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-self-tryauranode-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still mints an issue for a genuine external prospect reply", async () => {
    const msg = makeMessage("prospect-1", "thread-prospect-1", "Re: quick question about pricing");
    msg.payload.headers[0].value = "Jane Prospect <jane@example.com>";
    mockListMessages.mockResolvedValue({ messages: [{ id: "prospect-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-prospect-1" });
    mockAddComment.mockResolvedValue({});

    const db = buildDbMock({ selectRows: [] });
    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "alex");

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("classifier: matches auranodehq.com From domain, rejects tryauranode.com and other domains", () => {
    expect(isColdOutreachOwnSend("Alex at Auranode <alex@auranodehq.com>")).toBe(true);
    expect(isColdOutreachOwnSend("alex@auranodehq.com")).toBe(true);
    expect(isColdOutreachOwnSend("ALEX@AURANODEHQ.COM")).toBe(true);
    expect(isColdOutreachOwnSend("bounce@mail.auranodehq.com")).toBe(true);
    expect(isColdOutreachOwnSend("alex@tryauranode.com")).toBe(false);
    expect(isColdOutreachOwnSend("jane@example.com")).toBe(false);
    expect(isColdOutreachOwnSend("someone@notauranodehq.com")).toBe(false);
  });
});

describe("thread lookup excludes null-issueId rows (AUR-5491)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNotNullCallCount.count = 0;
  });

  // Simulates the shadowing bug the where-clause fix addresses: a thread can
  // carry a null-issueId record (DMARC/auto-reply/own-outbound suppression)
  // alongside the real issueId record from the original inbound message. The
  // fake db can't run real SQL, so it decides what the thread-lookup query
  // (select call #2) returns based on whether `isNotNull` was actually
  // invoked while that query's where-clause was built — i.e. whether the
  // fix's filter is present, not a hardcoded "correct" answer.
  it("a null-issueId row in the thread does not shadow the real issueId row", async () => {
    const msg = makeMessage("reply-1", "thread-shadow-1", "Re: Interested in a pilot");
    mockListMessages.mockResolvedValue({ messages: [{ id: "reply-1" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([{ id: "lbl-t", name: "paperclip/triaged" }]);
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "should-not-be-created" });
    mockAddComment.mockResolvedValue({});

    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Message-level "already processed" dedup check — proceed.
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([]),
          };
        }
        if (selectCallCount === 2) {
          // Thread lookup under test.
          const isNotNullCountBeforeQuery = isNotNullCallCount.count;
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() =>
              Promise.resolve(
                isNotNullCallCount.count > isNotNullCountBeforeQuery
                  ? [{ issueId: "thread-real-issue-1" }]
                  : [{ issueId: null }],
              ),
            ),
          };
        }
        // Any further query (cross-thread sender+subj dedupe, agent lookup) — no match.
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as unknown as Db;

    const svc = createGmailIntakeService(db);
    const result = await svc.processMailbox(COMPANY_ID, "board");

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockAddComment).toHaveBeenCalledOnce();
    expect(mockAddComment).toHaveBeenCalledWith(
      "thread-real-issue-1",
      expect.any(String),
      {},
      expect.objectContaining({ authorType: "system" }),
    );
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });
});
