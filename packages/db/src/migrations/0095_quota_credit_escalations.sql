CREATE TABLE "quota_credit_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"episode_key" text NOT NULL,
	"rate_limit_type" text,
	"overage_disabled_reason" text,
	"reset_at" timestamp with time zone,
	"telegram_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quota_credit_escalations" ADD CONSTRAINT "quota_credit_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quota_credit_escalations" ADD CONSTRAINT "quota_credit_escalations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quota_credit_escalations" ADD CONSTRAINT "quota_credit_escalations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quota_credit_escalations" ADD CONSTRAINT "quota_credit_escalations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "quota_credit_escalations_company_agent_episode_uq" ON "quota_credit_escalations" USING btree ("company_id","agent_id","episode_key");
--> statement-breakpoint
CREATE INDEX "quota_credit_escalations_company_created_idx" ON "quota_credit_escalations" USING btree ("company_id","created_at");
