// AUR-5168 AC2/AC3: rolling 7-day output-token spend per work class, and the
// carve-outs that keep the resulting cap from starving the fleet's own
// ability to keep running. Reuses cost_events + issues.workClass — no new
// telemetry.
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, issues, projectWorkspaces } from "@paperclipai/db";
import { deriveWorkClass, type WorkClass } from "./work-class.js";

export const WORK_CLASS_CAP_SHARE = 0.1;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Founder-directed carve-out subtree (AUR-5122): fixing the fleet's own
// ability to earn is never throttled by the earning-vs-self-improvement cap.
export const BUDGET_CARVEOUT_ROOT_IDENTIFIER = "AUR-5122";

export interface WorkClassBudget {
  windowStart: string;
  windowEnd: string;
  revenueTokens: number;
  selfImprovementTokens: number;
  selfImprovementShare: number;
  capShare: number;
  overCap: boolean;
}

export function workClassBudgetService(db: Db) {
  return {
    computeBudget: async (companyId: string, now: Date = new Date()): Promise<WorkClassBudget> => {
      const windowStart = new Date(now.getTime() - WINDOW_MS);

      // Grouped by issue (not by raw event) so the JS-side re-derivation
      // fallback below scales with issues touched in the window, not with
      // every heartbeat's individual cost event.
      const rows = await db
        .select({
          issueId: costEvents.issueId,
          outputTokens: costEvents.outputTokens,
          workClass: issues.workClass,
          description: issues.description,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
        })
        .from(costEvents)
        .leftJoin(issues, eq(costEvents.issueId, issues.id))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, windowStart)));

      const workspaceIds = [
        ...new Set(rows.map((row) => row.projectWorkspaceId).filter((id): id is string => !!id)),
      ];
      const repoUrlByWorkspaceId = new Map<string, string | null>();
      if (workspaceIds.length > 0) {
        const workspaceRows = await db
          .select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl })
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.id, workspaceIds));
        for (const workspace of workspaceRows) {
          repoUrlByWorkspaceId.set(workspace.id, workspace.repoUrl);
        }
      }

      let revenueTokens = 0;
      let selfImprovementTokens = 0;
      for (const row of rows) {
        // No linked issue (e.g. ambient agent activity) falls through to
        // deriveWorkClass's own default-to-revenue, same as everywhere else.
        const workClass: WorkClass =
          (row.workClass as WorkClass | null) ??
          deriveWorkClass({
            description: row.description,
            projectId: row.projectId,
            workspaceRepoUrl: row.projectWorkspaceId
              ? repoUrlByWorkspaceId.get(row.projectWorkspaceId) ?? null
              : null,
          });
        if (workClass === "self_improvement") selfImprovementTokens += row.outputTokens;
        else revenueTokens += row.outputTokens;
      }

      const totalTokens = revenueTokens + selfImprovementTokens;
      const selfImprovementShare = totalTokens > 0 ? selfImprovementTokens / totalTokens : 0;

      return {
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString(),
        revenueTokens,
        selfImprovementTokens,
        selfImprovementShare,
        capShare: WORK_CLASS_CAP_SHARE,
        overCap: selfImprovementShare >= WORK_CLASS_CAP_SHARE,
      };
    },

    // AC3 carve-out: is this issue (or an ancestor) the AUR-5122 subtree,
    // which protects the fleet's ability to earn and must never be skipped?
    // Walks parentId same as issueService.getAncestors, but without the
    // project/goal hydration that function does for display purposes — this
    // runs on the hot admission path.
    isUnderBudgetCarveoutRoot: async (issueId: string): Promise<boolean> => {
      const visited = new Set<string>();
      let currentId: string | null = issueId;
      for (let hop = 0; currentId && !visited.has(currentId) && hop < 50; hop += 1) {
        visited.add(currentId);
        const rows: Array<{ identifier: string | null; parentId: string | null }> = await db
          .select({ identifier: issues.identifier, parentId: issues.parentId })
          .from(issues)
          .where(eq(issues.id, currentId));
        const row = rows[0] ?? null;
        if (!row) return false;
        if (row.identifier === BUDGET_CARVEOUT_ROOT_IDENTIFIER) return true;
        currentId = row.parentId;
      }
      return false;
    },
  };
}

// AC3 hard carve-outs named by the founder: trunk-red CI, security/exposed
// credential work, disk/host exhaustion, control-plane outages. Deliberately
// four fixed patterns, not a taxonomy — matched against title+description so
// an issue doesn't need a new field to get the exemption.
const CARVEOUT_KEYWORD_PATTERNS: RegExp[] = [
  /\btrunk[- ]?(?:is\s+)?red\b|\bci\s+(?:is\s+)?(?:red|failing|broken)\b|\bbroken\s+ci\b/i,
  /\bsecurity\b|\bexposed\s+(?:secret|credential|key)\b|\b(?:secret|credential)\s+leak(?:ed|age)?\b/i,
  /\bdisk\s+(?:exhaustion|full|pressure)\b|\bhost\s+exhaustion\b|\bout\s+of\s+disk\b|\boom\b|\bout[- ]of[- ]memory\b/i,
  /\bcontrol[- ]?plane\s+(?:outage|down|unreachable)\b/i,
];

export function matchesBudgetCarveoutKeywords(title: string, description: string | null | undefined): boolean {
  const text = `${title}\n${description ?? ""}`;
  return CARVEOUT_KEYWORD_PATTERNS.some((pattern) => pattern.test(text));
}
