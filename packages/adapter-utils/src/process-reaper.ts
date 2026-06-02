/**
 * Backstop reaper for child processes tracked in `runningProcesses`.
 *
 * Why this exists (AUR-1714):
 *   The long-lived production server accumulated dozens of `<defunct>` (zombie)
 *   children over 47 days of uptime. Each child was a heartbeat run process
 *   spawned via `runChildProcess`. Registry cleanup was attached only to the
 *   `close` event, which never fires if a stdout/stderr pipe stays stuck on
 *   backpressure or never drains. The result: `runningProcesses` entries
 *   leaked, and the parent retained references to the ChildProcess and its
 *   pipe FDs — which prevented libuv from releasing the pidfd watcher and let
 *   the kernel slot stay as a zombie indefinitely.
 *
 * The primary fix lives in `runChildProcess` (registry cleanup + stdio
 * destruction on `exit`). This reaper is the backstop: it sweeps the
 * registry on a fixed cadence, drops entries whose child has died or is in
 * zombie state, and logs unreapable zombies so they're visible in ops dashboards.
 *
 * The reaper deliberately does NOT call `process.kill` on live PIDs. Its job
 * is registry hygiene + observability, not cancellation. Cancellation is
 * still owned by `cancelRunInternal`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { runningProcesses } from "./server-utils.js";

export interface ProcessReaperLogger {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ProcessReaperOptions {
  /** Sweep interval in milliseconds. Default 30 000ms. */
  intervalMs?: number;
  /** Logger; defaults to `console.warn`. */
  logger?: ProcessReaperLogger;
  /**
   * Override the registry being swept. Only used in tests so a unit test can
   * exercise the reaper without touching the global registry shared across
   * the process.
   */
  registry?: Map<string, { child: ChildProcess; processGroupId: number | null }>;
}

export interface ProcessReaperHandle {
  stop: () => void;
  /** Run a single sweep synchronously (for tests / manual triggers). */
  sweep: () => Promise<ProcessReaperSweepResult>;
}

export interface ProcessReaperSweepResult {
  scanned: number;
  removedDead: number;
  zombiesObserved: number;
  /** PIDs that were in state `Z` at the time of the sweep. */
  zombiePids: number[];
  /** runIds that were dropped because the child PID is gone. */
  removedRunIds: string[];
}

const DEFAULT_INTERVAL_MS = 30_000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 is a "does this PID exist" probe — no signal delivered.
    // Zombies return true here; that's intentional, the /proc state check
    // below distinguishes them.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    // EPERM means the PID exists but we don't have permission. Treat as
    // alive — we should not drop it from the registry.
    return code === "EPERM";
  }
}

async function readProcState(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const raw = await fs.readFile(path.join("/proc", String(pid), "status"), "utf8");
    const stateLine = raw.split("\n").find((line) => line.startsWith("State:"));
    if (!stateLine) return null;
    // Format: "State:\tZ (zombie)"
    const match = stateLine.split(/\s+/)[1];
    return match ?? null;
  } catch {
    return null;
  }
}

export function startProcessReaper(options: ProcessReaperOptions = {}): ProcessReaperHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger ?? {
    warn: (obj, msg) => console.warn(JSON.stringify({ ...obj, msg })),
  };
  const registry = options.registry ?? runningProcesses;

  const runSweep = async (): Promise<ProcessReaperSweepResult> => {
    const result: ProcessReaperSweepResult = {
      scanned: 0,
      removedDead: 0,
      zombiesObserved: 0,
      zombiePids: [],
      removedRunIds: [],
    };

    const snapshot = Array.from(registry.entries());
    for (const [runId, entry] of snapshot) {
      result.scanned += 1;
      const pid = entry.child.pid;
      if (typeof pid !== "number" || pid <= 0) {
        registry.delete(runId);
        result.removedDead += 1;
        result.removedRunIds.push(runId);
        continue;
      }

      const alive = isPidAlive(pid);
      if (!alive) {
        // PID is gone and `runChildProcess` never cleaned the registry.
        // Drop it and force-detach pipe references.
        registry.delete(runId);
        result.removedDead += 1;
        result.removedRunIds.push(runId);
        try { entry.child.stdout?.destroy(); } catch { /* best effort */ }
        try { entry.child.stderr?.destroy(); } catch { /* best effort */ }
        try { entry.child.stdin?.destroy(); } catch { /* best effort */ }
        try { entry.child.unref(); } catch { /* best effort */ }
        logger.warn?.({ runId, pid }, "process-reaper dropped dead registry entry");
        continue;
      }

      // PID still exists. Check whether it's a zombie that libuv hasn't
      // reaped yet. We can't waitpid from JS — but we can log it for ops
      // visibility AND force-destroy the parent-side pipes which sometimes
      // unblocks libuv's pidfd handling.
      const state = await readProcState(pid);
      if (state === "Z") {
        result.zombiesObserved += 1;
        result.zombiePids.push(pid);
        try { entry.child.stdout?.destroy(); } catch { /* best effort */ }
        try { entry.child.stderr?.destroy(); } catch { /* best effort */ }
        try { entry.child.stdin?.destroy(); } catch { /* best effort */ }
        try { entry.child.unref(); } catch { /* best effort */ }
        // Drop from registry so we stop holding a reference; the kernel
        // will reap once libuv catches up or when the parent exits.
        registry.delete(runId);
        result.removedDead += 1;
        result.removedRunIds.push(runId);
        logger.warn?.(
          { runId, pid },
          "process-reaper observed zombie child; dropped registry entry and forced stdio close",
        );
      }
    }

    return result;
  };

  const timer = setInterval(() => {
    void runSweep().catch((err) => {
      logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "process-reaper sweep failed",
      );
    });
  }, intervalMs);
  // Don't let the reaper keep the event loop alive on shutdown.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => clearInterval(timer),
    sweep: runSweep,
  };
}
