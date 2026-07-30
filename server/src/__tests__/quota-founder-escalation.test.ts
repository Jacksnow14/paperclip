import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

function callbackExecFile(stdout: string) {
  return (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(null, { stdout, stderr: "" } as unknown as { stdout: string; stderr: string });
    return { kill: vi.fn(), on: vi.fn() };
  };
}

const {
  readQuotaExhaustion,
  isOutOfCreditsResultJson,
  buildOutOfCreditsMessage,
  maybeEscalateOutOfCredits,
} = await import("../services/quota-founder-escalation.js");

function makeFakeDb(existingRow: unknown = null) {
  const inserted: any[] = [];
  const db = {
    query: {
      quotaCreditEscalations: {
        findFirst: vi.fn(async () => existingRow),
      },
    },
    insert: vi.fn(() => ({
      values: (row: any) => {
        inserted.push(row);
        return { onConflictDoNothing: vi.fn(async () => undefined) };
      },
    })),
  };
  return { db: db as unknown as Db, inserted };
}

describe("readQuotaExhaustion / isOutOfCreditsResultJson", () => {
  it("returns null when resultJson has no quotaExhaustion", () => {
    expect(readQuotaExhaustion({})).toBeNull();
    expect(readQuotaExhaustion(null)).toBeNull();
    expect(isOutOfCreditsResultJson({})).toBe(false);
  });

  it("reads outOfCredits through to the top level", () => {
    const resultJson = { quotaExhaustion: { outOfCredits: true, resetAt: "2026-08-01T00:00:00.000Z" } };
    expect(isOutOfCreditsResultJson(resultJson)).toBe(true);
  });
});

describe("buildOutOfCreditsMessage", () => {
  it("names the required human action and distinguishes from a reset-wait wall", () => {
    const message = buildOutOfCreditsMessage({
      agentName: "Claude Code Fast",
      quota: {
        outOfCredits: true,
        resetAt: "2026-08-01T00:00:00.000Z",
        rateLimitType: "weekly",
        overageDisabledReason: "out_of_credits",
      },
    });
    expect(message).toMatch(/OUT OF CREDITS/);
    expect(message).toMatch(/buy credits or raise the spending cap/i);
    expect(message).toMatch(/will NOT self-heal/i);
  });
});

describe("maybeEscalateOutOfCredits", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("does NOT escalate an ordinary quota wall (outOfCredits false)", async () => {
    const { db, inserted } = makeFakeDb();
    mocks.execFile.mockImplementation(callbackExecFile("sent message_id=123\n"));

    const result = await maybeEscalateOutOfCredits(db, {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Claude Code Fast",
      runId: "run-1",
      resultJson: { quotaExhaustion: { outOfCredits: false, resetAt: "2026-08-01T00:00:00.000Z" } },
    });

    expect(result.escalated).toBe(false);
    expect(result.reason).toBe("not_out_of_credits");
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("escalates exactly once per episode and persists the Telegram message_id as evidence", async () => {
    const { db, inserted } = makeFakeDb();
    mocks.execFile.mockImplementation(callbackExecFile("sent message_id=987654321\n"));

    const result = await maybeEscalateOutOfCredits(db, {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Claude Code Fast",
      runId: "run-1",
      issueId: "issue-1",
      resultJson: {
        quotaExhaustion: {
          outOfCredits: true,
          resetAt: "2026-08-01T00:00:00.000Z",
          rateLimitType: "weekly",
          overageDisabledReason: "out_of_credits",
        },
      },
    });

    expect(result.escalated).toBe(true);
    expect(result.reason).toBe("sent");
    expect(result.telegramMessageId).toBe("987654321");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [, execArgs] = mocks.execFile.mock.calls[0];
    expect(execArgs).toEqual(["SEV2", expect.stringMatching(/OUT OF CREDITS/)]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      companyId: "company-1",
      agentId: "agent-1",
      episodeKey: "2026-08-01T00:00:00.000Z",
      telegramMessageId: "987654321",
    });
  });

  it("does not re-escalate within the same episode (already_escalated)", async () => {
    const { db, inserted } = makeFakeDb({ id: "existing-row" });
    mocks.execFile.mockImplementation(callbackExecFile("sent message_id=1\n"));

    const result = await maybeEscalateOutOfCredits(db, {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Claude Code Fast",
      runId: "run-2",
      resultJson: {
        quotaExhaustion: { outOfCredits: true, resetAt: "2026-08-01T00:00:00.000Z" },
      },
    });

    expect(result.escalated).toBe(false);
    expect(result.reason).toBe("already_escalated");
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("does not persist a row when the notify_founder.sh delivery fails", async () => {
    const { db, inserted } = makeFakeDb();
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: Error) => void) => {
        callback(new Error("delivery failed"));
        return { kill: vi.fn(), on: vi.fn() };
      },
    );

    const result = await maybeEscalateOutOfCredits(db, {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Claude Code Fast",
      runId: "run-3",
      resultJson: {
        quotaExhaustion: { outOfCredits: true, resetAt: "2026-08-01T00:00:00.000Z" },
      },
    });

    expect(result.escalated).toBe(false);
    expect(result.reason).toBe("send_failed");
    expect(inserted).toHaveLength(0);
  });
});
