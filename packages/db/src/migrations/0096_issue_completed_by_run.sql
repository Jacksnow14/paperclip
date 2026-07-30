ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completed_by_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_completed_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("completed_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
