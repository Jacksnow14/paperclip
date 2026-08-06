-- AUR-5097: resolve recovery actions at the only altitude every writer passes through.
--
-- AUR-4299 hooked both in-app terminal writers (issueService.update and
-- cancelIssueStatusesForHold), and a full audit of server/src found no other in-app path
-- that can write status='done'/'cancelled'. Yet the D+7 convergence control (AUR-4728)
-- found 18 stranded actions, all closed by bulk statements sharing one microsecond
-- updated_at — and one cohort landed at 2026-08-05T16:36:28.620Z while the API server was
-- down in a migration crash-loop, so no application code could have written it. The writer
-- class is out-of-band SQL against the embedded Postgres (agents running ad-hoc cleanup
-- during incidents). No application-level hook can cover that; a row-level trigger fires
-- for every UPDATE regardless of who issues it.
--
-- Disposition mapping matches terminalIssueRecoveryResolution and the AUR-4299 backfill:
--   done      -> action status 'resolved',  outcome 'restored'
--   cancelled -> action status 'cancelled', outcome 'cancelled'
-- The note keeps the "Source issue reached terminal status" prefix existing controls and
-- backfill reports grep for.
--
-- Deliberately NO OLD-vs-NEW transition predicate: an idempotent sweep re-writing
-- status='cancelled' onto an already-cancelled issue then HEALS any orphan that slipped in
-- instead of skipping it. The inner UPDATE only matches active/escalated rows, so repeat
-- fires are no-ops and never rewrite resolved_at. WHERE is covered by
-- issue_recovery_actions_company_source_status_idx.
CREATE OR REPLACE FUNCTION issues_terminal_status_resolve_recovery_actions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public
AS $fn$
BEGIN
  UPDATE issue_recovery_actions
     SET status = CASE NEW.status WHEN 'done' THEN 'resolved' ELSE 'cancelled' END,
         outcome = CASE NEW.status WHEN 'done' THEN 'restored' ELSE 'cancelled' END,
         resolution_note = 'Source issue reached terminal status ' || NEW.status || ' (issues trigger).',
         resolved_at = now(),
         updated_at = now()
   WHERE company_id = NEW.company_id
     AND source_issue_id = NEW.id
     AND status IN ('active', 'escalated');
  RETURN NULL;
END;
$fn$;--> statement-breakpoint
DROP TRIGGER IF EXISTS issues_terminal_status_resolve_recovery_actions ON issues;--> statement-breakpoint
CREATE TRIGGER issues_terminal_status_resolve_recovery_actions
AFTER UPDATE OF status ON issues
FOR EACH ROW
WHEN (NEW.status IN ('done', 'cancelled'))
EXECUTE FUNCTION issues_terminal_status_resolve_recovery_actions();
