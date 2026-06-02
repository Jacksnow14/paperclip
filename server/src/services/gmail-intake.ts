import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, gmailIntakeRecords, issues } from "@paperclipai/db";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { createGmailService, GMAIL_SUPPORTED_ALIASES, type GmailAlias } from "./gmail.js";
import { issueService } from "./issues.js";

// Mailbox → agent role for default ownership routing.
const MAILBOX_ROLE: Record<GmailAlias, string> = {
  board: "ceo",
  alex: "cmo",
  leo: "cto",
  adrian: "cfo",
};

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

function parseMessage(
  msg: {
    id?: string | null;
    threadId?: string | null;
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
  const from = sanitizeHeaderValue(extractHeader(headers, "from"));
  const subject = sanitizeHeaderValue(extractHeader(headers, "subject")) || "(no subject)";
  const dateStr = extractHeader(headers, "date");
  const dateMs = dateStr ? new Date(dateStr).getTime() : null;

  const bodyText = msg.payload ? extractTextBody(msg.payload) : "";
  const bodySnippet = (bodyText || msg.snippet || "").slice(0, SNIPPET_MAX_CHARS);

  return { from, subject, dateMs, bodySnippet, gmailThreadId, gmailMessageId };
}

async function resolveAssigneeAgentId(
  db: Pick<Db, "select">,
  companyId: string,
  mailbox: GmailAlias,
): Promise<string | null> {
  const role = MAILBOX_ROLE[mailbox];
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
  const gmail = createGmailService();
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
        // Find any existing record in this Gmail thread that has an issueId.
        const existingThreadRecord = await db
          .select({ issueId: gmailIntakeRecords.issueId })
          .from(gmailIntakeRecords)
          .where(
            and(
              eq(gmailIntakeRecords.companyId, companyId),
              eq(gmailIntakeRecords.mailbox, mailbox),
              eq(gmailIntakeRecords.gmailThreadId, parsed.gmailThreadId),
            ),
          )
          .limit(1);

        const existingIssueId = existingThreadRecord[0]?.issueId ?? null;

        let issueId: string;

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
          // New thread — create a new issue in an actionable, routed status
          // (`todo`) so the assignee picks it up rather than letting it sit in
          // `backlog`.
          const assigneeAgentId = await resolveAssigneeAgentId(db, companyId, mailbox);
          const issueTitle = buildIssueTitle(mailbox, parsed.subject);
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

        // Record the intake so we don't process this message again.
        await db.insert(gmailIntakeRecords).values({
          companyId,
          mailbox,
          gmailThreadId: parsed.gmailThreadId,
          gmailMessageId: parsed.gmailMessageId,
          issueId,
          sender: parsed.from.slice(0, 512),
          subject: parsed.subject.slice(0, 512),
          snippet: parsed.bodySnippet.slice(0, 512),
          receivedAt: parsed.dateMs ? new Date(parsed.dateMs) : null,
        });

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

function buildIssueTitle(mailbox: GmailAlias, subject: string): string {
  return `[${mailbox}@tryauranode.com] ${subject}`.slice(0, 255);
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
  const rows: IssueCommentMetadata["sections"][number]["rows"] = [
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
