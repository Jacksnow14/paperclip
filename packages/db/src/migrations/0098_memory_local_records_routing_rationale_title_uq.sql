-- A unique index over live data fails closed: if ANY duplicate already exists the
-- CREATE aborts, the migrator throws, and the server never finishes boot. That is
-- not hypothetical — this exact statement crash-looped the whole control plane on
-- 2026-08-05 16:31Z (release 709fc73ae0b6, 36 restarts, fleet-wide outage) on
-- `Key (company_id, title)=(..., routing/AUR-4140) is duplicated`. 65 duplicate
-- title groups / 86 surplus rows had accumulated before AUR-3991 made the capture
-- idempotent, and this migration assumed they were not there.
--
-- So converge the data FIRST, in the same migration, then build the index. Both
-- steps are idempotent: re-running is a no-op.
--
-- Convergence rule: within a (company_id, title) group the newest row wins and the
-- older ones are marked `superseded_by_record_id = <winner>`. Nothing is deleted or
-- renamed — superseded rows drop out of the index predicate below and out of agent
-- reads, and readers already resolve a re-routed issue by max(createdAt) (AUR-4280),
-- so the surviving row is the one they would have picked anyway.
UPDATE "memory_local_records" AS loser
SET "superseded_by_record_id" = winner."id",
    "updated_at" = now()
FROM (
  SELECT DISTINCT ON ("company_id", "title") "company_id", "title", "id"
  FROM "memory_local_records"
  WHERE "metadata"->>'category' = 'routing_rationale'
    AND "review_state" = 'accepted'
    AND "revoked_at" IS NULL
    AND "superseded_by_record_id" IS NULL
    AND "deleted_at" IS NULL
  ORDER BY "company_id", "title", "created_at" DESC, "id" DESC
) AS winner
WHERE loser."company_id" = winner."company_id"
  AND loser."title" = winner."title"
  AND loser."id" <> winner."id"
  AND loser."metadata"->>'category' = 'routing_rationale'
  AND loser."review_state" = 'accepted'
  AND loser."revoked_at" IS NULL
  AND loser."superseded_by_record_id" IS NULL
  AND loser."deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "memory_local_records_routing_rationale_title_uq" ON "memory_local_records" USING btree ("company_id","title") WHERE "memory_local_records"."metadata"->>'category' = 'routing_rationale'
          and "memory_local_records"."review_state" = 'accepted'
          and "memory_local_records"."revoked_at" is null
          and "memory_local_records"."superseded_by_record_id" is null
          and "memory_local_records"."deleted_at" is null;
