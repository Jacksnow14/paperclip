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
    // AUR-4674: how this row was produced. "sent" = recorded by the sendMessage()
    // chokepoint at dispatch time. "out_of_band*" = discovered by the outbound
    // reconciler in the mailbox's SENT label with no chokepoint record — i.e. a
    // send that bypassed the control plane (raw SA-key send, co-tenant, script).
    status: text("status").notNull().default("sent"),
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
