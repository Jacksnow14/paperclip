import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, gmailIntakeRecords, issues } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentMetadataSection } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { createGmailService, GMAIL_SUPPORTED_ALIASES, type GmailAlias } from "./gmail.js";
import { issueService } from "./issues.js";

// Mailbox → agent role for default ownership routing.
const MAILBOX_ROLE: Record<GmailAlias, string> = {
  board: "ceo",
  alex: "cmo",
};

// Sender-based routing overrides: emails from these senders bypass the default
// mailbox→role routing and go directly to the specified role+forward target.
const SENDER_ROUTES: Array<{
  senderMatch: string;
  targetRole: string;
  forwardTo?: string;
}> = [
  { senderMatch: "payments-noreply@google.com", targetRole: "cfo" },
  { senderMatch: "workspace-noreply@google.com", targetRole: "cfo" },
];

// DMARC aggregate-report telemetry (AUR-4466): mailbox providers deliver
// aggregate reports to board@ daily, and each one was minting an issue that
// self-assigned and burned a heartbeat. These reports are machine telemetry
// consumed in place from the mailbox by the DMARC sensor (AUR-4241/AUR-4295) —
// mail-side filters were deliberately removed (AUR-4318) to keep that sensor's
// view live, so suppression must happen here at intake classification instead.
const DMARC_REPORT_SENDERS = [
  "dmarcreport@microsoft.com",
  "noreply-dmarc-support@google.com",
  "noreply@dmarc.yahoo.com",
];
// Outlook reports arrive from subdomained senders (e.g.
// postmaster@mail.protection.outlook.com), so match the domain suffix.
const DMARC_REPORT_SENDER_DOMAIN_RE = /[@.]protection\.outlook\.com\b/;
// RFC 7489 aggregate-report subject convention:
// "Report Domain: <domain> Submitter: <org> Report-ID: <id>" — catches
// submitters not yet in the sender list.
const DMARC_REPORT_SUBJECT_RE = /^report domain:\s*\S+[\s\S]*\bsubmitter\b/i;

export function isDmarcAggregateReport(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  if (DMARC_REPORT_SENDERS.some((s) => fromLower.includes(s))) return true;
  if (DMARC_REPORT_SENDER_DOMAIN_RE.test(fromLower)) return true;
  return DMARC_REPORT_SUBJECT_RE.test(subject);
}

// Marketing/promotional mail is not actionable correspondence (AUR-5831):
// GlockApps and Shopify newsletter sends (AUR-5803, AUR-5804, both cancelled
// 2026-08-19) were minting "Inbound email received" issues and burning agent
// heartbeats on unsubscribe-able bulk mail. The RFC 2369/8058 List-Unsubscribe
// header is the standard machine-checkable signal for this class of mail —
// since Gmail/Yahoo's Feb-2024 bulk-sender rules, any ESP sending promotional
// mail at volume is required to set it, and genuine correspondence (including
// transactional receipts and password resets) essentially never carries it.
// Prefer this structural signal over subject/body keyword matching, which is
// both easy for a sender to vary and prone to false positives on legitimate
// mail that happens to mention a keyword (see isDmarcAggregateReport above
// for the same reasoning applied to its domain/subject checks).
export function isMarketingEmail(listUnsubscribe: string): boolean {
  return listUnsubscribe.trim().length > 0;
}

// Our own cold-outreach send-only identity (AUR-6042). `auranodehq.com` 550s
// at its own MX, so no human or system legitimately sends *from* it except
// the outreach campaign — mail arriving in the alex@ intake mailbox with
// this From domain is our own ESP-sent (Resend/SES) cold email round-
// tripping back in, not correspondence. Unlike tryauranode.com (see
// isOwnOutboundCopy below), auranodehq.com never legitimately receives real
// replies to itself, so a From-domain check alone is safe here — ESP sends
// never pass through Gmail's own send path, so there is no SENT label to
// discriminate on the way isOwnOutboundCopy does for tryauranode.com.
export const COLD_OUTREACH_SEND_ONLY_DOMAIN = "auranodehq.com";
const COLD_OUTREACH_SEND_ONLY_DOMAIN_RE = new RegExp(
  `[@.]${COLD_OUTREACH_SEND_ONLY_DOMAIN.replace(/\./g, "\\.")}\\b`,
  "i",
);

export function isColdOutreachOwnSend(from: string): boolean {
  return COLD_OUTREACH_SEND_ONLY_DOMAIN_RE.test(from);
}

// Shopify informational notifications are not actionable correspondence
// (AUR-6074). account-security@shopify.com carried every decision on the
// First Mile account-security case (ticket 4a5cff83, AUR-2156/AUR-5816/
// AUR-6024/AUR-5938) and must never be dampened — it is deliberately
// excluded from this check. mailer@/no-reply@shopify.com started emitting
// continuous order/payout/product-feature notifications once the store
// went public (AUR-6071): 5 triage issues in 24h on 2026-08-20, one whole
// agent run to triage a Klarna auto-enrollment notice (AUR-6073). Suppress
// those senders by default, but fail toward escalation on a genuine money/
// account-action event so a real payout failure or chargeback is never
// swallowed by the digest.
// Anchored on both sides so a lookalike sender can't ride the plain substring
// match: an unanchored `.includes("mailer@shopify.com")` also matches
// "attacker-mailer@shopify.com" (local-part prefix) and
// "mailer@shopify.com.evil.net" (domain suffix) — either would silently
// suppress a spoofed/phishing message that impersonates Shopify instead of
// routing it to CMO. Require the address to start right after a boundary
// (string start, whitespace, `<`, or a quote) and end right after
// "shopify.com" at a matching boundary.
const SHOPIFY_INFORMATIONAL_SENDER_RE = /(?:^|[\s<"])(?:mailer|no-reply)@shopify\.com(?=[\s>"]|$)/i;
const SHOPIFY_ACTION_SUBJECT_RE =
  /zahlung fehlgeschlagen|auszahlung|chargeback|deaktiviert|suspended/i;

export function isShopifyInformationalNotification(from: string, subject: string): boolean {
  if (!SHOPIFY_INFORMATIONAL_SENDER_RE.test(from)) return false;
  return !SHOPIFY_ACTION_SUBJECT_RE.test(subject);
}

// Our own outbound mail is not correspondence (AUR-5473). The intake listing
// query is a plain Gmail search, which matches SENT as well as received mail —
// so every cold email the outreach sequence sends from alex@ was minting an
// "Inbound email received" issue addressed to the prospect we had just written
// to. AUR-5473 was one such phantom: our own pitch to a prospect, filed as a
// revenue enquiry and assigned to the CMO.
//
// The sender address does NOT discriminate: alex@ legitimately receives mail
// from alex@ (booking confirmations, internal verification sends), and those
// are real deliveries that must keep minting issues. The Gmail label set does
// discriminate — a message we sent to an external recipient carries SENT and
// no INBOX, while anything actually delivered to this mailbox carries INBOX
// (verified against live messages, both directions).
//
// Do NOT try to push this into the listing query as `-in:sent`: a message we
// send to our own mailbox carries BOTH labels, so that filter would also drop
// the self-addressed mail this guard is careful to keep. The label pair has to
// be evaluated per message, here.
export function isOwnOutboundCopy(labelIds: readonly string[] | null | undefined): boolean {
  if (!labelIds) return false;
  return labelIds.includes("SENT") && !labelIds.includes("INBOX");
}

// Our own persona-to-persona audit CCs are not correspondence (AUR-4673).
// board@ is Cc'd on every substantive external send from the alex@ persona,
// by design — it is our case file. That Cc copy is a genuine delivery to
// board@'s own INBOX (board@ did not send it), so it carries no SENT label
// and isOwnOutboundCopy above — which only discriminates the *sending*
// mailbox's own view of its outbound mail — cannot catch it. One send batch
// on 2026-07-29 (two outbound messages, both Cc board@) minted three
// duplicate "[board@] alex@tryauranode.com — ..." issues from our own mail.
//
// What discriminates: the sender is one of our own persona mailboxes
// (`${alias}@tryauranode.com`) AND it is a *different* mailbox than the one
// currently being polled. Restricting to "different mailbox" is deliberate —
// it preserves the exception documented on isOwnOutboundCopy above: alex@
// genuinely receives real mail from alex@ (booking confirmations, internal
// verification sends) and those must keep minting issues.
const OWNED_MAILBOX_DOMAIN = "tryauranode.com";

function ownedMailboxAddressRe(alias: GmailAlias): RegExp {
  return new RegExp(
    `(?:^|[\\s<"])${alias}@${OWNED_MAILBOX_DOMAIN.replace(/\./g, "\\.")}(?=[\\s>"]|$)`,
    "i",
  );
}

// A "Display Name <email@example.com>" From header lets the sender put
// arbitrary text — including a fake "alex@tryauranode.com" — in the display
// name while the real, deliverable address is anything they control. Testing
// the raw header (as the boundary-anchored regex above would, unguarded)
// makes this predicate spoofable: an external sender crafting
// `"alex@tryauranode.com" <attacker@evil.com>` would have their genuinely
// external mail silently suppressed (case-file-only, no issue, no human
// ever sees it) rather than merely misrouted. Evaluate only the actual
// address — inside the angle brackets when present, else the whole trimmed
// header — never the attacker-controlled display name.
function extractSenderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim();
}

export function isSelfOriginatedAuditCopy(from: string, mailbox: GmailAlias): boolean {
  const address = extractSenderAddress(from);
  for (const alias of GMAIL_SUPPORTED_ALIASES) {
    if (alias === mailbox) continue;
    if (ownedMailboxAddressRe(alias).test(address)) return true;
  }
  return false;
}

// Gmail label names applied by the intake pipeline.
export const INTAKE_LABELS = {
  TRIAGED: "paperclip/triaged",
  NEEDS_REPLY: "paperclip/needs-reply",
  REPLIED: "paperclip/replied",
} as const;

// Truncate body text to a safe snippet for issue comments.
const SNIPPET_MAX_CHARS = 500;

interface ParsedMessage {
  from: string;
  subject: string;
  dateMs: number | null;
  bodySnippet: string;
  gmailThreadId: string;
  gmailMessageId: string;
  // True when RFC 3834 Auto-Submitted header or Precedence: bulk is present.
  // Auto-replies are low-signal; the dedupe logic skips creating a new issue
  // when a historical match (even closed) exists for the same sender+subject.
  isAutoReply: boolean;
  // Gmail's own label set for this message. Used to tell mail delivered to this
  // mailbox from our own SENT copies — see isOwnOutboundCopy (AUR-5473).
  labelIds: string[];
  // Raw List-Unsubscribe header value, "" when absent. See isMarketingEmail (AUR-5831).
  listUnsubscribe: string;
}

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function decodeBase64urlPart(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function extractTextBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null }> | null;
}): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64urlPart(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64urlPart(part.body.data);
      }
    }
    // Fallback: try text/html parts if no plain text found.
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return decodeBase64urlPart(part.body.data).replace(/<[^>]*>/g, " ").trim();
      }
    }
  }
  return "";
}

function sanitizeHeaderValue(value: string): string {
  // Strip newlines and null bytes from header values to prevent injection.
  return value.replace(/[\r\n\0]/g, " ").trim();
}

// Detect and reverse double-UTF-8 encoding ("mojibake") caused by the Gmail
// API returning header bytes that were decoded as Latin-1 instead of UTF-8.
// Each pass: re-encode the string as Latin-1 bytes, then decode as UTF-8.
// If the result is shorter in byte length (fewer multi-byte sequences) and
// contains no replacement characters, the string was mojibaked — accept it.
// Up to 2 passes handles the double-encoding case (AUR-3569 / LAR-570).
export function repairUtf8Mojibake(input: string): string {
  let current = input;
  for (let pass = 0; pass < 2; pass++) {
    let decoded: string;
    try {
      const bytes = Buffer.from(current, "latin1");
      decoded = bytes.toString("utf-8");
    } catch {
      break;
    }
    if (decoded.includes("�")) break;
    if (Buffer.byteLength(decoded, "utf-8") < Buffer.byteLength(current, "utf-8")) {
      current = decoded;
    } else {
      break;
    }
  }
  return current;
}

function parseMessage(
  msg: {
    id?: string | null;
    threadId?: string | null;
    labelIds?: string[] | null;
    payload?: {
      headers?: Array<{ name?: string | null; value?: string | null }> | null;
      mimeType?: string | null;
      body?: { data?: string | null } | null;
      parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null }> | null;
    } | null;
    snippet?: string | null;
  },
): ParsedMessage | null {
  const gmailMessageId = msg.id;
  const gmailThreadId = msg.threadId;
  if (!gmailMessageId || !gmailThreadId) return null;

  const headers = msg.payload?.headers ?? [];
  // Sanitize at parse time so all downstream paths (title, DB fields, comments) receive clean values.
  // repairUtf8Mojibake reverses double-Latin-1 encoding that the Gmail API sometimes produces for
  // non-ASCII header values (LAR-570).
  const from = repairUtf8Mojibake(sanitizeHeaderValue(extractHeader(headers, "from")));
  const subject = repairUtf8Mojibake(sanitizeHeaderValue(extractHeader(headers, "subject"))) || "(no subject)";
  const dateStr = extractHeader(headers, "date");
  const dateMs = dateStr ? new Date(dateStr).getTime() : null;

  const bodyText = msg.payload ? extractTextBody(msg.payload) : "";
  const bodySnippet = (bodyText || msg.snippet || "").slice(0, SNIPPET_MAX_CHARS);

  const autoSubmitted = extractHeader(headers, "auto-submitted").toLowerCase();
  const precedence = extractHeader(headers, "precedence").toLowerCase();
  const isAutoReply =
    autoSubmitted === "auto-replied" ||
    autoSubmitted === "auto-generated" ||
    precedence === "bulk";
  const listUnsubscribe = sanitizeHeaderValue(extractHeader(headers, "list-unsubscribe"));

  return {
    from,
    subject,
    dateMs,
    bodySnippet,
    gmailThreadId,
    gmailMessageId,
    isAutoReply,
    labelIds: msg.labelIds ?? [],
    listUnsubscribe,
  };
}

// Strip leading Re:/Fwd:/Fw: prefixes (repeatedly), collapse whitespace, lowercase.
// The result is stored in gmail_intake_records.subject and used as the dedupe key
// for the sender+subject cross-thread flood-prevention lookup (AUR-2674).
function normalizeSubject(subject: string): string {
  let s = subject;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(?:re|fwd|fw)\s*:\s*/i, "");
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// Row shape for gmail_intake_records, shared by the issue-linked insert and
// the telemetry-suppression insert (issueId null).
function buildIntakeRecordValues(
  companyId: string,
  mailbox: GmailAlias,
  parsed: ParsedMessage,
  issueId: string | null,
) {
  return {
    companyId,
    mailbox,
    gmailThreadId: parsed.gmailThreadId,
    gmailMessageId: parsed.gmailMessageId,
    issueId,
    sender: parsed.from.slice(0, 512),
    subject: normalizeSubject(parsed.subject).slice(0, 512),
    snippet: parsed.bodySnippet.slice(0, 512),
    receivedAt: parsed.dateMs ? new Date(parsed.dateMs) : null,
  };
}

function matchSenderRoute(from: string): (typeof SENDER_ROUTES)[number] | null {
  const fromLower = from.toLowerCase();
  return SENDER_ROUTES.find((r) => fromLower.includes(r.senderMatch)) ?? null;
}

async function resolveAssigneeAgentId(
  db: Pick<Db, "select">,
  companyId: string,
  mailbox: GmailAlias,
  parsed?: ParsedMessage | null,
): Promise<string | null> {
  // Sender-based override: specific senders route to a different role.
  const senderRoute = parsed ? matchSenderRoute(parsed.from) : null;
  const role = senderRoute?.targetRole ?? MAILBOX_ROLE[mailbox];
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, role)))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function ensureLabel(
  gmail: ReturnType<typeof createGmailService>,
  alias: GmailAlias,
  labelName: string,
): Promise<string | null> {
  try {
    const allLabels = await gmail.listLabels(alias);
    const existing = allLabels.find((l) => l.name === labelName);
    if (existing?.id) return existing.id;
    const created = await gmail.createLabel(alias, labelName);
    return created.id ?? null;
  } catch (err) {
    logger.warn({ err, alias, labelName }, "gmail-intake: failed to ensure label");
    return null;
  }
}

export function createGmailIntakeService(db: Db) {
  const gmail = createGmailService(db);
  const isvc = issueService(db);

  async function processMailbox(companyId: string, mailbox: GmailAlias): Promise<{
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  }> {
    let processed = 0, created = 0, updated = 0, skipped = 0, errors = 0;

    let listData: Awaited<ReturnType<typeof gmail.listMessages>>;
    try {
      // Poll for messages received in the last 2 days, including already-read ones.
      listData = await gmail.listMessages(mailbox, {
        query: "newer_than:2d",
        maxResults: 50,
      });
    } catch (err) {
      logger.error({ err, companyId, mailbox }, "gmail-intake: failed to list messages");
      errors++;
      return { processed, created, updated, skipped, errors };
    }

    const messageStubs = listData.messages ?? [];
    if (messageStubs.length === 0) return { processed, created, updated, skipped, errors };

    // Resolve the triaged label ID once per mailbox poll.
    const triagedLabelId = await ensureLabel(gmail, mailbox, INTAKE_LABELS.TRIAGED);

    for (const stub of messageStubs) {
      if (!stub.id) continue;

      // Skip if already processed.
      const existing = await db
        .select({ id: gmailIntakeRecords.id })
        .from(gmailIntakeRecords)
        .where(
          and(
            eq(gmailIntakeRecords.companyId, companyId),
            eq(gmailIntakeRecords.mailbox, mailbox),
            eq(gmailIntakeRecords.gmailMessageId, stub.id),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      let msg: Awaited<ReturnType<typeof gmail.getMessage>>;
      try {
        msg = await gmail.getMessage(mailbox, stub.id);
      } catch (err) {
        logger.error({ err, mailbox, messageId: stub.id }, "gmail-intake: failed to fetch message");
        errors++;
        continue;
      }

      const parsed = parseMessage(msg);
      if (!parsed) {
        skipped++;
        continue;
      }

      processed++;

      try {
        // Our own SENT copies are not inbound correspondence (AUR-5473).
        // Record the intake so the message is not refetched on every poll for
        // the next 2 days, mint no issue, and leave the mail untouched — no
        // triaged label on our own outbound. A later genuine reply arrives as
        // a separate message carrying INBOX, and since this record has a null
        // issueId the thread lookup will not fold the reply into nothing.
        if (isOwnOutboundCopy(parsed.labelIds)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, subject: parsed.subject },
            "gmail-intake: suppressed own outbound copy (SENT without INBOX, no issue)",
          );
          skipped++;
          continue;
        }

        // Our own persona-to-persona audit CCs are not correspondence
        // (AUR-4673) — see isSelfOriginatedAuditCopy above. Record the
        // intake so the message is not refetched on every poll, mint no
        // issue, and leave the mail untouched — same suppress-in-place
        // treatment as the own-outbound case above. The audit CC itself
        // stays in the mailbox as case-file evidence; it just must not mint
        // a new top-level issue.
        if (isSelfOriginatedAuditCopy(parsed.from, mailbox)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, from: parsed.from, subject: parsed.subject },
            "gmail-intake: suppressed self-originated audit CC (no issue)",
          );
          skipped++;
          continue;
        }

        // DMARC aggregate reports are telemetry, not correspondence (AUR-4466).
        // Record the intake so the message is not reprocessed on later polls,
        // but mint no issue and leave the mail fully untouched — no label, no
        // archive — so the DMARC sensor (AUR-4241) still sees it in place.
        if (isDmarcAggregateReport(parsed.from, parsed.subject)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, from: parsed.from },
            "gmail-intake: suppressed DMARC aggregate report (telemetry, no issue)",
          );
          skipped++;
          continue;
        }

        // Marketing/promotional mail is not actionable correspondence
        // (AUR-5831). Record the intake so the message is not refetched on
        // every poll, mint no issue, and leave the mail untouched — same
        // suppress-in-place treatment as the DMARC and own-outbound cases
        // above.
        if (isMarketingEmail(parsed.listUnsubscribe)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, from: parsed.from, subject: parsed.subject },
            "gmail-intake: suppressed marketing/promotional email (List-Unsubscribe present, no issue)",
          );
          skipped++;
          continue;
        }

        // Our own cold-outreach sends round-tripping back into the alex@
        // intake mailbox are not correspondence (AUR-6042). Record the
        // intake so the message is not refetched on every poll, mint no
        // issue, and leave the mail untouched — same suppress-in-place
        // treatment as the DMARC and marketing cases above.
        if (isColdOutreachOwnSend(parsed.from)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, from: parsed.from, subject: parsed.subject },
            "gmail-intake: suppressed own cold-outreach send-only domain (no issue)",
          );
          skipped++;
          continue;
        }

        // Shopify informational notifications are not actionable
        // correspondence (AUR-6074). Record the intake so the message is
        // not refetched on every poll, mint no issue, and leave the mail
        // untouched — same suppress-in-place treatment as the cases above.
        // account-security@shopify.com never matches this check (see
        // isShopifyInformationalNotification) and falls through unchanged.
        if (isShopifyInformationalNotification(parsed.from, parsed.subject)) {
          await db.insert(gmailIntakeRecords).values(
            buildIntakeRecordValues(companyId, mailbox, parsed, null),
          );
          logger.info(
            { mailbox, messageId: parsed.gmailMessageId, from: parsed.from, subject: parsed.subject },
            "gmail-intake: suppressed Shopify informational notification (no issue)",
          );
          skipped++;
          continue;
        }

        // Find any existing record in this Gmail thread that has an issueId.
        const existingThreadRecord = await db
          .select({ issueId: gmailIntakeRecords.issueId })
          .from(gmailIntakeRecords)
          .where(
            and(
              eq(gmailIntakeRecords.companyId, companyId),
              eq(gmailIntakeRecords.mailbox, mailbox),
              eq(gmailIntakeRecords.gmailThreadId, parsed.gmailThreadId),
              isNotNull(gmailIntakeRecords.issueId),
            ),
          )
          .orderBy(desc(gmailIntakeRecords.createdAt))
          .limit(1);

        const existingIssueId = existingThreadRecord[0]?.issueId ?? null;

        // null only for the auto-reply+closed-issue skip path; the schema column is nullable.
        let issueId: string | null = null;

        if (existingIssueId) {
          // Existing issue for this thread — add a comment carrying the Gmail
          // thread/message refs as first-class structured metadata so the
          // reply workflow can resolve them without parsing prose.
          const commentBody = buildUpdateCommentBody(mailbox, parsed);
          await isvc.addComment(existingIssueId, commentBody, {}, {
            authorType: "system",
            metadata: buildGmailReferenceMetadata(mailbox, parsed),
          });
          issueId = existingIssueId;
          updated++;
        } else {
          // Cross-thread sender+subject dedupe (AUR-2674): fold same-sender same-subject
          // auto-ack floods (e.g. bunq acknowledgment replies) into one issue even across
          // different Gmail threads. We normalize the subject (strip Re:/Fwd:, lowercase)
          // so "Re: Notification" and "Notification" match. We left-join with issues to
          // distinguish open vs closed matches within a 14-day recency window.
          const normalizedSubj = normalizeSubject(parsed.subject).slice(0, 512);
          const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

          const senderSubjRecord = await db
            .select({ issueId: gmailIntakeRecords.issueId, issueStatus: issues.status })
            .from(gmailIntakeRecords)
            .leftJoin(issues, eq(gmailIntakeRecords.issueId, issues.id))
            .where(
              and(
                eq(gmailIntakeRecords.companyId, companyId),
                eq(gmailIntakeRecords.mailbox, mailbox),
                eq(gmailIntakeRecords.sender, parsed.from.slice(0, 512)),
                eq(gmailIntakeRecords.subject, normalizedSubj),
                gte(gmailIntakeRecords.createdAt, cutoff),
                isNotNull(gmailIntakeRecords.issueId),
              ),
            )
            .orderBy(desc(gmailIntakeRecords.createdAt))
            .limit(1);

          const senderSubjIssueId = senderSubjRecord[0]?.issueId ?? null;
          const senderSubjIssueStatus = senderSubjRecord[0]?.issueStatus ?? null;
          const isClosed = senderSubjIssueStatus === "done" || senderSubjIssueStatus === "cancelled";
          const isOpenMatch = senderSubjIssueId !== null && !isClosed;

          if (isOpenMatch) {
            // Fold into the existing open issue as a comment.
            const commentBody = buildUpdateCommentBody(mailbox, parsed);
            await isvc.addComment(senderSubjIssueId!, commentBody, {}, {
              authorType: "system",
              metadata: buildGmailReferenceMetadata(mailbox, parsed),
            });
            issueId = senderSubjIssueId!;
            updated++;
          } else if (senderSubjIssueId !== null && isClosed && parsed.isAutoReply) {
            // Auto-reply against a historically closed issue: skip creating a new issue.
            // issueId stays null; the bottom insert records the intake to prevent
            // reprocessing without linking to any issue.
            skipped++;
          } else {
            // No match or closed match without auto-reply header — create a new issue.
            const assigneeAgentId = await resolveAssigneeAgentId(db, companyId, mailbox, parsed);
            const issueTitle = buildIssueTitle(mailbox, parsed.subject, parsed.from);
            const issueDescription = buildIssueDescription(mailbox, parsed);

            const issue = await isvc.create(companyId, {
              title: issueTitle,
              description: issueDescription,
              status: "todo",
              priority: "medium",
              originKind: "inbound_email",
              ...(assigneeAgentId ? { assigneeAgentId } : {}),
            });
            issueId = issue.id;

            // Attach the Gmail thread/message refs as a first-class structured
            // metadata comment on the new issue so the reply workflow has a
            // reliable, issue-visible contract (not brittle prose parsing).
            await isvc.addComment(issueId, buildReferenceCommentBody(mailbox), {}, {
              authorType: "system",
              metadata: buildGmailReferenceMetadata(mailbox, parsed, { includeSubject: true }),
            });
            created++;
          }
        }

        // Record the intake so we don't process this message again.
        await db.insert(gmailIntakeRecords).values(
          buildIntakeRecordValues(companyId, mailbox, parsed, issueId),
        );

        // Apply paperclip/triaged label.
        if (triagedLabelId) {
          try {
            await gmail.modifyMessageLabels(mailbox, parsed.gmailMessageId, {
              addLabelIds: [triagedLabelId],
            });
          } catch (err) {
            logger.warn({ err, mailbox, messageId: parsed.gmailMessageId }, "gmail-intake: failed to apply triaged label");
          }
        }

        // Forward to target mailbox when a sender route has a forwardTo.
        const route = matchSenderRoute(parsed.from);
        if (route?.forwardTo) {
          try {
            await gmail.sendMessage(
              mailbox,
              {
                to: route.forwardTo,
                subject: `Fwd: ${parsed.subject}`,
                body: `---------- Forwarded message ----------\nFrom: ${parsed.from}\nDate: ${parsed.dateMs ? new Date(parsed.dateMs).toISOString() : "unknown"}\nSubject: ${parsed.subject}\n\n${parsed.bodySnippet}`,
              },
              undefined,
              // AUR-1796: sender-routed forwards are outbound too — track them.
              { companyId },
            );
            logger.info(
              { mailbox, to: route.forwardTo, messageId: parsed.gmailMessageId },
              "gmail-intake: forwarded sender-routed email",
            );
          } catch (err) {
            logger.warn(
              { err, mailbox, to: route.forwardTo, messageId: parsed.gmailMessageId },
              "gmail-intake: failed to forward sender-routed email",
            );
          }
        }
      } catch (err) {
        logger.error({ err, companyId, mailbox, messageId: stub.id }, "gmail-intake: failed to process message");
        errors++;
      }
    }

    return { processed, created, updated, skipped, errors };
  }

  async function pollAllMailboxes(companyId: string): Promise<{
    mailbox: string;
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  }[]> {
    const results = [];
    for (const mailbox of GMAIL_SUPPORTED_ALIASES) {
      try {
        const result = await processMailbox(companyId, mailbox);
        results.push({ mailbox, ...result });
        if (result.processed > 0 || result.errors > 0) {
          logger.info(
            { companyId, mailbox, ...result },
            "gmail-intake: mailbox poll complete",
          );
        }
      } catch (err) {
        logger.error({ err, companyId, mailbox }, "gmail-intake: mailbox poll failed");
        results.push({ mailbox, processed: 0, created: 0, updated: 0, skipped: 0, errors: 1 });
      }
    }
    return results;
  }

  return { processMailbox, pollAllMailboxes };
}

export type GmailIntakeService = ReturnType<typeof createGmailIntakeService>;

// --- Formatting helpers ---

function extractSenderLabel(from: string): string {
  // "Display Name <email@example.com>" → "Display Name"
  const match = from.match(/^([^<]+?)\s*<[^>]+>/);
  if (match?.[1]) return match[1].trim().slice(0, 60);
  return from.trim().slice(0, 60);
}

function buildIssueTitle(mailbox: GmailAlias, subject: string, from: string): string {
  const senderLabel = extractSenderLabel(from);
  return `[${mailbox}@] ${senderLabel} — ${subject}`.slice(0, 255);
}

function buildIssueDescription(mailbox: GmailAlias, parsed: ParsedMessage): string {
  const lines = [
    `**Inbound email received at ${mailbox}@tryauranode.com**`,
    "",
    `- **From:** ${sanitizeHeaderValue(parsed.from)}`,
    `- **Subject:** ${sanitizeHeaderValue(parsed.subject)}`,
    `- **Received:** ${parsed.dateMs ? new Date(parsed.dateMs).toISOString() : "unknown"}`,
    `- **Gmail thread ID:** \`${parsed.gmailThreadId}\``,
    `- **Gmail message ID:** \`${parsed.gmailMessageId}\``,
  ];
  if (parsed.bodySnippet) {
    lines.push("", "**Message preview:**", "", "```", parsed.bodySnippet, "```");
  }
  return lines.join("\n");
}

function buildUpdateCommentBody(mailbox: GmailAlias, parsed: ParsedMessage): string {
  const lines = [
    `**New reply in Gmail thread (${mailbox}@tryauranode.com)**`,
    "",
    `- **From:** ${sanitizeHeaderValue(parsed.from)}`,
    `- **Received:** ${parsed.dateMs ? new Date(parsed.dateMs).toISOString() : "unknown"}`,
    `- **Gmail message ID:** \`${parsed.gmailMessageId}\``,
  ];
  if (parsed.bodySnippet) {
    lines.push("", "**Message preview:**", "", "```", parsed.bodySnippet, "```");
  }
  return lines.join("\n");
}

function buildReferenceCommentBody(mailbox: GmailAlias): string {
  return `Inbound Gmail reference for ${mailbox}@tryauranode.com. Thread and message ids are attached as structured metadata for the reply workflow.`;
}

// Build first-class structured comment metadata carrying the safe Gmail
// references. This is the issue-visible contract the reply workflow relies on
// instead of parsing free-text descriptions/comments.
function buildGmailReferenceMetadata(
  mailbox: GmailAlias,
  parsed: ParsedMessage,
  opts: { includeSubject?: boolean } = {},
): IssueCommentMetadata {
  const rows: IssueCommentMetadataSection["rows"] = [
    { type: "key_value", label: "Mailbox", value: `${mailbox}@tryauranode.com` },
    { type: "key_value", label: "From", value: sanitizeHeaderValue(parsed.from) || "(unknown)" },
  ];
  if (opts.includeSubject) {
    rows.push({
      type: "key_value",
      label: "Subject",
      value: sanitizeHeaderValue(parsed.subject) || "(no subject)",
    });
  }
  rows.push(
    {
      type: "key_value",
      label: "Received",
      value: parsed.dateMs ? new Date(parsed.dateMs).toISOString() : "unknown",
    },
    { type: "key_value", label: "Gmail thread ID", value: parsed.gmailThreadId },
    { type: "key_value", label: "Gmail message ID", value: parsed.gmailMessageId },
  );
  return {
    version: 1,
    sections: [{ title: "Gmail reference", rows }],
  };
}
