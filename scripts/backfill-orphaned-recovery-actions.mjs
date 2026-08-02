#!/usr/bin/env node
/**
 * backfill-orphaned-recovery-actions.mjs (AUR-4299)
 *
 * An `issue_recovery_actions` row tracks "this issue is stranded and needs to get moving
 * again". Until AUR-4299 nothing closed those rows out when the source issue itself reached a
 * terminal status, so `active`/`escalated` actions accumulated against issues that were already
 * `done`/`cancelled`. At the time of writing that was 305 of 384 active rows (79%), which makes
 * `activeRecoveryAction` useless as a signal for any watchdog, UI, or liveness consumer.
 *
 * The code fix (issueService.update + issueTreeControlService.cancelIssueStatusesForHold) stops
 * NEW orphans from being created. This script clears the ones already in the table.
 *
 * Disposition matches the runtime mapping in `terminalIssueRecoveryResolution`:
 *   source issue `done`      -> action status `resolved`,  outcome `restored`
 *   source issue `cancelled` -> action status `cancelled`, outcome `cancelled`
 *
 * Only rows whose SOURCE ISSUE is terminal are touched. Actions on live issues (`blocked`,
 * `in_progress`, `todo`, `in_review`) are left completely alone — those are the true signal.
 *
 * Idempotent: the WHERE clause requires an active/escalated status, so a second run matches
 * zero rows and does not rewrite `resolved_at` on anything it already closed.
 *
 * Usage:
 *   node scripts/backfill-orphaned-recovery-actions.mjs            # dry-run, writes nothing
 *   node scripts/backfill-orphaned-recovery-actions.mjs --apply    # execute
 *
 * Connection (embedded Postgres defaults; override via env):
 *   PGHOST (127.0.0.1) PGPORT (54329) PGUSER (paperclip) PGPASSWORD (paperclip) PGDATABASE (paperclip)
 */

import { createRequire } from "node:module";

// `postgres` (postgres.js) is a dependency of @paperclipai/db, not of the repo root, so resolve
// it from there rather than relying on pnpm hoisting.
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = require("postgres");

const APPLY = process.argv.includes("--apply");

const TERMINAL_DISPOSITIONS = [
  { issueStatus: "done", actionStatus: "resolved", outcome: "restored" },
  { issueStatus: "cancelled", actionStatus: "cancelled", outcome: "cancelled" },
];

const ACTIVE_STATUSES = ["active", "escalated"];

async function reportDistribution(sql, label) {
  const rows = await sql`
    select i.status as source_status, count(*)::int as active_actions
      from issue_recovery_actions ra
      join issues i on i.id = ra.source_issue_id
     where ra.status in ${sql(ACTIVE_STATUSES)}
     group by 1
     order by 2 desc`;
  const total = rows.reduce((sum, row) => sum + row.active_actions, 0);
  const orphaned = rows
    .filter((row) => row.source_status === "done" || row.source_status === "cancelled")
    .reduce((sum, row) => sum + row.active_actions, 0);
  console.log(`\n=== ${label} ===`);
  console.table(rows.map((row) => ({ ...row })));
  const pct = total === 0 ? "0.0" : ((orphaned / total) * 100).toFixed(1);
  console.log(`total active: ${total} | orphaned (source done/cancelled): ${orphaned} (${pct}%)`);
  return { total, orphaned };
}

async function main() {
  const sql = postgres({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 54329),
    user: process.env.PGUSER ?? "paperclip",
    password: process.env.PGPASSWORD ?? "paperclip",
    database: process.env.PGDATABASE ?? "paperclip",
  });

  try {
    const before = await reportDistribution(sql, "BEFORE");

    if (before.orphaned === 0) {
      console.log("\nNothing to backfill — no active recovery action points at a terminal issue.");
      return;
    }

    if (!APPLY) {
      for (const disposition of TERMINAL_DISPOSITIONS) {
        const [{ n }] = await sql`
          select count(*)::int as n
            from issue_recovery_actions ra
            join issues i on i.id = ra.source_issue_id
           where ra.status in ${sql(ACTIVE_STATUSES)}
             and i.status = ${disposition.issueStatus}`;
        console.log(
          `[dry-run] would set ${n} action(s) with source status '${disposition.issueStatus}' ` +
            `-> status '${disposition.actionStatus}', outcome '${disposition.outcome}'`,
        );
      }
      console.log("\nDry run — nothing written. Re-run with --apply to execute.");
      return;
    }

    let updatedTotal = 0;
    await sql.begin(async (tx) => {
      for (const disposition of TERMINAL_DISPOSITIONS) {
        const updated = await tx`
          update issue_recovery_actions ra
             set status = ${disposition.actionStatus},
                 outcome = ${disposition.outcome},
                 resolution_note = ${`Backfilled by AUR-4299: source issue reached terminal status ${disposition.issueStatus}.`},
                 resolved_at = now(),
                 updated_at = now()
            from issues i
           where i.id = ra.source_issue_id
             and ra.status in ${tx(ACTIVE_STATUSES)}
             and i.status = ${disposition.issueStatus}
       returning ra.id`;
        console.log(
          `[apply] source '${disposition.issueStatus}' -> ${updated.length} action(s) set to ` +
            `'${disposition.actionStatus}'/'${disposition.outcome}'`,
        );
        updatedTotal += updated.length;
      }
    });

    const after = await reportDistribution(sql, "AFTER");
    console.log(`\nbackfilled ${updatedTotal} orphaned recovery action(s).`);
    if (after.orphaned !== 0) {
      console.error(`FAILED TO CONVERGE: ${after.orphaned} orphan(s) remain.`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

await main();
