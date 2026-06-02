import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDailyHealthScheduler } from "./daily-health-scheduler.js";

describe("createDailyHealthScheduler (AUR-1743)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once at the debounced startup delay, then on each interval tick", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createDailyHealthScheduler({
      startupDelayMs: 3 * 60 * 1000,
      intervalMs: 24 * 60 * 60 * 1000,
      run,
    });
    scheduler.start();

    // Nothing before the debounce elapses.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(0);

    // Debounced startup pass.
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    expect(run).toHaveBeenCalledTimes(1);

    // First steady-state interval tick (~24h after start).
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);

    // Second steady-state tick.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("stop() prevents further runs", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createDailyHealthScheduler({
      startupDelayMs: 1000,
      intervalMs: 10_000,
      run,
    });
    scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(0);
  });

  it("coalesces overlapping fires so deletes are idempotent", async () => {
    let resolveRun: (() => void) | null = null;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const scheduler = createDailyHealthScheduler({
      startupDelayMs: 1000,
      intervalMs: 5000,
      run,
    });
    scheduler.start();

    // Startup tick fires but never resolves yet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // Interval tick lands while the first run is still in flight: dropped.
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);

    // First run completes; next interval tick fires normally.
    resolveRun!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("invokes onError when run() rejects", async () => {
    const onError = vi.fn();
    const scheduler = createDailyHealthScheduler({
      startupDelayMs: 100,
      intervalMs: 1000,
      run: async () => {
        throw new Error("boom");
      },
      onError,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("boom");
    scheduler.stop();
  });
});
