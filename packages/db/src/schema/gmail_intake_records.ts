import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const gmailIntakeRecords = pgTable(
  "gmail_intake_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mailbox: text("mailbox").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    sender: text("sender"),
    subject: text("subject"),
    snippet: text("snippet"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageUniqueIdx: uniqueIndex("gmail_intake_message_uq").on(
      table.companyId,
      table.mailbox,
      table.gmailMessageId,
    ),
    threadIdx: index("gmail_intake_thread_idx").on(
      table.companyId,
      table.mailbox,
      table.gmailThreadId,
    ),
  }),
);
