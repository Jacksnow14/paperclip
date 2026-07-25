import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

const REAP_STALE_DATA_DIR_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Every embedded-postgres data dir this helper creates gets this marker prepended,
 * regardless of the caller-supplied label. The reaper below sweeps on this single
 * shared constant instead of each caller's own label so that: (a) a leaked dir is
 * reclaimed by *any* helper invocation's startup sweep, not only a re-run of the
 * exact test that created it (there are 60+ distinct caller labels in this repo),
 * and (b) one label that happens to be a string-prefix of another (e.g.
 * "environment-runtime" / "environment-runtime-contract") can no longer cause a
 * sweep scoped to the shorter label to reach into the longer one's dirs by accident
 * — every real data dir is reachable by the same marker, so scope is never label-dependent.
 */
const EMBEDDED_POSTGRES_TEMP_DIR_MARKER = "paperclip-embpg-";

/**
 * Data dirs that a helper call has created but not yet cleaned up. Used by the
 * process-exit/signal handlers below to reap dirs whose owning test never reached
 * its normal teardown (killed worker, uncaught throw after registration, etc).
 */
const activeEmbeddedPostgresDataDirs = new Set<string>();
let processExitHandlersInstalled = false;

function readPostmasterPid(dataDir: string): number | null {
  try {
    const contents = fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8");
    const pid = Number.parseInt(contents.split("\n")[0]?.trim() ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A leaked dir's own naming prefix is not evidence it's actually a Postgres data
 * dir — it's just whatever string the caller passed. Require the markers `initdb`
 * always writes before the reaper is allowed to `rm -rf` anything, so a stale
 * unrelated directory that happens to share a name prefix is never collateral damage.
 */
function isEmbeddedPostgresDataDir(dirPath: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dirPath, "PG_VERSION")) &&
      fs.existsSync(path.join(dirPath, "postgresql.conf"))
    );
  } catch {
    return false;
  }
}

/** Synchronous best-effort stop+remove, safe to call from a `process.on("exit")` handler. */
function reapDataDirSync(dataDir: string): void {
  const pid = readPostmasterPid(dataDir);
  if (pid !== null && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function handleProcessExit(): void {
  for (const dataDir of activeEmbeddedPostgresDataDirs) {
    reapDataDirSync(dataDir);
  }
}

function handleTerminationSignal(signal: NodeJS.Signals): void {
  // Reap synchronously ourselves, then remove our own listener and re-raise the signal so
  // its default disposition (and any other listener — e.g. vitest's own shutdown handling)
  // still runs, instead of unilaterally hard-exiting with a fixed code that would preempt it.
  handleProcessExit();
  process.removeListener(signal, handleTerminationSignal);
  process.kill(process.pid, signal);
}

function installProcessExitHandlers(): void {
  if (processExitHandlersInstalled) return;
  processExitHandlersInstalled = true;

  process.on("exit", handleProcessExit);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, handleTerminationSignal);
  }
}

/**
 * Removes tmpdir entries left behind by a prior helper invocation that never reached
 * its normal teardown (killed worker, SIGKILL, etc — none of which this process can
 * observe when it happens to another process). Scoped to this helper's shared marker
 * (never a per-caller label — see EMBEDDED_POSTGRES_TEMP_DIR_MARKER), and a candidate
 * is only ever removed once it is confirmed to be an actual Postgres data dir with no
 * live postmaster.
 */
function reapStaleEmbeddedPostgresTempDirs(maxAgeMs: number = REAP_STALE_DATA_DIR_AGE_MS): void {
  const tmpDir = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(EMBEDDED_POSTGRES_TEMP_DIR_MARKER)) continue;
    const fullPath = path.join(tmpDir, entry.name);

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < maxAgeMs) continue;

    const pid = readPostmasterPid(fullPath);
    if (pid !== null && isProcessAlive(pid)) continue;

    if (!isEmbeddedPostgresDataDir(fullPath)) continue;

    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `${EMBEDDED_POSTGRES_TEMP_DIR_MARKER}${tempDirPrefix}`),
  );
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  return { dataDir, port, instance };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  installProcessExitHandlers();
  const probePrefix = "paperclip-embedded-postgres-probe-";
  reapStaleEmbeddedPostgresTempDirs();

  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;

  try {
    const created = await createEmbeddedPostgresTestInstance(probePrefix);
    dataDir = created.dataDir;
    instance = created.instance;
    activeEmbeddedPostgresDataDirs.add(dataDir);
    await instance.initialise();
    await instance.start();
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await instance?.stop().catch(() => {});
    if (dataDir) {
      cleanupEmbeddedPostgresTestDirs(dataDir);
      activeEmbeddedPostgresDataDirs.delete(dataDir);
    }
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  installProcessExitHandlers();
  reapStaleEmbeddedPostgresTempDirs();

  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;

  try {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    dataDir = created.dataDir;
    instance = created.instance;
    activeEmbeddedPostgresDataDirs.add(dataDir);
    const { port } = created;
    await instance.initialise();
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await instance?.stop().catch(() => {});
        if (dataDir) {
          cleanupEmbeddedPostgresTestDirs(dataDir);
          activeEmbeddedPostgresDataDirs.delete(dataDir);
        }
      },
    };
  } catch (error) {
    await instance?.stop().catch(() => {});
    if (dataDir) {
      cleanupEmbeddedPostgresTestDirs(dataDir);
      activeEmbeddedPostgresDataDirs.delete(dataDir);
    }
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}

/** Exposed for tests only: exercises the same reap/registration internals used above. */
export const __testing = {
  activeEmbeddedPostgresDataDirs,
  EMBEDDED_POSTGRES_TEMP_DIR_MARKER,
  handleProcessExit,
  handleTerminationSignal,
  installProcessExitHandlers,
  isEmbeddedPostgresDataDir,
  reapStaleEmbeddedPostgresTempDirs,
  reapDataDirSync,
  readPostmasterPid,
};
