CREATE UNIQUE INDEX "memory_local_records_routing_rationale_title_uq" ON "memory_local_records" USING btree ("company_id","title") WHERE "memory_local_records"."metadata"->>'category' = 'routing_rationale'
          and "memory_local_records"."review_state" = 'accepted'
          and "memory_local_records"."revoked_at" is null
          and "memory_local_records"."superseded_by_record_id" is null
          and "memory_local_records"."deleted_at" is null;
