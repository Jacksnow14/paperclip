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
      attachments: { get: mockAttachmentsGet },
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
const { createGmailService, isSupportedGmailAlias, GMAIL_SUPPORTED_ALIASES } = await import(
  "../services/gmail.js"
);

const FAKE_SA_KEY = JSON.stringify({
  type: "service_account",
  client_email: "test-sa@project.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_id: "116336860548037885070",
});

describe("GMAIL_SUPPORTED_ALIASES", () => {
  it("includes the four tryauranode.com mailboxes", () => {
    expect(GMAIL_SUPPORTED_ALIASES).toContain("board");
    expect(GMAIL_SUPPORTED_ALIASES).toContain("alex");
    expect(GMAIL_SUPPORTED_ALIASES).toContain("leo");
    expect(GMAIL_SUPPORTED_ALIASES).toContain("adrian");
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

  describe("getAttachment", () => {
    it("calls gmail.users.messages.attachments.get with correct params", async () => {
      mockAttachmentsGet.mockResolvedValue({ data: { size: 1234, data: "base64urlpayload" } });
      const service = createGmailService();
      const result = await service.getAttachment("board", "msg1", "att1");

      expect(mockAttachmentsGet).toHaveBeenCalledWith({
        userId: "me",
        messageId: "msg1",
        id: "att1",
      });
      expect(result).toEqual({ size: 1234, data: "base64urlpayload" });
    });
  });

  describe("getMessage", () => {
    it("calls gmail.users.messages.get with full format", async () => {
      mockMessagesGet.mockResolvedValue({ data: { id: "msg1", threadId: "t1" } });
      const service = createGmailService();
      const result = await service.getMessage("leo", "msg1");

      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "full",
      });
      expect(result).toEqual({ id: "msg1", threadId: "t1" });
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
  });

  describe("listThreads", () => {
    it("calls gmail.users.threads.list", async () => {
      mockThreadsList.mockResolvedValue({ data: { threads: [] } });
      const service = createGmailService();
      await service.listThreads("adrian", { query: "label:inbox" });

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
