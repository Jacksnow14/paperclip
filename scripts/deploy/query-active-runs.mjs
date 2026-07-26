#!/usr/bin/env node
// AUR-4028: quiescence probe for auto-deploy.sh.
//
// Asks the control-plane DB — the same table the control plane itself reads —
// how many heartbeat runs are running vs queued. /api/health cannot answer
// this in production (the count is gated behind PAPERCLIP_DEV_SERVER_STATUS_FILE,
// unset on the live server), and unlike the HTTP route this keeps working while
// the server is mid-restart, which is exactly when the deploy daemon operates.
//
// Output (one JSON line):
//   {"running": <non-stale running count>, "queued": <queued count>,
//    "staleRunning": [{"id": "...", "ageSec": N}, ...]}
//
// Stale running rows (older than PAPERCLIP_DEPLOY_RUNNING_STALE_SEC, default
// 2 h) are DISCOUNTED from `running` and listed by id: there is no startup
// reconciliation of orphaned rows, so a dead run would otherwise block the
// restart forever — and when one is discounted the caller names it in the
// state file and the log rather than swallowing it.

import { createRequire } from "node:module";
// postgres is declared by @paperclipai/db; resolve it from that package
// (same pattern as scripts/verify-run-outcome-integrity.mjs).
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const postgres = require("postgres");

const STALE_SEC = Number(process.env.PAPERCLIP_DEPLOY_RUNNING_STALE_SEC ?? 7200);

const sql = postgres({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54329),
  db: process.env.PGDATABASE ?? "paperclip",
  user: process.env.PGUSER ?? "paperclip",
  pass: process.env.PGPASSWORD ?? "paperclip",
  max: 1,
  connect_timeout: 10,
});

try {
  const rows = await sql`
    select id, status, coalesce(started_at, created_at) as since
    from heartbeat_runs
    where status in ('running', 'queued')
  `;
  const now = Date.now();
  const queued = rows.filter((r) => r.status === "queued").length;
  const running = rows.filter((r) => r.status === "running");
  const ageSec = (r) => Math.round((now - new Date(r.since).getTime()) / 1000);
  const stale = running.filter((r) => ageSec(r) > STALE_SEC);
  process.stdout.write(
    JSON.stringify({
      running: running.length - stale.length,
      queued,
      staleRunning: stale.map((r) => ({ id: r.id, ageSec: ageSec(r) })),
    }) + "\n",
  );
} finally {
  await sql.end({ timeout: 5 });
}
