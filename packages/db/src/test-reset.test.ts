import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { companies, issueComments, issues } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import {
  extractPostgresErrorCode,
  resetEmbeddedPostgresTestDatabase,
  type TestDatabaseResetTarget,
} from "./test-reset.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres test-reset tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function extractConstraintName(error: unknown): string | undefined {
  for (
    let cause: unknown = error;
    cause && typeof cause === "object";
    cause = (cause as { cause?: unknown }).cause
  ) {
    const name = (cause as { constraint_name?: unknown }).constraint_name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function deadlockError(): Error {
  return new Error("deadlock detected", { cause: { code: "40P01" } });
}

function fkViolationError(): Error {
  const error = new Error(
    'update or delete on table "issues" violates foreign key constraint "issue_comments_issue_id_issues_id_fk"',
  );
  (error as Error & { code: string }).code = "23503";
  return error;
}

/**
 * Fake reset target: call 1 serves the catalog query, later calls run the
 * scripted truncate outcomes.
 */
function fakeResetTarget(truncateOutcomes: Array<Error | null>): {
  target: TestDatabaseResetTarget;
  execute: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const execute = vi.fn(async () => {
    call += 1;
    if (call === 1) return [{ tablename: "issues" }, { tablename: "issue_comments" }];
    const outcome = truncateOutcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return [];
  });
  return { target: { execute }, execute };
}

describe("extractPostgresErrorCode", () => {
  it("reads the code from the error itself and from nested causes", () => {
    expect(extractPostgresErrorCode(fkViolationError())).toBe("23503");
    expect(extractPostgresErrorCode(new Error("outer", { cause: deadlockError() }))).toBe("40P01");
    expect(extractPostgresErrorCode(new Error("no code"))).toBeUndefined();
    expect(extractPostgresErrorCode(null)).toBeUndefined();
  });
});

describe("resetEmbeddedPostgresTestDatabase deadlock retry", () => {
  it("retries a 40P01 deadlock and converges once the partner session finishes", async () => {
    const { target, execute } = fakeResetTarget([deadlockError(), deadlockError(), null]);
    await resetEmbeddedPostgresTestDatabase(target, { deadlockRetryDelayMs: 0 });
    // 1 catalog query + 2 deadlocked truncates + 1 clean truncate
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("gives up loudly after the bounded attempts instead of spinning forever", async () => {
    const { target, execute } = fakeResetTarget([
      deadlockError(),
      deadlockError(),
      deadlockError(),
    ]);
    await expect(
      resetEmbeddedPostgresTestDatabase(target, {
        maxDeadlockAttempts: 3,
        deadlockRetryDelayMs: 0,
      }),
    ).rejects.toThrow("deadlock detected");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-deadlock errors — an FK violation must stay loud", async () => {
    const { target, execute } = fakeResetTarget([fkViolationError()]);
    await expect(
      resetEmbeddedPostgresTestDatabase(target, { deadlockRetryDelayMs: 0 }),
    ).rejects.toThrow("issue_comments_issue_id_issues_id_fk");
    // exactly 1 catalog query + 1 truncate attempt: no blanket retry hiding real bugs
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("is a no-op on a database with no public tables", async () => {
    const execute = vi.fn(async () => []);
    await resetEmbeddedPostgresTestDatabase({ execute });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describeEmbeddedPostgres("teardown FK-race discrimination", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-test-reset-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Fixture hygiene between tests. This suite has no background writers, so
    // ordered deletes are deterministic here; the reset helper is exercised by
    // the tests themselves, not the fixture.
    await db.execute(sql`delete from issue_comments`);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithComment() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reset Discrimination Co" });
    await db.insert(issues).values({ id: issueId, companyId, title: "teardown fixture" });
    await db.insert(issueComments).values({ companyId, issueId, body: "child row" });
    return { companyId, issueId };
  }

  it("control (FAIL direction): deleting parents before children raises the trunk 23503", async () => {
    await seedIssueWithComment();

    const error = await db.delete(issues).then(
      () => null,
      (raised: unknown) => raised,
    );

    expect(error).not.toBeNull();
    expect(extractPostgresErrorCode(error)).toBe("23503");
    expect(extractConstraintName(error)).toBe("issue_comments_issue_id_issues_id_fk");
  });

  it("control (root cause): a correctly ordered delete still fails when a writer lands in the window", async () => {
    const { companyId, issueId } = await seedIssueWithComment();

    // The exact interleaving from AUR-5103: children cleared first (the order
    // the failing suite already used) ...
    await db.execute(sql`delete from issue_comments`);
    // ... then a scheduler continuation commits a fresh child before the
    // parent delete runs.
    await db.insert(issueComments).values({ companyId, issueId, body: "landed in the window" });

    const error = await db.delete(issues).then(
      () => null,
      (raised: unknown) => raised,
    );

    expect(extractPostgresErrorCode(error)).toBe("23503");
  });

  it("mechanism (PASS direction): reset clears the state ordered deletes fail on, sparing migration history", async () => {
    const { companyId, issueId } = await seedIssueWithComment();
    // Same poisoned state as the root-cause control above.
    await db.execute(sql`delete from issue_comments`);
    await db.insert(issueComments).values({ companyId, issueId, body: "landed in the window" });

    await resetEmbeddedPostgresTestDatabase(db);

    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
    const migrations = Array.from(
      (await db.execute(
        sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
      )) as Iterable<{ applied: number }>,
    );
    expect(Number(migrations[0]?.applied)).toBeGreaterThan(0);
  });

  it("mechanism: waits out a concurrent writer holding an uncommitted child row, then wipes it too", async () => {
    const { companyId, issueId } = await seedIssueWithComment();
    const writer = postgres(tempDb.connectionString, { max: 1, onnotice: () => {} });
    try {
      let releaseWriter!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let signalInsertLanded!: () => void;
      const insertLanded = new Promise<void>((resolve) => {
        signalInsertLanded = resolve;
      });
      const writerTx = writer.begin(async (tx) => {
        await tx.unsafe(
          "insert into issue_comments (company_id, issue_id, body) values ($1, $2, $3)",
          [companyId, issueId, "uncommitted background write"],
        );
        signalInsertLanded();
        await gate;
      });
      // The gate keeps writerTx from resolving, so winning the race means the
      // insert landed; a writer-side failure rejects here with the real error.
      await Promise.race([insertLanded, writerTx]);

      // The truncate must queue behind the writer's locks (no deadlock: the
      // writer wants nothing further), then wipe the row the writer commits.
      const resetPromise = resetEmbeddedPostgresTestDatabase(db);
      await new Promise((resolve) => setTimeout(resolve, 150));
      releaseWriter();
      await writerTx;
      await resetPromise;

      expect(await db.select().from(issueComments)).toHaveLength(0);
      expect(await db.select().from(issues)).toHaveLength(0);
    } finally {
      await writer.end();
    }
  }, 15_000);

  it("mechanism: covers tables created after the helper was written — no hand-maintained list to drift", async () => {
    const { issueId } = await seedIssueWithComment();
    await db.execute(
      sql.raw(`
        create table if not exists "aur5103_future_child" (
          "id" uuid primary key default gen_random_uuid(),
          "issue_id" uuid not null references "issues"("id")
        )
      `),
    );
    await db.execute(
      sql.raw(`insert into "aur5103_future_child" ("issue_id") values ('${issueId}')`),
    );
    // Any hand-maintained delete list written before this table existed is now
    // stale: the parent delete trips its FK.
    await db.execute(sql`delete from issue_comments`);
    const error = await db.delete(issues).then(
      () => null,
      (raised: unknown) => raised,
    );
    expect(extractPostgresErrorCode(error)).toBe("23503");

    // The catalog-derived reset picks the new table up with no code change.
    await resetEmbeddedPostgresTestDatabase(db);
    const rows = Array.from(
      (await db.execute(
        sql`select count(*)::int as remaining from "aur5103_future_child"`,
      )) as Iterable<{ remaining: number }>,
    );
    expect(Number(rows[0]?.remaining)).toBe(0);
    expect(await db.select().from(issues)).toHaveLength(0);
  });
});
