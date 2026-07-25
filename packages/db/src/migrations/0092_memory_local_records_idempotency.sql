ALTER TABLE "memory_local_records" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_local_records_company_idempotency_uq"
  ON "memory_local_records" USING btree ("company_id","owner_type","owner_id","idempotency_key")
  WHERE "memory_local_records"."idempotency_key" IS NOT NULL
    AND "memory_local_records"."revoked_at" IS NULL
    AND "memory_local_records"."deleted_at" IS NULL
    AND "memory_local_records"."superseded_by_record_id" IS NULL;
