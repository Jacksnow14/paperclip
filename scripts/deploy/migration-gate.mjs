#!/usr/bin/env node
// AUR-5019: deploy-time migration gate — refuse to arm a release whose pending
// migrations would abort against live data.
//
// The 2026-08-05 outage produced two distinct boot-aborting migration defects
// in one day (0098: CREATE UNIQUE INDEX over live duplicates; 0099: raw
// re-execution against a drifted DB after the history-reconciliation branch
// bailed). Both were discovered during boot, in production, because nothing
// replayed pending migrations against production-shaped data before the deploy
// armed. CI cannot do it (ubuntu-latest cannot reach the live embedded PG on
// this host), so the gate runs host-side, at arm time, BEFORE the `current`
// symlink flips — called by auto-deploy.sh and safe-deploy.sh.
//
// What it does:
//   1. inspect the LIVE DB with the CANDIDATE release's own applier code —
//      no pending migrations means nothing to replay: PASS in ~1s (the common
//      case; this is the only step that runs on most deploys).
//   2. snapshot the live DB with the candidate's backup engine: full schema
//      (every table, index, constraint, enum, sequence — schema drift IS the
//      0099 mode) + the migration journal's rows + full data for the tables
//      the pending migrations reference (plus their FK-parent closure, so an
//      ADD CONSTRAINT can validate). Excluded tables keep schema, drop data:
//      the live DB is ~3 GB dominated by heartbeat history; the tables a
//      migration touches are typically tens of MB.
//   3. restore the snapshot into a throwaway embedded-postgres cluster.
//   4. REPLAY: call the candidate's applyPendingMigrations() — the exact
//      function production boot runs, including the reconciliation branch and
//      the per-migration transaction — against the scratch DB.
//
// Everything that matters is imported FROM THE CANDIDATE RELEASE (--release):
// its migrations, its journal, its applier, its backup engine. The gate never
// re-implements the applier, so it cannot drift from what boot will do.
//
// Exit codes (auto-deploy.sh keys quarantine decisions off these):
//   0  PASS        — replay applied cleanly (or nothing was pending)
//   2  BLOCK       — replay ABORTED: a property of the SHA + live data.
//   3  INFRA-FAIL  — the gate itself could not run (snapshot/cluster/disk).
//                    Not a property of the SHA: no strike, retry next tick.
//                    The caller must still fail closed (no flip).
//
// The gate only ever READS the live DB. All writes go to the scratch cluster
// in a temp workdir that is removed on every exit path.
//
// Usage:
//   migration-gate.mjs --release <release-dir> [--db-dist <dir>]
//                      [--live-url <postgres-url>] [--work-dir <dir>] [--keep]
//                      [--full-data]
// Env:
//   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD — live DB (defaults match
//     query-active-runs.mjs: 127.0.0.1:54329 paperclip/paperclip/paperclip)
//   PAPERCLIP_MIGRATION_GATE_FULL_DATA=1      — snapshot all data, not scoped
//   PAPERCLIP_MIGRATION_GATE_DISK_FLOOR_MB    — min free disk (default 1024)
//   PAPERCLIP_MIGRATION_GATE_TIMEOUT_SEC      — hard cap (default 2400: a
//     pending migration touching a hub table drags the FK-ancestor closure in,
//     measured ~3 GB of data and a ~20 min replay cycle on this host)

import { existsSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXIT_PASS = 0;
const EXIT_BLOCK = 2;
const EXIT_INFRA = 3;

function log(msg) {
  console.log(`[${new Date().toISOString()}] gate: ${msg}`);
}

function parseArgs(argv) {
  const args = { keep: false, fullData: process.env.PAPERCLIP_MIGRATION_GATE_FULL_DATA === "1" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--release") args.release = argv[++i];
    else if (a === "--db-dist") args.dbDist = argv[++i];
    else if (a === "--live-url") args.liveUrl = argv[++i];
    else if (a === "--work-dir") args.workDir = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--full-data") args.fullData = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.release) throw new Error("--release <release-dir> is required");
  return args;
}

function defaultLiveUrl() {
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "54329";
  const db = process.env.PGDATABASE ?? "paperclip";
  const user = process.env.PGUSER ?? "paperclip";
  const pass = process.env.PGPASSWORD ?? "paperclip";
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

async function findFreePort(startPort) {
  const inUse = (port) =>
    new Promise((resolvePort) => {
      const server = createServer();
      server.unref();
      server.once("error", (error) => resolvePort(error.code === "EADDRINUSE"));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(false)));
    });
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (!(await inUse(port))) return port;
  }
  throw new Error(`no free port in ${startPort}..${startPort + 49}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tables whose DATA the replay needs: every live table whose name appears in
// any pending migration's SQL (quoted or bare, word-bounded), plus the
// TRANSITIVE FK-parent closure of that set. The closure is not optional: the
// snapshot's own restore re-validates every FK on a table that has data, so a
// kept table's ancestors must keep their rows too or the restore itself aborts
// (and replayed ADD CONSTRAINTs need real parents anyway). Over-matching (a
// table named in a comment) only costs snapshot bytes, never correctness.
function computeTouchedTables(pendingSqlBlobs, liveTables, fkEdges) {
  const touched = new Set();
  for (const { schema, table } of liveTables) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])"?${escapeRegExp(table)}"?(?![A-Za-z0-9_])`, "i");
    if (pendingSqlBlobs.some((sqlText) => pattern.test(sqlText))) {
      touched.add(`${schema}.${table}`);
    }
  }
  // Transitive closure over FK edges child -> parent.
  const queue = [...touched];
  while (queue.length > 0) {
    const key = queue.pop();
    for (const parent of fkEdges.get(key) ?? []) {
      if (!touched.has(parent)) {
        touched.add(parent);
        queue.push(parent);
      }
    }
  }
  return touched;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseDir = resolve(args.release);
  const dbDist = resolve(args.dbDist ?? join(releaseDir, "packages", "db", "dist"));
  const liveUrl = args.liveUrl ?? defaultLiveUrl();
  const diskFloorMb = Number(process.env.PAPERCLIP_MIGRATION_GATE_DISK_FLOOR_MB ?? 1024);

  log(`candidate release: ${releaseDir}`);
  log(`candidate db dist: ${dbDist}`);

  for (const required of ["client.js", "backup-lib.js", "migrations"]) {
    if (!existsSync(join(dbDist, required))) {
      throw new Error(`candidate db dist is missing ${required} — not a built release`);
    }
  }

  // Everything below comes from the CANDIDATE: applier, backup engine, and the
  // postgres / embedded-postgres dependencies its boot would use.
  const client = await import(pathToFileURL(join(dbDist, "client.js")).href);
  const backupLib = await import(pathToFileURL(join(dbDist, "backup-lib.js")).href);
  const candidateRequire = createRequire(join(dbDist, "client.js"));
  const postgres = candidateRequire("postgres");

  // ---- 1. inspect live (read-only) ------------------------------------------
  const liveState = await client.inspectMigrations(liveUrl);
  if (liveState.status === "upToDate") {
    log(`live DB is up to date (${liveState.appliedMigrations.length} applied) — nothing to replay`);
    console.log("MIGRATION-GATE: PASS (no pending migrations against live history)");
    return EXIT_PASS;
  }
  const pending = liveState.pendingMigrations;
  log(`pending against live history (${liveState.reason}): ${pending.join(", ")}`);
  if (liveState.reason !== "pending-migrations") {
    // Boot would refuse this state outright ("no migration journal") — that is
    // a live-DB problem, not something this SHA can fix or break. Fail closed
    // as infra so a human looks, without quarantining the SHA.
    throw new Error(`live DB migration state is ${liveState.reason} — gate cannot replay; boot would refuse too`);
  }

  // ---- disk floor -----------------------------------------------------------
  const workParent = args.workDir ?? process.env.TMPDIR ?? tmpdir();
  const stat = statfsSync(workParent);
  const freeMb = Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
  if (freeMb < diskFloorMb) {
    throw new Error(`only ${freeMb} MB free under ${workParent} < floor ${diskFloorMb} MB — refusing to snapshot`);
  }

  const workDir = mkdtempSync(join(workParent, "paperclip-migration-gate-"));
  let scratch = null;
  const timeoutSec = Number(process.env.PAPERCLIP_MIGRATION_GATE_TIMEOUT_SEC ?? 900);
  const watchdog = setTimeout(() => {
    console.error(`MIGRATION-GATE: INFRA-FAIL (timed out after ${timeoutSec}s)`);
    process.exit(EXIT_INFRA);
  }, timeoutSec * 1000);

  try {
    // ---- 2. scoped snapshot of the live DB ----------------------------------
    const liveSql = postgres(liveUrl, { max: 1, onnotice: () => {} });
    let excludeTables = [];
    let keptBytes = 0;
    try {
      const liveTables = (
        await liveSql.unsafe(
          `SELECT table_schema AS schema, table_name AS "table"
           FROM information_schema.tables
           WHERE table_type = 'BASE TABLE'
             AND table_schema <> 'information_schema'
             AND table_schema NOT LIKE 'pg\\_%'`,
        )
      ).map((row) => ({ schema: row.schema, table: row.table }));

      if (!args.fullData) {
        const fkRows = await liveSql.unsafe(
          `SELECT srcn.nspname AS child_schema, src.relname AS child_table,
                  tgtn.nspname AS parent_schema, tgt.relname AS parent_table
           FROM pg_constraint c
           JOIN pg_class src ON src.oid = c.conrelid
           JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
           JOIN pg_class tgt ON tgt.oid = c.confrelid
           JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
           WHERE c.contype = 'f'`,
        );
        const fkEdges = new Map();
        for (const row of fkRows) {
          const child = `${row.child_schema}.${row.child_table}`;
          if (!fkEdges.has(child)) fkEdges.set(child, new Set());
          fkEdges.get(child).add(`${row.parent_schema}.${row.parent_table}`);
        }

        const migrationsDir = join(dbDist, "migrations");
        const pendingSqlBlobs = await Promise.all(
          pending.map((file) => readFile(join(migrationsDir, file), "utf8")),
        );
        const touched = computeTouchedTables(pendingSqlBlobs, liveTables, fkEdges);
        // The migration journal's rows are the applied-history — the replay is
        // meaningless without them. Keep data for everything outside `public`
        // (drizzle + plugin namespaces are all small).
        const keep = (t) => touched.has(`${t.schema}.${t.table}`) || t.schema !== "public";
        excludeTables = liveTables.filter((t) => !keep(t)).map((t) => `${t.schema}.${t.table}`);
        const kept = liveTables.filter(keep);
        log(`snapshot scope: full schema; data for ${kept.length} table(s): ${kept.map((t) => `${t.schema}.${t.table}`).join(", ") || "(none)"}`);
        log(`data excluded for ${excludeTables.length} table(s) the pending migrations do not reference`);
        keptBytes = 0;
        for (const t of kept) {
          const regclass = `"${t.schema}"."${t.table}"`.replaceAll("'", "''");
          const rows = await liveSql.unsafe(`SELECT pg_total_relation_size('${regclass}') AS bytes`);
          keptBytes += Number(rows[0]?.bytes ?? 0);
        }
      } else {
        const rows = await liveSql.unsafe("SELECT pg_database_size(current_database()) AS bytes");
        keptBytes = Number(rows[0]?.bytes ?? 0);
        log("snapshot scope: FULL data (--full-data)");
      }
    } finally {
      await liveSql.end();
    }

    // The static floor above only guards the trivial case. The real bound is
    // the snapshot itself: dump + restored scratch cluster ≈ 2× the kept data.
    // Refusing here is what keeps the gate from finishing the disk off on a
    // nearly-full box (this host has been to 85% recently).
    const keptMb = Math.ceil(keptBytes / (1024 * 1024));
    const requiredMb = Math.ceil(keptMb * 2.2) + 512;
    if (freeMb < requiredMb) {
      throw new Error(
        `snapshot needs ~${requiredMb} MB (kept data ${keptMb} MB × 2.2 + slack) but only ${freeMb} MB free under ${workParent}`,
      );
    }
    log(`snapshot data volume ~${keptMb} MB (free ${freeMb} MB)`);

    const snapshotDir = join(workDir, "snapshot");
    const backupResult = await backupLib.runDatabaseBackup({
      connectionString: liveUrl,
      backupDir: snapshotDir,
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      backupEngine: "javascript",
      filenamePrefix: "gate",
      ...(excludeTables.length > 0 ? { excludeTables } : {}),
    });
    log(`snapshot written: ${backupResult.backupFile} (${backupResult.sizeBytes} bytes)`);

    // ---- 3. throwaway cluster + restore -------------------------------------
    const EmbeddedPostgres = (await import(pathToFileURL(candidateRequire.resolve("embedded-postgres")).href)).default;
    const scratchPort = await findFreePort(54990);
    const scratchDataDir = join(workDir, "scratch-pg");
    const clusterLogs = [];
    scratch = new EmbeddedPostgres({
      databaseDir: scratchDataDir,
      user: "paperclip",
      password: "paperclip",
      port: scratchPort,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: (m) => clusterLogs.push(String(m)),
      onError: (m) => clusterLogs.push(String(m)),
    });
    try {
      await scratch.initialise();
      await scratch.start();
    } catch (error) {
      throw new Error(
        `scratch cluster failed to start on :${scratchPort}: ${error?.message ?? error}\n${clusterLogs.slice(-15).join("\n")}`,
      );
    }
    const scratchAdminUrl = `postgres://paperclip:paperclip@127.0.0.1:${scratchPort}/postgres`;
    await client.ensurePostgresDatabase(scratchAdminUrl, "paperclip_gate");
    const scratchUrl = `postgres://paperclip:paperclip@127.0.0.1:${scratchPort}/paperclip_gate`;
    log(`scratch cluster up on :${scratchPort}, restoring snapshot`);
    await backupLib.runDatabaseRestore({ connectionString: scratchUrl, backupFile: backupResult.backupFile });

    // Parity check: the scratch DB must see the SAME pending set as live, or
    // the snapshot lost the journal — replaying would test the wrong thing.
    const scratchState = await client.inspectMigrations(scratchUrl);
    const scratchPending = scratchState.status === "upToDate" ? [] : scratchState.pendingMigrations;
    if (JSON.stringify(scratchPending) !== JSON.stringify(pending)) {
      throw new Error(
        `snapshot parity check failed: scratch pending [${scratchPending.join(", ")}] != live pending [${pending.join(", ")}]`,
      );
    }
    log("snapshot parity check passed: scratch sees the same pending set as live");

    // ---- 4. replay through the production applier ---------------------------
    log(`replaying ${pending.length} pending migration(s) via the candidate's applyPendingMigrations()`);
    try {
      await client.applyPendingMigrations(scratchUrl);
    } catch (error) {
      // Genuine SQL abort vs scratch infra death: if the cluster still answers,
      // the failure is the migration's own — exactly what production boot would
      // have hit.
      let clusterAlive = false;
      try {
        const probe = postgres(scratchUrl, { max: 1, connect_timeout: 5 });
        await probe.unsafe("SELECT 1");
        await probe.end();
        clusterAlive = true;
      } catch {
        clusterAlive = false;
      }
      if (!clusterAlive) {
        throw new Error(`scratch cluster died during replay: ${error?.message ?? error}`);
      }
      const detail = [error?.message ?? String(error)];
      if (error?.query) detail.push(`statement: ${String(error.query).split("\n").find((l) => l.trim() && !l.trim().startsWith("--"))?.slice(0, 200)}`);
      if (error?.detail) detail.push(`detail: ${error.detail}`);
      console.error(`MIGRATION-GATE: BLOCK — pending migration(s) [${pending.join(", ")}] abort against live data`);
      console.error(`MIGRATION-GATE: ${detail.join(" | ")}`);
      return EXIT_BLOCK;
    }

    log("replay applied cleanly; scratch DB reached upToDate");
    console.log(`MIGRATION-GATE: PASS (replayed ${pending.length} pending migration(s) against a live-data snapshot)`);
    return EXIT_PASS;
  } finally {
    clearTimeout(watchdog);
    if (scratch) {
      try {
        await scratch.stop();
      } catch {
        // The workdir removal below still reclaims the space.
      }
    }
    if (args.keep) {
      log(`--keep: leaving workdir ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`MIGRATION-GATE: INFRA-FAIL — ${error?.message ?? error}`);
  process.exit(EXIT_INFRA);
}
