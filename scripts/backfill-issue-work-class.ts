// AUR-5168: one-shot backfill of issues.workClass for existing open issues.
// Only touches rows where workClass is still null (never overwrites an
// explicit or previously-derived value) and reuses the exact same
// deriveWorkClass() rules the create-issue path now runs at write time, so
// backfilled issues and newly-created issues are classified identically.
import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";
import { companies, issues, projectWorkspaces, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { deriveWorkClass, type WorkClass } from "../server/src/services/work-class.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const companyId = parseFlag("--company");
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  const split: Record<WorkClass, number> = { revenue: 0, self_improvement: 0 };
  let total = 0;

  for (const company of companyRows) {
    const openIssues = await db
      .select({
        id: issues.id,
        description: issues.description,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          isNull(issues.workClass),
          isNotNull(issues.status),
          ne(issues.status, "done"),
          ne(issues.status, "cancelled"),
        ),
      );

    if (openIssues.length === 0) continue;

    const workspaceIds = [...new Set(openIssues.map((i) => i.projectWorkspaceId).filter((id): id is string => !!id))];
    const repoUrlByWorkspaceId = new Map<string, string | null>();
    if (workspaceIds.length > 0) {
      const workspaceRows = await db
        .select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.companyId, company.id));
      for (const row of workspaceRows) {
        repoUrlByWorkspaceId.set(row.id, row.repoUrl);
      }
    }

    for (const issue of openIssues) {
      const workspaceRepoUrl = issue.projectWorkspaceId
        ? repoUrlByWorkspaceId.get(issue.projectWorkspaceId) ?? null
        : null;
      const workClass = deriveWorkClass({
        description: issue.description,
        projectId: issue.projectId,
        workspaceRepoUrl,
      });
      await db.update(issues).set({ workClass }).where(eq(issues.id, issue.id));
      split[workClass] += 1;
      total += 1;
    }
  }

  console.log(`Backfilled workClass for ${total} open issue(s):`);
  console.log(`  revenue:          ${split.revenue}`);
  console.log(`  self_improvement: ${split.self_improvement}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Issue work-class backfill failed: ${message}`);
  process.exitCode = 1;
});
