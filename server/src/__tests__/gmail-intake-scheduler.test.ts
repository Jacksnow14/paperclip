import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { createGmailIntakeScheduler } = await import("../services/gmail-intake-scheduler.js");

type MinimalIntakeService = {
  pollAllMailboxes: ReturnType<typeof vi.fn>;
  processMailbox: ReturnType<typeof vi.fn>;
};

function makeIntakeSvc(pollResult = []): MinimalIntakeService {
  return {
    pollAllMailboxes: vi.fn().mockResolvedValue(pollResult),
    processMailbox: vi.fn(),
  };
}

describe("createGmailIntakeScheduler", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("fires the poll once after the startup delay", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc();
    const getCompanyId = vi.fn().mockResolvedValue("company-1");

    const scheduler = createGmailIntakeScheduler({
      getCompanyId,
      intakeService: svc as any,
      startupDelayMs: 5_000,
      intervalMs: 10 * 60 * 1000,
    });
    scheduler.start();

    expect(svc.pollAllMailboxes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(1);
    expect(getCompanyId).toHaveBeenCalledTimes(1);
    expect(svc.pollAllMailboxes).toHaveBeenCalledWith("company-1");

    scheduler.stop();
  });

  it("fires again on each subsequent interval tick", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc();
    const getCompanyId = vi.fn().mockResolvedValue("company-1");

    const scheduler = createGmailIntakeScheduler({
      getCompanyId,
      intakeService: svc as any,
      startupDelayMs: 1_000,
      intervalMs: 5_000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("skips the poll when no company exists and does not throw", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc();
    const getCompanyId = vi.fn().mockResolvedValue(undefined);

    const scheduler = createGmailIntakeScheduler({
      getCompanyId,
      intakeService: svc as any,
      startupDelayMs: 1_000,
      intervalMs: 10_000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCompanyId).toHaveBeenCalledOnce();
    expect(svc.pollAllMailboxes).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("AUR-3118: polls every company returned by getCompanyIds each cycle", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc([
      { mailbox: "board", processed: 1, created: 1, updated: 0, skipped: 0, errors: 0 },
    ]);
    const getCompanyIds = vi.fn().mockResolvedValue(["company-a", "company-b"]);

    const scheduler = createGmailIntakeScheduler({
      getCompanyIds,
      intakeService: svc as any,
      startupDelayMs: 1_000,
      intervalMs: 10 * 60 * 1000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCompanyIds).toHaveBeenCalledTimes(1);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(2);
    expect(svc.pollAllMailboxes).toHaveBeenNthCalledWith(1, "company-a");
    expect(svc.pollAllMailboxes).toHaveBeenNthCalledWith(2, "company-b");

    scheduler.stop();
  });

  it("AUR-3118: one company's poll failure does not abort the others", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc();
    svc.pollAllMailboxes
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([
        { mailbox: "board", processed: 1, created: 1, updated: 0, skipped: 0, errors: 0 },
      ]);
    const getCompanyIds = vi.fn().mockResolvedValue(["company-a", "company-b"]);

    const scheduler = createGmailIntakeScheduler({
      getCompanyIds,
      intakeService: svc as any,
      startupDelayMs: 1_000,
      intervalMs: 10 * 60 * 1000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(2); // second company still polled

    scheduler.stop();
  });

  it("stop() prevents further ticks from firing", async () => {
    vi.useFakeTimers();
    const svc = makeIntakeSvc();
    const getCompanyId = vi.fn().mockResolvedValue("company-1");

    const scheduler = createGmailIntakeScheduler({
      getCompanyId,
      intakeService: svc as any,
      startupDelayMs: 1_000,
      intervalMs: 5_000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(1);

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollAllMailboxes).toHaveBeenCalledTimes(1); // no additional call
  });
});
