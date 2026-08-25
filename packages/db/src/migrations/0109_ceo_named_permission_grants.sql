-- AUR-4135: canCreateAgentsLegacy and hasCrossIssueCommentPermission are being
-- switched from a `role === "ceo"` hardcode to named permission grants
-- (tasks:assign / tasks:manage_active_checkouts / tasks:comment_cross_issue).
-- access.hasPermission() requires an ACTIVE company_memberships row before it
-- will even look at principal_permission_grants, and nothing previously
-- created a company_memberships row for agent principals. Seed both so every
-- company's CEO agent(s) keep exactly the capabilities they have today.
INSERT INTO "company_memberships" ("company_id", "principal_type", "principal_id", "status")
SELECT a."company_id", 'agent', a."id"::text, 'active'
FROM "agents" a
WHERE a."role" = 'ceo'
ON CONFLICT ("company_id", "principal_type", "principal_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key")
SELECT a."company_id", 'agent', a."id"::text, perm.key
FROM "agents" a
CROSS JOIN (VALUES ('tasks:assign'), ('tasks:manage_active_checkouts'), ('tasks:comment_cross_issue'), ('agents:create')) AS perm(key)
WHERE a."role" = 'ceo'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
