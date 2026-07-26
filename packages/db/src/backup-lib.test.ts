import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  BackupProducerConflictError,
  createBufferedTextFileWriter,
  emergencyPruneBackups,
  getNewestBackupAgeMs,
  pruneOldBackups,
  runDatabaseBackup,
  runDatabaseRestore,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "round-trips the production COPY-format dump without psql (AUR-4035 DoD 4)",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      // Force the exact production configuration regardless of host tooling:
      // pg_dump unavailable → JS engine emits COPY blocks; psql unavailable →
      // restore must go through the driver's copy-in path.
      const savedPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      const savedPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/nonexistent/pg_dump";
      process.env.PAPERCLIP_PSQL_PATH = "/nonexistent/psql";
      cleanups.push(() => {
        if (savedPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = savedPgDumpPath;
        if (savedPsqlPath === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        else process.env.PAPERCLIP_PSQL_PATH = savedPsqlPath;
      });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."copy_roundtrip_test" (
            "id" serial PRIMARY KEY,
            "label" text NOT NULL,
            "tricky" text
          );
        `);
        // Values that exercise COPY text-format escaping
        await sourceSql`
          INSERT INTO "public"."copy_roundtrip_test" ("label", "tricky") VALUES
            ('plain', 'hello'),
            ('tab', ${"a\tb"}),
            ('newline', ${"line1\nline2"}),
            ('backslash', ${"back\\slash and \\."}),
            ('null-value', ${null})
        `;

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-test",
          // engine "auto" — the pg_dump attempt fails, falling back to the JS
          // engine, which uses COPY blocks when no transforms are configured
        });

        // Control: this dump really is COPY-format. Without it the test would
        // silently regress to the INSERT path and stop guarding anything.
        const zlib = await import("node:zlib");
        const dumpText = zlib.gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
        expect(dumpText).toContain("FROM stdin;");
        expect(dumpText).not.toContain("INSERT INTO \"public\".\"copy_roundtrip_test\"");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ label: string; tricky: string | null }[]>(`
          SELECT "label", "tricky"
          FROM "public"."copy_roundtrip_test"
          ORDER BY "id"
        `);
        expect(rows).toEqual([
          { label: "plain", tricky: "hello" },
          { label: "tab", tricky: "a\tb" },
          { label: "newline", tricky: "line1\nline2" },
          { label: "backslash", tricky: "back\\slash and \\." },
          { label: "null-value", tricky: null },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    20_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Retention logic unit tests — no real DB required
// ---------------------------------------------------------------------------

function createBackupFiles(
  dir: string,
  prefix: string,
  timestamps: Array<{ iso: string; sizeBytes?: number }>,
): void {
  for (const { iso, sizeBytes = 1024 } of timestamps) {
    const safe = iso.replace(/[:-]/g, "").replace("T", "-").slice(0, 15);
    const filename = `${prefix}-${safe}.sql.gz`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, Buffer.alloc(sizeBytes));
    const mtime = new Date(iso);
    fs.utimesSync(fullPath, mtime, mtime);
  }
}

function listBackupFiles(dir: string, prefix: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".sql.gz"))
    .sort();
}

function keyPart(iso: string): string {
  return iso.replace(/[:-]/g, "").replace("T", "-").slice(0, 13);
}

describe("pruneOldBackups — retention logic", () => {
  it("hourly count cap: 7 days × hourly cadence self-bounds to hourlyCount + daily/weekly/monthly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-hourly-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const now = new Date("2026-01-08T12:00:00Z");
    const timestamps: Array<{ iso: string }> = [];
    // 7 days × 24 hours = 168 hourly dumps
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const d = new Date(now.getTime() - (day * 24 + hour) * 60 * 60 * 1000);
        timestamps.push({ iso: d.toISOString() });
      }
    }
    createBackupFiles(dir, "pc", timestamps);
    expect(listBackupFiles(dir, "pc").length).toBe(168);

    pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 2,
      monthlyMonths: 1,
      hourlyCount: 48,
      maxBytes: 0, // no byte cap for this test
    }, "pc");

    const remaining = listBackupFiles(dir, "pc");
    // hourlyCount(48) + at most 7 daily + 2 weekly representatives ≈ ≤60
    expect(remaining.length).toBeLessThan(70);
    expect(remaining.length).toBeGreaterThan(0);
    // Newest backup must always survive
    const newest = timestamps.reduce((a, b) => a.iso > b.iso ? a : b);
    expect(remaining.some((f) => f.includes(keyPart(newest.iso)))).toBe(true);
  });

  it("hourly count cap: newest N are always kept, oldest pruned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-newest-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const now = new Date("2026-01-08T10:00:00Z");
    const timestamps = Array.from({ length: 10 }, (_, i) => ({
      iso: new Date(now.getTime() - i * 60 * 60 * 1000).toISOString(),
    }));
    createBackupFiles(dir, "pc", timestamps);

    pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 2,
      monthlyMonths: 1,
      hourlyCount: 3,
      maxBytes: 0,
    }, "pc");

    const remaining = listBackupFiles(dir, "pc");
    // 3 hourly + at most 1 per additional day within dailyDays
    expect(remaining.length).toBeLessThanOrEqual(4);
    // The 3 newest must survive
    const sortedDesc = [...timestamps].sort((a, b) => b.iso.localeCompare(a.iso));
    for (const ts of sortedDesc.slice(0, 3)) {
      expect(remaining.some((f) => f.includes(keyPart(ts.iso)))).toBe(true);
    }
  });

  it("byte cap: removes oldest kept when total exceeds cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-bytes-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const now = new Date("2026-01-08T12:00:00Z");
    const MB = 1024 * 1024;
    // 5 files 1h apart, each 10 MiB → 50 MiB total, cap at 25 MiB → must keep 2
    const timestamps = Array.from({ length: 5 }, (_, i) => ({
      iso: new Date(now.getTime() - i * 60 * 60 * 1000).toISOString(),
      sizeBytes: 10 * MB,
    }));
    createBackupFiles(dir, "pc", timestamps);

    pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 2,
      monthlyMonths: 1,
      hourlyCount: 10,
      maxBytes: 25 * MB,
    }, "pc");

    const remaining = listBackupFiles(dir, "pc");
    expect(remaining.length).toBe(2); // 2×10 MiB = 20 MiB ≤ 25 MiB cap
    // The 2 newest must survive
    const sortedDesc = [...timestamps].sort((a, b) => b.iso.localeCompare(a.iso));
    for (const ts of sortedDesc.slice(0, 2)) {
      expect(remaining.some((f) => f.includes(keyPart(ts.iso)))).toBe(true);
    }
  });

  it("byte cap: always keeps at least 1 backup even if every file exceeds cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-mincap-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const MB = 1024 * 1024;
    const timestamps = [
      { iso: new Date("2026-01-08T12:00:00Z").toISOString(), sizeBytes: 100 * MB },
      { iso: new Date("2026-01-08T11:00:00Z").toISOString(), sizeBytes: 100 * MB },
    ];
    createBackupFiles(dir, "pc", timestamps);

    pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 2,
      monthlyMonths: 1,
      hourlyCount: 10,
      maxBytes: 1 * MB, // cap smaller than any single file
    }, "pc");

    // Must always keep at least 1 (the newest)
    const remaining = listBackupFiles(dir, "pc");
    expect(remaining.length).toBe(1);
    expect(remaining.some((f) => f.includes(keyPart(timestamps[0]!.iso)))).toBe(true);
  });

  it("byte cap eviction is tier-aware: hourly bulk dies first, daily/weekly/monthly anchors survive (AUR-4035)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-tiercap-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const MB = 1024 * 1024;
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const at = (agoMs: number) => ({ iso: new Date(now - agoMs).toISOString(), sizeBytes: 10 * MB });
    const fileNameFor = (agoMs: number) => {
      const safe = new Date(now - agoMs).toISOString().replace(/[:-]/g, "").replace("T", "-").slice(0, 15);
      return `pc-${safe}.sql.gz`;
    };

    // 8 hourly near-duplicates + the DR ladder: 3 daily, 2 weekly, 1 monthly anchors
    const hourlyAgos = Array.from({ length: 8 }, (_, i) => i * HOUR);
    const anchorAgos = [2 * DAY, 3 * DAY, 4 * DAY, 10 * DAY, 17 * DAY, 35 * DAY];
    createBackupFiles(dir, "pc", [...hourlyAgos, ...anchorAgos].map(at));

    const measure = () =>
      listBackupFiles(dir, "pc").reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    // Control: the saturation the cap must resolve actually exists (14 × 10 MiB > 80 MiB cap)
    expect(measure()).toBe(140 * MB);

    const result = pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 4,
      monthlyMonths: 3,
      hourlyCount: 8,
      maxBytes: 80 * MB,
    }, "pc");

    // Bytes actually left the disk, and the result reports them accurately
    const afterBytes = measure();
    expect(afterBytes).toBe(80 * MB);
    expect(result.prunedBytes).toBe(60 * MB);
    expect(result.prunedCount).toBe(6);
    expect(result.keptBytes).toBe(afterBytes);
    // Every DR anchor survived: the cap drained the hourly tier instead.
    // (The pre-AUR-4035 oldest-first eviction deleted exactly these six.)
    for (const ago of anchorAgos) {
      expect(fs.existsSync(path.join(dir, fileNameFor(ago)))).toBe(true);
    }
    // The evicted mass is the oldest hourlies; the newest two hourlies remain
    expect(fs.existsSync(path.join(dir, fileNameFor(0)))).toBe(true);
    expect(fs.existsSync(path.join(dir, fileNameFor(1 * HOUR)))).toBe(true);
    for (const ago of hourlyAgos.slice(2)) {
      expect(fs.existsSync(path.join(dir, fileNameFor(ago)))).toBe(false);
    }
  });

  it("tier fall-through: daily → weekly → monthly; nothing survives beyond monthlyMonths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-prune-tiers-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const now = new Date("2026-03-01T12:00:00Z");
    const timestamps = Array.from({ length: 90 }, (_, day) => ({
      iso: new Date(now.getTime() - day * 24 * 60 * 60 * 1000).toISOString(),
    }));
    createBackupFiles(dir, "pc", timestamps);

    pruneOldBackups(dir, {
      dailyDays: 7,
      weeklyWeeks: 4,
      monthlyMonths: 2,
      hourlyCount: 2,
      maxBytes: 0,
    }, "pc");

    const remaining = listBackupFiles(dir, "pc");
    // hourly(2) + ~5 daily + ~4 weekly + ~2 monthly ≈ ≤20
    expect(remaining.length).toBeLessThanOrEqual(20);
    expect(remaining.length).toBeGreaterThan(0);
    // Nothing older than monthlyMonths×30 days should survive
    const cutoffMs = now.getTime() - 2 * 30 * 24 * 60 * 60 * 1000;
    const tooOld = remaining.filter((f) => {
      const ts = timestamps.find((t) => f.includes(keyPart(t.iso)));
      return ts !== undefined && new Date(ts.iso).getTime() < cutoffMs;
    });
    expect(tooOld.length).toBe(0);
  });
});

describe("emergencyPruneBackups — disk-pressure remediation (AUR-4035 defect 3)", () => {
  it("frees measured disk bytes from a dir the normal prune cannot shrink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-emergency-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const MB = 1024 * 1024;
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();
    // The incident shape: 23 hourly dumps, retention whose hourly tier wants
    // them all and whose byte cap they fit under.
    const timestamps = Array.from({ length: 23 }, (_, i) => ({
      iso: new Date(now - i * HOUR).toISOString(),
      sizeBytes: 10 * MB,
    }));
    createBackupFiles(dir, "pc", timestamps);
    const incidentRetention = {
      dailyDays: 7,
      weeklyWeeks: 4,
      monthlyMonths: 1,
      hourlyCount: 48,
      maxBytes: 240 * MB,
    };
    const measure = () =>
      listBackupFiles(dir, "pc").reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    expect(measure()).toBe(230 * MB);

    // Control — reproduce the defect: the "next backup cycle" prune the old
    // alert relied on frees nothing under this retention.
    const noopResult = pruneOldBackups(dir, incidentRetention, "pc");
    expect(noopResult.prunedCount).toBe(0);
    expect(noopResult.prunedBytes).toBe(0);
    expect(measure()).toBe(230 * MB);

    // Fix: the emergency overlay collapses the hourly bulk and actually frees bytes.
    const result = emergencyPruneBackups(dir, incidentRetention, "pc");
    const afterBytes = measure();
    expect(afterBytes).toBeLessThanOrEqual(40 * MB);
    expect(result.prunedBytes).toBe(230 * MB - afterBytes);
    expect(result.prunedBytes).toBeGreaterThanOrEqual(190 * MB);
    expect(result.prunedCount).toBeGreaterThanOrEqual(19);
    // The newest dump always survives an emergency prune
    const newest = timestamps[0]!;
    expect(listBackupFiles(dir, "pc").some((f) => f.includes(keyPart(newest.iso)))).toBe(true);
  });
});

describe("duplicate-producer guards (AUR-4035 defect 2)", () => {
  const MB = 1024 * 1024;
  // Nothing listens on port 1; guard checks must fire before any connection.
  const unreachableConnectionString = "postgres://paperclip:paperclip@127.0.0.1:1/paperclip";
  const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };

  it("getNewestBackupAgeMs reports the newest matching dump and null when none exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-newest-age-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    expect(getNewestBackupAgeMs(dir, "pc")).toBeNull();
    expect(getNewestBackupAgeMs(path.join(dir, "missing"), "pc")).toBeNull();

    const now = Date.now();
    createBackupFiles(dir, "pc", [
      { iso: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
      { iso: new Date(now - 30 * 60 * 1000).toISOString() },
    ]);
    // A non-matching prefix must not count
    fs.writeFileSync(path.join(dir, "other-20260101-000000.sql.gz"), Buffer.alloc(16));

    const ageMs = getNewestBackupAgeMs(dir, "pc", now);
    expect(ageMs).not.toBeNull();
    expect(ageMs!).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(ageMs!).toBeLessThanOrEqual(31 * 60 * 1000);
    expect(getNewestBackupAgeMs(dir, "other", now)).toBeLessThanOrEqual(1000);
  });

  it("refuses a dump when the newest backup is inside the min spacing window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-minspacing-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    createBackupFiles(dir, "pc", [
      { iso: new Date(Date.now() - 2 * 60 * 1000).toISOString(), sizeBytes: 1 * MB },
    ]);
    const before = listBackupFiles(dir, "pc");

    const err = await runDatabaseBackup({
      connectionString: unreachableConnectionString,
      backupDir: dir,
      retention,
      filenamePrefix: "pc",
      minIntervalMs: 55 * 60 * 1000,
      connectTimeoutSeconds: 1,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BackupProducerConflictError);
    expect((err as BackupProducerConflictError).reason).toBe("recent_backup");
    // Guard fired before any file was created or deleted
    expect(listBackupFiles(dir, "pc")).toEqual(before);
    expect(fs.existsSync(path.join(dir, ".pc-backup.lock"))).toBe(false);
  });

  it("refuses a dump while a live producer holds the cross-process lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lockheld-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const lockPath = path.join(dir, ".pc-backup.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    const err = await runDatabaseBackup({
      connectionString: unreachableConnectionString,
      backupDir: dir,
      retention,
      filenamePrefix: "pc",
      connectTimeoutSeconds: 1,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BackupProducerConflictError);
    expect((err as BackupProducerConflictError).reason).toBe("lock_held");
    // The loser must not delete the holder's lock
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("breaks a stale lock (dead pid) and releases its own lock even on failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lockstale-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const { spawnSync } = await import("node:child_process");
    const deadPid = spawnSync("true").pid;
    expect(deadPid).toBeGreaterThan(0);

    const lockPath = path.join(dir, ".pc-backup.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));

    const err = await runDatabaseBackup({
      connectionString: unreachableConnectionString,
      backupDir: dir,
      retention,
      filenamePrefix: "pc",
      connectTimeoutSeconds: 1,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // The stale lock was broken: the run got past the guard and failed on the
    // (unreachable) database instead of on the producer conflict.
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(BackupProducerConflictError);
    // And the lock taken for the failed run was released
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(listBackupFiles(dir, "pc")).toEqual([]);
  });
});
