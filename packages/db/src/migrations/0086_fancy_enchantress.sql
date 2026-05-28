ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "retry_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "rate_limit_retry_count" integer DEFAULT 0 NOT NULL;
