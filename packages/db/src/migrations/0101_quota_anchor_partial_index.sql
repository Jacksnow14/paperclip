-- AUR-5064: the AUR-5038 anchor lookup in quota-auth-reclassification.ts was a
-- 2-second scan of the 1.3 GB heartbeat_runs table (measured live on the PR
-- review; still 700-850 ms after the 0100 hot-path indexes landed, because the
-- planner had to heap-fetch and de-TOAST ~23k rows per 8-day window to evaluate
-- the jsonb filters). This partial index mirrors the anchor predicate EXACTLY,
-- so the planner proves the whole filter from the index predicate and walks
-- (company_id, created_at DESC) to the first row: measured 0.04-0.08 ms live.
--
-- COUPLING WARNING: the regex below IS fleet-capacity.ts QUOTA_SIGNATURE_RE and
-- the other clauses ARE the anchor conditions in quota-auth-reclassification.ts
-- (gatherClaudeAuthQuotaLaneHistory). Postgres only uses a partial index when
-- the query predicate provably implies the index predicate — if either side
-- changes without the other, nothing breaks functionally but the anchor lookup
-- silently reverts to the ~850 ms plan. A regex-free predicate was measured and
-- rejected: the residual filter can't be dropped, the planner keeps a bitmap
-- plan, and execution stays ~500 ms.
--
-- Created CONCURRENTLY on the live instance on 2026-08-06 (same playbook as
-- 0100); this migration makes it durable for fresh databases.
CREATE INDEX IF NOT EXISTS "hb_runs_quota_anchor_idx" ON "heartbeat_runs" ("company_id", "created_at" desc)
WHERE (
  "error_code" = 'claude_quota_exhausted'
  or "result_json" ->> 'quotaExhausted' = 'true'
  or (
    "error" ~* '(?:hit your (?:session|weekly|usage) limit|usage limit reached|usage cap reached|5[-\s]?hour limit reached|weekly limit reached|claude usage limit reached|out of extra usage|session limit reached)'
    and ("error_code" is null or "error_code" like 'claude%')
  )
)
and "status" = 'failed'
and "result_json" -> 'authRenderedQuotaWall' is null
and ("usage_json" ->> 'provider' is null or "usage_json" ->> 'provider' = 'anthropic')
and coalesce(("usage_json" ->> 'inputTokens')::numeric, 0) = 0
and coalesce(("usage_json" ->> 'outputTokens')::numeric, 0) = 0;
