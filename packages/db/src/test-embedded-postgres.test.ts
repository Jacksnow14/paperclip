import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./test-embedded-postgres.js";

const {
  activeEmbeddedPostgresDataDirs,
  handleProcessExit,
  handleTerminationSignal,
  reapDataDirSync,
  reapStaleEmbeddedPostgresTempDirs,
} = __testing;

const dirsToClean: string[] = [];
const childrenToKill: ChildProcess[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirsToClean.push(dir);
  return dir;
}

function spawnLiveProcess(): ChildProcess {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  childrenToKill.push(child);
  return child;
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

afterEach(() => {
  activeEmbeddedPostgresDataDirs.clear();
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  while (childrenToKill.length > 0) {
    const child = childrenToKill.pop();
    try {
      if (child?.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

describe("crash-safe teardown", () => {
  it("reaps a data dir that never reached normal teardown when the process exits", () => {
    // Simulates the exact gap this issue fixes: a data dir was created and registered
    // (as startEmbeddedPostgresTestDatabase does right after createEmbeddedPostgresTestInstance),
    // then the owning worker is killed/crashes before its `cleanup()` ever runs.
    // handleProcessExit is the literal function wired to `process.on("exit", ...)` in
    // installProcessExitHandlers — invoking it directly (rather than emitting a real
    // "exit" event on the shared process object) exercises the same code path without
    // touching other modules' unrelated exit listeners in this test worker.
    const dataDir = makeTempDir("crash-path-test-");
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "16\n");
    activeEmbeddedPostgresDataDirs.add(dataDir);

    expect(fs.existsSync(dataDir)).toBe(true);

    // No cleanup() call happens here — this is the crash.
    handleProcessExit();

    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("re-raises termination signals as process.exit so the exit handler runs", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => undefined as never));

    handleTerminationSignal();

    expect(exitSpy).toHaveBeenCalledWith(128);
    exitSpy.mockRestore();
  });

  it("stops a live postmaster before removing the data dir, and removes dirs with no postmaster.pid", async () => {
    const dataDir = makeTempDir("crash-path-live-postmaster-");
    const child = spawnLiveProcess();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(path.join(dataDir, "postmaster.pid"), `${child.pid}\n`);

    reapDataDirSync(dataDir);

    expect(fs.existsSync(dataDir)).toBe(false);
    if (child.pid) await waitForProcessExit(child.pid);
  });
});

describe("reapStaleEmbeddedPostgresTempDirs", () => {
  const prefix = "reaper-test-prefix-";

  it("reaps an old dir with no live postmaster", () => {
    const staleDir = makeTempDir(prefix);
    const oldTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    reapStaleEmbeddedPostgresTempDirs(prefix);

    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("does not reap an old dir with a live postmaster.pid", async () => {
    const staleDir = makeTempDir(prefix);
    const child = spawnLiveProcess();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(path.join(staleDir, "postmaster.pid"), `${child.pid}\n`);
    const oldTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    reapStaleEmbeddedPostgresTempDirs(prefix);

    expect(fs.existsSync(staleDir)).toBe(true);
  });

  it("does not reap a recent dir even without a live postmaster", () => {
    const recentDir = makeTempDir(prefix);

    reapStaleEmbeddedPostgresTempDirs(prefix);

    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("ignores entries that do not match the prefix", () => {
    const unrelatedDir = makeTempDir("some-other-prefix-");
    const oldTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    fs.utimesSync(unrelatedDir, oldTime, oldTime);

    reapStaleEmbeddedPostgresTempDirs(prefix);

    expect(fs.existsSync(unrelatedDir)).toBe(true);
  });
});
