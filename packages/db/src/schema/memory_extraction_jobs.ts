import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";
import { memoryOperations } from "./memory_operations.js";
import type { MemoryExtractionJobStatus, MemorySourceKind } from "@paperclipai/shared";

export const memoryExtractionJobs = pgTable(
  "memory_extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => memoryBindings.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    operationId: uuid("operation_id").references(() => memoryOperations.id, { onDelete: "set null" }),
    status: text("status").$type<MemoryExtractionJobStatus>().notNull().default("queued"),
    providerJobId: text("provider_job_id"),
    sourceKind: text("source_kind").$type<MemorySourceKind>(),
    sourceIssueId: uuid("source_issue_id"),
    sourceCommentId: uuid("source_comment_id"),
    sourceDocumentKey: text("source_document_key"),
    sourceRunId: uuid("source_run_id"),
    sourceActivityId: uuid("source_activity_id"),
    sourceExternalRef: text("source_external_ref"),
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusCreatedIdx: index("memory_extraction_jobs_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyBindingCreatedIdx: index("memory_extraction_jobs_company_binding_created_idx").on(
      table.companyId,
      table.bindingId,
      table.createdAt,
    ),
  }),
);
