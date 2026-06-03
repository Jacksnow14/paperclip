// AUR-1743: restart-resilient grooming.
//
// The daily health report + artifact grooming pass used to run only on a
// trailing 24h `setInterval`. On a churny host (frequent restarts) the 24h
// timer is reset every boot, so the daily real-prune can be starved and disk
// is only ever reclaimed by the 90% pressure valve. This scheduler adds a
// debounced startup pass so every restart triggers exactly one reclaim while
// keeping the 24h interval as the steady-state backstop.

export interface DailyHealthSchedulerOptions {
  /** Delay between scheduler start and the first run (lets the process settle). */
  startupDelayMs: number;
  /** Steady-state cadence after the startup pass. */
  intervalMs: number;
  /** The grooming + daily-report body. Must be idempotent. */
  run: () => Promise<void> | void;
  /** Surfaced if `run` throws outside its own try/catch. */
  onError?: (err: unknown) => void;
}

export interface DailyHealthScheduler {
  start: () => void;
  stop: () => void;
}

export function createDailyHealthScheduler(opts: DailyHealthSchedulerOptions): DailyHealthScheduler {
  let inFlight = false;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const fire = async () => {
    // Coalesce when startup tick and interval tick land within the same
    // execution window: a single pass is enough — no double deletes.
    if (inFlight) return;
    inFlight = true;
    try {
      await opts.run();
    } catch (err) {
      opts.onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => {
      startupTimer = setTimeout(() => {
        void fire();
      }, opts.startupDelayMs);
      if (typeof (startupTimer as any).unref === "function") (startupTimer as any).unref();
      intervalTimer = setInterval(() => {
        void fire();
      }, opts.intervalMs);
      if (typeof (intervalTimer as any).unref === "function") (intervalTimer as any).unref();
    },
    stop: () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      startupTimer = null;
      intervalTimer = null;
    },
  };
}
