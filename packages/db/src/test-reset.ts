import { sql, type SQL } from "drizzle-orm";

/**
 * Minimal structural view of a drizzle database used by
 * {@link resetEmbeddedPostgresTestDatabase}. Kept structural so the retry
 * behaviour can be unit-tested against a fake executor without an embedded
 * Postgres instance.
 */
export interface TestDatabaseResetTarget {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface ResetEmbeddedPostgresTestDatabaseOptions {
  /** Attempts for the truncate when Postgres resolves a deadlock against us (40P01). */
  maxDeadlockAttempts?: number;
  /** Delay between deadlock retries, in milliseconds. */
  deadlockRetryDelayMs?: number;
}

/**
 * Walks an error's `cause` chain and returns the first Postgres error code
 * (`23503`, `40P01`, ...) it finds. postgres-js surfaces the code on the root
 * error; drizzle sometimes wraps it one or more `cause` levels down.
 */
export function extractPostgresErrorCode(error: unknown): string | undefined {
  for (
    let cause: unknown = error;
    cause && typeof cause === "object";
    cause = (cause as { cause?: unknown }).cause
  ) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function quotePostgresIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const DEADLOCK_CODE = "40P01";

/**
 * Wipes every table in the test database's `public` schema with a single
 * `TRUNCATE ... CASCADE` statement.
 *
 * Why one statement instead of ordered per-table deletes: suites that run the
 * live heartbeat scheduler race their own background machinery. Even a
 * correctly FK-ordered delete sequence has a window between the child-table
 * delete and the parent-table delete where a scheduler continuation can commit
 * a fresh child row, failing the parent delete with 23503 (AUR-4526,
 * AUR-4555, AUR-5103). A single statement has no such window: it acquires
 * ACCESS EXCLUSIVE on every table before removing any row, so a concurrent
 * writer either commits before the truncate (and is wiped with everything
 * else) or fails its own FK check afterwards — the teardown itself cannot
 * lose the race.
 *
 * The table list is read from the live catalog on every call, so new tables
 * are covered the moment their migration lands — there is no hand-maintained
 * list to drift. Drizzle's migration bookkeeping lives in the `drizzle`
 * schema (excluded by the `public` filter; the name filter is a belt for
 * setups that keep it in `public`) and survives the reset.
 *
 * Postgres may resolve a lock cycle with the suite's own in-flight scheduler
 * transaction by killing the truncate (40P01); that specific code is retried
 * a bounded number of times (AUR-4648). Every other error — including FK
 * violations — propagates immediately: retrying those would hide real
 * teardown bugs, which is exactly the band-aid this helper replaces.
 */
export async function resetEmbeddedPostgresTestDatabase(
  db: TestDatabaseResetTarget,
  options: ResetEmbeddedPostgresTestDatabaseOptions = {},
): Promise<void> {
  const maxDeadlockAttempts = options.maxDeadlockAttempts ?? 5;
  const deadlockRetryDelayMs = options.deadlockRetryDelayMs ?? 250;

  const catalogRows = (await db.execute(sql`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `)) as Iterable<Record<string, unknown>>;
  const tables = Array.from(catalogRows)
    .map((row) => row.tablename)
    .filter((name): name is string => typeof name === "string");
  if (tables.length === 0) return;

  const truncate = sql.raw(
    `truncate table ${tables.map(quotePostgresIdentifier).join(", ")} cascade`,
  );

  let lastDeadlockError: unknown;
  for (let attempt = 0; attempt < maxDeadlockAttempts; attempt += 1) {
    try {
      await db.execute(truncate);
      return;
    } catch (error) {
      if (extractPostgresErrorCode(error) !== DEADLOCK_CODE) throw error;
      lastDeadlockError = error;
      await new Promise((resolve) => setTimeout(resolve, deadlockRetryDelayMs));
    }
  }
  throw lastDeadlockError;
}
