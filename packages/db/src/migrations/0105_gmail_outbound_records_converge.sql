-- AUR-4674: converge gmail_outbound_records with the live control-plane DB.
--
-- The live table was hand-created (pre-0099) WITHOUT "snippet", and 0099's
-- CREATE TABLE IF NOT EXISTS no-ops against it — so every AUR-1796 chokepoint
-- tracking INSERT (which names "snippet") has failed with `column "snippet"
-- does not exist` since it shipped, swallowed by the best-effort catch. The
-- outbound audit trail was silently dead: 0 rows ever written. Measured live
-- 2026-08-12 (rollback-transaction probe on the production DB).
--
-- Same idempotency doctrine as 0098/0099: the live DB may or may not already
-- have each of these columns, so every statement must survive re-execution.
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "snippet" text;
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'sent' NOT NULL;
