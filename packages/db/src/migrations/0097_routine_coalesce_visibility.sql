ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "consecutive_coalesce_count" integer NOT NULL DEFAULT 0;
