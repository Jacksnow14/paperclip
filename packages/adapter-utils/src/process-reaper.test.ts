import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";
import { startProcessReaper } from "./process-reaper.js";

function spawnDirect(): ChildProcess {
  // Long-lived child so we can synthesize a "leaked registry entry" without
  // racing the runChildProcess close path.
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describe("process-reaper", () => {
  it("drops registry entries whose child PID is gone", async () => {
    const registry = new Map<string, { child: ChildProcess; processGroupId: number | null }>();
    const child = spawnDirect();
    const runId = randomUUID();
    registry.set(runId, { child, processGroupId: child.pid ?? null });

    // Kill it directly to leave a dangling registry entry.
    child.kill("SIGKILL");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);

    const handle = startProcessReaper({ intervalMs: 60_000, registry });
    const result = await handle.sweep();
    handle.stop();

    expect(result.scanned).toBe(1);
    expect(result.removedDead).toBe(1);
    expect(registry.has(runId)).toBe(false);
  });

  it("leaves live children in the registry alone", async () => {
    const registry = new Map<string, { child: ChildProcess; processGroupId: number | null }>();
    const child = spawnDirect();
    const runId = randomUUID();
    registry.set(runId, { child, processGroupId: child.pid ?? null });

    const handle = startProcessReaper({ intervalMs: 60_000, registry });
    const result = await handle.sweep();
    handle.stop();

    expect(registry.has(runId)).toBe(true);
    expect(result.removedDead).toBe(0);
    expect(result.zombiesObserved).toBe(0);

    child.kill("SIGKILL");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  });

  it.skipIf(process.platform === "win32")(
    "runChildProcess clears the global registry on exit (not just close)",
    async () => {
      const runId = randomUUID();
      const before = runningProcesses.size;
      const result = await runChildProcess(
        runId,
        process.execPath,
        ["-e", "process.stdout.write('ok')"],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok");
      expect(runningProcesses.has(runId)).toBe(false);
      expect(runningProcesses.size).toBe(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "spawning many short-lived children does not leak zombies",
    async () => {
      const FAN = 25;
      const promises: Array<Promise<unknown>> = [];
      for (let i = 0; i < FAN; i += 1) {
        promises.push(
          runChildProcess(
            randomUUID(),
            process.execPath,
            ["-e", `process.stdout.write('${i}')`],
            {
              cwd: process.cwd(),
              env: {},
              timeoutSec: 5,
              graceSec: 1,
              onLog: async () => {},
            },
          ),
        );
      }
      const results = await Promise.all(promises);
      for (const result of results) {
        expect((result as { exitCode: number | null }).exitCode).toBe(0);
      }

      // Give libuv a tick to settle, then assert registry is empty for the
      // runs we just launched. (Other tests in the suite may share the global
      // registry, so we don't assert size===0.)
      await new Promise((resolve) => setImmediate(resolve));

      // Run a sweep with the global registry — any leftover entries our test
      // contributed would be dropped and counted.
      const handle = startProcessReaper({ intervalMs: 60_000 });
      const sweep = await handle.sweep();
      handle.stop();
      expect(sweep.removedDead).toBe(0);
      expect(sweep.zombiesObserved).toBe(0);
    },
  );
});
