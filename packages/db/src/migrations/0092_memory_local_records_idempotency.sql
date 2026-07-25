ALTER TABLE "memory_local_records" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_local_records_company_idempotency_uq"
  ON "memory_local_records" USING btree ("company_id","idempotency_key")
  WHERE "memory_local_records"."idempotency_key" IS NOT NULL;
