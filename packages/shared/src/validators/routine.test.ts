import { describe, expect, it } from "vitest";
import {
  createRoutineTriggerSchema,
  routineRevisionSnapshotV1Schema,
  updateRoutineSchema,
} from "./routine.js";

const routineId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const triggerId = "33333333-3333-4333-8333-333333333333";
const baseRevisionId = "44444444-4444-4444-8444-444444444444";

describe("routine validators", () => {
  it("accepts versioned routine revision snapshots with safe trigger metadata", () => {
    const parsed = routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
      }],
    });

    expect(parsed.triggers[0]?.publicId).toBe("routine_webhook_123");
  });

  it("rejects secret-bearing trigger fields in routine revision snapshots", () => {
    expect(() => routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
        secretId: "55555555-5555-4555-8555-555555555555",
      }],
    })).toThrow();
  });

  it("accepts optional base revision ids on routine updates", () => {
    expect(updateRoutineSchema.parse({
      title: "Daily triage",
      baseRevisionId,
    }).baseRevisionId).toBe(baseRevisionId);
  });
});

describe("createRoutineTriggerSchema — schedule branch", () => {
  it("accepts a runAt one-shot trigger", () => {
    const result = createRoutineTriggerSchema.parse({
      kind: "schedule",
      runAt: "2026-06-01T12:00:00Z",
    });
    expect(result.kind).toBe("schedule");
    // @ts-expect-error - runAt is on the schedule branch
    expect(result.runAt).toBe("2026-06-01T12:00:00Z");
  });

  it("accepts a cron trigger without runAt", () => {
    const result = createRoutineTriggerSchema.parse({
      kind: "schedule",
      cronExpression: "0 9 * * 1",
    });
    expect(result.kind).toBe("schedule");
    // @ts-expect-error - cronExpression is on the schedule branch
    expect(result.cronExpression).toBe("0 9 * * 1");
  });

  it("rejects a trigger with both cronExpression and runAt", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({
        kind: "schedule",
        cronExpression: "0 9 * * 1",
        runAt: "2026-06-01T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects a trigger with neither cronExpression nor runAt", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({
        kind: "schedule",
      }),
    ).toThrow();
  });

  it("accepts executionLimit on a cron trigger", () => {
    const result = createRoutineTriggerSchema.parse({
      kind: "schedule",
      cronExpression: "0 9 * * 1",
      executionLimit: 5,
    });
    // @ts-expect-error - executionLimit is on the schedule branch
    expect(result.executionLimit).toBe(5);
  });

  it("rejects executionLimit of 0", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({
        kind: "schedule",
        cronExpression: "0 9 * * 1",
        executionLimit: 0,
      }),
    ).toThrow();
  });

  it("round-trips runLimit/runCount in revision snapshot triggers", () => {
    const parsed = routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "schedule",
        label: null,
        enabled: false,
        cronExpression: null,
        timezone: null,
        publicId: null,
        signingMode: null,
        replayWindowSec: null,
        runLimit: 1,
        runCount: 1,
      }],
    });
    expect(parsed.triggers[0]?.runLimit).toBe(1);
    expect(parsed.triggers[0]?.runCount).toBe(1);
  });
});
