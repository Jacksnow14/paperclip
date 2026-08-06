import { pgTable, uuid, timestamp, integer, doublePrecision, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * AUR-5207: rolling 7-day merged-PR ratio (money-making:self-improvement),
 * computed out-of-band by scripts/sgi-ship-ratio-gate.mjs (the server process
 * has no GitHub credentials) and persisted here so the heartbeat admission
 * gate can read the latest snapshot without an inline GitHub API call on the
 * hot dispatch path. One row per computation, most-recent-wins on read --
 * deliberately not upserted, so the run history stays inspectable.
 *
 * closedWithoutMerge is reported but never enters the ratio: per the
 * founder's directive on AUR-5168, closing a stale PR is a legitimate
 * outcome and must not itself score as a shipping failure.
 */
export const shipRatioSnapshots = pgTable(
  "ship_ratio_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    moneyMakingMerged: integer("money_making_merged").notNull(),
    selfImprovementMerged: integer("self_improvement_merged").notNull(),
    moneyMakingClosedWithoutMerge: integer("money_making_closed_without_merge").notNull().default(0),
    selfImprovementClosedWithoutMerge: integer("self_improvement_closed_without_merge").notNull().default(0),
    // moneyMakingMerged / max(selfImprovementMerged, 1) -- see ship-ratio-gate.ts.
    ratio: doublePrecision("ratio").notNull(),
    floorRatio: doublePrecision("floor_ratio").notNull().default(2),
    // true = the ratio gate FAILS (ratio below floorRatio). Named overCap to
    // match workClassBudget.overCap so heartbeat.ts can OR the two flags.
    overCap: boolean("over_cap").notNull(),
    // Array of { prNumber, repo, repoWorkClass, issueIdentifier, issueWorkClass }
    // for merged PRs whose repo-of-record disagrees with their linked issue's
    // self-declared workClass. Anti-gaming requirement: logged, never
    // silently resolved -- the repo always wins for the ratio computation.
    disagreements: jsonb("disagreements").$type<Array<Record<string, unknown>>>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("ship_ratio_snapshots_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
