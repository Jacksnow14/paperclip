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
  /**
   * AUR-3118: Async function that returns ALL company IDs to poll each cycle.
   * This is the correct multi-tenant resolver — a single shared server hosts
   * more than one company, and every company's mailboxes must be polled. When
   * provided, it takes precedence over the legacy single-company `getCompanyId`.
   */
  getCompanyIds?: () => Promise<string[]>;
  /**
   * @deprecated Legacy single-company resolver. Only consulted when
   * `getCompanyIds` is absent. Backed by `SELECT ... LIMIT 1` (no ORDER BY),
   * which silently starves every company but one in a multi-tenant deployment —
   * the root cause of AUR-3118's post-restart intake gap. Prefer `getCompanyIds`.
   */
  getCompanyId?: () => Promise<string | undefined>;
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
      let companyIds: string[];
      if (opts.getCompanyIds) {
        companyIds = (await opts.getCompanyIds()) ?? [];
      } else if (opts.getCompanyId) {
        const one = await opts.getCompanyId();
        companyIds = one ? [one] : [];
      } else {
        companyIds = [];
      }
      if (companyIds.length === 0) return;

      let totalCreated = 0;
      let totalUpdated = 0;
      let totalErrors = 0;
      for (const companyId of companyIds) {
        try {
          const results = await opts.intakeService.pollAllMailboxes(companyId);
          totalCreated += results.reduce((s, r) => s + r.created, 0);
          totalUpdated += results.reduce((s, r) => s + r.updated, 0);
          totalErrors += results.reduce((s, r) => s + r.errors, 0);
        } catch (err) {
          totalErrors += 1;
          logger.error({ err, companyId }, "gmail-intake: company poll failed");
        }
      }
      if (totalCreated > 0 || totalUpdated > 0 || totalErrors > 0) {
        logger.info(
          { totalCreated, totalUpdated, totalErrors, companies: companyIds.length },
          "gmail-intake: poll cycle complete",
        );
      }
    },
    onError: (err) => logger.error({ err }, "gmail-intake: scheduler unhandled error"),
  });
}
