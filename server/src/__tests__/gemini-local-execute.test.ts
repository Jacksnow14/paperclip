import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";

async function writeFakeGeminiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
  geminiCliTrustWorkspace: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "gemini-session-1",
  model: "gemini-2.5-pro",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "gemini-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFailingGeminiCommand(
  commandPath: string,
  options: {
    stdoutLines?: Array<Record<string, unknown>>;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  },
): Promise<void> {
  const stdoutLines = options.stdoutLines ?? [];
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  const exit = options.exitCode ?? 1;
  const script = `#!/usr/bin/env node
for (const line of ${JSON.stringify(stdoutLines.map((line) => JSON.stringify(line)))}) {
  console.log(line);
}
if (${JSON.stringify(stdout)}) {
  process.stdout.write(${JSON.stringify(stdout)});
}
if (${JSON.stringify(stderr)}) {
  console.error(${JSON.stringify(stderr)});
}
process.exit(${exit});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
  geminiCliTrustWorkspace: string | null;
};

describe("gemini execute", () => {
  it("passes prompt via --prompt and injects paperclip env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--output-format");
      expect(capture.argv).toContain("stream-json");
      expect(capture.argv).toContain("--prompt");
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(promptArg).toContain("Follow the paperclip heartbeat.");
      expect(promptArg).toContain("Paperclip runtime note:");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(invocationPrompt).toContain("Paperclip runtime note:");
      expect(invocationPrompt).toContain("PAPERCLIP_API_URL");
      expect(invocationPrompt).toContain("Paperclip API access note:");
      expect(invocationPrompt).toContain("run_shell_command");
      expect(result.question).toBeNull();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("always passes --approval-mode yolo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-yolo-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-yolo",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(capture.argv).not.toContain("--policy");
      expect(capture.argv).not.toContain("--allow-all");
      expect(capture.argv).not.toContain("--allow-read");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // AUR-5165 AC1/AC3: gemini-cli only trusts folders listed in
  // ~/.gemini/trustedFolders.json (just $HOME by default). Every Paperclip
  // workspace path is outside that list, so without GEMINI_CLI_TRUST_WORKSPACE
  // the CLI silently downgrades --approval-mode yolo to default and blocks on
  // approval. The env var used to be set only when executionTargetIsRemote was
  // true, so every local run (the common case, and the one this issue
  // reproduced) never got it. This assertion FAILS on that prior gating and
  // PASSES with the fix, proving the guard both ways per the artifact
  // provenance doctrine.
  it("sets GEMINI_CLI_TRUST_WORKSPACE=true for local execution, not just remote targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-trust-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-trust",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.geminiCliTrustWorkspace).toBe("true");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // AUR-5165 AC2: gemini-cli's untrusted-folder banner starts with a capital
  // letter ("YOLO mode is enabled...") and reads like a real log line, so it
  // used to win selectFatalStderrLine's "first non-noise line" pick over the
  // actual fatal line ("Gemini CLI is not running in a trusted directory...")
  // two lines below it. Every failure in this shape read as a YOLO problem and
  // the real cause never surfaced. This is the exact stderr gemini-cli 0.54.0
  // emits, reproduced verbatim from the issue.
  it("surfaces the untrusted-directory failure instead of the harmless YOLO banner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-untrusted-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: [
        "YOLO mode is enabled. All tool calls will be automatically approved.",
        'Approval mode overridden to "default" because the current folder is not trusted.',
        "Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`,",
        "set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory...",
      ].join("\n"),
      exitCode: 1,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-untrusted",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("not running in a trusted directory");
      expect(result.errorMessage).not.toContain("YOLO mode is enabled");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes turn-limit exhaustion into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-max-turns-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          status: "turn_limit",
          error: "Turn limit reached.",
        },
      ],
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-turn-limit",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("max_turns_exhausted");
      expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
      expect(result.clearSession).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes Gemini exit code 53 as max-turn exhaustion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-exit-53-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: "Gemini stopped because the max turns limit was reached.",
      exitCode: 53,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-exit-53",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(53);
      expect(result.errorCode).toBe("max_turns_exhausted");
      expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
      expect(result.clearSession).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not normalize unstructured turn-limit text into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-max-turn-text-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          error: "Tool output said: maximum turns reached.",
        },
      ],
      stdout: "attacker-controlled transcript mentions turn limit reached\n",
      stderr: "Gemini stopped because the max turns limit was reached.",
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-turn-limit-text",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).not.toBe("max_turns_exhausted");
      expect(result.resultJson?.stopReason).not.toBe("max_turns_exhausted");
      expect(result.clearSession).toBe(false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a compact wake delta instead of the full heartbeat prompt when resuming a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-resume-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-resume",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "gemini-session-1",
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 1,
              includedCount: 1,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(capture.argv).toContain("--resume");
      expect(capture.argv).toContain("gemini-session-1");
      expect(promptArg).toContain("## Paperclip Resume Delta");
      expect(promptArg).toContain("Do not switch to another issue until you have handled this wake.");
      expect(promptArg).toContain("Second comment");
      expect(promptArg).not.toContain("Follow the paperclip heartbeat.");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // AUR-4038: gemini-cli wrote a cosmetic "256-color support not detected"
  // warning to stderr alongside the fatal IneligibleTierError. Picking the
  // wrong stderr line masked a 100% adapter outage for 24h+ because every
  // recorded run error looked like a terminal-settings issue. Prove the fix
  // holds regardless of which side of the fatal line the warning lands on.
  it("prefers the fatal auth error over a trailing 256-color warning and includes the exit code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-noise-after-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: [
        "Error authenticating: IneligibleTierError: This client is no longer supported for",
        "Gemini Code Assist for individuals.",
        "Warning: 256-color support not detected. Using a terminal with at least 256-color",
        "support is recommended for a better visual experience.",
      ].join("\n"),
      exitCode: 55,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-noise-after",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(55);
      expect(result.errorMessage).toContain("IneligibleTierError");
      expect(result.errorMessage).toContain("exit code 55");
      expect(result.errorMessage).not.toContain("256-color");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the fatal auth error over a leading 256-color warning (the AUR-4038 stderr order)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-noise-before-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: [
        "Warning: 256-color support not detected. Using a terminal with at least 256-color",
        "support is recommended for a better visual experience.",
        "Error authenticating: IneligibleTierError: This client is no longer supported for",
        "Gemini Code Assist for individuals.",
      ].join("\n"),
      exitCode: 55,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-noise-before",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(55);
      expect(result.errorMessage).toContain("IneligibleTierError");
      expect(result.errorMessage).toContain("exit code 55");
      expect(result.errorMessage).not.toContain("256-color");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // AUR-4531 AC7. `detectGeminiQuotaExhausted` shipped with NO non-test caller at all, so a
  // gemini quota wall produced a plain `adapter_failed` run: no errorFamily, therefore
  // heartbeat's readTransientRecoveryContractFromRun returned null, therefore no bounded
  // retry, no quota pause and no breaker. Every wake walked straight back into the wall.
  //
  // Asserting on `errorFamily` / `resultJson.errorFamily` specifically because that is what
  // heartbeat actually reads (readHeartbeatRunErrorFamily consults resultJson.errorFamily
  // first, then the errorCode allowlist) -- a test that only asserted errorCode would pass
  // while the retry contract stayed unreachable.
  it("wires detectGeminiQuotaExhausted into the execute path and emits errorFamily transient_upstream", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-quota-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          status: "error",
          error:
            "[429 Too Many Requests] You exceeded your current quota. " +
            'details: [{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"57s"}]',
        },
      ],
      exitCode: 1,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const before = Date.now();
      const result = await execute({
        runId: "run-gemini-quota",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorCode).toBe("gemini_transient_upstream");
      // The persisted copy is the one heartbeat reads off the run row.
      expect(result.resultJson).toMatchObject({ errorFamily: "transient_upstream" });

      // The RetryInfo duration must become a concrete instant, otherwise the breaker has no
      // lifetime to key on and Defect B degrades back to the bounded ladder.
      expect(result.retryNotBefore).toBeTruthy();
      const retryNotBefore = new Date(result.retryNotBefore!).getTime();
      expect(retryNotBefore).toBeGreaterThanOrEqual(before + 57_000);
      expect(retryNotBefore).toBeLessThan(Date.now() + 60_000);
      expect(result.resultJson?.transientRetryNotBefore).toBe(result.retryNotBefore);

      // The wall is not a session problem: clearing the session would throw away context
      // for a failure that has nothing to do with it.
      expect(result.clearSession).toBe(false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Control for the classifier above: an auth wall is DETERMINISTIC and must never be
  // dressed up as transient, even though quota-ish billing wording sits right next to it in
  // real gemini output. Without this, the AC7 test would also pass on a build that simply
  // tagged every failure transient.
  it("does not tag a gemini auth wall as transient_upstream", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-quota-auth-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: "Error: unauthorized - please authenticate. Check your billing details.",
      exitCode: 41,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-gemini-quota-auth",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.errorCode).toBe("gemini_auth_required");
      expect(result.errorFamily ?? null).toBeNull();
      expect(result.resultJson?.errorFamily).toBeUndefined();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Control for the stdout-exclusion decision in the execute path: gemini stdout is the
  // assistant transcript. AUR-4513 (2,394 mis-tagged claude runs) is what happens when a
  // transient classifier reads the conversation it is resuming.
  it("does not tag a failure transient when the quota wording appears only in the stdout transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-quota-stdout-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "output_text",
                text: "LANE HEALTH: gemini returned 429 Too Many Requests and we exceeded your current quota on the shared key.",
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          status: "error",
          error: "Tool call rejected by policy",
        },
      ],
      stderr: "Error: tool call rejected by policy",
      exitCode: 1,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-gemini-quota-stdout",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorFamily ?? null).toBeNull();
      expect(result.errorCode).not.toBe("gemini_transient_upstream");
      expect(result.resultJson?.errorFamily).toBeUndefined();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
