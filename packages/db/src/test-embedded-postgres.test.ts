import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./test-embedded-postgres.js";

const {
  activeEmbeddedPostgresDataDirs,
  EMBEDDED_POSTGRES_TEMP_DIR_MARKER,
  handleProcessExit,
  handleTerminationSignal,
  installProcessExitHandlers,
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

/** Builds a dir under the helper's shared marker with real Postgres data-dir markers. */
function makePostgresDataDir(label: string): string {
  const dir = makeTempDir(`${EMBEDDED_POSTGRES_TEMP_DIR_MARKER}${label}`);
  fs.writeFileSync(path.join(dir, "PG_VERSION"), "16\n");
  fs.writeFileSync(path.join(dir, "postgresql.conf"), "# test fixture\n");
  return dir;
}

function makeStale(dir: string): void {
  const oldTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
  fs.utimesSync(dir, oldTime, oldTime);
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

  it("actually registers handleProcessExit as an exit listener, not just as a callable function", () => {
    // The crash-path test above proves handleProcessExit works when invoked directly, but
    // that alone doesn't prove installProcessExitHandlers wires it up for a real crash. Assert
    // the registration side explicitly.
    installProcessExitHandlers();
    expect(process.listeners("exit")).toContain(handleProcessExit);
  });

  it("reaps active data dirs, unregisters itself, and re-raises the signal instead of hard-exiting", () => {
    const dataDir = makeTempDir("crash-signal-test-");
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "16\n");
    activeEmbeddedPostgresDataDirs.add(dataDir);

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    handleTerminationSignal("SIGTERM");

    expect(fs.existsSync(dataDir)).toBe(false);
    expect(removeListenerSpy).toHaveBeenCalledWith("SIGTERM", handleTerminationSignal);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");

    killSpy.mockRestore();
    removeListenerSpy.mockRestore();
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
  it("reaps an old Postgres data dir with no live postmaster", () => {
    const staleDir = makePostgresDataDir("reaper-test-");
    makeStale(staleDir);

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("does not reap an old Postgres data dir with a live postmaster.pid", async () => {
    const staleDir = makePostgresDataDir("reaper-test-");
    const child = spawnLiveProcess();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(path.join(staleDir, "postmaster.pid"), `${child.pid}\n`);
    makeStale(staleDir);

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(staleDir)).toBe(true);
  });

  it("does not reap a recent Postgres data dir even without a live postmaster", () => {
    const recentDir = makePostgresDataDir("reaper-test-");

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("ignores entries that do not carry the shared embedded-postgres marker", () => {
    const unrelatedDir = makeTempDir("some-unrelated-prefix-");
    makeStale(unrelatedDir);

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(unrelatedDir)).toBe(true);
  });

  it("regression (blocker 1): never reaps a marker-prefixed dir that is not an actual Postgres data dir", () => {
    // A caller's label is just a string it chose — matching the marker prefix is not proof
    // initdb ever ran there. Seed a dir that looks eligible by name/age/no-postmaster alone,
    // but carries none of the files initdb always writes, and assert it survives.
    const collateralDir = makeTempDir(`${EMBEDDED_POSTGRES_TEMP_DIR_MARKER}environment-service-`);
    fs.writeFileSync(path.join(collateralDir, "unrelated-file.txt"), "not a postgres data dir");
    makeStale(collateralDir);

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(collateralDir)).toBe(true);
  });

  it("regression (blocker 2): reaps a stale dir left by a different caller label than the one currently starting up", () => {
    // Before the fix, the reap sweep was scoped to the exact label the *current* caller
    // passed in, so a leaked dir from any of the 60+ other distinct labels in this repo
    // could only ever be reclaimed by a re-run of its own originating test. Any caller's
    // startup sweep must be able to reclaim any other caller's stale dir.
    const otherCallersLeak = makePostgresDataDir("environment-runtime-contract-");
    makeStale(otherCallersLeak);

    // Simulates a *different* label's helper invocation doing its own startup sweep.
    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(otherCallersLeak)).toBe(false);
  });

  it("regression (blocker 2): a live dir survives even when its label extends another label as a substring prefix", async () => {
    // "environment-runtime" is a string-prefix of "environment-runtime-contract". Assert that
    // collision no longer matters: the longer-named dir is judged purely on its own liveness,
    // never on whether some other, shorter label happens to be a substring of its name.
    const shortLabelStaleDir = makePostgresDataDir("environment-runtime-");
    makeStale(shortLabelStaleDir);

    const longLabelLiveDir = makePostgresDataDir("environment-runtime-contract-");
    const child = spawnLiveProcess();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(path.join(longLabelLiveDir, "postmaster.pid"), `${child.pid}\n`);
    makeStale(longLabelLiveDir);

    reapStaleEmbeddedPostgresTempDirs();

    expect(fs.existsSync(shortLabelStaleDir)).toBe(false);
    expect(fs.existsSync(longLabelLiveDir)).toBe(true);
  });
});
