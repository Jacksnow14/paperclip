import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const telegramIntakeRecords = pgTable(
  "telegram_intake_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    telegramChatId: text("telegram_chat_id").notNull(),
    telegramMessageId: text("telegram_message_id").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    reelUrl: text("reel_url"),
    snippet: text("snippet"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageUniqueIdx: uniqueIndex("telegram_intake_message_uq").on(
      table.companyId,
      table.telegramMessageId,
    ),
    chatIdx: index("telegram_intake_chat_idx").on(
      table.companyId,
      table.telegramChatId,
    ),
  }),
);
