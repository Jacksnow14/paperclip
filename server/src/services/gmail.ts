import { google } from "googleapis";
import { logger } from "../middleware/logger.js";

const DOMAIN = "tryauranode.com";
export const GMAIL_SUPPORTED_ALIASES = ["board", "alex"] as const;
export type GmailAlias = (typeof GMAIL_SUPPORTED_ALIASES)[number];

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

export interface GmailSendOptions {
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
}

export interface GmailReplyOptions {
  replyToMessageId?: string;
  threadId?: string;
  body: string;
}

export interface GmailListOptions {
  query?: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GmailModifyLabelsOptions {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailVacationSettings {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyHtml?: string;
  startTimeIso?: string;
  endTimeIso?: string;
}

function resolveMailboxEmail(alias: GmailAlias): string {
  return `${alias}@${DOMAIN}`;
}

function loadServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_WORKSPACE_SA_KEY;
  if (!raw) {
    throw new Error("GOOGLE_WORKSPACE_SA_KEY is not configured");
  }
  let key: Record<string, string>;
  try {
    key = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("GOOGLE_WORKSPACE_SA_KEY is not valid JSON");
  }
  // Fail fast: systemd EnvironmentFile strips backslashes from unquoted values,
  // turning \n → n and breaking PEM parsing with a cryptic OpenSSL DECODER error.
  // Fix: single-quote the value in EnvironmentFile so systemd leaves it verbatim.
  const pk = key["private_key"] ?? "";
  if (!pk.startsWith("-----BEGIN") || !pk.includes("\n")) {
    throw new Error(
      "GOOGLE_WORKSPACE_SA_KEY private_key is malformed (missing PEM header or newlines). " +
        "Ensure the value is single-quoted in EnvironmentFile to prevent systemd backslash stripping.",
    );
  }
  return key;
}

function buildAuthClient(alias: GmailAlias) {
  const key = loadServiceAccountKey();
  return new google.auth.JWT({
    email: key["client_email"],
    key: key["private_key"],
    scopes: GMAIL_SCOPES,
    subject: resolveMailboxEmail(alias),
  });
}

function buildGmailClient(alias: GmailAlias) {
  return google.gmail({ version: "v1", auth: buildAuthClient(alias) });
}

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | null | undefined,
  name: string,
): string {
  return (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

interface BuildRawMessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

function buildRawMessage(opts: BuildRawMessageOptions): string {
  const isReply = Boolean(opts.inReplyTo);
  const subject =
    isReply && !/^re:/i.test(opts.subject.trim()) ? `Re: ${opts.subject}` : opts.subject;
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`, `Subject: ${subject}`];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", opts.body);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export function isSupportedGmailAlias(alias: string): alias is GmailAlias {
  return (GMAIL_SUPPORTED_ALIASES as readonly string[]).includes(alias);
}

export function createGmailService() {
  async function listMessages(alias: GmailAlias, opts?: GmailListOptions) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.messages.list({
      userId: "me",
      q: opts?.query,
      maxResults: opts?.maxResults ?? 20,
      pageToken: opts?.pageToken,
    });
    return res.data;
  }

  async function getMessage(alias: GmailAlias, messageId: string) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return res.data;
  }

  async function sendMessage(alias: GmailAlias, opts: GmailSendOptions) {
    const gmail = buildGmailClient(alias);
    const from = resolveMailboxEmail(alias);
    const requestBody: { raw: string; threadId?: string } = { raw: "" };
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (opts.replyToMessageId) {
      const original = await getMessage(alias, opts.replyToMessageId);
      if (original.threadId) requestBody.threadId = original.threadId;
      const originalMessageId = extractHeader(original.payload?.headers, "Message-ID");
      if (originalMessageId) {
        const originalReferences = extractHeader(original.payload?.headers, "References");
        inReplyTo = originalMessageId;
        references = originalReferences
          ? `${originalReferences} ${originalMessageId}`
          : originalMessageId;
      }
    }
    requestBody.raw = buildRawMessage({
      from,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      inReplyTo,
      references,
    });
    const res = await gmail.users.messages.send({ userId: "me", requestBody });
    logger.info({ alias, to: opts.to, messageId: res.data.id }, "gmail: message sent");
    return res.data;
  }

  async function replyInThread(alias: GmailAlias, opts: GmailReplyOptions) {
    if (!opts.replyToMessageId && !opts.threadId) {
      throw new Error("replyInThread requires replyToMessageId or threadId");
    }
    let targetMessageId = opts.replyToMessageId;
    if (!targetMessageId) {
      const thread = await getThread(alias, opts.threadId as string);
      const messages = thread.messages ?? [];
      const last = messages[messages.length - 1];
      if (!last?.id) throw new Error(`Thread ${opts.threadId} has no messages`);
      targetMessageId = last.id;
    }
    const original = await getMessage(alias, targetMessageId);
    const headers = original.payload?.headers;
    const subject = extractHeader(headers, "Subject") || "(no subject)";
    const replyTo = extractHeader(headers, "Reply-To") || extractHeader(headers, "From");
    if (!replyTo) {
      throw new Error(`Could not determine reply-to address for message ${targetMessageId}`);
    }
    return sendMessage(alias, {
      to: replyTo,
      subject,
      body: opts.body,
      replyToMessageId: targetMessageId,
    });
  }

  async function listThreads(alias: GmailAlias, opts?: GmailListOptions) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.threads.list({
      userId: "me",
      q: opts?.query,
      maxResults: opts?.maxResults ?? 20,
      pageToken: opts?.pageToken,
    });
    return res.data;
  }

  async function getThread(alias: GmailAlias, threadId: string) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    return res.data;
  }

  async function listLabels(alias: GmailAlias) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.labels.list({ userId: "me" });
    return res.data.labels ?? [];
  }

  async function createLabel(alias: GmailAlias, name: string) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return res.data;
  }

  async function modifyMessageLabels(alias: GmailAlias, messageId: string, opts: GmailModifyLabelsOptions) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: opts.addLabelIds,
        removeLabelIds: opts.removeLabelIds,
      },
    });
    return res.data;
  }

  async function getVacationSettings(alias: GmailAlias) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.settings.getVacation({ userId: "me" });
    return res.data;
  }

  async function updateVacationSettings(alias: GmailAlias, settings: GmailVacationSettings) {
    const gmail = buildGmailClient(alias);
    const res = await gmail.users.settings.updateVacation({
      userId: "me",
      requestBody: {
        enableAutoReply: settings.enableAutoReply,
        responseSubject: settings.responseSubject,
        responseBodyHtml: settings.responseBodyHtml,
        startTime: settings.startTimeIso
          ? String(new Date(settings.startTimeIso).getTime())
          : undefined,
        endTime: settings.endTimeIso
          ? String(new Date(settings.endTimeIso).getTime())
          : undefined,
      },
    });
    return res.data;
  }

  return {
    listMessages,
    getMessage,
    sendMessage,
    replyInThread,
    listThreads,
    getThread,
    listLabels,
    createLabel,
    modifyMessageLabels,
    getVacationSettings,
    updateVacationSettings,
  };
}

export type GmailService = ReturnType<typeof createGmailService>;
