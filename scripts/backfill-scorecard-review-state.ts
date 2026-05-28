/**
 * One-off backfill: promote pending memory records whose metadata.category is in
 * AUTO_ACCEPT_CATEGORIES to reviewState = "accepted".
 *
 * These categories are structured, low-sensitivity retrospective captures that
 * require no board review (see AUR-1425). Running this script is idempotent —
 * already-accepted records are skipped.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-scorecard-review-state.ts
 *
 * Override company and batch size:
 *   COMPANY_ID=... BATCH_SIZE=200 pnpm tsx scripts/backfill-scorecard-review-state.ts
 */
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { memoryLocalRecords } from "../packages/db/src/schema/memory_local_records.js";
import { and, eq, sql } from "drizzle-orm";

const COMPANY_ID = process.env.COMPANY_ID ?? "b26d3647-3e6c-4a28-9c25-e9315696484d";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "500");
const AUTO_ACCEPT_CATEGORIES = ["performance_scorecard", "tool_gap", "lesson"];
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const config = loadConfig();
  const databaseUrl = config.databaseUrl ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const db = createDb(databaseUrl);

  console.log(`Backfill scorecard review states for company ${COMPANY_ID}`);
  console.log(`Auto-accept categories: ${AUTO_ACCEPT_CATEGORIES.join(", ")}`);
  if (DRY_RUN) console.log("DRY RUN — no changes will be written");

  const categoryList = AUTO_ACCEPT_CATEGORIES.map((c) => `'${c}'`).join(", ");

  // Count affected rows first
  const [{ count }] = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM memory_local_records
    WHERE company_id = ${COMPANY_ID}
      AND review_state = 'pending'
      AND deleted_at IS NULL
      AND metadata->>'category' IN (${sql.raw(categoryList)})
  `);

  console.log(`Pending records to promote: ${count}`);

  if (DRY_RUN || Number(count) === 0) {
    console.log("Nothing to update.");
    process.exit(0);
  }

  // Update in a single statement (idempotent — already-accepted rows unaffected by WHERE clause)
  const result = await db.execute(sql`
    UPDATE memory_local_records
    SET review_state = 'accepted',
        reviewed_at  = NOW(),
        review_note  = 'auto-accepted by backfill-scorecard-review-state (AUR-1425)'
    WHERE company_id = ${COMPANY_ID}
      AND review_state = 'pending'
      AND deleted_at IS NULL
      AND metadata->>'category' IN (${sql.raw(categoryList)})
  `);

  console.log(`Updated ${(result as any).rowCount ?? "?"} records to reviewState=accepted.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
