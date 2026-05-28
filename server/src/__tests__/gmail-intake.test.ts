import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// Mock the Gmail service and issue service before importing intake
const mockListMessages = vi.fn();
const mockGetMessage = vi.fn();
const mockListLabels = vi.fn();
const mockCreateLabel = vi.fn();
const mockModifyMessageLabels = vi.fn();

vi.mock("../services/gmail.js", () => ({
  GMAIL_SUPPORTED_ALIASES: ["board", "alex", "leo", "adrian"],
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
function buildDbMock(
  overrides: {
    selectRows?: Record<string, unknown>[];
  } = {},
) {
  const selectRows = overrides.selectRows ?? [];
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
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
      title: expect.stringContaining("[board@tryauranode.com]"),
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
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        const rows = selectCallCount === 1
          ? []
          : [{ issueId: "issue-existing-1" }];
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
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
    expect(title).toContain("[board@tryauranode.com]");
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

describe("createGmailIntakeService.pollAllMailboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls all four mailboxes and returns per-mailbox results", async () => {
    mockListMessages.mockResolvedValue({ messages: [] });
    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(4);
    const mailboxes = results.map((r) => r.mailbox);
    expect(mailboxes).toContain("board");
    expect(mailboxes).toContain("alex");
    expect(mailboxes).toContain("leo");
    expect(mailboxes).toContain("adrian");
  });

  it("continues polling remaining mailboxes when one fails", async () => {
    mockListMessages
      .mockRejectedValueOnce(new Error("board failed"))
      .mockResolvedValue({ messages: [] });

    const db = buildDbMock();
    const svc = createGmailIntakeService(db);
    const results = await svc.pollAllMailboxes(COMPANY_ID);

    expect(results).toHaveLength(4);
    const boardResult = results.find((r) => r.mailbox === "board");
    expect(boardResult?.errors).toBe(1);
    const alexResult = results.find((r) => r.mailbox === "alex");
    expect(alexResult?.errors).toBe(0);
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
  ] as const)("%s mailbox resolves to %s agent role", async (mailbox, _role) => {
    const msg = makeMessage("msg-r", "thread-r");
    mockListMessages.mockResolvedValue({ messages: [{ id: "msg-r" }] });
    mockGetMessage.mockResolvedValue(msg);
    mockListLabels.mockResolvedValue([]);
    mockCreateLabel.mockResolvedValue({ id: "lbl-x" });
    mockModifyMessageLabels.mockResolvedValue({});
    mockIssueCreate.mockResolvedValue({ id: "issue-r" });

    // Simulate agent lookup returning an id
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        // First call: message-level dedup → no record
        // Second call: thread-level lookup → no record
        // Third call: agent role lookup → return an agent
        const rows = selectCallCount >= 3 ? [{ id: "agent-ceo-1" }] : [];
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
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
