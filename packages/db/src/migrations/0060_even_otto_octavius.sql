ALTER TABLE "issues" ADD COLUMN "retry_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "rate_limit_retry_count" integer DEFAULT 0 NOT NULL;