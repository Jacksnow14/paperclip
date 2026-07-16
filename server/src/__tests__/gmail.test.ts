import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock googleapis before importing the service
const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();
const mockMessagesModify = vi.fn();
const mockAttachmentsGet = vi.fn();
const mockThreadsList = vi.fn();
const mockThreadsGet = vi.fn();
const mockLabelsList = vi.fn();
const mockSettingsGetVacation = vi.fn();
const mockSettingsUpdateVacation = vi.fn();

const mockGmailFactory = vi.fn(() => ({
  users: {
    messages: {
      list: mockMessagesList,
      get: mockMessagesGet,
      send: mockMessagesSend,
      modify: mockMessagesModify,
      attachments: {
        get: mockAttachmentsGet,
      },
    },
    threads: {
      list: mockThreadsList,
      get: mockThreadsGet,
    },
    labels: {
      list: mockLabelsList,
    },
    settings: {
      getVacation: mockSettingsGetVacation,
      updateVacation: mockSettingsUpdateVacation,
    },
  },
}));

const mockJWT = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: mockJWT },
    gmail: mockGmailFactory,
  },
}));

// Import after mock setup
const { createGmailService, decodeGmailMessageBody, isSupportedGmailAlias, GMAIL_SUPPORTED_ALIASES } =
  await import("../services/gmail.js");

const FAKE_SA_KEY = JSON.stringify({
  type: "service_account",
  client_email: "test-sa@project.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_id: "116336860548037885070",
});

describe("GMAIL_SUPPORTED_ALIASES", () => {
  it("includes only the alias-safe tryauranode.com mailboxes (board, alex)", () => {
    expect(GMAIL_SUPPORTED_ALIASES).toContain("board");
    expect(GMAIL_SUPPORTED_ALIASES).toContain("alex");
    // leo@/adrian@ became free aliases (AUR-3080/AUR-3079); aliases have no
    // mailbox, so DWD cannot impersonate them — they must not be polled.
    expect(GMAIL_SUPPORTED_ALIASES).not.toContain("leo");
    expect(GMAIL_SUPPORTED_ALIASES).not.toContain("adrian");
  });
});

describe("isSupportedGmailAlias", () => {
  it("accepts supported aliases", () => {
    expect(isSupportedGmailAlias("board")).toBe(true);
    expect(isSupportedGmailAlias("alex")).toBe(true);
  });

  it("rejects unknown aliases", () => {
    expect(isSupportedGmailAlias("noreply")).toBe(false);
    expect(isSupportedGmailAlias("")).toBe(false);
  });
});

describe("createGmailService", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GOOGLE_WORKSPACE_SA_KEY;
    process.env.GOOGLE_WORKSPACE_SA_KEY = FAKE_SA_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_WORKSPACE_SA_KEY;
    } else {
      process.env.GOOGLE_WORKSPACE_SA_KEY = originalEnv;
    }
  });

  describe("auth construction", () => {
    it("builds JWT with correct fields for impersonation", async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });
      const service = createGmailService();
      await service.listMessages("board");

      expect(mockJWT).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "test-sa@project.iam.gserviceaccount.com",
          subject: "board@tryauranode.com",
          scopes: expect.arrayContaining([
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.settings.basic",
          ]),
        }),
      );
    });

    it("impersonates the correct mailbox per alias", async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });
      const service = createGmailService();
      await service.listMessages("alex");

      expect(mockJWT).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "alex@tryauranode.com" }),
      );
    });

    it("throws when GOOGLE_WORKSPACE_SA_KEY is not set", async () => {
      delete process.env.GOOGLE_WORKSPACE_SA_KEY;
      const service = createGmailService();
      await expect(service.listMessages("board")).rejects.toThrow(
        "GOOGLE_WORKSPACE_SA_KEY is not configured",
      );
    });

    it("throws when GOOGLE_WORKSPACE_SA_KEY is not valid JSON", async () => {
      process.env.GOOGLE_WORKSPACE_SA_KEY = "not-json";
      const service = createGmailService();
      await expect(service.listMessages("board")).rejects.toThrow(
        "GOOGLE_WORKSPACE_SA_KEY is not valid JSON",
      );
    });

    it("throws when private_key has literal n instead of newlines (systemd backslash stripping)", async () => {
      // Simulate what systemd does to an unquoted EnvironmentFile value:
      // strips backslashes, so \n becomes n in the JSON string.
      const strippedKey = JSON.stringify({
        type: "service_account",
        client_email: "test-sa@project.iam.gserviceaccount.com",
        private_key: "-----BEGIN RSA PRIVATE KEY-----nfaken-----END RSA PRIVATE KEY-----n",
        client_id: "116336860548037885070",
      });
      process.env.GOOGLE_WORKSPACE_SA_KEY = strippedKey;
      const service = createGmailService();
      await expect(service.listMessages("board")).rejects.toThrow(
        "GOOGLE_WORKSPACE_SA_KEY private_key is malformed",
      );
    });
  });

  describe("listMessages", () => {
    it("calls gmail.users.messages.list with correct params", async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [{ id: "abc" }] } });
      const service = createGmailService();
      const result = await service.listMessages("board", { query: "is:unread", maxResults: 5 });

      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: "is:unread",
        maxResults: 5,
        pageToken: undefined,
      });
      expect(result).toEqual({ messages: [{ id: "abc" }] });
    });

    it("defaults maxResults to 20", async () => {
      mockMessagesList.mockResolvedValue({ data: {} });
      const service = createGmailService();
      await service.listMessages("board");

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 20 }),
      );
    });
  });

  describe("getMessage", () => {
    it("calls gmail.users.messages.get with full format", async () => {
      mockMessagesGet.mockResolvedValue({ data: { id: "msg1", threadId: "t1" } });
      const service = createGmailService();
      const result = await service.getMessage("alex", "msg1");

      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "full",
      });
      expect(result).toEqual({ id: "msg1", threadId: "t1" });
    });
  });

  describe("getAttachment", () => {
    it("calls gmail.users.messages.attachments.get and returns data + dataBase64", async () => {
      const base64url = Buffer.from("hello attachment").toString("base64url");
      mockAttachmentsGet.mockResolvedValue({ data: { size: 17, data: base64url } });
      const service = createGmailService();
      const result = await service.getAttachment("board", "msg1", "att1");

      expect(mockAttachmentsGet).toHaveBeenCalledWith({
        userId: "me",
        messageId: "msg1",
        id: "att1",
      });
      expect(result.attachmentId).toBe("att1");
      expect(result.size).toBe(17);
      expect(result.data).toBe(base64url);
      expect(Buffer.from(result.dataBase64, "base64").toString("utf-8")).toBe("hello attachment");
    });

    it("returns empty strings when the response has no data", async () => {
      mockAttachmentsGet.mockResolvedValue({ data: {} });
      const service = createGmailService();
      const result = await service.getAttachment("board", "msg1", "att1");

      expect(result.data).toBe("");
      expect(result.dataBase64).toBe("");
      expect(result.size).toBe(0);
    });
  });

  describe("sendMessage", () => {
    it("sends with base64url-encoded raw message", async () => {
      mockMessagesSend.mockResolvedValue({ data: { id: "sent1" } });
      const service = createGmailService();
      const result = await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Hello",
        body: "World",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      expect(callArgs.userId).toBe("me");
      const raw = callArgs.requestBody.raw as string;
      const decoded = Buffer.from(raw, "base64url").toString("utf-8");
      expect(decoded).toContain("From: board@tryauranode.com");
      expect(decoded).toContain("To: user@example.com");
      expect(decoded).toContain("Subject: Hello");
      expect(decoded).toContain("World");
      expect(result).toEqual({ id: "sent1" });
    });

    it("threads the reply when replyToMessageId is given", async () => {
      mockMessagesGet.mockResolvedValue({ data: { id: "orig", threadId: "thread42" } });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Re: Hello",
        body: "Replying",
        replyToMessageId: "orig",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      expect(callArgs.requestBody.threadId).toBe("thread42");
    });

    it("sets In-Reply-To/References headers and prefixes subject with Re: when replying", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "orig",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig-msg-id@mail.gmail.com>" },
              { name: "References", value: "<earlier@mail.gmail.com>" },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Hello",
        body: "Replying",
        replyToMessageId: "orig",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("In-Reply-To: <orig-msg-id@mail.gmail.com>");
      expect(decoded).toContain("References: <earlier@mail.gmail.com> <orig-msg-id@mail.gmail.com>");
      expect(decoded).toContain("Subject: Re: Hello");
    });

    it("does not double-prefix Re: when the subject already has it", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "orig",
          threadId: "thread42",
          payload: {
            headers: [{ name: "Message-ID", value: "<orig-msg-id@mail.gmail.com>" }],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Re: Hello",
        body: "Replying",
        replyToMessageId: "orig",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("Subject: Re: Hello");
      expect(decoded).not.toContain("Subject: Re: Re: Hello");
    });

    it("uses the original Message-ID alone as References when the original has none", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "orig",
          threadId: "thread42",
          payload: {
            headers: [{ name: "Message-ID", value: "<orig-msg-id@mail.gmail.com>" }],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Hello",
        body: "Replying",
        replyToMessageId: "orig",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("References: <orig-msg-id@mail.gmail.com>");
    });

    it("includes Cc and Reply-To headers when provided", async () => {
      mockMessagesSend.mockResolvedValue({ data: { id: "sent1" } });
      const service = createGmailService();
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Hello",
        body: "World",
        cc: ["cc1@example.com", "cc2@example.com"],
        replyTo: "replies@example.com",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("Cc: cc1@example.com, cc2@example.com");
      expect(decoded).toContain("Reply-To: replies@example.com");
    });

    it("builds a multipart/mixed message with an attachment part", async () => {
      mockMessagesSend.mockResolvedValue({ data: { id: "sent1" } });
      const service = createGmailService();
      const contentBase64 = Buffer.from("file contents").toString("base64");
      await service.sendMessage("board", {
        to: "user@example.com",
        subject: "Hello",
        body: "See attached",
        attachments: [{ filename: "note.txt", mimeType: "text/plain", contentBase64 }],
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("Content-Type: multipart/mixed; boundary=");
      expect(decoded).toContain("Content-Disposition: attachment; filename=\"note.txt\"");
      expect(decoded).toContain("Content-Transfer-Encoding: base64");
      expect(decoded).toContain(contentBase64);
      expect(decoded).toContain("See attached");
    });

    it("rejects an attachment over the size cap with a 400", async () => {
      const service = createGmailService();
      const oversized = "a".repeat(34_000_001);
      await expect(
        service.sendMessage("board", {
          to: "user@example.com",
          subject: "Hello",
          body: "World",
          attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", contentBase64: oversized }],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("allows an ordinary send with no gated signals", async () => {
      mockMessagesSend.mockResolvedValue({ data: { id: "sent1" } });
      const service = createGmailService();
      await expect(
        service.sendMessage("board", { to: "customer@example.com", subject: "Hi", body: "Hi" }),
      ).resolves.toEqual({ id: "sent1" });
    });

    it("blocks a gated outbound (fraud report) at the service chokepoint without an approval", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", {
          to: "report@bunq.com",
          subject: "Fraud report",
          body: "We are reporting an account takeover.",
        }),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("allows a gated outbound when the caller has a verified approval scoped to this send", async () => {
      mockMessagesSend.mockResolvedValue({ data: { id: "sent1" } });
      const service = createGmailService();
      await expect(
        service.sendMessage(
          "board",
          {
            to: "report@bunq.com",
            subject: "Fraud report",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true, approvalScope: { mailbox: "board", to: "report@bunq.com" } },
        ),
      ).resolves.toEqual({ id: "sent1" });
      expect(mockMessagesSend).toHaveBeenCalledOnce();
    });

    // AUR-3628: approvalVerified alone (no matching scope, or a scope for a
    // different mailbox/recipient) must NOT satisfy the gate — otherwise any
    // approved approval in the company could be replayed against any send.
    it("blocks a gated outbound when approvalVerified is true but the approval has no scope", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage(
          "board",
          {
            to: "report@bunq.com",
            subject: "Fraud report",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true },
        ),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("blocks a gated outbound when the approval's scope targets a different recipient", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage(
          "board",
          {
            to: "report@bunq.com",
            subject: "Fraud report",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true, approvalScope: { mailbox: "board", to: "someone-else@example.com" } },
        ),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("blocks a gated outbound when the approval's scope targets a different mailbox", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage(
          "board",
          {
            to: "report@bunq.com",
            subject: "Fraud report",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true, approvalScope: { mailbox: "alex", to: "report@bunq.com" } },
        ),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("rejects a `to` address containing CR/LF with a 400 (header injection defense-in-depth)", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", { to: "user@example.com\r\nBcc: evil@example.com", subject: "Hi", body: "Hi" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("rejects a subject containing CR/LF with a 400", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", {
          to: "user@example.com",
          subject: "Hi\r\nBcc: evil@example.com",
          body: "Hi",
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("rejects a replyTo address containing CR/LF with a 400", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", {
          to: "user@example.com",
          subject: "Hi",
          body: "Hi",
          replyTo: "user@example.com\r\nBcc: evil@example.com",
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("rejects a cc address containing CR/LF with a 400", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", {
          to: "user@example.com",
          subject: "Hi",
          body: "Hi",
          cc: "cc@example.com\r\nBcc: evil@example.com",
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("rejects an attachment filename containing CR/LF with a 400", async () => {
      const service = createGmailService();
      const contentBase64 = Buffer.from("data").toString("base64");
      await expect(
        service.sendMessage("board", {
          to: "user@example.com",
          subject: "Hi",
          body: "Hi",
          attachments: [
            { filename: "a.txt\r\nContent-Type: text/html", mimeType: "text/plain", contentBase64 },
          ],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("blocks a gated cc recipient even when the primary `to` is benign", async () => {
      const service = createGmailService();
      await expect(
        service.sendMessage("board", {
          to: "customer@example.com",
          cc: "legal@shopify.com",
          subject: "FYI",
          body: "See attached.",
        }),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });
  });

  describe("replyInThread", () => {
    it("resolves the given message, replies to its sender, and threads the reply", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig-msg-id@mail.gmail.com>" },
              { name: "Subject", value: "Question about pricing" },
              { name: "From", value: "Jane Customer <jane@example.com>" },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1", threadId: "thread42" } });
      const service = createGmailService();
      const result = await service.replyInThread("board", {
        replyToMessageId: "msg1",
        body: "Thanks for reaching out!",
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      expect(callArgs.requestBody.threadId).toBe("thread42");
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("To: Jane Customer <jane@example.com>");
      expect(decoded).toContain("Subject: Re: Question about pricing");
      expect(decoded).toContain("In-Reply-To: <orig-msg-id@mail.gmail.com>");
      expect(result).toEqual({ id: "reply1", threadId: "thread42" });
    });

    it("resolves the latest message of a thread when threadId is given", async () => {
      mockThreadsGet.mockResolvedValue({
        data: {
          id: "thread42",
          messages: [
            { id: "msg1", threadId: "thread42" },
            { id: "msg2", threadId: "thread42" },
          ],
        },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg2",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Message-ID", value: "<msg2@mail.gmail.com>" },
              { name: "Subject", value: "Question about pricing" },
              { name: "From", value: "jane@example.com" },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.replyInThread("board", { threadId: "thread42", body: "Following up" });

      expect(mockMessagesGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg2" }),
      );
    });

    it("prefers Reply-To over From when present", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig@mail.gmail.com>" },
              { name: "Subject", value: "Hi" },
              { name: "From", value: "noreply@example.com" },
              { name: "Reply-To", value: "support@example.com" },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await service.replyInThread("board", { replyToMessageId: "msg1", body: "Reply" });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("To: support@example.com");
    });

    it("throws when neither replyToMessageId nor threadId is given", async () => {
      const service = createGmailService();
      await expect(
        service.replyInThread("board", { body: "Reply" } as never),
      ).rejects.toThrow("replyInThread requires replyToMessageId or threadId");
    });

    it("threads cc, replyTo, and attachments through to sendMessage", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig@mail.gmail.com>" },
              { name: "Subject", value: "Hi" },
              { name: "From", value: "jane@example.com" },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      const contentBase64 = Buffer.from("attachment").toString("base64");
      await service.replyInThread("board", {
        replyToMessageId: "msg1",
        body: "Reply body",
        cc: "cc@example.com",
        replyTo: "replies@example.com",
        attachments: [{ filename: "a.txt", mimeType: "text/plain", contentBase64 }],
      });

      const callArgs = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(callArgs.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("Cc: cc@example.com");
      expect(decoded).toContain("Reply-To: replies@example.com");
      expect(decoded).toContain("Content-Disposition: attachment; filename=\"a.txt\"");
    });

    it("threads the outbound guard context through to sendMessage — blocks a gated reply without approval", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "report@bunq.com" }],
          },
        },
      });
      const service = createGmailService();
      await expect(
        service.replyInThread("board", {
          replyToMessageId: "msg1",
          body: "We are reporting an account takeover.",
        }),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it("allows a gated reply when the approval's scope matches the resolved mailbox/recipient", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "report@bunq.com" }],
          },
        },
      });
      mockMessagesSend.mockResolvedValue({ data: { id: "reply1" } });
      const service = createGmailService();
      await expect(
        service.replyInThread(
          "board",
          {
            replyToMessageId: "msg1",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true, approvalScope: { mailbox: "board", to: "report@bunq.com" } },
        ),
      ).resolves.toEqual({ id: "reply1" });
      expect(mockMessagesSend).toHaveBeenCalledOnce();
    });

    it("blocks a gated reply when approvalVerified is true but the scope targets a different recipient", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg1",
          threadId: "thread42",
          payload: {
            headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "report@bunq.com" }],
          },
        },
      });
      const service = createGmailService();
      await expect(
        service.replyInThread(
          "board",
          {
            replyToMessageId: "msg1",
            body: "We are reporting an account takeover.",
          },
          { approvalVerified: true, approvalScope: { mailbox: "board", to: "other@example.com" } },
        ),
      ).rejects.toMatchObject({ name: "GmailOutboundBlockedError" });
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });
  });

  describe("listThreads", () => {
    it("calls gmail.users.threads.list", async () => {
      mockThreadsList.mockResolvedValue({ data: { threads: [] } });
      const service = createGmailService();
      await service.listThreads("alex", { query: "label:inbox" });

      expect(mockThreadsList).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "me", q: "label:inbox" }),
      );
    });
  });

  describe("getThread", () => {
    it("calls gmail.users.threads.get with full format", async () => {
      mockThreadsGet.mockResolvedValue({ data: { id: "t1", messages: [] } });
      const service = createGmailService();
      const result = await service.getThread("alex", "t1");

      expect(mockThreadsGet).toHaveBeenCalledWith({ userId: "me", id: "t1", format: "full" });
      expect(result).toEqual({ id: "t1", messages: [] });
    });
  });

  describe("listLabels", () => {
    it("returns labels array", async () => {
      mockLabelsList.mockResolvedValue({ data: { labels: [{ id: "INBOX", name: "INBOX" }] } });
      const service = createGmailService();
      const result = await service.listLabels("board");

      expect(result).toEqual([{ id: "INBOX", name: "INBOX" }]);
    });

    it("returns empty array when no labels in response", async () => {
      mockLabelsList.mockResolvedValue({ data: {} });
      const service = createGmailService();
      const result = await service.listLabels("board");
      expect(result).toEqual([]);
    });
  });

  describe("modifyMessageLabels", () => {
    it("calls gmail.users.messages.modify with label changes", async () => {
      mockMessagesModify.mockResolvedValue({ data: { id: "msg1" } });
      const service = createGmailService();
      await service.modifyMessageLabels("board", "msg1", {
        addLabelIds: ["STARRED"],
        removeLabelIds: ["INBOX"],
      });

      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        requestBody: { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX"] },
      });
    });
  });

  describe("getVacationSettings", () => {
    it("calls gmail.users.settings.getVacation", async () => {
      mockSettingsGetVacation.mockResolvedValue({ data: { enableAutoReply: false } });
      const service = createGmailService();
      const result = await service.getVacationSettings("board");

      expect(mockSettingsGetVacation).toHaveBeenCalledWith({ userId: "me" });
      expect(result).toEqual({ enableAutoReply: false });
    });
  });

  describe("retry/backoff on transient failures", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a transient network error and succeeds once the call recovers", async () => {
      vi.useFakeTimers();
      const transientErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      mockMessagesList
        .mockRejectedValueOnce(transientErr)
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValueOnce({ data: { messages: [{ id: "abc" }] } });
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(mockMessagesList).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ messages: [{ id: "abc" }] });
    });

    it("retries on a 429 and on a 5xx response", async () => {
      vi.useFakeTimers();
      const rateLimitErr = Object.assign(new Error("rate limited"), { code: 429 });
      const serverErr = Object.assign(new Error("backend error"), {
        response: { status: 503 },
      });
      mockMessagesList
        .mockRejectedValueOnce(rateLimitErr)
        .mockRejectedValueOnce(serverErr)
        .mockResolvedValueOnce({ data: { messages: [] } });
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(mockMessagesList).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ messages: [] });
    });

    it("gives up after the max attempts on a persistent transient error", async () => {
      vi.useFakeTimers();
      const transientErr = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      mockMessagesList.mockRejectedValue(transientErr);
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      resultPromise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow("timed out");
      expect(mockMessagesList).toHaveBeenCalledTimes(3);
    });

    it("does not retry a 4xx auth/config error", async () => {
      const authErr = Object.assign(new Error("invalid_grant"), { code: 400 });
      mockMessagesList.mockRejectedValue(authErr);
      const service = createGmailService();

      await expect(service.listMessages("board")).rejects.toThrow("invalid_grant");
      expect(mockMessagesList).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 403 permission error", async () => {
      const forbiddenErr = Object.assign(new Error("insufficient permission"), {
        response: { status: 403 },
      });
      mockMessagesList.mockRejectedValue(forbiddenErr);
      const service = createGmailService();

      await expect(service.listMessages("board")).rejects.toThrow("insufficient permission");
      expect(mockMessagesList).toHaveBeenCalledTimes(1);
    });
  });

  describe("structured error mapping", () => {
    it("maps an upstream 404 to a 404 HttpError instead of an opaque 500", async () => {
      const notFoundErr = Object.assign(new Error("Requested entity was not found."), {
        response: { status: 404 },
      });
      mockMessagesGet.mockRejectedValue(notFoundErr);
      const service = createGmailService();

      await expect(service.getMessage("board", "missing-id")).rejects.toMatchObject({
        status: 404,
      });
      expect(mockMessagesGet).toHaveBeenCalledTimes(1);
    });

    it("maps an upstream 500 to a 502 HttpError after retries are exhausted", async () => {
      vi.useFakeTimers();
      const serverErr = Object.assign(new Error("backend error"), {
        response: { status: 500 },
      });
      mockMessagesList.mockRejectedValue(serverErr);
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      resultPromise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toMatchObject({ status: 502 });
      expect(mockMessagesList).toHaveBeenCalledTimes(3);
    });

    it("maps a persistent ENOTFOUND (DNS failure) to a 502 HttpError", async () => {
      vi.useFakeTimers();
      const dnsErr = Object.assign(new Error("getaddrinfo ENOTFOUND gmail.googleapis.com"), {
        code: "ENOTFOUND",
      });
      mockMessagesList.mockRejectedValue(dnsErr);
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      resultPromise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toMatchObject({ status: 502 });
      expect(mockMessagesList).toHaveBeenCalledTimes(3);
    });

    it("maps a persistent 429 to a 429 HttpError", async () => {
      vi.useFakeTimers();
      const rateLimitErr = Object.assign(new Error("rate limited"), { code: 429 });
      mockMessagesList.mockRejectedValue(rateLimitErr);
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      resultPromise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toMatchObject({ status: 429 });
      expect(mockMessagesList).toHaveBeenCalledTimes(3);
    });

    it("recovers via retry on a transient-then-success sequence without mapping an error", async () => {
      vi.useFakeTimers();
      const transientErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      mockMessagesList
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValueOnce({ data: { messages: [{ id: "recovered" }] } });
      const service = createGmailService();

      const resultPromise = service.listMessages("board");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ messages: [{ id: "recovered" }] });
      expect(mockMessagesList).toHaveBeenCalledTimes(2);
    });

    it("does not remap a 4xx auth/config error (leaves 400/422 paths unaffected)", async () => {
      const authErr = Object.assign(new Error("invalid_grant"), { code: 400 });
      mockMessagesList.mockRejectedValue(authErr);
      const service = createGmailService();

      await expect(service.listMessages("board")).rejects.toBe(authErr);
    });
  });

  describe("updateVacationSettings", () => {
    it("calls gmail.users.settings.updateVacation with correct payload", async () => {
      mockSettingsUpdateVacation.mockResolvedValue({ data: { enableAutoReply: true } });
      const service = createGmailService();
      await service.updateVacationSettings("board", {
        enableAutoReply: true,
        responseSubject: "OOO",
        responseBodyHtml: "<p>Away</p>",
      });

      const callArgs = mockSettingsUpdateVacation.mock.calls[0][0];
      expect(callArgs.userId).toBe("me");
      expect(callArgs.requestBody.enableAutoReply).toBe(true);
      expect(callArgs.requestBody.responseSubject).toBe("OOO");
      expect(callArgs.requestBody.responseBodyHtml).toBe("<p>Away</p>");
    });

    it("converts ISO datetime to epoch ms string for startTime/endTime", async () => {
      mockSettingsUpdateVacation.mockResolvedValue({ data: {} });
      const service = createGmailService();
      await service.updateVacationSettings("board", {
        startTimeIso: "2026-06-01T00:00:00.000Z",
        endTimeIso: "2026-06-07T00:00:00.000Z",
      });

      const callArgs = mockSettingsUpdateVacation.mock.calls[0][0];
      expect(callArgs.requestBody.startTime).toBe(
        String(new Date("2026-06-01T00:00:00.000Z").getTime()),
      );
      expect(callArgs.requestBody.endTime).toBe(
        String(new Date("2026-06-07T00:00:00.000Z").getTime()),
      );
    });
  });
});

describe("decodeGmailMessageBody", () => {
  function toBase64Url(text: string): string {
    return Buffer.from(text, "utf-8").toString("base64url");
  }

  it("decodes a flat text/plain body", () => {
    const result = decodeGmailMessageBody({
      mimeType: "text/plain",
      body: { data: toBase64Url("Hello, full body.") },
    });

    expect(result.bodyText).toBe("Hello, full body.");
    expect(result.bodyHtml).toBeNull();
  });

  it("finds text/plain and text/html leaves inside a nested multipart/alternative tree", () => {
    const result = decodeGmailMessageBody({
      mimeType: "multipart/mixed",
      body: {},
      parts: [
        {
          mimeType: "multipart/alternative",
          body: {},
          parts: [
            { mimeType: "text/plain", body: { data: toBase64Url("Plain version") } },
            { mimeType: "text/html", body: { data: toBase64Url("<p>HTML version</p>") } },
          ],
        },
      ],
    });

    expect(result.bodyText).toBe("Plain version");
    expect(result.bodyHtml).toBe("<p>HTML version</p>");
  });

  it("returns nulls when no text/plain or text/html part is present", () => {
    const result = decodeGmailMessageBody({
      mimeType: "multipart/mixed",
      body: {},
      parts: [{ mimeType: "image/png", body: { data: toBase64Url("binary") } }],
    });

    expect(result.bodyText).toBeNull();
    expect(result.bodyHtml).toBeNull();
  });

  it("handles a missing payload without throwing", () => {
    expect(decodeGmailMessageBody(undefined)).toEqual({ bodyText: null, bodyHtml: null });
    expect(decodeGmailMessageBody(null)).toEqual({ bodyText: null, bodyHtml: null });
  });
});
