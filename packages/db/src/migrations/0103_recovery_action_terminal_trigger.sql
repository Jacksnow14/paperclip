-- AUR-5465: close active recovery actions whenever their source issue reaches a
-- terminal status, enforced as a trigger so no future write path (ORM call site,
-- raw SQL, bulk script) can bypass it the way the 08-06 bulk-cancel path did.
-- Mirrors terminalIssueRecoveryResolution() in issue-recovery-actions.ts:
--   done      -> resolved / restored
--   cancelled -> cancelled / cancelled
CREATE OR REPLACE FUNCTION resolve_recovery_actions_on_issue_terminal() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' THEN
    UPDATE issue_recovery_actions
    SET status = 'resolved',
        outcome = 'restored',
        resolution_note = 'Source issue reached terminal status ' || NEW.status || '.',
        resolved_at = now(),
        updated_at = now()
    WHERE company_id = NEW.company_id
      AND source_issue_id = NEW.id
      AND status IN ('active', 'escalated');
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE issue_recovery_actions
    SET status = 'cancelled',
        outcome = 'cancelled',
        resolution_note = 'Source issue reached terminal status ' || NEW.status || '.',
        resolved_at = now(),
        updated_at = now()
    WHERE company_id = NEW.company_id
      AND source_issue_id = NEW.id
      AND status IN ('active', 'escalated');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issues_resolve_recovery_actions_on_terminal ON "issues";
--> statement-breakpoint
CREATE TRIGGER issues_resolve_recovery_actions_on_terminal
AFTER UPDATE OF status ON "issues"
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('done', 'cancelled'))
EXECUTE FUNCTION resolve_recovery_actions_on_issue_terminal();
