CREATE TABLE "memory_binding_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"provider_key" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_extraction_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"operation_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_job_id" text,
	"source_kind" text,
	"source_issue_id" uuid,
	"source_comment_id" uuid,
	"source_document_key" text,
	"source_run_id" uuid,
	"source_activity_id" uuid,
	"source_external_ref" text,
	"result_json" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_local_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"scope_agent_id" uuid,
	"scope_project_id" uuid,
	"scope_issue_id" uuid,
	"scope_run_id" uuid,
	"scope_subject_id" text,
	"scope_type" text DEFAULT 'org' NOT NULL,
	"scope_id" text,
	"scope_workspace_id" text,
	"scope_team_id" text,
	"source_kind" text,
	"source_issue_id" uuid,
	"source_comment_id" uuid,
	"source_document_key" text,
	"source_run_id" uuid,
	"source_activity_id" uuid,
	"source_external_ref" text,
	"title" text,
	"content" text NOT NULL,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_type" text,
	"owner_id" text,
	"created_by_actor_type" text,
	"created_by_actor_id" text,
	"sensitivity_label" text DEFAULT 'internal' NOT NULL,
	"retention_policy" jsonb,
	"expires_at" timestamp with time zone,
	"retention_state" text DEFAULT 'active' NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_actor_type" text,
	"reviewed_by_actor_id" text,
	"review_note" text,
	"citation_json" jsonb,
	"supersedes_record_id" uuid,
	"superseded_by_record_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_actor_type" text,
	"revoked_by_actor_id" text,
	"revocation_reason" text,
	"created_by_operation_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"operation_type" text NOT NULL,
	"trigger_kind" text DEFAULT 'manual' NOT NULL,
	"hook_kind" text,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"scope_agent_id" uuid,
	"scope_project_id" uuid,
	"scope_issue_id" uuid,
	"scope_run_id" uuid,
	"scope_subject_id" text,
	"scope_type" text,
	"scope_id" text,
	"scope_workspace_id" text,
	"scope_team_id" text,
	"max_sensitivity_label" text,
	"source_kind" text,
	"source_issue_id" uuid,
	"source_comment_id" uuid,
	"source_document_key" text,
	"source_run_id" uuid,
	"source_activity_id" uuid,
	"source_external_ref" text,
	"query_text" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"request_json" jsonb,
	"result_json" jsonb,
	"policy_decision_json" jsonb,
	"revocation_selector_json" jsonb,
	"retention_action_json" jsonb,
	"usage_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"cost_event_id" uuid,
	"finance_event_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_operation_id_memory_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."memory_operations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_scope_agent_id_agents_id_fk" FOREIGN KEY ("scope_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_scope_project_id_projects_id_fk" FOREIGN KEY ("scope_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_scope_issue_id_issues_id_fk" FOREIGN KEY ("scope_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_scope_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD CONSTRAINT "memory_local_records_created_by_operation_id_memory_operations_id_fk" FOREIGN KEY ("created_by_operation_id") REFERENCES "public"."memory_operations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_scope_agent_id_agents_id_fk" FOREIGN KEY ("scope_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_scope_project_id_projects_id_fk" FOREIGN KEY ("scope_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_scope_issue_id_issues_id_fk" FOREIGN KEY ("scope_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_scope_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_activity_id_activity_log_id_fk" FOREIGN KEY ("source_activity_id") REFERENCES "public"."activity_log"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_finance_event_id_finance_events_id_fk" FOREIGN KEY ("finance_event_id") REFERENCES "public"."finance_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_binding_targets_company_target_idx" ON "memory_binding_targets" USING btree ("company_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "memory_binding_targets_company_binding_idx" ON "memory_binding_targets" USING btree ("company_id","binding_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_bindings_company_key_idx" ON "memory_bindings" USING btree ("company_id","key");
--> statement-breakpoint
CREATE INDEX "memory_bindings_company_provider_idx" ON "memory_bindings" USING btree ("company_id","provider_key");
--> statement-breakpoint
CREATE INDEX "memory_extraction_jobs_company_status_created_idx" ON "memory_extraction_jobs" USING btree ("company_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "memory_extraction_jobs_company_binding_created_idx" ON "memory_extraction_jobs" USING btree ("company_id","binding_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_binding_created_idx" ON "memory_local_records" USING btree ("company_id","binding_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_agent_created_idx" ON "memory_local_records" USING btree ("company_id","scope_agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_issue_created_idx" ON "memory_local_records" USING btree ("company_id","scope_issue_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_scope_created_idx" ON "memory_local_records" USING btree ("company_id","scope_type","scope_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_sensitivity_created_idx" ON "memory_local_records" USING btree ("company_id","sensitivity_label","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_retention_created_idx" ON "memory_local_records" USING btree ("company_id","retention_state","expires_at","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_company_review_created_idx" ON "memory_local_records" USING btree ("company_id","review_state","created_at");
--> statement-breakpoint
CREATE INDEX "memory_local_records_fts_idx" ON "memory_local_records" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || "content"));
--> statement-breakpoint
CREATE INDEX "memory_operations_company_occurred_idx" ON "memory_operations" USING btree ("company_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "memory_operations_company_binding_occurred_idx" ON "memory_operations" USING btree ("company_id","binding_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "memory_operations_company_issue_occurred_idx" ON "memory_operations" USING btree ("company_id","scope_issue_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "memory_operations_company_run_occurred_idx" ON "memory_operations" USING btree ("company_id","scope_run_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "memory_operations_company_scope_occurred_idx" ON "memory_operations" USING btree ("company_id","scope_type","scope_id","occurred_at");
