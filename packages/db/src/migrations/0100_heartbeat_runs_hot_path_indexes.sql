-- AUR-5xxx (2026-08-06 VPS saturation incident): the dispatch loop matched
-- runs by context_snapshot->>'issueId'/'taskId'/'taskKey' and the run
-- listings ordered by created_at — neither had an index, so every check was
-- a seq scan + de-TOAST over a 1.3 GB table (1.9M seq scans, 71.6B tuples
-- read, host pinned at 100% CPU). These indexes were created CONCURRENTLY on
-- the live instance on 2026-08-06; this migration makes them durable for
-- fresh databases. Root-cause refactor (promote issueId to a real column) is
-- tracked separately.
CREATE INDEX IF NOT EXISTS "hb_runs_ctx_issue_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'issueId')));
CREATE INDEX IF NOT EXISTS "hb_runs_ctx_task_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'taskId')));
CREATE INDEX IF NOT EXISTS "hb_runs_ctx_taskkey_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'taskKey')));
CREATE INDEX IF NOT EXISTS "hb_runs_company_created_idx" ON "heartbeat_runs" ("company_id", "created_at" desc);
CREATE INDEX IF NOT EXISTS "hb_runs_company_agent_created_idx" ON "heartbeat_runs" ("company_id", "agent_id", "created_at" desc);
CREATE INDEX IF NOT EXISTS "heartbeat_runs_wakeup_request_idx" ON "heartbeat_runs" ("wakeup_request_id");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_retry_of_run_idx" ON "heartbeat_runs" ("retry_of_run_id");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_external_run_idx" ON "heartbeat_runs" ("external_run_id");
