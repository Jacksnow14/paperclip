CREATE TABLE IF NOT EXISTS "issue_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"identifier" text,
	"title" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_tombstones_company_id_companies_id_fk') THEN
		ALTER TABLE "issue_tombstones" ADD CONSTRAINT "issue_tombstones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_tombstones_company_issue_uq" ON "issue_tombstones" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_tombstones_company_identifier_idx" ON "issue_tombstones" USING btree ("company_id","identifier");
