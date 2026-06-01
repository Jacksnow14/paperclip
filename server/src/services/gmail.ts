import { google } from "googleapis";
import { logger } from "../middleware/logger.js";
import { assertNoUnresolvedPlaceholders } from "./outbound-render-guard.js";

const DOMAIN = "tryauranode.com";
export const GMAIL_SUPPORTED_ALIASES = ["board", "alex", "leo", "adrian"] as const;
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
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("GOOGLE_WORKSPACE_SA_KEY is not valid JSON");
  }
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

function buildRawMessage(from: string, to: string, subject: string, body: string): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
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
    assertNoUnresolvedPlaceholders(opts.subject, opts.body);
    const gmail = buildGmailClient(alias);
    const from = resolveMailboxEmail(alias);
    const raw = buildRawMessage(from, opts.to, opts.subject, opts.body);
    const requestBody: { raw: string; threadId?: string } = { raw };
    if (opts.replyToMessageId) {
      const original = await getMessage(alias, opts.replyToMessageId);
      if (original.threadId) requestBody.threadId = original.threadId;
    }
    const res = await gmail.users.messages.send({ userId: "me", requestBody });
    logger.info({ alias, to: opts.to, messageId: res.data.id }, "gmail: message sent");
    return res.data;
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
