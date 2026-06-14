// AUR-2215: Telegram bot intake service.
// Mirrors the gmail-intake.ts pattern: dedup via telegramIntakeRecords,
// create one Paperclip issue per unique reel URL, track chatId→issueId for relay.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { telegramIntakeRecords } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

const INSTAGRAM_REEL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+\/?[^\s]*/i;

export interface TelegramIntakeOptions {
  db: Db;
  companyId: string;
  assigneeAgentId?: string | null;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  date: number;
}

function extractReelUrl(text: string): string | null {
  const m = text.match(INSTAGRAM_REEL_RE);
  return m ? m[0] : null;
}

function buildIssueTitle(reelUrl: string): string {
  return `[reel-intake] ${reelUrl}`.slice(0, 255);
}

function buildIssueDescription(reelUrl: string, chatId: number, messageId: number, receivedAt: Date): string {
  return [
    `**Inbound reel shared via Telegram bot**`,
    "",
    `- **Reel URL:** ${reelUrl}`,
    `- **Telegram chat ID:** \`${chatId}\``,
    `- **Telegram message ID:** \`${messageId}\``,
    `- **Received:** ${receivedAt.toISOString()}`,
    "",
    `exec.labels: reel-intake`,
  ].join("\n");
}

export function createTelegramIntakeService(opts: TelegramIntakeOptions) {
  const { db, companyId, assigneeAgentId } = opts;
  const isvc = issueService(db);

  async function processMessage(msg: TelegramMessage): Promise<{
    action: "created" | "skipped" | "no_url";
    issueId?: string;
    reelUrl?: string;
  }> {
    const text = msg.text ?? msg.caption ?? "";
    const reelUrl = extractReelUrl(text);

    if (!reelUrl) {
      return { action: "no_url" };
    }

    const chatId = String(msg.chat.id);
    const messageId = String(msg.message_id);

    // Dedup: skip if we've already processed this Telegram message.
    const existing = await db
      .select({ id: telegramIntakeRecords.id, issueId: telegramIntakeRecords.issueId })
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.companyId, companyId),
          eq(telegramIntakeRecords.telegramMessageId, messageId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return { action: "skipped", issueId: existing[0].issueId ?? undefined, reelUrl };
    }

    const receivedAt = new Date(msg.date * 1000);
    const issueTitle = buildIssueTitle(reelUrl);
    const issueDescription = buildIssueDescription(reelUrl, msg.chat.id, msg.message_id, receivedAt);

    const issue = await isvc.create(companyId, {
      title: issueTitle,
      description: issueDescription,
      status: "todo",
      priority: "medium",
      originKind: "reel_intake",
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
    });

    await db.insert(telegramIntakeRecords).values({
      companyId,
      telegramChatId: chatId,
      telegramMessageId: messageId,
      issueId: issue.id,
      reelUrl: reelUrl.slice(0, 512),
      snippet: text.slice(0, 512),
      receivedAt,
    });

    logger.info({ companyId, issueId: issue.id, reelUrl, chatId }, "telegram-intake: created reel-intake issue");

    return { action: "created", issueId: issue.id, reelUrl };
  }

  async function getChatIdForIssue(issueId: string): Promise<string | null> {
    const rows = await db
      .select({ telegramChatId: telegramIntakeRecords.telegramChatId })
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.companyId, companyId),
          eq(telegramIntakeRecords.issueId, issueId),
        ),
      )
      .limit(1);
    return rows[0]?.telegramChatId ?? null;
  }

  return { processMessage, getChatIdForIssue };
}

export type TelegramIntakeService = ReturnType<typeof createTelegramIntakeService>;
