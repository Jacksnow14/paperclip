-- AUR-5952: agent memory store MVP.
--
-- "embedding" is a plain real[] array, not a native pgvector column: the
-- embedded-postgres binary this platform ships (@embedded-postgres/linux-x64)
-- has no vector.control file, so "CREATE EXTENSION vector" is not installable
-- against it. Similarity search is computed in application code (cosine
-- similarity over the float array) in server/src/services/agent-memory.ts.
-- A dedicated pgvector-capable Postgres instance is a follow-up infra
-- decision, not something this migration can provision.
CREATE TABLE IF NOT EXISTS "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"namespace" text DEFAULT 'default' NOT NULL,
	"content" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_memories_agent_id_agents_id_fk'
			AND conrelid = '"agent_memories"'::regclass
	) THEN
		ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_memories_company_id_companies_id_fk'
			AND conrelid = '"agent_memories"'::regclass
	) THEN
		ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_agent_namespace_idx" ON "agent_memories" USING btree ("agent_id","namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_company_idx" ON "agent_memories" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_expires_at_idx" ON "agent_memories" USING btree ("expires_at");
