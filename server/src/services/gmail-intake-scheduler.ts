// AUR-1747: restart-resilient Gmail intake scheduler.
//
// Wraps createDailyHealthScheduler so the Gmail intake poller fires once on
// startup (after a settle delay) and then on a steady-state interval, with the
// same in-flight coalescing and unref'd timer semantics as the daily-health
// scheduler. The caller is responsible for the GOOGLE_WORKSPACE_SA_KEY guard
// and the heartbeatSchedulerEnabled gate.

import { createDailyHealthScheduler, type DailyHealthScheduler } from "./daily-health-scheduler.js";
import type { GmailIntakeService } from "./gmail-intake.js";
import { logger } from "../middleware/logger.js";

export interface GmailIntakeSchedulerOptions {
  /** Async function that returns the primary company ID, or undefined when none exists. */
  getCompanyId: () => Promise<string | undefined>;
  intakeService: GmailIntakeService;
  /** Delay before the first poll fires after start() (lets the process settle). */
  startupDelayMs?: number;
  /** Steady-state poll cadence. */
  intervalMs: number;
}

export function createGmailIntakeScheduler(opts: GmailIntakeSchedulerOptions): DailyHealthScheduler {
  return createDailyHealthScheduler({
    startupDelayMs: opts.startupDelayMs ?? 60_000,
    intervalMs: opts.intervalMs,
    run: async () => {
      const companyId = await opts.getCompanyId();
      if (!companyId) return;
      const results = await opts.intakeService.pollAllMailboxes(companyId);
      const totalCreated = results.reduce((s, r) => s + r.created, 0);
      const totalUpdated = results.reduce((s, r) => s + r.updated, 0);
      const totalErrors = results.reduce((s, r) => s + r.errors, 0);
      if (totalCreated > 0 || totalUpdated > 0 || totalErrors > 0) {
        logger.info(
          { totalCreated, totalUpdated, totalErrors },
          "gmail-intake: poll cycle complete",
        );
      }
    },
    onError: (err) => logger.error({ err }, "gmail-intake: scheduler unhandled error"),
  });
}
