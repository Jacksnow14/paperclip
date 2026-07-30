import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Recorded when an issue is hard-deleted (issueService.remove), before its
 * row disappears from `issues`. Lets the memory-capture guard (AUR-3996)
 * distinguish "this identifier referred to a real issue that was later
 * deleted" from "this identifier never existed" — the former should still
 * resolve, the latter should still 422. `issueId` deliberately has no FK
 * back to `issues`: the whole point of this table is to outlive that row.
 */
export const issueTombstones = pgTable(
  "issue_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    identifier: text("identifier"),
    title: text("title"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: uniqueIndex("issue_tombstones_company_issue_uq").on(table.companyId, table.issueId),
    companyIdentifierIdx: index("issue_tombstones_company_identifier_idx").on(table.companyId, table.identifier),
  }),
);
