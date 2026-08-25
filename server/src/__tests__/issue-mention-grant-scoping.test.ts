import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mention grant scoping tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("wasAgentMentionedInThread scoping (AUR-4135)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mention-grant-scoping-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgents(names: Record<string, string>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const ids: Record<string, string> = {};
    for (const [key, name] of Object.entries(names)) {
      const id = randomUUID();
      ids[key] = id;
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    return { companyId, ids };
  }

  async function seedIssue(companyId: string, createdByAgentId: string, description = "Issue body") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mention scoping fixture",
      description,
      status: "in_progress",
      priority: "high",
      createdByAgentId,
    });
    return issueId;
  }

  it("(a) does not grant on a narrative third-party @Name mention that never resolves to a real token match against the actor", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      other: "OtherAgent",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator);
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.other,
      body: "We should loop in @SomeoneElseEntirely about this narrative aside.",
    });

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(false);
  });

  it("(b) does not grant when the mention was authored by the actor themselves", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator);
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.actor,
      body: "Noting for the record: @TargetAgent should follow up on this later.",
    });

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(false);
  });

  it("(c) does not grant when the actor's own later reply consumes the mention", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      other: "OtherAgent",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator);
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.other,
      body: "@TargetAgent can you take a look at this?",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.actor,
      body: "Sure, looking into it now.",
    });

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(false);
  });

  it("(d) grants on a genuine fresh third-party mention (no AUR-2825 regression)", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      other: "OtherAgent",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator);
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.other,
      body: "@TargetAgent can you take a look at this?",
    });

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(true);
  });

  it("grants when the actor never commented, even though other comments exist on the thread", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      other: "OtherAgent",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator);
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.other,
      body: "Just chatting, no mention here.",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.insert(issueComments).values({
      id: randomUUID(),
      issueId,
      companyId,
      authorAgentId: ids.other,
      body: "@TargetAgent following up on the above.",
    });

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(true);
  });

  it("does not grant on a self-authored description mention", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.actor, "Filed by me, @TargetAgent will handle this.");

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(false);
  });

  it("grants on a genuine third-party description mention", async () => {
    const { companyId, ids } = await seedCompanyAndAgents({
      creator: "Creator",
      actor: "TargetAgent",
    });
    const issueId = await seedIssue(companyId, ids.creator, "Please route this to @TargetAgent for triage.");

    const granted = await issueService(db).wasAgentMentionedInThread(companyId, issueId, ids.actor);
    expect(granted).toBe(true);
  });
});
