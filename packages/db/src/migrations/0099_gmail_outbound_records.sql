-- Idempotency guards (AUR-5004 review of the 0098 fix): the live control-plane DB
-- already has a hand-created gmail_outbound_records table but no journal row for
-- this migration. Boot-time history reconciliation only repairs a contiguous prefix
-- of pending migrations it can prove applied, and the 0098 data-convergence UPDATE
-- ahead of this file is not provable — so this migration WILL be re-executed raw
-- against a database where these objects already exist. Same doctrine as 0098:
-- every statement must survive re-execution over live data (2026-08-05 outage).
CREATE TABLE IF NOT EXISTS "gmail_outbound_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"recipient" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'gmail_outbound_records_company_id_companies_id_fk'
			AND conrelid = '"gmail_outbound_records"'::regclass
	) THEN
		ALTER TABLE "gmail_outbound_records" ADD CONSTRAINT "gmail_outbound_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_outbound_message_uq" ON "gmail_outbound_records" USING btree ("company_id","mailbox","gmail_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_outbound_thread_idx" ON "gmail_outbound_records" USING btree ("company_id","mailbox","gmail_thread_id");
