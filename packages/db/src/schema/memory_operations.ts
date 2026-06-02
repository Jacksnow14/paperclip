import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { activityLog } from "./activity_log.js";
import { costEvents } from "./cost_events.js";
import { financeEvents } from "./finance_events.js";
import { memoryBindings } from "./memory_bindings.js";
import type {
  MemoryHookKind,
  MemoryOperationStatus,
  MemoryOperationType,
  MemoryScopeType,
  MemorySensitivityLabel,
  MemorySourceKind,
  MemoryTriggerKind,
} from "@paperclipai/shared";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => memoryBindings.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    operationType: text("operation_type").$type<MemoryOperationType>().notNull(),
    triggerKind: text("trigger_kind").$type<MemoryTriggerKind>().notNull().default("manual"),
    hookKind: text("hook_kind").$type<MemoryHookKind>(),
    status: text("status").$type<MemoryOperationStatus>().notNull().default("succeeded"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    userId: text("user_id"),
    scopeAgentId: uuid("scope_agent_id").references(() => agents.id),
    scopeProjectId: uuid("scope_project_id").references(() => projects.id),
    scopeIssueId: uuid("scope_issue_id").references(() => issues.id),
    scopeRunId: uuid("scope_run_id").references(() => heartbeatRuns.id),
    scopeSubjectId: text("scope_subject_id"),
    scopeType: text("scope_type").$type<MemoryScopeType>(),
    scopeId: text("scope_id"),
    scopeWorkspaceId: text("scope_workspace_id"),
    scopeTeamId: text("scope_team_id"),
    maxSensitivityLabel: text("max_sensitivity_label").$type<MemorySensitivityLabel>(),
    sourceKind: text("source_kind").$type<MemorySourceKind>(),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id),
    sourceDocumentKey: text("source_document_key"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id),
    sourceActivityId: uuid("source_activity_id").references(() => activityLog.id),
    sourceExternalRef: text("source_external_ref"),
    queryText: text("query_text"),
    recordCount: integer("record_count").notNull().default(0),
    requestJson: jsonb("request_json").$type<Record<string, unknown> | null>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    policyDecisionJson: jsonb("policy_decision_json").$type<Record<string, unknown> | null>(),
    revocationSelectorJson: jsonb("revocation_selector_json").$type<Record<string, unknown> | null>(),
    retentionActionJson: jsonb("retention_action_json").$type<Record<string, unknown> | null>(),
    usageJson: jsonb("usage_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    error: text("error"),
    costEventId: uuid("cost_event_id").references(() => costEvents.id),
    financeEventId: uuid("finance_event_id").references(() => financeEvents.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("memory_operations_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyBindingOccurredIdx: index("memory_operations_company_binding_occurred_idx").on(
      table.companyId,
      table.bindingId,
      table.occurredAt,
    ),
    companyIssueOccurredIdx: index("memory_operations_company_issue_occurred_idx").on(
      table.companyId,
      table.scopeIssueId,
      table.occurredAt,
    ),
    companyRunOccurredIdx: index("memory_operations_company_run_occurred_idx").on(
      table.companyId,
      table.scopeRunId,
      table.occurredAt,
    ),
    companyScopeOccurredIdx: index("memory_operations_company_scope_occurred_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.occurredAt,
    ),
  }),
);
