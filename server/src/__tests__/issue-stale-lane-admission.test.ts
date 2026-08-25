import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";
import { STALE_LANE_HEARTBEAT_THRESHOLD_MS } from "../services/agent-lane-admission.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const STALE_HEARTBEAT_AT = new Date(Date.now() - 82 * 60 * 60 * 1000); // 82h stale (real AUR-4512 blast-radius shape)
const FRESH_HEARTBEAT_AT = new Date(Date.now() - 5 * 60 * 1000);

describeEmbeddedPostgres("issueService stale-lane admission (AUR-4512)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lane-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(agentOverrides: {
    status: string;
    lastHeartbeatAt: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CMO Ops",
      role: "engineer",
      status: agentOverrides.status,
      lastHeartbeatAt: agentOverrides.lastHeartbeatAt,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("red: refuses to assign a todo issue to a stale lane, naming agent id / heartbeat age / threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "idle",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
    });

    await expect(
      svc.create(companyId, {
        assigneeAgentId: agentId,
        title: "Should be refused",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        agentId,
        staleLaneThresholdMs: STALE_LANE_HEARTBEAT_THRESHOLD_MS,
      }),
    });
  });

  it("green: assigns a todo issue to a fresh lane", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "active",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: agentId,
      title: "Should succeed",
      status: "todo",
      priority: "medium",
    });

    expect(issue.assigneeAgentId).toBe(agentId);
  });

  it("escape hatch: allows a blocked issue to be routed to its only possible owner even on a stale lane (AUR-4167/AUR-3873 shape)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "idle",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: agentId,
      title: "Founder-gated blocker parked on a stale lane",
      status: "blocked",
      priority: "medium",
      description: "External owner: Founder\nExternal action: Approve budget",
    });

    expect(issue.assigneeAgentId).toBe(agentId);
    expect(issue.status).toBe("blocked");
  });

  it("null heartbeat is not stale: an agent that has never heartbeated is still assignable", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "idle",
      lastHeartbeatAt: null,
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: agentId,
      title: "Wake Watchdog Bot shape",
      status: "todo",
      priority: "medium",
    });

    expect(issue.assigneeAgentId).toBe(agentId);
  });

  it("red: refuses a PATCH re-route onto a stale lane on a live (non-blocked) issue", async () => {
    const { companyId, agentId: freshAgentId } = await seedCompanyAndAgent({
      status: "active",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    });
    const staleAgentId = randomUUID();
    await db.insert(agents).values({
      id: staleAgentId,
      companyId,
      name: "Stale Corpse",
      role: "engineer",
      status: "error",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: freshAgentId,
      title: "Live issue re-routed onto a corpse",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.update(issue.id, { assigneeAgentId: staleAgentId }),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ agentId: staleAgentId }),
    });
  });

  it("escape hatch: a PATCH that re-routes AND sets status: blocked onto a stale lane succeeds", async () => {
    const { companyId, agentId: freshAgentId } = await seedCompanyAndAgent({
      status: "active",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    });
    const staleAgentId = randomUUID();
    await db.insert(agents).values({
      id: staleAgentId,
      companyId,
      name: "CMO Ops",
      role: "engineer",
      status: "idle",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: freshAgentId,
      title: "Founder-gated blocker",
      status: "todo",
      priority: "medium",
      description: "External owner: Founder\nExternal action: Approve budget",
    });

    const updated = await svc.update(issue.id, {
      assigneeAgentId: staleAgentId,
      status: "blocked",
    });

    expect(updated?.assigneeAgentId).toBe(staleAgentId);
    expect(updated?.status).toBe("blocked");
  });

  it("red: checkout always refuses a stale lane, even for an issue currently sitting blocked (no escape hatch on checkout)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "idle",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
    });

    const issue = await svc.create(companyId, {
      assigneeAgentId: agentId,
      title: "Parked on a stale lane",
      status: "blocked",
      priority: "medium",
      description: "External owner: Founder\nExternal action: Approve budget",
    });

    await expect(
      svc.checkout(issue.id, agentId, ["blocked"], null),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ agentId }),
    });
  });
});

describeEmbeddedPostgres("routineService stale-lane admission (AUR-4512)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lane-routines-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(agentOverrides: {
    status: string;
    lastHeartbeatAt: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CMO Ops",
      role: "engineer",
      status: agentOverrides.status,
      lastHeartbeatAt: agentOverrides.lastHeartbeatAt,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("red: refuses to create a routine whose target agent lane is stale", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "idle",
      lastHeartbeatAt: STALE_HEARTBEAT_AT,
    });
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });

    await expect(
      svc.create(
        companyId,
        {
          projectId: null,
          goalId: null,
          parentIssueId: null,
          title: "Daily corpse routine",
          description: "Should be refused",
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        },
        {},
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ agentId }),
    });
  });

  it("green: creates a routine targeting a fresh agent lane", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      status: "active",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    });
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily fresh routine",
        description: "Should succeed",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.assigneeAgentId).toBe(agentId);
  });
});
