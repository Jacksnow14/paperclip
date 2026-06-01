ALTER TABLE "routine_triggers" ADD COLUMN "run_limit" integer;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "trigger_payload" jsonb;
