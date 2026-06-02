CREATE TABLE IF NOT EXISTS "memory_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"kind" text DEFAULT 'manual_note' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_records_company_id_companies_id_fk') THEN
		ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_records_agent_id_agents_id_fk') THEN
		ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_company_created_idx" ON "memory_records" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_agent_idx" ON "memory_records" ("agent_id");
