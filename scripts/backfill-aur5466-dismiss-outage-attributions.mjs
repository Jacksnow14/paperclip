#!/usr/bin/env node
/**
 * backfill-aur5466-dismiss-outage-attributions.mjs (AUR-5466)
 *
 * The recovery filer used to file `stranded_assigned_issue` / `missing_disposition`
 * actions off runs that died at the provider wall (auth/quota/transient upstream) —
 * blaming the assignee for an infrastructure outage. The code fix makes the filer
 * consult NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES and requeue instead of escalating.
 * This script dismisses the actions the OLD behavior already filed, citing the outage
 * in the resolution note (an unexplained dismissal is just a different kind of noise).
 *
 * Selection is keyed on the action's own recorded evidence (`evidence.latestRunErrorCode`),
 * not on a time-window heuristic: the filer stamped the failing run's error code into
 * every action at creation time, so each dismissed row carries its own proof. At the time
 * of writing this matches 75 active rows — 74 `claude_auth_required` + 1
 * `claude_transient_upstream` — all from the 2026-08-06 → 2026-08-12 claude_local lane
 * outage (verified by dry run; counts posted on the AUR-5466 thread).
 *
 * The code set is frozen here on purpose. The RUNTIME filer imports the shared constant
 * (drift there re-attributes excused codes silently); a one-shot backfill dismisses rows
 * filed under a known outage and must not silently widen if the list later grows.
 * `process_lost` is excluded to mirror the runtime carve-out: stranded escalation is the
 * designed fail-loud terminal of the process-loss retry ladder, so those actions are not
 * outage noise. `adapter_failed` is excluded because it is not proven non-attributable.
 *
 * IMPORTANT: run this only AFTER the AUR-5466 code change is deployed. Before that, the
 * reconciler re-files a fresh action for any still-stranded issue within one sweep and
 * the dismissal is undone.
 *
 * Idempotent: the WHERE clause requires an active status, so a second run matches zero rows.
 *
 * Usage:
 *   node scripts/backfill-aur5466-dismiss-outage-attributions.mjs            # dry-run
 *   node scripts/backfill-aur5466-dismiss-outage-attributions.mjs --apply    # execute
 *
 * Connection (embedded Postgres defaults; override via env):
 *   PGHOST (127.0.0.1) PGPORT (54329) PGUSER (paperclip) PGPASSWORD (paperclip) PGDATABASE (paperclip)
 */

import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = require("postgres");

const APPLY = process.argv.includes("--apply");

// Provider-wall codes excused by the AUR-5466 runtime gate at the time of the backfill.
// See header for why this is frozen rather than imported.
const OUTAGE_DISMISSABLE_ERROR_CODES = [
  "claude_transient_upstream",
  "claude_quota_exhausted",
  "claude_auth_required",
  "codex_transient_upstream",
  "gemini_transient_upstream",
];

const DISMISSABLE_KINDS = ["stranded_assigned_issue", "missing_disposition"];
const ACTIVE_STATUSES = ["active", "escalated"];

const RESOLUTION_NOTE_PREFIX = "Auto-dismissed (AUR-5466): non-attributable provider failure.";

function resolutionNote(errorCode) {
  return (
    `${RESOLUTION_NOTE_PREFIX} The run this action was filed from died at the provider wall ` +
    `(errorCode=${errorCode}) during the 2026-08-06 → 2026-08-12 claude_local lane outage, before ` +
    `the assigned agent was invoked. Per NON_ATTRIBUTABLE_PROVIDER_ERROR_CODES this carries no ` +
    `signal about the assignee; the recovery filer now requeues such issues instead of filing blame.`
  );
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
    const candidates = await sql`
      select ra.id,
             ra.kind,
             ra.evidence ->> 'latestRunErrorCode' as error_code,
             ra.created_at,
             i.identifier as source_identifier,
             i.status as source_status
        from issue_recovery_actions ra
        join issues i on i.id = ra.source_issue_id
       where ra.status in ${sql(ACTIVE_STATUSES)}
         and ra.kind in ${sql(DISMISSABLE_KINDS)}
         and ra.evidence ->> 'latestRunErrorCode' in ${sql(OUTAGE_DISMISSABLE_ERROR_CODES)}
       order by ra.created_at asc`;

    const byKindCode = new Map();
    for (const row of candidates) {
      const key = `${row.kind} / ${row.error_code}`;
      byKindCode.set(key, (byKindCode.get(key) ?? 0) + 1);
    }

    console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"}: dismissable outage attributions ===`);
    console.log(`total: ${candidates.length}`);
    for (const [key, count] of byKindCode) console.log(`  ${key}: ${count}`);

    if (!APPLY) {
      console.log("\nDry run only — re-run with --apply AFTER the AUR-5466 gate is deployed.");
      return;
    }

    let dismissed = 0;
    for (const row of candidates) {
      const updated = await sql`
        update issue_recovery_actions
           set status = 'cancelled',
               outcome = 'cancelled',
               resolution_note = ${resolutionNote(row.error_code)},
               resolved_at = now(),
               updated_at = now()
         where id = ${row.id}
           and status in ${sql(ACTIVE_STATUSES)}
         returning id`;
      dismissed += updated.length;
    }
    console.log(`\ndismissed: ${dismissed}/${candidates.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
