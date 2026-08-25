-- AUR-4719 (defect 3): issue_recovery_actions.timeout_at was written on every
-- insert/update but never read by any query, escalation, or sweep — a
-- write-only column masquerading as enforced behavior. Dropping it rather
-- than leaving it written-and-unread, per the issue's acceptance criteria.
ALTER TABLE "issue_recovery_actions" DROP COLUMN IF EXISTS "timeout_at";
