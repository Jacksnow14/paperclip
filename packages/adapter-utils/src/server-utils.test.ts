import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR,
  RUN_MEMORY_CEILING_DISABLED_ENV_VAR,
  RUN_MEMORY_CEILING_ENV_VAR,
  resolveGlobalMaxConcurrentRuns,
  resolveRunMemoryCeilingMb,
  applyPaperclipWorkspaceEnv,
  appendWithByteCap,
  buildChildProcessEnv,
  buildInvocationEnvForLogs,
  sanitizeInheritedSecretEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureCommandResolvable,
  ensurePathInEnv,
  ensureUserLocalBinInPath,
  materializePaperclipSkillCopy,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  runningProcesses,
  runChildProcess,
  sanitizeSshRemoteEnv,
  shapePaperclipWorkspaceEnvForExecution,
  rewriteWorkspaceCwdEnvVarsForExecution,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForTextMatch(read: () => string, pattern: RegExp, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    const match = value.match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read().match(pattern);
}

describe("buildInvocationEnvForLogs", () => {
  it("redacts inline secrets from resolved command metadata", () => {
    const loggedEnv = buildInvocationEnvForLogs(
      { SAFE_VALUE: "visible" },
      {
        resolvedCommand: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
      },
    );

    expect(loggedEnv.SAFE_VALUE).toBe("visible");
    expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(
      "env OPENAI_API_KEY=***REDACTED*** custom-acp --token ***REDACTED***",
    );
  });
});

describe("sanitizeSshRemoteEnv", () => {
  it("drops inherited host shell identity variables for SSH remote execution", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
        },
      ),
    ).toEqual({
      SAFE_VALUE: "visible",
    });
  });

  it("preserves explicit remote overrides even for filtered key names", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/custom/remote/bin:/usr/bin",
          HOME: "/home/agent",
          TMPDIR: "/tmp",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          TMPDIR: "/var/folders/local/T",
        },
      ),
    ).toEqual({
      PATH: "/custom/remote/bin:/usr/bin",
      HOME: "/home/agent",
      TMPDIR: "/tmp",
      SAFE_VALUE: "visible",
    });
  });

  it("filters identity keys via case-insensitive match against the inherited env", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          // Caller passed PATH in upper case while the inherited (Windows-style)
          // host env exposes it as Path. The lookup must still treat them as
          // equal so the leaked host PATH gets stripped.
          PATH: "/host/bin:/usr/bin",
          HOME: "/host/home",
        },
        {
          Path: "/host/bin:/usr/bin",
          home: "/host/home",
        },
      ),
    ).toEqual({});
  });

  it("preserves explicitly-set identity keys when the inherited env disagrees in case but not in value", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/explicit/remote/bin",
        },
        {
          Path: "/host/bin:/usr/bin",
        },
      ),
    ).toEqual({ PATH: "/explicit/remote/bin" });
  });
});

describe("materializePaperclipSkillCopy", () => {
  it("refuses to materialize into an ancestor of the source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "parent", "skill");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");

      await expect(materializePaperclipSkillCopy(source, path.join(root, "parent"))).rejects.toThrow(
        /ancestor/,
      );
      await expect(fs.readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe("# skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete and recopy an unchanged materialized skill target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");

      const first = await materializePaperclipSkillCopy(source, target);
      expect(first.copiedFiles).toBe(1);
      await fs.writeFile(path.join(target, "local-marker.txt"), "keep\n", "utf8");

      const second = await materializePaperclipSkillCopy(source, target);
      expect(second.copiedFiles).toBe(0);
      await expect(fs.readFile(path.join(target, "local-marker.txt"), "utf8")).resolves.toBe("keep\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("breaks stale materialization locks left by dead processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      const lock = `${target}.lock`;
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");
      await fs.mkdir(lock, { recursive: true });
      await fs.writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" }),
        "utf8",
      );

      await expect(materializePaperclipSkillCopy(source, target)).resolves.toMatchObject({ copiedFiles: 1 });
      await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe("# skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runChildProcess", () => {
  it("does not arm a timeout when timeoutSec is 0", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 150);"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done");
  });

  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cleans up a lingering process group after terminal output and child exit", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const descendantPid = Number.parseInt(result.stdout.match(/descendant:(\d+)/)?.[1] ?? "", 10);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cleans up a still-running child after terminal output", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout).toContain('"type":"result"');
  });

  it.skipIf(process.platform === "win32")(
    "kills descendant process group when parent exits (AUR-1714 zombie-leak fix)",
    async () => {
      const runId = randomUUID();
      let observed = "";
      const resultPromise = runChildProcess(
        runId,
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('noise\\\\n'), 50)\"], { stdio: ['ignore', 'inherit', 'ignore'] });",
            "process.stdout.write(`descendant:${child.pid}\\n`);",
            "setTimeout(() => process.exit(0), 25);",
          ].join(" "),
        ],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 0,
          graceSec: 1,
          onLog: async (_stream, chunk) => {
            observed += chunk;
          },
          // No terminalResultCleanup configured — previously this kept the
          // run promise pending forever while the descendant kept the stdio
          // pipes open. With AUR-1714 the parent-exit handler signals the
          // process group so descendants exit and the run resolves.
        },
      );

      const pidMatch = await waitForTextMatch(() => observed, /descendant:(\d+)/);
      const descendantPid = Number.parseInt(pidMatch?.[1] ?? "", 10);
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

      const result = await resultPromise;
      expect(result.exitCode).toBe(0);
      expect(runningProcesses.has(runId)).toBe(false);
      expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
    },
  );
});

describe("renderPaperclipWakePrompt", () => {
  it("keeps the default local-agent prompt action-oriented", () => {
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Start actionable work in this heartbeat");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("do not stop at a plan");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("clear final disposition");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("evidence, not valid liveness paths by themselves");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("keep `in_progress` only when a live continuation path exists");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Prefer the smallest verification that proves the change");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Use child issues");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("instead of polling agents, sessions, or processes");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Create child issues directly when you know what needs to be done");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/interactions");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("kind suggest_tasks, ask_user_questions, or request_confirmation");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("confirmation:{issueId}:plan:{revisionId}");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Wait for acceptance before creating implementation subtasks");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(
      "Respect budget, pause/cancel, approval gates, and company boundaries",
    );
  });

  it("adds the execution contract to scoped wake prompts", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1580",
        title: "Update prompts",
        status: "in_progress",
      },
      commentWindow: {
        requestedCount: 0,
        includedCount: 0,
        missingCount: 0,
      },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("Execution contract: take concrete action in this heartbeat");
    expect(prompt).toContain("clear final disposition");
    expect(prompt).toContain("evidence, not valid liveness paths by themselves");
    expect(prompt).toContain("Use child issues for long or parallel delegated work instead of polling");
    expect(prompt).toContain("named unblock owner/action");
  });

  it("preserves Chinese, Japanese, and Hindi issue and comment text in scoped wake prompts", () => {
    const title = "验证中文任务";
    const commentBody = [
      "请用中文回复。",
      "日本語: 次の手順を書いてください。",
      "हिन्दी: कृपया स्थिति बताएं।",
    ].join("\n");
    const payload = {
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-9452",
        title,
        status: "in_progress",
        workMode: "standard",
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [
        {
          id: "comment-1",
          body: commentBody,
          author: { type: "user", id: "board-user-1" },
          createdAt: "2026-05-15T16:30:00.000Z",
        },
      ],
      fallbackFetchNeeded: false,
    };

    const serialized = stringifyPaperclipWakePayload(payload);
    expect(serialized).toContain(title);
    expect(serialized).toContain("日本語");
    expect(serialized).toContain("हिन्दी");
    expect(JSON.parse(serialized ?? "{}")).toMatchObject({
      issue: { title },
      comments: [{ body: commentBody }],
    });

    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain(`- issue: PAP-9452 ${title}`);
    expect(prompt).toContain(commentBody);
  });

  it("renders planning-mode directives for assignment and comment wakes", () => {
    const assignmentPrompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(assignmentPrompt).toContain("- issue work mode: planning");
    expect(assignmentPrompt).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentPrompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{ id: "comment-1", body: "Revise the plan" }],
      fallbackFetchNeeded: false,
    });

    expect(commentPrompt).toContain("Update the plan only. Do not write code or perform implementation work.");
  });

  it("does not render stale accepted-plan continuation guidance for later planning comment wakes", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{ id: "comment-1", body: "Revise the plan" }],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(prompt).not.toContain("accepted-plan continuation");
    expect(prompt).not.toContain("Create child issues from the approved plan only");
  });

  it("renders accepted-plan continuation guidance for planning issues", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("accepted-plan continuation");
    expect(prompt).toContain("Create child issues from the approved plan only");
    expect(prompt).toContain("may create child implementation issues");
    expect(prompt).toContain("must not start implementation work on the planning issue itself");
  });

  it("keeps accepted-plan guidance when stale comment ids have no loaded comments", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentIds: ["stale-comment-1"],
      latestCommentId: "stale-comment-1",
      commentWindow: { requestedCount: 1, includedCount: 0, missingCount: 1 },
      comments: [],
      fallbackFetchNeeded: true,
    });

    expect(prompt).toContain("accepted-plan continuation");
    expect(prompt).toContain("Create child issues from the approved plan only");
    expect(prompt).not.toContain("Update the plan only");
  });

  it("renders dependency-blocked interaction guidance", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-1703",
        title: "Blocked parent",
        status: "todo",
      },
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: ["blocker-1"],
      unresolvedBlockerSummaries: [
        {
          id: "blocker-1",
          identifier: "PAP-1723",
          title: "Finish blocker",
          status: "todo",
          priority: "medium",
        },
      ],
      commentWindow: {
        requestedCount: 1,
        includedCount: 1,
        missingCount: 0,
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      comments: [{ id: "comment-1", body: "hello" }],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("dependency-blocked interaction: yes");
    expect(prompt).toContain("respond or triage the human comment");
    expect(prompt).toContain("PAP-1723 Finish blocker (todo)");
  });

  it("renders loose review request instructions for execution handoffs", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "execution_review_requested",
      issue: {
        id: "issue-1",
        identifier: "PAP-2011",
        title: "Review request handoff",
        status: "in_review",
      },
      executionStage: {
        wakeRole: "reviewer",
        stageId: "stage-1",
        stageType: "review",
        currentParticipant: { type: "agent", agentId: "agent-1" },
        returnAssignee: { type: "agent", agentId: "agent-2" },
        reviewRequest: {
          instructions: "Please focus on edge cases and leave a short risk summary.",
        },
        allowedActions: ["approve", "request_changes"],
      },
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("Review request instructions:");
    expect(prompt).toContain("Please focus on edge cases and leave a short risk summary.");
    expect(prompt).toContain("You are waking as the active reviewer for this issue.");
  });

  it("includes continuation and child issue summaries in structured wake context", () => {
    const payload = {
      reason: "issue_children_completed",
      issue: {
        id: "parent-1",
        identifier: "PAP-100",
        title: "Integrate child work",
        status: "in_progress",
        priority: "medium",
      },
      continuationSummary: {
        key: "continuation-summary",
        title: "Continuation Summary",
        body: "# Continuation Summary\n\n## Next Action\n\n- Integrate child outputs.",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        reason: "Run described future work without concrete action evidence",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Implement helper",
          status: "done",
          priority: "medium",
          summary: "Added the helper route and tests.",
        },
      ],
    };

    expect(JSON.parse(stringifyPaperclipWakePayload(payload) ?? "{}")).toMatchObject({
      continuationSummary: {
        body: expect.stringContaining("Continuation Summary"),
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          identifier: "PAP-101",
          summary: "Added the helper route and tests.",
        },
      ],
    });

    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("Issue continuation summary:");
    expect(prompt).toContain("Integrate child outputs.");
    expect(prompt).toContain("Run liveness continuation:");
    expect(prompt).toContain("- attempt: 2/2");
    expect(prompt).toContain("- source run: run-1");
    expect(prompt).toContain("- liveness state: plan_only");
    expect(prompt).toContain("- reason: Run described future work without concrete action evidence");
    expect(prompt).toContain("- instruction: Take the first concrete action now.");
    expect(prompt).toContain("Direct child issue summaries:");
    expect(prompt).toContain("PAP-101 Implement helper (done)");
    expect(prompt).toContain("Added the helper route and tests.");
  });
});

describe("applyPaperclipWorkspaceEnv", () => {
  it("adds shared workspace env vars including AGENT_HOME", () => {
    const env = applyPaperclipWorkspaceEnv(
      {},
      {
        workspaceCwd: "/tmp/workspace",
        workspaceSource: "project_primary",
        workspaceStrategy: "git_worktree",
        workspaceId: "workspace-1",
        workspaceRepoUrl: "https://github.com/paperclipai/paperclip.git",
        workspaceRepoRef: "main",
        workspaceBranch: "feature/test",
        workspaceWorktreePath: "/tmp/worktree",
        agentHome: "/tmp/agent-home",
      },
    );

    expect(env).toEqual({
      PAPERCLIP_WORKSPACE_CWD: "/tmp/workspace",
      PAPERCLIP_WORKSPACE_SOURCE: "project_primary",
      PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
      PAPERCLIP_WORKSPACE_ID: "workspace-1",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/paperclipai/paperclip.git",
      PAPERCLIP_WORKSPACE_REPO_REF: "main",
      PAPERCLIP_WORKSPACE_BRANCH: "feature/test",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/tmp/worktree",
      AGENT_HOME: "/tmp/agent-home",
    });
  });

  it("skips empty workspace env values", () => {
    const env = applyPaperclipWorkspaceEnv(
      {},
      {
        workspaceCwd: "",
        workspaceSource: null,
        agentHome: "",
      },
    );

    expect(env).toEqual({});
  });
});

describe("shapePaperclipWorkspaceEnvForExecution", () => {
  it("rewrites workspace env paths for remote execution", () => {
    const shaped = shapePaperclipWorkspaceEnvForExecution({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/tmp/workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-2",
          cwd: "/tmp/other-workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-3",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
      ],
      executionTargetIsRemote: true,
      executionCwd: "/remote/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/remote/workspace",
      workspaceWorktreePath: null,
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/remote/workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-2",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-3",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
      ],
    });
  });

  it("leaves local execution workspace paths unchanged", () => {
    const workspaceHints = [{ workspaceId: "workspace-1", cwd: "/tmp/workspace" }];
    const shaped = shapePaperclipWorkspaceEnvForExecution({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints,
      executionTargetIsRemote: false,
      executionCwd: "/remote/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints,
    });
  });
});

describe("rewriteWorkspaceCwdEnvVarsForExecution", () => {
  it("rewrites custom *_WORKSPACE_CWD env vars for remote execution", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: true,
      env: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
        RANDOM_WORKSPACE_CWD: "/host/workspace",
        OTHER_ENV: "/host/workspace",
      },
    });

    expect(env).toEqual({
      QA_PROJECT_WORKSPACE_CWD: "/remote/workspace",
      RANDOM_WORKSPACE_CWD: "/remote/workspace",
      OTHER_ENV: "/host/workspace",
    });
  });

  it("does not rewrite matching values for local execution", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: false,
      env: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
        RANDOM_WORKSPACE_CWD_TOKEN: "/host/workspace",
      },
    });

    expect(env).toEqual({
      QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
      RANDOM_WORKSPACE_CWD_TOKEN: "/host/workspace",
    });
  });

  it("only rewrites matching *_WORKSPACE_CWD string values", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: true,
      env: {
        MATCHING_WORKSPACE_CWD: "/host/workspace/.",
        DIFFERENT_WORKSPACE_CWD: "/host/other-workspace",
        BLANK_WORKSPACE_CWD: "   ",
        NON_STRING_WORKSPACE_CWD: 42,
      },
    });

    expect(env).toEqual({
      MATCHING_WORKSPACE_CWD: "/remote/workspace",
      DIFFERENT_WORKSPACE_CWD: "/host/other-workspace",
      BLANK_WORKSPACE_CWD: "   ",
    });
  });
});

describe("refreshPaperclipWorkspaceEnvForExecution", () => {
  it("rewrites Paperclip workspace env to the prepared remote runtime cwd", () => {
    const env: Record<string, string> = {
      PAPERCLIP_WORKSPACE_CWD: "/remote/workspace",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/host/worktree",
      PAPERCLIP_WORKSPACES_JSON: JSON.stringify([
        { workspaceId: "workspace-1", cwd: "/remote/workspace" },
        { workspaceId: "workspace-2", cwd: "/tmp/other" },
      ]),
      QA_PROJECT_WORKSPACE_CWD: "/remote/workspace",
    };

    const shaped = refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
      },
      workspaceCwd: "/host/workspace",
      workspaceWorktreePath: "/host/worktree",
      workspaceHints: [
        { workspaceId: "workspace-1", cwd: "/host/workspace" },
        { workspaceId: "workspace-2", cwd: "/tmp/other" },
      ],
      executionTargetIsRemote: true,
      executionCwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      workspaceWorktreePath: null,
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
        },
        {
          workspaceId: "workspace-2",
        },
      ],
    });
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe("/remote/workspace/.paperclip-runtime/runs/run-1/workspace");
    expect(env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(env.QA_PROJECT_WORKSPACE_CWD).toBe("/remote/workspace/.paperclip-runtime/runs/run-1/workspace");
    expect(JSON.parse(env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      },
      {
        workspaceId: "workspace-2",
      },
    ]);
  });
});

describe.skipIf(process.platform === "win32")("ensureCommandResolvable", () => {
  async function withTempBinDir<T>(fn: (binDir: string) => Promise<T>): Promise<T> {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-command-resolve-"));
    try {
      return await fn(binDir);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  }

  it("resolves immediately when the command is already on PATH", async () => {
    await withTempBinDir(async (binDir) => {
      const commandPath = path.join(binDir, "aur3302-tool");
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      await expect(
        ensureCommandResolvable("aur3302-tool", process.cwd(), { PATH: binDir }),
      ).resolves.toBeUndefined();
    });
  });

  it("survives a symlink-swap race by retrying before failing", async () => {
    await withTempBinDir(async (binDir) => {
      const commandPath = path.join(binDir, "aur3302-tool");

      // Simulate a self-update briefly removing the binary (e.g. mid version
      // install) and then reinstating it a little later.
      setTimeout(() => {
        void fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }, 150);

      await expect(
        ensureCommandResolvable("aur3302-tool", process.cwd(), { PATH: binDir }),
      ).resolves.toBeUndefined();
    });
  });

  it('throws "Command not found in PATH" after retries are exhausted', async () => {
    await withTempBinDir(async (binDir) => {
      await expect(
        ensureCommandResolvable("aur3302-missing-tool", process.cwd(), { PATH: binDir }),
      ).rejects.toThrow('Command not found in PATH: "aur3302-missing-tool"');
    });
  });
});

describe("appendWithByteCap", () => {
  it("keeps valid UTF-8 when trimming through multibyte text", () => {
    const output = appendWithByteCap("prefix ", "hello — world", 7);

    expect(output).not.toContain("\uFFFD");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(7);
  });
});

describe("ensurePathInEnv", () => {
  it("leaves an already-populated PATH untouched (empty-fill semantics only)", () => {
    const env = { HOME: "/nonexistent-aur3529", PATH: "/usr/bin:/bin" };
    const result = ensurePathInEnv(env);

    expect(result).toBe(env);
    expect(result.PATH).toBe("/usr/bin:/bin");
  });

  it("substitutes a platform default when PATH is absent", () => {
    const result = ensurePathInEnv({ HOME: "/nonexistent-aur3529" });
    expect(typeof result.PATH).toBe("string");
    expect((result.PATH as string).length).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === "win32")("ensureUserLocalBinInPath", () => {
  async function withTempHome(run: (home: string) => Promise<void>) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aur3529-home-"));
    const originalHome = process.env.HOME;
    // Pin process.env.HOME (which os.homedir() reads on POSIX) to the temp
    // dir so real-host dirs (e.g. this sandbox's own ~/.local/bin) can't leak
    // into candidateUserLocalBinDirs and make these assertions flaky.
    process.env.HOME = home;
    try {
      await run(home);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  const minimalPath = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(
    path.delimiter,
  );

  it("prepends an existing user-local bin dir (~/.local/bin) that PATH omits (AUR-3529)", async () => {
    await withTempHome(async (home) => {
      const localBin = path.join(home, ".local/bin");
      await fs.mkdir(localBin, { recursive: true });

      const result = ensureUserLocalBinInPath({ HOME: home, PATH: minimalPath });
      const segments = (result.PATH as string).split(path.delimiter);

      // The run-scoped HOME comes first in resolution order, so its existing
      // .local/bin is the first dir prepended.
      expect(segments[0]).toBe(localBin);
      // The original PATH is preserved in full after the prepended dirs.
      expect((result.PATH as string).endsWith(minimalPath)).toBe(true);
    });
  });

  it("does not duplicate a user-local bin dir already on PATH", async () => {
    await withTempHome(async (home) => {
      const localBin = path.join(home, ".local/bin");
      await fs.mkdir(localBin, { recursive: true });

      const withDir = [localBin, minimalPath].join(path.delimiter);
      const env = { HOME: home, PATH: withDir };
      const result = ensureUserLocalBinInPath(env);

      const occurrences = (result.PATH as string)
        .split(path.delimiter)
        .filter((segment) => segment === localBin).length;
      expect(occurrences).toBe(1);
    });
  });

  it("never adds a candidate bin dir that does not exist", async () => {
    await withTempHome(async (home) => {
      // Temp HOME has none of the well-known bin subdirs, so none of ITS dirs
      // should ever be injected (unrelated dirs from the real process HOME may
      // still be prepended — that is intended).
      const result = ensureUserLocalBinInPath({ HOME: home, PATH: minimalPath });
      const segments = (result.PATH as string).split(path.delimiter);

      expect(segments).not.toContain(path.join(home, ".local/bin"));
      expect(segments).not.toContain(path.join(home, ".npm-global/bin"));
      expect(segments).not.toContain(path.join(home, ".local/share/pnpm"));
      // The original PATH is always still present in full.
      expect((result.PATH as string).endsWith(minimalPath)).toBe(true);
    });
  });

  it("is a byte-for-byte no-op (same object) when nothing needs adding", async () => {
    await withTempHome(async (home) => {
      const env = { HOME: home, PATH: minimalPath };
      const result = ensureUserLocalBinInPath(env);
      expect(result).toBe(env);
    });
  });
});

describe("sanitizeInheritedSecretEnv (AUR-4003)", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    LANG: "en_US.UTF-8",
    GOOGLE_WORKSPACE_SA_KEY: "fixture-not-a-secret",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-secret",
    SUPABASE_DB_URL: "postgres://fixture",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/fixture.json",
    BETTER_AUTH_SECRET: "fixture-not-a-secret",
    CLOUDFLARE_API_TOKEN: "fixture-not-a-secret",
    SOME_DB_PASSWORD: "fixture-not-a-secret",
    ANTHROPIC_API_KEY: "fixture-not-a-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-not-a-secret",
  };

  it("strips secret-shaped vars matched by the sensitive-key regex", () => {
    const result = sanitizeInheritedSecretEnv(base, { mode: "enforce", log: () => {} });
    expect(result).not.toHaveProperty("GOOGLE_WORKSPACE_SA_KEY");
    expect(result).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(result).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(result).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(result).not.toHaveProperty("SOME_DB_PASSWORD");
  });

  it("strips explicit-denylist vars the regex misses", () => {
    const result = sanitizeInheritedSecretEnv(base, { mode: "enforce", log: () => {} });
    expect(result).not.toHaveProperty("SUPABASE_DB_URL");
    expect(result).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("keeps runtime-auth keep-list vars and non-secret vars", () => {
    const result = sanitizeInheritedSecretEnv(base, { mode: "enforce", log: () => {} });
    expect(result.ANTHROPIC_API_KEY).toBe("fixture-not-a-secret");
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-not-a-secret");
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.LANG).toBe("en_US.UTF-8");
  });

  it("report mode strips nothing but logs what would be stripped", () => {
    const messages: string[] = [];
    const result = sanitizeInheritedSecretEnv(base, {
      mode: "report",
      runId: "run-report",
      log: (message) => messages.push(message),
    });
    expect(result.GOOGLE_WORKSPACE_SA_KEY).toBe("fixture-not-a-secret");
    expect(result.SUPABASE_DB_URL).toBe("postgres://fixture");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("would strip");
    expect(messages[0]).toContain("run=run-report");
    expect(messages[0]).toContain("GOOGLE_WORKSPACE_SA_KEY");
  });

  it("logs stripped key names but never values", () => {
    const messages: string[] = [];
    sanitizeInheritedSecretEnv(base, {
      mode: "enforce",
      runId: "run-enforce",
      log: (message) => messages.push(message),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("stripped");
    expect(messages[0]).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(messages[0]).not.toContain("fixture-not-a-secret");
    expect(messages[0]).not.toContain("postgres://fixture");
  });

  it("does not log when nothing is stripped", () => {
    const messages: string[] = [];
    sanitizeInheritedSecretEnv(
      { PATH: "/usr/bin" },
      { mode: "enforce", log: (message) => messages.push(message) },
    );
    expect(messages).toHaveLength(0);
  });
});

describe("buildChildProcessEnv (AUR-4003)", () => {
  it("run-env (vault-bound) values with secret-shaped names are never stripped", () => {
    const result = buildChildProcessEnv(
      { PATH: "/usr/bin", GOOGLE_WORKSPACE_SA_KEY: "host-fixture" },
      { TENANT_SCOPED_API_KEY: "tenant-fixture", PAPERCLIP_API_KEY: "run-fixture" },
      { mode: "enforce", log: () => {} },
    );
    expect(result.TENANT_SCOPED_API_KEY).toBe("tenant-fixture");
    expect(result.PAPERCLIP_API_KEY).toBe("run-fixture");
    expect(result).not.toHaveProperty("GOOGLE_WORKSPACE_SA_KEY");
  });

  it("a per-run binding wins over a stripped host var of the same name", () => {
    const result = buildChildProcessEnv(
      { TENANT_SCOPED_API_TOKEN: "host-fixture" },
      { TENANT_SCOPED_API_TOKEN: "vault-bound-fixture" },
      { mode: "enforce", log: () => {} },
    );
    expect(result.TENANT_SCOPED_API_TOKEN).toBe("vault-bound-fixture");
  });

  it("still applies paperclip identity sanitization to the inherited side", () => {
    const result = buildChildProcessEnv(
      { PAPERCLIP_HOME: "/host", PAPERCLIP_RUNTIME_API_URL: "http://runtime" },
      {},
      { mode: "enforce", log: () => {} },
    );
    expect(result).not.toHaveProperty("PAPERCLIP_HOME");
    expect(result.PAPERCLIP_RUNTIME_API_URL).toBe("http://runtime");
  });
});

describe("buildChildProcessEnv host-credential runEnv denylist (AUR-4046)", () => {
  const hostCredentialKeys = [
    "GOOGLE_WORKSPACE_SA_KEY",
    "INTEROP_R2_ACCESS_KEY_ID",
    "INTEROP_R2_SECRET_ACCESS_KEY",
  ] as const;

  it("blocks all three host-credential keys from a composed (inherited + runEnv) child env by default, even when only runEnv carries them", () => {
    const runEnv = Object.fromEntries(hostCredentialKeys.map((key) => [key, "vault-bound-fixture"]));
    const result = buildChildProcessEnv(
      { PATH: "/usr/bin", HOME: "/home/user" },
      runEnv,
      { mode: "enforce", log: () => {} },
    );
    for (const key of hostCredentialKeys) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
  });

  it("does not affect other, non-denylisted vault-bound runEnv secrets (no blanket runEnv filter)", () => {
    const result = buildChildProcessEnv(
      {},
      {
        GOOGLE_WORKSPACE_SA_KEY: "vault-bound-fixture",
        STRIPE_API_KEY: "tenant-vault-fixture",
        CUSTOMER_SECRET_TOKEN: "tenant-vault-fixture",
      },
      { mode: "enforce", log: () => {} },
    );
    expect(result).not.toHaveProperty("GOOGLE_WORKSPACE_SA_KEY");
    expect(result.STRIPE_API_KEY).toBe("tenant-vault-fixture");
    expect(result.CUSTOMER_SECRET_TOKEN).toBe("tenant-vault-fixture");
  });

  it("allows an explicitly opted-in key through", () => {
    const result = buildChildProcessEnv(
      {},
      { GOOGLE_WORKSPACE_SA_KEY: "vault-bound-fixture" },
      { mode: "enforce", log: () => {}, allowRunEnvKeys: ["GOOGLE_WORKSPACE_SA_KEY"] },
    );
    expect(result.GOOGLE_WORKSPACE_SA_KEY).toBe("vault-bound-fixture");
  });

  it("opting in to one key does not allow the others through", () => {
    const result = buildChildProcessEnv(
      {},
      {
        GOOGLE_WORKSPACE_SA_KEY: "vault-bound-fixture",
        INTEROP_R2_ACCESS_KEY_ID: "vault-bound-fixture",
      },
      { mode: "enforce", log: () => {}, allowRunEnvKeys: ["GOOGLE_WORKSPACE_SA_KEY"] },
    );
    expect(result.GOOGLE_WORKSPACE_SA_KEY).toBe("vault-bound-fixture");
    expect(result).not.toHaveProperty("INTEROP_R2_ACCESS_KEY_ID");
  });

  it("report mode logs what would be blocked but does not block it", () => {
    const messages: string[] = [];
    const result = buildChildProcessEnv(
      {},
      { GOOGLE_WORKSPACE_SA_KEY: "vault-bound-fixture" },
      { mode: "report", runId: "run-report", log: (message) => messages.push(message) },
    );
    expect(result.GOOGLE_WORKSPACE_SA_KEY).toBe("vault-bound-fixture");
    expect(messages.some((m) => m.includes("would block"))).toBe(true);
    expect(messages.some((m) => m.includes("GOOGLE_WORKSPACE_SA_KEY"))).toBe(true);
    expect(messages.some((m) => m.includes("run=run-report"))).toBe(true);
  });

  it("logs blocked key names but never values", () => {
    const messages: string[] = [];
    buildChildProcessEnv(
      {},
      { GOOGLE_WORKSPACE_SA_KEY: "super-secret-value-should-not-be-logged" },
      { mode: "enforce", log: (message) => messages.push(message) },
    );
    expect(messages.some((m) => m.includes("GOOGLE_WORKSPACE_SA_KEY"))).toBe(true);
    expect(messages.some((m) => m.includes("super-secret-value-should-not-be-logged"))).toBe(false);
  });

  it("does not log when no host-credential keys are present", () => {
    const messages: string[] = [];
    buildChildProcessEnv(
      {},
      { TENANT_SCOPED_API_KEY: "tenant-fixture" },
      { mode: "enforce", log: (message) => messages.push(message) },
    );
    expect(messages).toHaveLength(0);
  });
});

describe("runChildProcess secret env scrub (AUR-4003)", () => {
  it("a secret-shaped host env var never reaches the child; run-env secrets do", async () => {
    const sentinelKey = "AUR4003_E2E_FAKE_TOKEN";
    process.env[sentinelKey] = "host-fixture-not-a-secret";
    try {
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({inherited: process.env.AUR4003_E2E_FAKE_TOKEN ?? null, bound: process.env.AUR4003_RUN_BOUND_KEY ?? null}))",
        ],
        {
          cwd: process.cwd(),
          env: { AUR4003_RUN_BOUND_KEY: "vault-fixture-not-a-secret" },
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(result.stdout) as { inherited: string | null; bound: string | null };
      expect(observed.inherited).toBeNull();
      expect(observed.bound).toBe("vault-fixture-not-a-secret");
    } finally {
      delete process.env[sentinelKey];
    }
  });
});

// AUR-4536: the per-run memory ceiling. Two distinct claims are proven here and
// they need different kinds of test:
//   1. the SIZING arithmetic is right (pure, host-independent)
//   2. the ceiling is actually WIRED to the real child-process spawn boundary —
//      i.e. the process runChildProcess starts really does land inside a cgroup
//      whose memory.max is the ceiling. Claim 2 cannot be proven by asserting on
//      a config value; it is asserted against /proc and /sys/fs/cgroup for the
//      live child, and it is paired with a mutation control (memoryCeilingMb:
//      null) that must NOT land in a scope — otherwise the check would pass on
//      a host where everything happens to be in a scope for unrelated reasons.
describe("resolveRunMemoryCeilingMb (AUR-4536)", () => {
  const HOST_TOTAL_BYTES = 7747 * 1024 * 1024;

  it("derives floor((total - reserve) / cap) — 7747 MB host, cap 4 => 1168 MB", () => {
    // cap  = floor((7747 - 3072) / 1024) = floor(4.565) = 4
    // ceil = floor((7747 - 3072) / 4)    = floor(1168.75) = 1168
    expect(resolveGlobalMaxConcurrentRuns({}, HOST_TOTAL_BYTES)).toBe(4);
    expect(resolveRunMemoryCeilingMb({}, HOST_TOTAL_BYTES)).toBe(1168);
  });

  it("tightens when the operator raises the concurrency cap, so the two never drift", () => {
    const env = { [GLOBAL_MAX_CONCURRENT_RUNS_ENV_VAR]: "8" };
    expect(resolveGlobalMaxConcurrentRuns(env, HOST_TOTAL_BYTES)).toBe(8);
    // floor(4675 / 8) = 584 — same total budget, split 8 ways instead of 4.
    expect(resolveRunMemoryCeilingMb(env, HOST_TOTAL_BYTES)).toBe(584);
  });

  it("honours an explicit per-run override", () => {
    expect(resolveRunMemoryCeilingMb({ [RUN_MEMORY_CEILING_ENV_VAR]: "512" }, HOST_TOTAL_BYTES)).toBe(512);
  });

  it("returns null when explicitly disabled (the mutation-control switch)", () => {
    expect(resolveRunMemoryCeilingMb({ [RUN_MEMORY_CEILING_DISABLED_ENV_VAR]: "1" }, HOST_TOTAL_BYTES)).toBeNull();
    // Disabled wins over an explicit override — a disabled ceiling is disabled.
    expect(
      resolveRunMemoryCeilingMb(
        { [RUN_MEMORY_CEILING_DISABLED_ENV_VAR]: "1", [RUN_MEMORY_CEILING_ENV_VAR]: "512" },
        HOST_TOTAL_BYTES,
      ),
    ).toBeNull();
  });

  it("never returns a non-positive ceiling on a host smaller than the reserve", () => {
    expect(resolveRunMemoryCeilingMb({}, 1024 * 1024 * 1024)).toBeNull();
  });
});

const hasUserSystemdScopes = (() => {
  if (process.platform !== "linux") return false;
  try {
    fsSync.accessSync("/run/systemd/system");
  } catch {
    return false;
  }
  try {
    return fsSync
      .readFileSync(`/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/cgroup.controllers`, "utf8")
      .includes("memory");
  } catch {
    return false;
  }
})();

describe.skipIf(!hasUserSystemdScopes)("runChildProcess memory ceiling wiring (AUR-4536)", () => {
  // Prints the child's OWN cgroup path, and the kernel limits on that cgroup as
  // read BY THE CHILD ITSELF. Reading them from the test process instead would
  // race `--collect`, which tears the transient scope down the instant the child
  // exits (observed: ENOENT on memory.max). If the ceiling is wired at the spawn
  // boundary the path is a transient systemd scope; if it is not wired the child
  // simply inherits this test runner's cgroup.
  const PRINT_CGROUP = [
    "-e",
    [
      "const fs=require('node:fs');",
      "const p=fs.readFileSync('/proc/self/cgroup','utf8').trim().replace(/^0::/,'');",
      "const read=(f)=>{try{return fs.readFileSync('/sys/fs/cgroup'+p+'/'+f,'utf8').trim()}catch(e){return 'ENOENT'}};",
      "process.stdout.write(JSON.stringify({path:p,memoryMax:read('memory.max'),swapMax:read('memory.swap.max')}));",
    ].join(""),
  ];

  async function runPrintingCgroup(memoryCeilingMb: number | null) {
    const result = await runChildProcess(randomUUID(), process.execPath, PRINT_CGROUP, {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 20,
      graceSec: 1,
      onLog: async () => {},
      memoryCeilingMb,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.trim()) as { path: string; memoryMax: string; swapMax: string };
  }

  // systemd names transient scopes run-u<decimal>.scope (sequential bus id),
  // run-r<hex>.scope (random id — what GitHub Actions' systemd produces), or
  // run-<pid>.scope, depending on how the unit name was allocated.
  const TRANSIENT_RUN_SCOPE = /\/run-[ur]?[0-9a-f]+\.scope$/;

  it("places the real child in a transient scope whose memory.max IS the ceiling", async () => {
    const ceilingMb = 128;
    const seen = await runPrintingCgroup(ceilingMb);

    // The child is in its own transient run-*.scope, not the runner's cgroup.
    expect(seen.path).toMatch(TRANSIENT_RUN_SCOPE);
    // The ceiling is a real kernel limit on that cgroup, not just an argv string.
    expect(seen.memoryMax).toBe(String(ceilingMb * 1024 * 1024));
    // MemorySwapMax=0 makes the ceiling a hard kill instead of swap thrashing.
    expect(seen.swapMax).toBe("0");
  }, 30_000);

  it("mutation control: memoryCeilingMb null leaves the child unceilinged", async () => {
    const seen = await runPrintingCgroup(null);
    expect(seen.path).not.toMatch(TRANSIENT_RUN_SCOPE);
    // ...and inherits no 128 MB limit from anywhere else — proving the assertion
    // above is measuring the ceiling and not some ambient host configuration.
    expect(seen.memoryMax).not.toBe(String(128 * 1024 * 1024));
  }, 30_000);

  it("a child exceeding the ceiling is killed; the same child under a higher ceiling is not", async () => {
    // Allocate ~180 MB of non-collectable buffer, then exit 0.
    const BALLOON = [
      "-e",
      "const b=[];for(let i=0;i<180;i++){b.push(Buffer.alloc(1024*1024,i%251))}process.stdout.write('ALLOCATED '+b.length)",
    ];
    const run = (memoryCeilingMb: number | null) =>
      runChildProcess(randomUUID(), process.execPath, BALLOON, {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        onLog: async () => {},
        memoryCeilingMb,
      });

    // 96 MB ceiling < ~180 MB balloon + node baseline => cgroup OOM-kills it.
    const killed = await run(96);
    expect(killed.exitCode).not.toBe(0);
    expect(killed.stdout).not.toContain("ALLOCATED");

    // Mutation control: identical child, ceiling disabled => completes normally.
    // This is what proves the KILL above came from the ceiling and not from the
    // balloon simply being unable to run in this environment.
    const survived = await run(null);
    expect(survived.exitCode).toBe(0);
    expect(survived.stdout).toContain("ALLOCATED 180");
  }, 60_000);
});
