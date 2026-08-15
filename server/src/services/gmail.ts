import { google } from "googleapis";
import type { Db } from "@paperclipai/db";
import { gmailOutboundRecords } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { HttpError, badRequest, notFound, tooManyRequests, badGateway, gatewayTimeout } from "../errors.js";
import { classifyGmailOutbound, GmailOutboundBlockedError } from "./gmail-outbound-guard.js";
import { checkProspectSendability, GmailProspectSuppressedError } from "./gmail-prospect-guard.js";
import {
  assertIntendedRecipient,
  assertProspectingRecipient,
  normalizeAddress,
} from "./outbound-recipient-shape.js";
import { loadServiceAccountKey } from "./google-service-account.js";

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

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Maps a thrown googleapis/Gaxios error (after retries are exhausted, or for
// non-transient failures) to a structured HttpError so routes never leak an
// opaque 500 for upstream Google failures. Errors that aren't recognized
// upstream failures (e.g. 4xx auth/validation) pass through unchanged so
// existing 400/422 paths are unaffected.
function mapGoogleApiError(operation: string, err: unknown): unknown {
  if (err instanceof HttpError) return err;
  const status = getHttpStatus(err);
  const errorCode = getErrorCode(err);
  const upstreamMessage = getErrorMessage(err);
  const details = { operation, upstreamMessage };

  if (status === 404) {
    return notFound(`Gmail API upstream error (${operation}): ${upstreamMessage}`);
  }
  if (status === 429) {
    return tooManyRequests(`Gmail API rate limited (${operation}): ${upstreamMessage}`, details);
  }
  if (errorCode === "ETIMEDOUT") {
    return gatewayTimeout(`Gmail API upstream timeout (${operation}): ${upstreamMessage}`, details);
  }
  if (
    (errorCode && TRANSIENT_NETWORK_ERROR_CODES.has(errorCode)) ||
    (status !== undefined && status >= 500 && status < 600)
  ) {
    return badGateway(`Gmail API upstream error (${operation}): ${upstreamMessage}`, details);
  }
  return err;
}

async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= RETRY_MAX_ATTEMPTS || !isTransientGoogleApiError(err)) {
        throw mapGoogleApiError(operation, err);
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
  throw mapGoogleApiError(operation, lastError);
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
 * passes `approvalVerified: true` AND an `approvalScope` that matches this
 * specific send (see routes/gmail.ts).
 *
 * AUR-2525/AUR-2682/AUR-3523: classification lives in sendMessage() itself —
 * not just the HTTP route — so any in-repo caller (intake auto-replies,
 * replyInThread, future scripts) is gated regardless of code path.
 *
 * AUR-3628: `approvalVerified: true` alone is no longer sufficient. Any
 * `approved` approvals row (regardless of what it was actually approved for)
 * used to satisfy the gate for every gated send in the company. `approvalScope`
 * binds the approval to the mailbox/recipient (and, when present, subject) it
 * was actually granted for, so an unrelated approved approval can't be reused.
 */
export interface GmailApprovalScope {
  mailbox?: string;
  to?: string;
  subject?: string;
}

export interface GmailSendGuardContext {
  approvalVerified?: boolean;
  approvalScope?: GmailApprovalScope;
}

/**
 * AUR-1796: identifies the company whose outbound mail activity should be
 * recorded. Threaded through the sendMessage() chokepoint (the same place the
 * outbound guard classifies every send) so any code path that dispatches mail
 * leaves a gmail_outbound_records row for the conversations dashboard's
 * reply-state computation. Callers without a company context (or a db) simply
 * skip tracking — the send itself is unaffected.
 */
export interface GmailOutboundTrackingContext {
  companyId: string;
}

function normalizeEmailForScopeCompare(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// True only when the verified approval's scope matches THIS send: same
// mailbox, same target recipient, and (if the approval recorded one) the same
// subject. Reject silently — the caller (sendMessage) treats a non-match the
// same as no approval at all.
function isApprovalScopedToSend(
  guard: GmailSendGuardContext | undefined,
  alias: GmailAlias,
  opts: Pick<GmailSendOptions, "to" | "subject">,
): boolean {
  if (!guard?.approvalVerified) return false;
  const scope = guard.approvalScope;
  if (!scope) return false;
  if (scope.mailbox !== alias) return false;
  if (normalizeEmailForScopeCompare(scope.to) !== normalizeEmailForScopeCompare(opts.to)) return false;
  if (scope.subject !== undefined && scope.subject.trim() !== opts.subject.trim()) return false;
  return true;
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
  /**
   * AUR-4479: opt in to a send whose entire recipient set is on our own domain.
   * Self-addressed probes (capability tests, booking smoketests) are legitimate,
   * but a self-send must be a deliberate act — never the accidental outcome of
   * reply-recipient resolution.
   */
  allowSelfAddressed?: boolean;
  /**
   * AUR-5732: declare this a COLD PROSPECTING send. Turns on the recipient-shape
   * gate — a role/queue/shared inbox recipient must then carry
   * `queueJustification`, and a human recipient must be named. Replying to a
   * party who wrote to us first is not prospecting; leave this unset there.
   */
  prospecting?: boolean;
  /** AUR-5732: the human this prospecting send is for, e.g. "Zachary Welsher". */
  recipientPersonName?: string;
  /** AUR-5732: why a role/queue inbox is nonetheless correct for this send. */
  queueJustification?: string;
  /**
   * AUR-5732: the prospect address recorded on the tracker row. The address
   * actually placed in To: must equal it, or the send is refused. AUR-4479 only
   * proved the recipient was not us; this proves it is the prospect.
   */
  intendedRecipient?: string;
}

export interface GmailReplyOptions {
  replyToMessageId?: string;
  threadId?: string;
  body: string;
  cc?: string | string[];
  replyTo?: string;
  attachments?: GmailAttachmentInput[];
  /** AUR-4479: see GmailSendOptions.allowSelfAddressed. */
  allowSelfAddressed?: boolean;
  /** AUR-5732: see GmailSendOptions.prospecting. */
  prospecting?: boolean;
  /** AUR-5732: see GmailSendOptions.recipientPersonName. */
  recipientPersonName?: string;
  /** AUR-5732: see GmailSendOptions.queueJustification. */
  queueJustification?: string;
  /**
   * AUR-5732: the prospect address this reply is meant to reach. Checked
   * against the recipient RESOLVED from the thread, which is the only place a
   * queue auto-responder can silently take the conversation over.
   */
  intendedRecipient?: string;
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

// AUR-4479 — self-address detection.
//
// Pulls every address out of an RFC 5322 address header, which may be a bare
// address, an angle-bracket display-name form, or a comma-separated list:
//   `Alex at Auranode <alex@tryauranode.com>, jane@example.com`
export function extractEmailAddresses(headerValue: string | undefined | null): string[] {
  if (!headerValue) return [];
  const addresses: string[] = [];
  const pattern = /<([^<>@\s]+@[^<>@\s]+)>|([^\s,<>()]+@[^\s,<>()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(headerValue)) !== null) {
    const address = (match[1] ?? match[2] ?? "").trim().replace(/[.,;:]+$/, "");
    if (address) addresses.push(address.toLowerCase());
  }
  return addresses;
}

function isOwnDomain(address: string): boolean {
  return address.toLowerCase().endsWith(`@${DOMAIN}`);
}

/** True when the header names at least one address on our own domain. */
export function isSelfAddress(headerValue: string | undefined | null): boolean {
  return extractEmailAddresses(headerValue).some(isOwnDomain);
}

/**
 * True only when EVERY resolved recipient is on our own domain — i.e. the
 * message reaches nobody outside the company. A mixed set still reaches a real
 * external party, so it is not a self-addressed send.
 */
export function isSelfAddressedOnly(values: Array<string | string[] | undefined>): boolean {
  const all = values
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .flatMap((v) => extractEmailAddresses(v));
  return all.length > 0 && all.every(isOwnDomain);
}

export interface GmailMessagePart {
  mimeType?: string | null;
  body?: { data?: string | null; size?: number | null } | null;
  parts?: GmailMessagePart[] | null;
}

export interface GmailDecodedBody {
  bodyText: string | null;
  bodyHtml: string | null;
}

// Gmail's "full" format nests the body in a MIME part tree, base64url-encoded.
// Walk it breadth-first and take the first text/plain and text/html leaf found,
// mirroring how mail clients pick a representative part out of multipart/alternative.
export function decodeGmailMessageBody(
  payload: GmailMessagePart | null | undefined,
): GmailDecodedBody {
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  const queue: Array<GmailMessagePart | null | undefined> = [payload];
  while (queue.length > 0) {
    const part = queue.shift();
    if (!part) continue;
    const mimeType = part.mimeType ?? "";
    const data = part.body?.data;
    if (data && mimeType === "text/plain" && bodyText === null) {
      bodyText = Buffer.from(data, "base64url").toString("utf-8");
    } else if (data && mimeType === "text/html" && bodyHtml === null) {
      bodyHtml = Buffer.from(data, "base64url").toString("utf-8");
    }
    if (part.parts) queue.push(...part.parts);
  }
  return { bodyText, bodyHtml };
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

// RFC 2047 §4.1 encoded-word for non-ASCII header values: =?utf-8?b?<base64>?=
// Required so that mail clients don't misinterpret raw UTF-8 bytes in the header.
function encodeRfc2047(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?utf-8?b?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function buildMimeBoundary(): string {
  return `paperclip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Defense-in-depth (AUR-3628): reject CR/LF in any value interpolated into a
// raw RFC822 header line before it reaches buildRawMessage's string
// concatenation, so a crafted `to`/`cc`/`subject`/`replyTo`/attachment
// filename can't smuggle extra header lines (e.g. a forged Bcc:) into the
// outbound message. The outbound guard's tokenized recipient scan already
// catches CRLF-smuggled blocked-domain/report-desk recipients — this closes
// the header-injection surface itself, not just the recipient-classification
// bypass.
const HEADER_INJECTION_RE = /[\r\n]/;

function assertNoHeaderInjection(value: string, field: string): void {
  if (HEADER_INJECTION_RE.test(value)) {
    throw badRequest(`${field} must not contain CR or LF characters`);
  }
}

function buildRawMessage(opts: BuildRawMessageOptions): string {
  assertNoHeaderInjection(opts.to, "to");
  assertNoHeaderInjection(opts.subject, "subject");
  if (opts.replyTo) assertNoHeaderInjection(opts.replyTo, "replyTo");
  for (const attachment of opts.attachments ?? []) {
    assertNoHeaderInjection(attachment.filename, "attachments[].filename");
  }

  const isReply = Boolean(opts.inReplyTo);
  const rawSubject =
    isReply && !/^re:/i.test(opts.subject.trim()) ? `Re: ${opts.subject}` : opts.subject;
  // RFC 2047-encode so mail clients receive valid structured headers for non-ASCII subjects.
  const subject = encodeRfc2047(rawSubject);
  const ccRecipients = normalizeRecipients(opts.cc);
  for (const recipient of ccRecipients) assertNoHeaderInjection(recipient, "cc");
  const cc = ccRecipients.join(", ");

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

export function createGmailService(db?: Db) {
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
    tracking?: GmailOutboundTrackingContext,
  ) {
    for (const attachment of opts.attachments ?? []) {
      if (attachment.contentBase64.length > MAX_ATTACHMENT_BASE64_BYTES) {
        throw badRequest(
          `Attachment ${attachment.filename} exceeds the 25MB size limit`,
        );
      }
    }

    // AUR-4479 belt-and-braces: a send whose ENTIRE recipient set is on our own
    // domain reaches nobody. Gmail accepts it, returns a message id, and the
    // caller records a delivered send — the success signal is not the same
    // object as the outcome. On a threaded/reply send this is always a bug (the
    // recipient was resolved, not chosen), so hard-block it. A non-threaded
    // self-send is a legitimate probe, so only warn.
    if (!opts.allowSelfAddressed && isSelfAddressedOnly([opts.to, opts.cc])) {
      if (opts.replyToMessageId) {
        logger.error(
          { alias, to: opts.to, cc: opts.cc, subject: opts.subject, replyToMessageId: opts.replyToMessageId },
          "gmail-guard: BLOCKED self-addressed threaded send (AUR-4479)",
        );
        throw badRequest(
          `Refusing to send: every recipient of this threaded reply is on our own domain (${DOMAIN}), ` +
            `so it would reach nobody while still returning a message id. ` +
            `Resolved recipients: to=${opts.to}${opts.cc ? `, cc=${JSON.stringify(opts.cc)}` : ""}. ` +
            `Pass allowSelfAddressed:true only if a self-addressed send is genuinely intended.`,
        );
      }
      logger.warn(
        { alias, to: opts.to, cc: opts.cc, subject: opts.subject },
        "gmail: self-addressed non-threaded send (allowed; pass allowSelfAddressed to declare intent) (AUR-4479)",
      );
    }

    // AUR-5732 — extend the AUR-4479 read-back from "To: is not us" to "To: is
    // the intended prospect". Checked here, at the same chokepoint every caller
    // funnels through, so it also covers replyInThread — where the recipient is
    // RESOLVED from the thread rather than chosen, and a queue auto-responder
    // in that thread silently becomes the recipient.
    if (opts.intendedRecipient) {
      assertIntendedRecipient(
        opts.to,
        opts.intendedRecipient,
        opts.replyToMessageId ? `threaded reply anchored at ${opts.replyToMessageId}` : "direct send",
      );
    }

    // AUR-5732 — recipient-shape gate for cold prospecting. Every AUR-681
    // contact path was a role/queue inbox; the outreach was triaged as ticket
    // noise for ten weeks and nobody's guard asked the question.
    if (opts.prospecting) {
      const verdicts = assertProspectingRecipient({
        to: opts.to,
        cc: opts.cc,
        recipientPersonName: opts.recipientPersonName,
        queueJustification: opts.queueJustification,
      });
      logger.info(
        {
          alias,
          to: opts.to,
          subject: opts.subject,
          recipientShapes: verdicts.map((v) => ({
            address: v.address,
            shape: v.shape,
            matchedRule: v.matchedRule,
          })),
          recipientPersonName: opts.recipientPersonName ?? null,
          queueJustified: Boolean(opts.queueJustification),
        },
        "gmail: prospecting recipient shape checked (AUR-5732)",
      );
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
    if (decision.gated && !isApprovalScopedToSend(guard, alias, opts)) {
      logger.error(
        {
          alias,
          to: opts.to,
          category: decision.category,
          reasons: decision.reasons,
          hadApproval: Boolean(guard?.approvalVerified),
        },
        "gmail-guard: BLOCKED gated outbound at service chokepoint (AUR-2525/AUR-2682/AUR-3628)",
      );
      throw new GmailOutboundBlockedError(decision);
    }

    // AUR-5734 second-sink guard: this route (an agent driving Gmail directly)
    // is a second sink that never consulted the machine-only/non-prospect/
    // bounce truth the Auranode dispatcher enforces — the Help at Home
    // ticket-queue mailbox answered exclusively by a machine, twice, kept
    // getting resent to anyway. Scoped to external addresses only; an account
    // is not disqualified by this, only this automated route into it.
    //
    // A send the CEO explicitly approved for this exact mailbox/to/subject is
    // exempt, same precedent as the gated-outbound check just above: the
    // non-prospect heuristic exists to catch cold sends an agent chose
    // unsupervised, and a role/queue mailbox is routinely the CORRECT address
    // for approved business correspondence (compliance, fraud reports,
    // support escalations) — that is not the class of mistake this guard is
    // for, and a human sign-off on this specific recipient outranks it.
    if (!isApprovalScopedToSend(guard, alias, opts)) {
      const ccList = Array.isArray(opts.cc) ? opts.cc : opts.cc ? [opts.cc] : [];
      const externalRecipients = new Set(
        [opts.to, ...ccList].flatMap((v) => extractEmailAddresses(v)).filter((addr) => !isOwnDomain(addr)),
      );
      for (const address of externalRecipients) {
        const verdict = await checkProspectSendability(address);
        if (verdict && !verdict.sendable) {
          logger.error(
            { alias, to: opts.to, cc: opts.cc, address, reason: verdict.reason, source: verdict.source },
            "gmail-guard: BLOCKED prospect-suppressed recipient at service chokepoint (AUR-5734)",
          );
          throw new GmailProspectSuppressedError(verdict);
        }
      }
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
    // AUR-1796: record the outbound AFTER the guard classification and the
    // actual dispatch, so only sends that really went out are tracked.
    // Tracking is observability — a failed write must never fail a send that
    // already left the building, so this is strictly best-effort.
    if (db && tracking && res.data.id) {
      try {
        await db
          .insert(gmailOutboundRecords)
          .values({
            companyId: tracking.companyId,
            mailbox: alias,
            gmailThreadId: res.data.threadId ?? "",
            gmailMessageId: res.data.id,
            recipient: opts.to,
            subject: opts.subject,
            snippet: opts.body.slice(0, 200),
            sentAt: new Date(),
          })
          .onConflictDoNothing();
      } catch (err) {
        // AUR-4674: this write failing means the outbound audit trail — which
        // the out-of-band reconciler treats as proof a send went through the
        // chokepoint — is silently dying. It failed on EVERY send from ship
        // time until 0105 converged the live schema (missing `snippet`
        // column), and nobody saw the warn. Error-level so it pages a log
        // sweep instead of vanishing.
        logger.error(
          { err, alias, to: opts.to, messageId: res.data.id },
          "gmail: failed to record outbound message for reply tracking (AUR-1796/AUR-4674)",
        );
      }
    }
    return res.data;
  }

  async function replyInThread(
    alias: GmailAlias,
    opts: GmailReplyOptions,
    guard?: GmailSendGuardContext,
    tracking?: GmailOutboundTrackingContext,
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
    let replyTo = extractHeader(headers, "Reply-To") || extractHeader(headers, "From");
    let recipientSourceMessageId = targetMessageId;
    const threadId = opts.threadId ?? original.threadId ?? undefined;

    // AUR-4479: NEVER self-address. The reply recipient was previously taken
    // from the From: of the thread's last message, which is correct only when
    // that message is inbound. On any follow-up WE spoke last, so From: is our
    // own alias and the reply was addressed to ourselves — sent successfully,
    // message id returned, reaching nobody. Walk backwards for the last message
    // whose sender is not us and address the reply to them instead.
    if (!opts.allowSelfAddressed && (!replyTo || isSelfAddress(replyTo))) {
      const external = threadId ? await findLastExternalSender(alias, threadId) : null;
      if (!external) {
        throw badRequest(
          `Refusing to reply in thread ${threadId ?? targetMessageId}: no external participant found ` +
            `(every message is from ${DOMAIN}), so the reply would be addressed to ourselves and reach ` +
            `nobody. Pass allowSelfAddressed:true only if a self-addressed send is genuinely intended.`,
        );
      }
      logger.warn(
        {
          alias,
          threadId,
          anchorMessageId: targetMessageId,
          selfAddressedCandidate: replyTo || null,
          recoveredRecipient: external.address,
          recoveredFromMessageId: external.messageId,
        },
        "gmail: last message in thread is ours — recovered external reply recipient (AUR-4479)",
      );
      replyTo = external.address;
      recipientSourceMessageId = external.messageId;
    }
    if (!replyTo) {
      throw new Error(`Could not determine reply-to address for message ${targetMessageId}`);
    }
    // Log the recipient at RESOLUTION time, not just at send time, so a future
    // misfire is greppable even if the send itself never happens.
    logger.info(
      {
        alias,
        threadId,
        anchorMessageId: targetMessageId,
        recipientSourceMessageId,
        resolvedRecipient: replyTo,
      },
      "gmail: reply recipient resolved (AUR-4479)",
    );
    const sent = await sendMessage(
      alias,
      {
        to: replyTo,
        subject,
        body: opts.body,
        replyToMessageId: targetMessageId,
        cc: opts.cc,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
        allowSelfAddressed: opts.allowSelfAddressed,
        // AUR-5732: the resolved recipient is the thing that has to match the
        // intended prospect — that is exactly the axis AUR-4479 never measured.
        prospecting: opts.prospecting,
        recipientPersonName: opts.recipientPersonName,
        queueJustification: opts.queueJustification,
        intendedRecipient: opts.intendedRecipient,
      },
      guard,
      tracking,
    );
    // AUR-4479: surface the resolved recipient so callers can ASSERT on who was
    // actually addressed. A returned message id proves dispatch, not delivery
    // to the intended party.
    // AUR-5732: `intendedRecipientMatched` is the stronger claim — the resolved
    // recipient IS the prospect, not merely somebody external. Null when the
    // caller declared no intended recipient, so absence stays visible rather
    // than reading as a pass.
    return {
      ...sent,
      resolvedRecipient: replyTo,
      recipientSourceMessageId,
      intendedRecipientMatched: opts.intendedRecipient
        ? normalizeAddress(replyTo) === normalizeAddress(opts.intendedRecipient)
        : null,
    };
  }

  // AUR-4479: walk a thread newest-first and return the last sender who is not
  // us. Thread messages come back in "full" format with headers already
  // attached; fall back to a per-message fetch only if they are missing.
  async function findLastExternalSender(
    alias: GmailAlias,
    threadId: string,
  ): Promise<{ address: string; messageId: string } | null> {
    const thread = await getThread(alias, threadId);
    const messages = thread.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message?.id) continue;
      let headers = message.payload?.headers;
      if (!headers) {
        headers = (await getMessage(alias, message.id)).payload?.headers;
      }
      const candidate = extractHeader(headers, "Reply-To") || extractHeader(headers, "From");
      if (candidate && !isSelfAddress(candidate)) {
        return { address: candidate, messageId: message.id };
      }
    }
    return null;
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
