#!/usr/bin/env node
// Post-deploy verification for the false-fail fixes (AUR-3302 + PR #47).
//
// Usage: node scripts/verify-run-outcome-integrity.mjs [--hours 6]
//
// Reads heartbeat_runs from the embedded control-plane DB and reports, per
// hour: succeeded / failed / false-fail-shaped rows (status=failed with
// exit_code=0 and a success-shaped result_json), cli-unresolvable failures,
// and reclaimed runs (PR #47 writes a "Reclaimed run from stale terminal
// failure" lifecycle event; reclaim also cancels ghost retries with
// error_code=superseded_by_source_success).
//
// Healthy post-deploy signature: false-fail-shaped count ~0; any mid-flight
// reaping shows up as reclaims instead; cli_unresolvable failures become
// scheduled retries rather than terminal failures.

import { createRequire } from "node:module";
// postgres is declared by @paperclipai/db; resolve it from that package.
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = require("postgres");

const hoursArg = process.argv.indexOf("--hours");
const HOURS = hoursArg > -1 ? Number(process.argv[hoursArg + 1]) || 6 : 6;

const sql = postgres({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54329),
  db: process.env.PGDATABASE ?? "paperclip",
  user: process.env.PGUSER ?? "paperclip",
  pass: process.env.PGPASSWORD ?? "paperclip",
  max: 1,
});

const rows = await sql`
  select
    date_trunc('hour', created_at) as hour,
    count(*) filter (where status = 'succeeded') as succeeded,
    count(*) filter (where status = 'failed') as failed,
    count(*) filter (
      where status = 'failed'
        and coalesce(exit_code, 0) = 0
        and (result_json->>'subtype' = 'success' or result_json->>'is_error' = 'false')
    ) as false_fail_shaped,
    count(*) filter (where error_code = 'adapter_cli_unresolvable') as cli_unresolvable,
    count(*) filter (where error_code = 'process_lost') as process_lost,
    count(*) filter (where error_code = 'superseded_by_source_success') as ghost_retries_cancelled
  from heartbeat_runs
  where created_at > now() - make_interval(hours => ${HOURS})
  group by 1
  order by 1
`;

const reclaims = await sql`
  select count(*)::int as n
  from heartbeat_run_events
  where message like 'Reclaimed run from stale terminal failure%'
    and created_at > now() - make_interval(hours => ${HOURS})
`;

console.log(`Run-outcome integrity, last ${HOURS}h (UTC hours):`);
console.log("hour              | ok   | fail | false-fail | cli-unres | proc-lost | ghost-cancelled");
for (const r of rows) {
  const h = new Date(r.hour).toISOString().slice(5, 13);
  console.log(
    `${h.padEnd(17)} | ${String(r.succeeded).padEnd(4)} | ${String(r.failed).padEnd(4)} | ` +
      `${String(r.false_fail_shaped).padEnd(10)} | ${String(r.cli_unresolvable).padEnd(9)} | ` +
      `${String(r.process_lost).padEnd(9)} | ${r.ghost_retries_cancelled}`,
  );
}
console.log(`\nReclaimed false failures (PR #47 event): ${reclaims[0].n}`);
if (rows.length && rows.every((r) => Number(r.false_fail_shaped) === 0)) {
  console.log("VERDICT: no false-fail-shaped rows in the window — outcome integrity holds.");
} else {
  console.log("VERDICT: false-fail-shaped rows still present — investigate the newest ones.");
}
await sql.end();
