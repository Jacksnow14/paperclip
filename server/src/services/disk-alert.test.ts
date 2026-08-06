import { describe, expect, it, vi } from "vitest";
import {
  DISK_ALERT_ORIGIN_ID,
  DISK_ALERT_ORIGIN_KIND,
  handleDiskAlertAct,
  handleDiskAlertClear,
  type DiskAlertIssueRef,
  type DiskAlertIssuesPort,
} from "./disk-alert.js";
import type { DiskCheckResult } from "./disk-monitor.js";

const COMPANY_ID = "company-1";

function makeResult(usedPercent: number): DiskCheckResult {
  return {
    diskStats: { totalBytes: 100, freeBytes: 100 - usedPercent, usedBytes: usedPercent, usedPercent },
    backupDirStats: { totalSizeBytes: 0, fileCount: 0 },
    childProcessCount: 0,
    thresholds: { warnPercent: 80, actPercent: 90, clearPercent: 85 },
    warning: usedPercent >= 80,
    act: usedPercent >= 90,
    clear: usedPercent < 85,
  };
}

// Fake "database" of issue rows, shared across calls to simulate persistence
// across a process restart (nothing here depends on module-level JS state).
type FakeRow = { id: string; companyId: string; originKind: string; originId: string; status: string };

function makeFakeIssuesSvc(rows: FakeRow[] = []): DiskAlertIssuesPort & { rows: FakeRow[]; comments: string[] } {
  const comments: string[] = [];
  let nextId = 1;
  const svc: DiskAlertIssuesPort & { rows: FakeRow[]; comments: string[] } = {
    rows,
    comments,
    list: async (companyId, filters) => {
      return rows
        .filter(
          (r) =>
            r.companyId === companyId &&
            r.originKind === filters.originKind &&
            r.originId === filters.originId &&
            filters.status.split(",").includes(r.status),
        )
        .map((r): DiskAlertIssueRef => ({ id: r.id }));
    },
    create: async (companyId, data) => {
      const id = `issue-${nextId++}`;
      rows.push({
        id,
        companyId,
        originKind: data.originKind as string,
        originId: data.originId as string,
        status: data.status as string,
      });
      return { id };
    },
    addComment: async (issueId, body) => {
      comments.push(`${issueId}:${body}`);
    },
    update: async (issueId, data) => {
      const row = rows.find((r) => r.id === issueId);
      if (row && typeof data.status === "string") row.status = data.status;
    },
  };
  return svc;
}

describe("handleDiskAlertAct — state-based dedup", () => {
  it("creates exactly one issue across two act readings; the second is a comment", async () => {
    const issuesSvc = makeFakeIssuesSvc();
    const result = makeResult(92);

    const first = await handleDiskAlertAct({
      companyId: COMPANY_ID,
      result,
      assigneeAgentId: "ceo-agent",
      readingBody: "reading 1",
      issuesSvc,
    });
    expect(first.action).toBe("created");

    const second = await handleDiskAlertAct({
      companyId: COMPANY_ID,
      result,
      assigneeAgentId: "ceo-agent",
      readingBody: "reading 2",
      issuesSvc,
    });
    expect(second.action).toBe("commented");
    expect(second.issueId).toBe(first.issueId);

    const openIssues = issuesSvc.rows.filter((r) => r.status !== "done" && r.status !== "cancelled");
    expect(openIssues).toHaveLength(1);
    expect(issuesSvc.comments).toHaveLength(1);
  });

  it("still yields exactly one issue when the second reading runs against a fresh module instance (restart simulation)", async () => {
    // Correctness must not depend on in-memory module state. Simulate a
    // server restart by resetting the module registry and re-importing
    // handleDiskAlertAct between the two calls — only the shared fake DB
    // rows persist across the "restart", exactly like a real Postgres table.
    vi.resetModules();
    const mod1 = await import("./disk-alert.js");
    const sharedRows: FakeRow[] = [];
    const issuesSvc = makeFakeIssuesSvc(sharedRows);
    const result = makeResult(92);

    const first = await mod1.handleDiskAlertAct({
      companyId: COMPANY_ID,
      result,
      assigneeAgentId: "ceo-agent",
      readingBody: "reading 1",
      issuesSvc,
    });
    expect(first.action).toBe("created");

    vi.resetModules();
    const mod2 = await import("./disk-alert.js");
    expect(mod2).not.toBe(mod1);
    const second = await mod2.handleDiskAlertAct({
      companyId: COMPANY_ID,
      result,
      assigneeAgentId: "ceo-agent",
      readingBody: "reading 2",
      issuesSvc,
    });
    expect(second.action).toBe("commented");
    expect(second.issueId).toBe(first.issueId);

    const openIssues = sharedRows.filter((r) => r.status !== "done" && r.status !== "cancelled");
    expect(openIssues).toHaveLength(1);
  });

  it("falls back to commenting when it loses a create race to a concurrent check (postgres.js constraint_name shape)", async () => {
    // postgres.js (this repo's driver — packages/db/src/client.ts) surfaces
    // the violated constraint as `constraint_name`, not `constraint`. A
    // fixture that only sets `constraint` proves the code against a shape
    // node-postgres throws, not the one production actually sees.
    const rows: FakeRow[] = [];
    const issuesSvc = makeFakeIssuesSvc(rows);
    const winningIssueId = "issue-raced";
    const realCreate = issuesSvc.create;
    issuesSvc.create = async (companyId, data) => {
      // Simulate the concurrent check's insert landing first, then this
      // insert hitting the partial unique index.
      rows.push({
        id: winningIssueId,
        companyId,
        originKind: data.originKind as string,
        originId: data.originId as string,
        status: "todo",
      });
      const err: any = new Error("duplicate key value violates unique constraint");
      err.code = "23505";
      err.constraint_name = "issues_active_disk_alert_uq";
      throw err;
    };
    void realCreate;

    const outcome = await handleDiskAlertAct({
      companyId: COMPANY_ID,
      result: makeResult(92),
      assigneeAgentId: "ceo-agent",
      readingBody: "reading",
      issuesSvc,
    });

    expect(outcome).toEqual({ action: "commented_after_race", issueId: winningIssueId });
    expect(rows).toHaveLength(1);
  });

  it("also falls back to commenting on the `constraint` shape (node-postgres), keeping the `??` fallback covered both ways", async () => {
    const rows: FakeRow[] = [];
    const issuesSvc = makeFakeIssuesSvc(rows);
    const winningIssueId = "issue-raced-2";
    issuesSvc.create = async (companyId, data) => {
      rows.push({
        id: winningIssueId,
        companyId,
        originKind: data.originKind as string,
        originId: data.originId as string,
        status: "todo",
      });
      const err: any = new Error("duplicate key value violates unique constraint");
      err.code = "23505";
      err.constraint = "issues_active_disk_alert_uq";
      throw err;
    };

    const outcome = await handleDiskAlertAct({
      companyId: COMPANY_ID,
      result: makeResult(92),
      assigneeAgentId: "ceo-agent",
      readingBody: "reading",
      issuesSvc,
    });

    expect(outcome).toEqual({ action: "commented_after_race", issueId: winningIssueId });
    expect(rows).toHaveLength(1);
  });

  it("re-throws a create error that isn't the expected unique-constraint conflict", async () => {
    const issuesSvc = makeFakeIssuesSvc();
    issuesSvc.create = async () => {
      throw new Error("boom");
    };

    await expect(
      handleDiskAlertAct({
        companyId: COMPANY_ID,
        result: makeResult(92),
        assigneeAgentId: "ceo-agent",
        readingBody: "reading",
        issuesSvc,
      }),
    ).rejects.toThrow("boom");
  });

  it("files the created issue with disk_alert origin and the routing-rationale skip marker", async () => {
    const issuesSvc = makeFakeIssuesSvc();
    let capturedData: Record<string, unknown> | undefined;
    const realCreate = issuesSvc.create;
    issuesSvc.create = async (companyId, data) => {
      capturedData = data;
      return realCreate(companyId, data);
    };

    await handleDiskAlertAct({
      companyId: COMPANY_ID,
      result: makeResult(92),
      assigneeAgentId: "ceo-agent",
      readingBody: "reading",
      issuesSvc,
    });

    expect(capturedData?.originKind).toBe(DISK_ALERT_ORIGIN_KIND);
    expect(capturedData?.originId).toBe(DISK_ALERT_ORIGIN_ID);
    expect(String(capturedData?.description)).toContain("exec.routing-rationale: skip");
  });
});

describe("handleDiskAlertClear — auto-resolve with hysteresis", () => {
  it("closes the open alert with the recovery reading", async () => {
    const rows: FakeRow[] = [
      { id: "issue-1", companyId: COMPANY_ID, originKind: DISK_ALERT_ORIGIN_KIND, originId: DISK_ALERT_ORIGIN_ID, status: "todo" },
    ];
    const issuesSvc = makeFakeIssuesSvc(rows);

    const outcome = await handleDiskAlertClear({
      companyId: COMPANY_ID,
      recoveryBody: "recovered to 70%",
      issuesSvc,
    });

    expect(outcome).toEqual({ action: "resolved", issueId: "issue-1" });
    expect(rows[0]?.status).toBe("done");
    expect(issuesSvc.comments).toHaveLength(1);
  });

  it("is a no-op when there is no open alert to resolve", async () => {
    const issuesSvc = makeFakeIssuesSvc([]);
    const outcome = await handleDiskAlertClear({
      companyId: COMPANY_ID,
      recoveryBody: "recovered",
      issuesSvc,
    });
    expect(outcome).toEqual({ action: "noop" });
    expect(issuesSvc.comments).toHaveLength(0);
  });
});
