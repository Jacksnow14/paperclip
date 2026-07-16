import { google } from "googleapis";
import { logger } from "../middleware/logger.js";
import { badRequest } from "../errors.js";
import { classifyGmailOutbound, GmailOutboundBlockedError } from "./gmail-outbound-guard.js";

const DOMAIN = "tryauranode.com";
export const GMAIL_SUPPORTED_ALIASES = ["board", "alex"] as const;
export type GmailAlias = (typeof GMAIL_SUPPORTED_ALIASES)[number];

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

// Retries transient network/5xx/429 failures on outbound Google API calls
// (DNS hiccups, resets, rate limiting). Never retries 4xx auth/config errors
// (bad key, missing scope, invalid request) since retrying those just wastes
// attempts on a failure that will not change.
function isTransientGoogleApiError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;
  }
  const status = getHttpStatus(err);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= RETRY_MAX_ATTEMPTS || !isTransientGoogleApiError(err)) {
        throw err;
      }
      const backoffMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
      const jitteredMs = backoffMs + Math.random() * backoffMs * 0.5;
      logger.warn(
        { operation, attempt, maxAttempts: RETRY_MAX_ATTEMPTS, err },
        "gmail: retrying transient failure",
      );
      await sleep(jitteredMs);
    }
  }
  throw lastError;
}

// Base64 inflates payload size ~4/3; 25MB decoded ~= 33.4MB encoded.
const MAX_ATTACHMENT_BASE64_BYTES = 34_000_000;

function normalizeRecipients(...groups: Array<string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    const arr = Array.isArray(group) ? group : [group];
    for (const entry of arr) {
      for (const addr of entry.split(",")) {
        const trimmed = addr.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out;
}

/**
 * Guard context threaded through the service-layer chokepoint. The ONLY way a
 * gated outbound (fraud/abuse/legal/chargeback/law-enforcement/blocklisted-
 * domain — see gmail-outbound-guard.ts) is allowed through `sendMessage` is
 * when a caller that has already verified an explicit CEO board approval
 * passes `approvalVerified: true` (see routes/gmail.ts).
 *
 * AUR-2525/AUR-2682/AUR-3523: classification lives in sendMessage() itself —
 * not just the HTTP route — so any in-repo caller (intake auto-replies,
 * replyInThread, future scripts) is gated regardless of code path.
 */
export interface GmailSendGuardContext {
  approvalVerified?: boolean;
}

export interface GmailAttachmentInput {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface GmailSendOptions {
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
  cc?: string | string[];
  replyTo?: string;
  attachments?: GmailAttachmentInput[];
}

export interface GmailReplyOptions {
  replyToMessageId?: string;
  threadId?: string;
  body: string;
  cc?: string | string[];
  replyTo?: string;
  attachments?: GmailAttachmentInput[];
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
  cc?: string | string[];
  replyTo?: string;
  attachments?: GmailAttachmentInput[];
}

function wrapBase64(data: string): string {
  return data.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function buildMimeBoundary(): string {
  return `paperclip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function buildRawMessage(opts: BuildRawMessageOptions): string {
  const isReply = Boolean(opts.inReplyTo);
  const subject =
    isReply && !/^re:/i.test(opts.subject.trim()) ? `Re: ${opts.subject}` : opts.subject;
  const cc = normalizeRecipients(opts.cc).join(", ");

  const headers = [`From: ${opts.from}`, `To: ${opts.to}`];
  if (cc) headers.push(`Cc: ${cc}`);
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  headers.push(`Subject: ${subject}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push("MIME-Version: 1.0");

  const attachments = opts.attachments ?? [];
  if (attachments.length === 0) {
    headers.push("Content-Type: text/plain; charset=utf-8", "", opts.body);
    return Buffer.from(headers.join("\r\n")).toString("base64url");
  }

  const boundary = buildMimeBoundary();
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");

  const parts: string[] = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    "",
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(attachment.contentBase64),
      "",
    );
  }
  parts.push(`--${boundary}--`);

  return Buffer.from([...headers, ...parts].join("\r\n")).toString("base64url");
}

export function isSupportedGmailAlias(alias: string): alias is GmailAlias {
  return (GMAIL_SUPPORTED_ALIASES as readonly string[]).includes(alias);
}

export function createGmailService() {
  async function listMessages(alias: GmailAlias, opts?: GmailListOptions) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("messages.list", () =>
      gmail.users.messages.list({
        userId: "me",
        q: opts?.query,
        maxResults: opts?.maxResults ?? 20,
        pageToken: opts?.pageToken,
      }),
    );
    return res.data;
  }

  async function getMessage(alias: GmailAlias, messageId: string) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("messages.get", () =>
      gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }),
    );
    return res.data;
  }

  async function getAttachment(alias: GmailAlias, messageId: string, attachmentId: string) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("messages.attachments.get", () =>
      gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      }),
    );
    const data = res.data.data ?? "";
    return {
      attachmentId,
      size: res.data.size ?? 0,
      data,
      dataBase64: data ? Buffer.from(data, "base64url").toString("base64") : "",
    };
  }

  async function sendMessage(
    alias: GmailAlias,
    opts: GmailSendOptions,
    guard?: GmailSendGuardContext,
  ) {
    for (const attachment of opts.attachments ?? []) {
      if (attachment.contentBase64.length > MAX_ATTACHMENT_BASE64_BYTES) {
        throw badRequest(
          `Attachment ${attachment.filename} exceeds the 25MB size limit`,
        );
      }
    }

    // AUR-2682 service-layer chokepoint: classify EVERY outbound, regardless
    // of which code path called us (direct send, replyInThread, future
    // callers). Gated categories are hard-blocked unless the caller has
    // already verified an explicit CEO board approval.
    const decision = classifyGmailOutbound({
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
      cc: opts.cc,
    });
    if (decision.gated && !guard?.approvalVerified) {
      logger.error(
        { alias, to: opts.to, category: decision.category, reasons: decision.reasons },
        "gmail-guard: BLOCKED gated outbound at service chokepoint (AUR-2525/AUR-2682)",
      );
      throw new GmailOutboundBlockedError(decision);
    }

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
      cc: opts.cc,
      replyTo: opts.replyTo,
      attachments: opts.attachments,
    });
    const res = await withRetry("messages.send", () =>
      gmail.users.messages.send({ userId: "me", requestBody }),
    );
    logger.info(
      { alias, to: opts.to, cc: opts.cc, subject: opts.subject, messageId: res.data.id },
      "gmail: message sent",
    );
    return res.data;
  }

  async function replyInThread(
    alias: GmailAlias,
    opts: GmailReplyOptions,
    guard?: GmailSendGuardContext,
  ) {
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
    return sendMessage(
      alias,
      {
        to: replyTo,
        subject,
        body: opts.body,
        replyToMessageId: targetMessageId,
        cc: opts.cc,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
      },
      guard,
    );
  }

  async function listThreads(alias: GmailAlias, opts?: GmailListOptions) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("threads.list", () =>
      gmail.users.threads.list({
        userId: "me",
        q: opts?.query,
        maxResults: opts?.maxResults ?? 20,
        pageToken: opts?.pageToken,
      }),
    );
    return res.data;
  }

  async function getThread(alias: GmailAlias, threadId: string) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("threads.get", () =>
      gmail.users.threads.get({ userId: "me", id: threadId, format: "full" }),
    );
    return res.data;
  }

  async function listLabels(alias: GmailAlias) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("labels.list", () => gmail.users.labels.list({ userId: "me" }));
    return res.data.labels ?? [];
  }

  async function createLabel(alias: GmailAlias, name: string) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("labels.create", () =>
      gmail.users.labels.create({
        userId: "me",
        requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      }),
    );
    return res.data;
  }

  async function modifyMessageLabels(alias: GmailAlias, messageId: string, opts: GmailModifyLabelsOptions) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("messages.modify", () =>
      gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: opts.addLabelIds,
          removeLabelIds: opts.removeLabelIds,
        },
      }),
    );
    return res.data;
  }

  async function getVacationSettings(alias: GmailAlias) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("settings.getVacation", () =>
      gmail.users.settings.getVacation({ userId: "me" }),
    );
    return res.data;
  }

  async function updateVacationSettings(alias: GmailAlias, settings: GmailVacationSettings) {
    const gmail = buildGmailClient(alias);
    const res = await withRetry("settings.updateVacation", () =>
      gmail.users.settings.updateVacation({
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
      }),
    );
    return res.data;
  }

  return {
    listMessages,
    getMessage,
    getAttachment,
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
