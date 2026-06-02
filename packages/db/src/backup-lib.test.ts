import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createBufferedTextFileWriter, pruneOldBackups, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
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
