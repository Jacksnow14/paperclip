import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue identifier route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue identifier routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identifier-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("resolves alphanumeric Cloud tenant issue identifiers for detail reads and updates", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cloud tenant",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 7,
      identifier: "PC1A2-7",
      title: "Tenant identifier route",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });

    const app = createApp(companyId);
    const read = await request(app).get("/api/issues/pc1a2-7");

    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
    });

    const updated = await request(app)
      .patch("/api/issues/PC1A2-7")
      .send({ priority: "high" });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
      priority: "high",
    });

    const stored = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(stored?.priority).toBe("high");
  });

  it("?identifier= batch filter returns exactly the matching issues and omits unknown ones (AUR-3530)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Batch identifier tenant",
      issuePrefix: "BID",
      requireBoardApprovalForNewAgents: false,
    });

    const issueIdA = randomUUID();
    const issueIdB = randomUUID();
    const issueIdC = randomUUID();
    await db.insert(issues).values([
      {
        id: issueIdA,
        companyId,
        issueNumber: 1,
        identifier: "BID-1",
        title: "First",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
      {
        id: issueIdB,
        companyId,
        issueNumber: 2,
        identifier: "BID-2",
        title: "Second",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
      {
        id: issueIdC,
        companyId,
        issueNumber: 3,
        identifier: "BID-3",
        title: "Third (not requested)",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app).get(
      `/api/companies/${companyId}/issues?identifier=bid-1,BID-2,BID-999`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((issue: { identifier: string }) => issue.identifier).sort()).toEqual([
      "BID-1",
      "BID-2",
    ]);
  });

  it("?include=comments embeds the issue's comments in GET /issues/:id (AUR-3530)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Include comments tenant",
      issuePrefix: "INC",
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "INC-1",
      title: "Has comments",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "cloud-user-1",
      body: "First comment",
    });

    const app = createApp(companyId);

    const withoutInclude = await request(app).get(`/api/issues/${issueId}`);
    expect(withoutInclude.status, JSON.stringify(withoutInclude.body)).toBe(200);
    expect(withoutInclude.body.comments).toBeUndefined();

    const withInclude = await request(app).get(`/api/issues/${issueId}?include=comments`);
    expect(withInclude.status, JSON.stringify(withInclude.body)).toBe(200);
    expect(withInclude.body.comments).toHaveLength(1);
    expect(withInclude.body.comments[0]).toMatchObject({ body: "First comment" });
  });

  it("?search= is an alias for ?q= keyword search (AUR-3526)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Search alias tenant",
      issuePrefix: "SRCH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        issueNumber: 1,
        identifier: "SRCH-1",
        title: "Deploy the widget pipeline",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
      {
        id: randomUUID(),
        companyId,
        issueNumber: 2,
        identifier: "SRCH-2",
        title: "Unrelated gardening task",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app).get(
      `/api/companies/${companyId}/issues?search=widget`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { identifier: string }) => issue.identifier)).toEqual(["SRCH-1"]);
  });

  it("?completedAt/cancelledAt range filters narrow the list to the window (AUR-3526)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Date range tenant",
      issuePrefix: "DR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        issueNumber: 1,
        identifier: "DR-1",
        title: "Completed in window",
        status: "done",
        priority: "medium",
        createdByUserId: "cloud-user-1",
        completedAt: new Date("2026-07-05T12:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueNumber: 2,
        identifier: "DR-2",
        title: "Completed outside window",
        status: "done",
        priority: "medium",
        createdByUserId: "cloud-user-1",
        completedAt: new Date("2026-06-01T12:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueNumber: 3,
        identifier: "DR-3",
        title: "Cancelled in window",
        status: "cancelled",
        priority: "medium",
        createdByUserId: "cloud-user-1",
        cancelledAt: new Date("2026-07-06T12:00:00Z"),
      },
    ]);

    const app = createApp(companyId);

    const completed = await request(app).get(
      `/api/companies/${companyId}/issues?completedAtFrom=2026-07-01T00:00:00Z&completedAtTo=2026-07-31T23:59:59Z`,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.map((issue: { identifier: string }) => issue.identifier)).toEqual(["DR-1"]);

    const cancelled = await request(app).get(
      `/api/companies/${companyId}/issues?cancelledAtFrom=2026-07-01T00:00:00Z`,
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.map((issue: { identifier: string }) => issue.identifier)).toEqual(["DR-3"]);
  });
});
