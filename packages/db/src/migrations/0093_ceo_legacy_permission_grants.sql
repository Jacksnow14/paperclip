-- AUR-4135: canCreateAgentsLegacy and hasCrossIssueCommentPermission
-- (server/src/routes/issues.ts) no longer bypass on `role === "ceo"`.
-- Backfill the equivalent explicit grants for every existing CEO agent so
-- observable behaviour is unchanged.
INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key")
SELECT a."company_id", 'agent', a."id"::text, perm.key
FROM "agents" a
CROSS JOIN (VALUES ('tasks:assign'), ('tasks:manage_active_checkouts'), ('tasks:comment_cross_issue')) AS perm(key)
WHERE a."role" = 'ceo'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
