CREATE TABLE "ship_ratio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"money_making_merged" integer NOT NULL,
	"self_improvement_merged" integer NOT NULL,
	"money_making_closed_without_merge" integer DEFAULT 0 NOT NULL,
	"self_improvement_closed_without_merge" integer DEFAULT 0 NOT NULL,
	"ratio" double precision NOT NULL,
	"floor_ratio" double precision DEFAULT 2 NOT NULL,
	"over_cap" boolean NOT NULL,
	"disagreements" jsonb,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ship_ratio_snapshots" ADD CONSTRAINT "ship_ratio_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ship_ratio_snapshots" ADD CONSTRAINT "ship_ratio_snapshots_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ship_ratio_snapshots_company_created_idx" ON "ship_ratio_snapshots" USING btree ("company_id","created_at");
