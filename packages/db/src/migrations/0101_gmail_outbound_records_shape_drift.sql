-- AUR-5015: the live control-plane DB's gmail_outbound_records table was
-- hand-created before migration 0099 ever ran, with a richer shape than the
-- ORM schema: status (text NOT NULL DEFAULT 'sent'), campaign, sent_by_agent_id
-- (FK agents), issue_id (FK issues) present, snippet missing, recipient NOT
-- NULL. 0099's CREATE TABLE IF NOT EXISTS no-ops against that pre-existing
-- table, so it never converges the shape. No writer in-repo (or on the host)
-- references status/campaign/sent_by_agent_id/issue_id and the live table has
-- 0 rows, so nothing depends on their current values; the columns themselves
-- are kept (not dropped) since a live hand-created shape may reflect intended
-- design this migration should not destroy.
--
-- This migration converges BOTH directions so the ORM schema and the DB agree
-- regardless of starting point:
--   - a scratch/fresh DB built purely from 0099 gains the extra columns
--   - the drifted live DB gains the missing snippet column
-- Every statement must survive re-execution over live data (AUR-5002 doctrine
-- carried forward from 0098/0099 for this same table).

ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "snippet" text;
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'sent';
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "campaign" text;
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "sent_by_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ALTER COLUMN "recipient" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'gmail_outbound_records_sent_by_agent_id_agents_id_fk'
			AND conrelid = '"gmail_outbound_records"'::regclass
	) THEN
		ALTER TABLE "gmail_outbound_records" ADD CONSTRAINT "gmail_outbound_records_sent_by_agent_id_agents_id_fk" FOREIGN KEY ("sent_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE SET NULL ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'gmail_outbound_records_issue_id_issues_id_fk'
			AND conrelid = '"gmail_outbound_records"'::regclass
	) THEN
		ALTER TABLE "gmail_outbound_records" ADD CONSTRAINT "gmail_outbound_records_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL ON UPDATE no action;
	END IF;
END $$;
