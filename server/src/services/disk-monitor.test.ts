import { describe, expect, it, vi } from "vitest";

const statfsMock = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: (...args: unknown[]) => statfsMock(...args),
  };
});

// backupDir stats and child-process count aren't under test here — point at
// a directory that's guaranteed to exist so getBackupDirStats short-circuits
// cleanly, and don't assert on childProcessCount.
const BACKUP_DIR = "/tmp";

function mockUsedPercent(usedPercent: number) {
  const bsize = 1;
  const blocks = 10_000;
  const bfree = Math.round(blocks * (1 - usedPercent / 100));
  statfsMock.mockReturnValue({ blocks, bsize, bfree });
}

describe("checkDisk hysteresis", () => {
  const thresholds = { warnPercent: 80, actPercent: 90, clearPercent: 85 };

  it("fires act and not clear once usage reaches the act threshold", async () => {
    const { checkDisk } = await import("./disk-monitor.js");
    mockUsedPercent(92);
    const result = checkDisk("/tmp", BACKUP_DIR, thresholds);
    expect(result.act).toBe(true);
    expect(result.clear).toBe(false);
  });

  it("fires clear and not act once usage drops below the clear threshold", async () => {
    const { checkDisk } = await import("./disk-monitor.js");
    mockUsedPercent(70);
    const result = checkDisk("/tmp", BACKUP_DIR, thresholds);
    expect(result.act).toBe(false);
    expect(result.clear).toBe(true);
  });

  it("fires neither act nor clear inside the hysteresis dead zone — no flapping", async () => {
    const { checkDisk } = await import("./disk-monitor.js");
    // Between clearPercent (85) and actPercent (90): a reading oscillating
    // around, say, 87% must never trigger a new alert or an auto-resolve.
    for (const usedPercent of [85, 87, 89.9]) {
      mockUsedPercent(usedPercent);
      const result = checkDisk("/tmp", BACKUP_DIR, thresholds);
      expect(result.act).toBe(false);
      expect(result.clear).toBe(false);
    }
  });
});
