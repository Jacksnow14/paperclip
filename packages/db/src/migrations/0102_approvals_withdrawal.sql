-- AUR-5344: requester-initiated withdrawal of an own pending approval.
--
-- `withdrawn` is a terminal status DISTINCT from `rejected`. `rejected` carries
-- board judgement; `withdrawn` carries "the requester says this artifact is
-- defective". Different meanings, so different audit columns — a withdrawal
-- must never leave a row that looks like the board judged it, which is why the
-- withdrawal actor/time/reason do not reuse decided_by_user_id / decided_at /
-- decision_note.
--
-- superseded_by_approval_id links a retired row FORWARD to its replacement so
-- the board can tell a stale duplicate from the live request at the point of
-- clicking, rather than seeing two byte-identical titles.
--
-- Every statement is re-execution safe (same doctrine as 0098/0099): boot-time
-- history reconciliation can replay a migration raw against a database where
-- the objects already exist.
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawn_by_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawn_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawal_reason" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "superseded_by_approval_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'approvals_withdrawn_by_agent_id_agents_id_fk'
			AND conrelid = '"approvals"'::regclass
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_withdrawn_by_agent_id_agents_id_fk" FOREIGN KEY ("withdrawn_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'approvals_superseded_by_approval_id_approvals_id_fk'
			AND conrelid = '"approvals"'::regclass
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_superseded_by_approval_id_approvals_id_fk" FOREIGN KEY ("superseded_by_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
