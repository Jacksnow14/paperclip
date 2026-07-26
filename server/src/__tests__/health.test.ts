import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

// Outside a pinned release there is no build-info.json (AUR-3937).
const untrackedBuild = { source: "untracked", sha: null, ref: null, builtAt: null };

// AUR-4059: getGlobalConcurrencyState() runs a status-breakdown select and a
// queued-runs-by-agent-status select, both ending in groupBy(). Real drizzle
// query builders stay chainable until awaited; this mimics that shape so the
// health route's extra queries don't throw in tests that stub `db.select`.
function createConcurrencyAwareDb(options: {
  statusRows?: Array<{ status: string; count: number }>;
  queuedByAgentStatusRows?: Array<{ agentStatus: string; count: number }>;
} = {}) {
  const statusRows = options.statusRows ?? [];
  const queuedByAgentStatusRows = options.queuedByAgentStatusRows ?? [];
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          groupBy: vi.fn().mockResolvedValue(statusRows),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn().mockResolvedValue(queuedByAgentStatusRows),
          })),
        })),
      })),
    })),
  } as unknown as Db;
}

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion, build: untrackedBuild });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = createConcurrencyAwareDb();
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("surfaces global concurrency cap state on the health payload (AUR-4059)", async () => {
    const db = createConcurrencyAwareDb({
      statusRows: [
        { status: "running", count: 4 },
        { status: "queued", count: 23 },
        { status: "scheduled_retry", count: 15 },
      ],
      queuedByAgentStatusRows: [
        { agentStatus: "idle", count: 20 },
        { agentStatus: "error", count: 3 },
      ],
    });
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.concurrency).toMatchObject({
      running: 4,
      queued: 23,
      scheduledRetry: 15,
      saturated: expect.any(Boolean),
      queuedByAgentStatus: { idle: 20, error: 3 },
    });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      build: untrackedBuild,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      build: untrackedBuild,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      // Query order for this request: (1) bootstrapStatus roleCount, then
      // getGlobalConcurrencyState's (2) status breakdown and (3) queued-by-
      // agent-status breakdown — each shaped like its real call site.
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({ where: () => ({ groupBy: () => Promise.resolve([]) }) }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ groupBy: () => Promise.resolve([]) }) }),
          }),
        })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });
});
