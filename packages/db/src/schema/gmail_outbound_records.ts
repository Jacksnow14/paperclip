import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const gmailOutboundRecords = pgTable(
  "gmail_outbound_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mailbox: text("mailbox").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    recipient: text("recipient"),
    subject: text("subject"),
    snippet: text("snippet"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageUniqueIdx: uniqueIndex("gmail_outbound_message_uq").on(
      table.companyId,
      table.mailbox,
      table.gmailMessageId,
    ),
    threadIdx: index("gmail_outbound_thread_idx").on(
      table.companyId,
      table.mailbox,
      table.gmailThreadId,
    ),
  }),
);
