import { closeSync, existsSync, openSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AUR-3937 acceptance criterion 4: an agent must be structurally unable to
 * dirty or branch-switch what production executes. Production runs a pinned,
 * root-owned release under /opt/paperclip/app — these tests run as the agent
 * user on the production box and prove, behaviorally, that every way to alter
 * the production execution path is denied by the kernel.
 *
 * On machines without /opt/paperclip/app/current (CI, dev laptops) the suite
 * skips: the property it proves is a property of the production box.
 *
 * Every probe is written to be safe if the property is BROKEN: a probe that
 * unexpectedly succeeds removes what it created and fails the test, so a
 * misconfigured tree is reported, never damaged further.
 */

const APP_ROOT = process.env.PAPERCLIP_DEPLOY_APP_ROOT ?? "/opt/paperclip/app";
const CURRENT = path.join(APP_ROOT, "current");
const onProductionBox = existsSync(CURRENT) && process.getuid?.() !== 0;

describe.skipIf(!onProductionBox)("production deploy immutability (AUR-3937)", () => {
  // Guarded: the describe body is collected even when skipIf is true.
  const release = onProductionBox ? realpathSync(CURRENT) : "";

  it("runs as an unprivileged agent user", () => {
    expect(process.getuid?.()).not.toBe(0);
    expect(process.getuid?.()).toBeDefined();
  });

  it("release tree is owned by root", () => {
    expect(statSync(release).uid).toBe(0);
    expect(statSync(path.join(release, "server/dist/index.js")).uid).toBe(0);
  });

  it("agent cannot create files inside the release", () => {
    const probe = path.join(release, ".aur3937-immutability-probe");
    let created = false;
    try {
      writeFileSync(probe, "should never exist");
      created = true;
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM|EROFS)$/);
    }
    if (created) {
      rmSync(probe, { force: true });
      expect.fail(`release tree is agent-writable: created ${probe}`);
    }
  });

  it("agent cannot modify the server entrypoint production executes", () => {
    let fd: number | null = null;
    try {
      fd = openSync(path.join(release, "server/dist/index.js"), "a");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM|EROFS)$/);
    }
    if (fd !== null) {
      closeSync(fd);
      expect.fail("server/dist/index.js opened writable by the agent user");
    }
  });

  it("agent cannot branch-switch the release git tree", () => {
    const result = spawnSync("git", ["-C", release, "checkout", "-b", "aur3937-probe-branch"], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      spawnSync("git", ["-C", release, "checkout", "--detach"], { encoding: "utf8" });
      spawnSync("git", ["-C", release, "branch", "-D", "aur3937-probe-branch"], { encoding: "utf8" });
      expect.fail("agent user was able to create and switch branches in the production release");
    }
    expect(result.status).not.toBe(0);
    // The failed attempt must leave the release exactly as it was: detached at its pinned SHA.
    const head = spawnSync("git", ["-C", release, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" });
    expect(head.status).not.toBe(0); // still detached, not on any branch
  });

  it("agent cannot repoint the `current` symlink (no write access to the app root)", () => {
    // Replacing `current` requires write permission on APP_ROOT itself; prove it
    // is denied by attempting a sibling symlink rather than touching `current`.
    const probe = path.join(APP_ROOT, ".aur3937-symlink-probe");
    let created = false;
    try {
      symlinkSync("releases/nonexistent", probe);
      created = true;
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM|EROFS)$/);
    }
    if (created) {
      unlinkSync(probe);
      expect.fail(`app root is agent-writable: created ${probe} — \`current\` could be repointed`);
    }
  });

  it("production unit executes the pinned release, not a user-writable checkout", () => {
    const execStart = execFileSync("systemctl", ["--user", "show", "paperclip", "-p", "ExecStart"], {
      encoding: "utf8",
    });
    expect(execStart).toContain(path.join(APP_ROOT, "current"));
    expect(execStart).not.toContain("/home/ievgen/paperclip");
    // The launcher the unit points at must itself be root-owned.
    expect(statSync(path.join(release, "scripts/deploy/run-server.sh")).uid).toBe(0);
  });

  it("release records the commit it was built from", () => {
    const info = JSON.parse(
      execFileSync("cat", [path.join(release, "build-info.json")], { encoding: "utf8" }),
    ) as { sha?: string };
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
    // build-info must agree with the git tree it ships inside.
    const head = spawnSync("git", ["-C", release, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(head.stdout.trim()).toBe(info.sha);
  });
});
