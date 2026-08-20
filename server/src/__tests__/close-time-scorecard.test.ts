import { describe, expect, it, vi } from "vitest";
import {
  buildCloseTimeScorecardCaptures,
  captureCloseTimeScorecard,
  inferTaskType,
  sumIssueTokenCost,
} from "../services/close-time-scorecard.js";

const ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "AUR-4224",
  title: "Fix the scorecard capture gap",
  description: "root cause and fix",
  assigneeAgentId: "agent-1",
  projectId: "project-1",
};

describe("inferTaskType", () => {
  it("classifies bug-shaped titles", () => {
    expect(inferTaskType({ title: "Fix crash on close", description: "" })).toBe("bug");
  });

  it("classifies infra-shaped titles", () => {
    expect(inferTaskType({ title: "Deploy watchdog for release pruning", description: "" })).toBe("infra");
  });

  it("falls back to feature when nothing matches", () => {
    expect(inferTaskType({ title: "Add a new dashboard widget", description: "" })).toBe("feature");
  });
});

describe("buildCloseTimeScorecardCaptures", () => {
  const closedAt = new Date("2026-07-29T12:00:00.000Z");

  it("builds a performance_scorecard and scorecard_adjusted pair keyed uniquely per issue", () => {
    const { performanceScorecard, scorecardAdjusted } = buildCloseTimeScorecardCaptures(ISSUE, 15000, closedAt);

    expect(performanceScorecard.title).toBe("performance/agent-1/bug/2026-07-29/AUR-4224");
    expect(performanceScorecard.upsert).toBe(true);
    expect(performanceScorecard.metadata).toMatchObject({
      category: "performance_scorecard",
      issue_id: "AUR-4224",
      agent_id: "agent-1",
      task_type: "bug",
      token_cost: 15000,
      quality_signal: 3,
      value_signal: 3,
      auto_generated: true,
      project_id: "project-1",
    });

    expect(scorecardAdjusted.title).toBe("scorecard-adjusted/agent-1/bug/2026-07-29/AUR-4224");
    expect(scorecardAdjusted.metadata).toMatchObject({
      category: "scorecard_adjusted",
      issue_id: "AUR-4224",
      score_adjusted: (3 * 3) / 15000,
      auto_generated: true,
    });
  });

  it("AUR-5410: suppresses the score instead of fabricating one when there is no recorded token cost", () => {
    // FIRING case: the pre-fix clamp (`Math.max(safeTokenCost, 1)`) turned an
    // unmeasured close into score_adjusted: 9.0 — the single best score
    // obtainable in the registry. Re-running the pre-fix formula here proves
    // the defect this guard exists to catch: `(3 * 3) / Math.max(0, 1) === 9`.
    expect((3 * 3) / Math.max(0, 1)).toBe(9);

    const { performanceScorecard, scorecardAdjusted } = buildCloseTimeScorecardCaptures(ISSUE, 0, closedAt);

    expect(scorecardAdjusted.metadata).not.toHaveProperty("score_adjusted");
    expect(scorecardAdjusted.metadata.token_cost).toBe(0);
    expect(scorecardAdjusted.metadata.metrics_lost).toBe(true);
    expect(scorecardAdjusted.metadata.exclude_from_aggregates).toBe(true);
    expect(performanceScorecard.metadata.token_cost).toBe(0);
    expect(performanceScorecard.metadata.metrics_lost).toBe(true);
    expect(performanceScorecard.metadata.exclude_from_aggregates).toBe(true);
  });

  it("AUR-5410: PASSING case — a normal measured close still scores and carries no exclude flags", () => {
    const { performanceScorecard, scorecardAdjusted } = buildCloseTimeScorecardCaptures(ISSUE, 15000, closedAt);

    expect(scorecardAdjusted.metadata.score_adjusted).toBe((3 * 3) / 15000);
    expect(scorecardAdjusted.metadata).not.toHaveProperty("metrics_lost");
    expect(scorecardAdjusted.metadata).not.toHaveProperty("exclude_from_aggregates");
    expect(performanceScorecard.metadata).not.toHaveProperty("metrics_lost");
    expect(performanceScorecard.metadata).not.toHaveProperty("exclude_from_aggregates");
  });

  it("distinguishes same-day closures by the assignee by appending the issue identifier, not colliding into one title", () => {
    const first = buildCloseTimeScorecardCaptures(ISSUE, 100, closedAt);
    const second = buildCloseTimeScorecardCaptures({ ...ISSUE, id: "22222222-2222-4222-8222-222222222222", identifier: "AUR-9999" }, 200, closedAt);
    expect(first.performanceScorecard.title).not.toBe(second.performanceScorecard.title);
  });
});

describe("sumIssueTokenCost", () => {
  it("sums cost_events tokens for the given issue", async () => {
    const where = vi.fn(async () => [{ total: "4200" }]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const fakeDb = { select } as any;

    const total = await sumIssueTokenCost(fakeDb, "company-1", ISSUE.id);
    expect(total).toBe(4200);
  });
});

describe("captureCloseTimeScorecard", () => {
  it("writes both records via memory.capture with the hook trigger kind", async () => {
    const where = vi.fn(async () => [{ total: "1000" }]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const fakeDb = { select } as any;
    const capture = vi.fn(async () => ({ operation: {}, records: [], dedup: false }));
    const memory = { capture } as any;

    await captureCloseTimeScorecard(fakeDb, memory, "company-1", ISSUE, new Date("2026-07-29T12:00:00.000Z"));

    expect(capture).toHaveBeenCalledTimes(2);
    const [companyId, performancePayload, actor, triggerKind, hookKind] = capture.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(performancePayload.metadata.category).toBe("performance_scorecard");
    expect(actor).toMatchObject({ actorType: "system", agentId: "agent-1" });
    expect(triggerKind).toBe("hook");
    expect(hookKind).toBe("issue_close_scorecard_capture");
    expect(capture.mock.calls[1][1].metadata.category).toBe("scorecard_adjusted");
  });

  it("never throws when the underlying capture fails (must not block the issue close)", async () => {
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => { throw new Error("db down"); } }) }),
    } as any;
    const memory = { capture: vi.fn() } as any;

    await expect(captureCloseTimeScorecard(fakeDb, memory, "company-1", ISSUE)).resolves.toBeUndefined();
    expect(memory.capture).not.toHaveBeenCalled();
  });
});
