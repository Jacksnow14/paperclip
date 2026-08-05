import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  environments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { projectRoutes } from "../routes/projects.js";
import { environmentRoutes } from "../routes/environments.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secret binding board gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secret binding board gate (AUR-4093)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-binding-gate-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-binding-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function boardActor(companyId: string) {
    return {
      type: "board",
      userId: "board-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key" };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", projectRoutes(db));
    app.use("/api", environmentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Gate Co ${companyId.slice(0, 8)}`,
      issuePrefix: `G${companyId.slice(0, 6)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedSecret(companyId: string, name = `secret-${randomUUID().slice(0, 8)}`) {
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: name,
      name,
    });
    return secretId;
  }

  async function seedAgent(
    companyId: string,
    input: { role?: string; adapterConfig?: Record<string, unknown>; permissions?: Record<string, unknown> } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: input.role ?? "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: input.adapterConfig ?? { instructionsFilePath: "/tmp/agents.md" },
      runtimeConfig: {},
      permissions: input.permissions ?? {},
    });
    return agentId;
  }

  function secretRef(secretId: string) {
    return { type: "secret_ref", secretId };
  }

  async function bindingRows(companyId: string, targetType: string, targetId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, targetType as "agent"),
          eq(companySecretBindings.targetId, targetId),
        ),
      );
  }

  describe("PATCH /agents/:id", () => {
    it("refuses an agent adding a secret_ref to its own adapterConfig.env and persists nothing", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { STOLEN_TOKEN: secretRef(secretId) } } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/board/i);
      expect(await bindingRows(companyId, "agent", agentId)).toHaveLength(0);
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(JSON.stringify(row.adapterConfig)).not.toContain(secretId);
    });

    it("refuses a CEO-role agent granting a secret to another agent", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const ceoId = await seedAgent(companyId, { role: "ceo" });
      const targetId = await seedAgent(companyId);

      const res = await request(createApp(agentActor(companyId, ceoId)))
        .patch(`/api/agents/${targetId}`)
        .send({ adapterConfig: { env: { GRANTED: secretRef(secretId) } } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await bindingRows(companyId, "agent", targetId)).toHaveLength(0);
    });

    it("refuses a CEO-role agent granting a secret to itself", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const ceoId = await seedAgent(companyId, { role: "ceo" });

      const res = await request(createApp(agentActor(companyId, ceoId)))
        .patch(`/api/agents/${ceoId}`)
        .send({ adapterConfig: { env: { SELF_GRANT: secretRef(secretId) } } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await bindingRows(companyId, "agent", ceoId)).toHaveLength(0);
    });

    it("board adds a binding; the agent can then keep, but not change, and finally remove it", async () => {
      const companyId = await seedCompany();
      const secretA = await seedSecret(companyId, "secret-a");
      const secretB = await seedSecret(companyId, "secret-b");
      const agentId = await seedAgent(companyId);

      // Board grants secret A.
      const grant = await request(createApp(boardActor(companyId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { API_TOKEN: secretRef(secretA) } } });
      expect(grant.status, JSON.stringify(grant.body)).toBe(200);
      const granted = await bindingRows(companyId, "agent", agentId);
      expect(granted).toHaveLength(1);
      expect(granted[0].secretId).toBe(secretA);
      expect(granted[0].configPath).toBe("env.API_TOKEN");

      const agentApp = createApp(agentActor(companyId, agentId));

      // Unchanged resubmit of the same ref is not an addition.
      const resubmit = await request(agentApp)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { API_TOKEN: secretRef(secretA) } } });
      expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
      expect(await bindingRows(companyId, "agent", agentId)).toHaveLength(1);

      // Swapping the secretId at the same configPath is an addition — refused.
      const swap = await request(agentApp)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { API_TOKEN: secretRef(secretB) } } });
      expect(swap.status, JSON.stringify(swap.body)).toBe(403);
      const afterSwap = await bindingRows(companyId, "agent", agentId);
      expect(afterSwap).toHaveLength(1);
      expect(afterSwap[0].secretId).toBe(secretA);

      // Changing the version selector at the same configPath is also an addition.
      const versionBump = await request(agentApp)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { API_TOKEN: { type: "secret_ref", secretId: secretA, version: 2 } } } });
      expect(versionBump.status, JSON.stringify(versionBump.body)).toBe(403);

      // Removal (AUR-4066 de-escalation path) still works for the agent.
      const removal = await request(agentApp)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { env: { HARMLESS: { type: "plain", value: "1" } } } });
      expect(removal.status, JSON.stringify(removal.body)).toBe(200);
      expect(await bindingRows(companyId, "agent", agentId)).toHaveLength(0);
    });

    it("still allows agent self-configuration that does not touch env bindings", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { timeoutSec: 900 } });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("refuses an agent smuggling a secret_ref through runtimeConfig model profiles", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({
          runtimeConfig: {
            modelProfiles: {
              cheap: { adapterConfig: { env: { SMUGGLED: secretRef(secretId) } } },
            },
          },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await bindingRows(companyId, "agent", agentId)).toHaveLength(0);
    });
  });

  describe("POST /companies/:companyId/agents", () => {
    it("refuses an agent creating an agent with a secret_ref env and creates nothing", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const creatorId = await seedAgent(companyId, { role: "ceo" });

      const res = await request(createApp(agentActor(companyId, creatorId)))
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: "Minion",
          adapterType: "claude_local",
          adapterConfig: {
            instructionsFilePath: "/tmp/agents.md",
            env: { EXFIL: secretRef(secretId) },
          },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      const allBindings = await db.select().from(companySecretBindings);
      expect(allBindings).toHaveLength(0);
    });

    it("allows a board actor to create an agent with a secret_ref env and syncs bindings", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: "Provisioned",
          adapterType: "claude_local",
          adapterConfig: {
            instructionsFilePath: "/tmp/agents.md",
            env: { API_TOKEN: secretRef(secretId) },
          },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const rows = await bindingRows(companyId, "agent", res.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].secretId).toBe(secretId);
    });
  });

  describe("POST /companies/:companyId/agent-hires", () => {
    it("refuses an agent hiring an agent with a secret_ref env", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const creatorId = await seedAgent(companyId, { role: "ceo" });

      const res = await request(createApp(agentActor(companyId, creatorId)))
        .post(`/api/companies/${companyId}/agent-hires`)
        .send({
          name: "Hired Minion",
          adapterType: "claude_local",
          adapterConfig: {
            instructionsFilePath: "/tmp/agents.md",
            env: { EXFIL: secretRef(secretId) },
          },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    });

    it("allows a board hire with a secret_ref env and syncs bindings", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .post(`/api/companies/${companyId}/agent-hires`)
        .send({
          name: "Hired Provisioned",
          adapterType: "claude_local",
          adapterConfig: {
            instructionsFilePath: "/tmp/agents.md",
            env: { API_TOKEN: secretRef(secretId) },
          },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const agentId = res.body.agent?.id ?? res.body.id;
      const rows = await bindingRows(companyId, "agent", agentId);
      expect(rows).toHaveLength(1);
    });
  });

  describe("project routes", () => {
    it("refuses an agent creating a project with a secret_ref env", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(agentActor(companyId, agentId)))
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: "Sneaky", env: { EXFIL: secretRef(secretId) } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await db.select().from(projects)).toHaveLength(0);
      expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    });

    it("board creates a project with env bindings; agent can remove but not add or swap", async () => {
      const companyId = await seedCompany();
      const secretA = await seedSecret(companyId, "proj-a");
      const secretB = await seedSecret(companyId, "proj-b");
      const agentId = await seedAgent(companyId);

      const created = await request(createApp(boardActor(companyId)))
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: "Funded", env: { DB_URL: secretRef(secretA) } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      expect(await bindingRows(companyId, "project", projectId)).toHaveLength(1);

      const agentApp = createApp(agentActor(companyId, agentId));

      const add = await request(agentApp)
        .patch(`/api/projects/${projectId}`)
        .send({ env: { DB_URL: secretRef(secretA), EXTRA: secretRef(secretB) } });
      expect(add.status, JSON.stringify(add.body)).toBe(403);
      expect(await bindingRows(companyId, "project", projectId)).toHaveLength(1);
      const [projRow] = await db.select().from(projects).where(eq(projects.id, projectId));
      expect(JSON.stringify(projRow.env)).not.toContain(secretB);

      const swap = await request(agentApp)
        .patch(`/api/projects/${projectId}`)
        .send({ env: { DB_URL: secretRef(secretB) } });
      expect(swap.status, JSON.stringify(swap.body)).toBe(403);

      const keep = await request(agentApp)
        .patch(`/api/projects/${projectId}`)
        .send({ env: { DB_URL: secretRef(secretA) } });
      expect(keep.status, JSON.stringify(keep.body)).toBe(200);

      const remove = await request(agentApp)
        .patch(`/api/projects/${projectId}`)
        .send({ env: {} });
      expect(remove.status, JSON.stringify(remove.body)).toBe(200);
      expect(await bindingRows(companyId, "project", projectId)).toHaveLength(0);
    });
  });

  describe("environment routes", () => {
    const sshConfig = (secretId: string) => ({
      host: "test.internal",
      username: "deploy",
      remoteWorkspacePath: "/srv/workspace",
      privateKeySecretRef: { type: "secret_ref", secretId },
    });

    it("refuses an agent creating an ssh environment with a privateKeySecretRef", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const agentId = await seedAgent(companyId, { permissions: { canCreateAgents: true } });

      const res = await request(createApp(agentActor(companyId, agentId)))
        .post(`/api/companies/${companyId}/environments`)
        .send({ name: "sneaky-ssh", driver: "ssh", config: sshConfig(secretId) });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await db.select().from(environments)).toHaveLength(0);
      expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    });

    it("board creates the environment; agent can remove but not swap the secret ref", async () => {
      const companyId = await seedCompany();
      const secretA = await seedSecret(companyId, "ssh-a");
      const secretB = await seedSecret(companyId, "ssh-b");
      const agentId = await seedAgent(companyId, { permissions: { canCreateAgents: true } });

      const created = await request(createApp(boardActor(companyId)))
        .post(`/api/companies/${companyId}/environments`)
        .send({ name: "board-ssh", driver: "ssh", config: sshConfig(secretA) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const environmentId = created.body.id;
      const rows = await bindingRows(companyId, "environment", environmentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].configPath).toBe("privateKeySecretRef");

      const agentApp = createApp(agentActor(companyId, agentId));

      const swap = await request(agentApp)
        .patch(`/api/environments/${environmentId}`)
        .send({ config: sshConfig(secretB) });
      expect(swap.status, JSON.stringify(swap.body)).toBe(403);
      const unchanged = await bindingRows(companyId, "environment", environmentId);
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0].secretId).toBe(secretA);

      const remove = await request(agentApp)
        .patch(`/api/environments/${environmentId}`)
        .send({ config: { privateKeySecretRef: null } });
      expect(remove.status, JSON.stringify(remove.body)).toBe(200);
      expect(await bindingRows(companyId, "environment", environmentId)).toHaveLength(0);
    });
  });

  describe("service-level fail-closed behavior", () => {
    it("sync functions refuse additions when no actor is supplied", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const svc = secretService(db);
      const targetId = randomUUID();

      await expect(
        svc.syncEnvBindingsForTarget(
          companyId,
          { targetType: "agent", targetId },
          { KEY: { type: "secret_ref", secretId } },
          undefined,
        ),
      ).rejects.toMatchObject({ status: 403 });

      await expect(
        svc.syncSecretRefsForTarget(
          companyId,
          { targetType: "environment", targetId },
          [{ secretId, configPath: "privateKeySecretRef" }],
          undefined,
        ),
      ).rejects.toMatchObject({ status: 403 });

      await expect(
        svc.createBinding(
          {
            companyId,
            secretId,
            targetType: "agent",
            targetId,
            configPath: "env.KEY",
          },
          undefined,
        ),
      ).rejects.toMatchObject({ status: 403 });

      expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    });

    it("non-board actor types are refused; board passes", async () => {
      const companyId = await seedCompany();
      const secretId = await seedSecret(companyId);
      const svc = secretService(db);
      const targetId = randomUUID();

      await expect(
        svc.syncEnvBindingsForTarget(
          companyId,
          { targetType: "agent", targetId },
          { KEY: { type: "secret_ref", secretId } },
          { type: "none" },
        ),
      ).rejects.toMatchObject({ status: 403 });

      const refs = await svc.syncEnvBindingsForTarget(
        companyId,
        { targetType: "agent", targetId },
        { KEY: { type: "secret_ref", secretId } },
        { type: "board" },
      );
      expect(refs).toHaveLength(1);
      expect(await db.select().from(companySecretBindings)).toHaveLength(1);
    });
  });
});
