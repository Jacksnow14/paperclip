import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { gmailOutboundRecords } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type OutboundStatus = "sent" | "bounced" | "failed";
export type ConversationResponseStatus = "needs-pickup" | "awaiting-reply" | "replied";

export interface PersistSendParams {
  companyId: string;
  mailbox: string;
  gmailThreadId: string;
  gmailMessageId: string;
  recipient: string;
  subject?: string;
  status?: OutboundStatus;
  campaign?: string;
  sentByAgentId?: string | null;
  issueId?: string | null;
  sentAt?: Date;
}

export interface ConversationFilters {
  mailbox?: string;
  owner?: string;
  status?: ConversationResponseStatus;
  campaign?: string;
}

export interface ConversationRow {
  mailbox: string;
  threadId: string;
  contact: string | null;
  owner: string;
  campaign: string | null;
  lastOutbound: { subject: string | null; sentAt: Date | null } | null;
  lastInbound: { subject: string | null; sender: string | null; receivedAt: Date | null } | null;
  whoReplied: string | null;
  responseStatus: ConversationResponseStatus;
}

const MAILBOX_OWNER: Record<string, string> = {
  board: "ceo",
  alex: "cmo",
  leo: "cto",
  adrian: "cfo",
};

function deriveOwner(mailbox: string): string {
  const alias = mailbox.split("@")[0] ?? mailbox;
  return MAILBOX_OWNER[alias] ?? alias;
}

export function createGmailOutboundService(db: Db) {
  async function persistSend(params: PersistSendParams): Promise<void> {
    try {
      await db.insert(gmailOutboundRecords).values({
        companyId: params.companyId,
        mailbox: params.mailbox,
        gmailThreadId: params.gmailThreadId,
        gmailMessageId: params.gmailMessageId,
        recipient: params.recipient,
        subject: params.subject ?? null,
        status: params.status ?? "sent",
        campaign: params.campaign ?? null,
        sentByAgentId: params.sentByAgentId ?? null,
        issueId: params.issueId ?? null,
        sentAt: params.sentAt ?? new Date(),
      });
    } catch (err) {
      logger.error({ err, params }, "gmail-outbound: failed to persist send record");
    }
  }

  async function queryConversations(
    companyId: string,
    filters: ConversationFilters = {},
  ): Promise<ConversationRow[]> {
    const result = await db.execute<{
      mailbox: string;
      thread_id: string;
      contact: string | null;
      out_subject: string | null;
      sent_at: Date | null;
      in_subject: string | null;
      who_replied: string | null;
      received_at: Date | null;
      campaign: string | null;
      response_status: ConversationResponseStatus;
    }>(sql`
      WITH last_out AS (
        SELECT DISTINCT ON (company_id, mailbox, gmail_thread_id)
          company_id,
          mailbox,
          gmail_thread_id,
          subject AS out_subject,
          recipient,
          campaign,
          sent_at
        FROM gmail_outbound_records
        WHERE company_id = ${companyId}::uuid
        ORDER BY company_id, mailbox, gmail_thread_id, sent_at DESC NULLS LAST
      ),
      last_in AS (
        SELECT DISTINCT ON (company_id, mailbox, gmail_thread_id)
          company_id,
          mailbox,
          gmail_thread_id,
          subject AS in_subject,
          sender,
          received_at
        FROM gmail_intake_records
        WHERE company_id = ${companyId}::uuid
        ORDER BY company_id, mailbox, gmail_thread_id, received_at DESC NULLS LAST
      ),
      threads AS (
        SELECT
          COALESCE(o.mailbox, i.mailbox) AS mailbox,
          COALESCE(o.gmail_thread_id, i.gmail_thread_id) AS thread_id,
          COALESCE(o.recipient, i.sender) AS contact,
          o.out_subject,
          o.sent_at,
          o.campaign,
          i.in_subject,
          i.sender AS who_replied,
          i.received_at,
          CASE
            WHEN o.sent_at IS NULL THEN 'needs-pickup'
            WHEN i.received_at IS NULL THEN 'awaiting-reply'
            WHEN i.received_at > o.sent_at THEN 'replied'
            ELSE 'awaiting-reply'
          END AS response_status
        FROM last_out o
        FULL OUTER JOIN last_in i
          ON o.company_id = i.company_id
          AND o.mailbox = i.mailbox
          AND o.gmail_thread_id = i.gmail_thread_id
      )
      SELECT *
      FROM threads
      ORDER BY
        CASE response_status
          WHEN 'needs-pickup' THEN 0
          WHEN 'replied' THEN 1
          ELSE 2
        END,
        COALESCE(received_at, sent_at) DESC NULLS LAST
    `);

    let rows = result.rows as typeof result.rows;

    if (filters.mailbox) {
      rows = rows.filter((r) => r.mailbox === filters.mailbox);
    }
    if (filters.owner) {
      rows = rows.filter((r) => deriveOwner(r.mailbox) === filters.owner);
    }
    if (filters.status) {
      rows = rows.filter((r) => r.response_status === filters.status);
    }
    if (filters.campaign) {
      rows = rows.filter((r) => r.campaign === filters.campaign);
    }

    return rows.map((r) => ({
      mailbox: r.mailbox,
      threadId: r.thread_id,
      contact: r.contact ?? null,
      owner: deriveOwner(r.mailbox),
      campaign: r.campaign ?? null,
      lastOutbound: r.sent_at !== null || r.out_subject !== null
        ? { subject: r.out_subject ?? null, sentAt: r.sent_at ? new Date(r.sent_at) : null }
        : null,
      lastInbound: r.received_at !== null || r.in_subject !== null
        ? {
            subject: r.in_subject ?? null,
            sender: r.who_replied ?? null,
            receivedAt: r.received_at ? new Date(r.received_at) : null,
          }
        : null,
      whoReplied: r.who_replied ?? null,
      responseStatus: r.response_status,
    }));
  }

  return { persistSend, queryConversations };
}

export type GmailOutboundService = ReturnType<typeof createGmailOutboundService>;
