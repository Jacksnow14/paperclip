import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "agy"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function successStdout(conversationId: string, response: string): string {
  return [
    `{"event":"init","conversation_id":"${conversationId}","init":{"cwd":"/tmp","tools":[],"permission_mode":"always-proceed"}}`,
    `{"event":"result","result":{"conversation_id":"${conversationId}","status":"SUCCESS","response":"${response}","num_turns":1,"usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":5,"cache_read_tokens":40,"total_tokens":125}}}`,
  ].join("\n");
}

function makeCtx(root: string, overrides: {
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
} = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Junior Coder" },
    runtime: { sessionId: null, sessionParams: null, ...(overrides.runtime ?? {}) },
    config: { cwd: root, ...(overrides.config ?? {}) },
    context: {},
    onLog: async () => {},
    onSpawn: async () => {},
    authToken: "token-1",
  } as unknown as AdapterExecutionContext;
}

describe("antigravity_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("invokes agy in headless stream-json mode and returns session + usage", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: successStdout("conv-1", "done"),
      stderr: "",
    });

    const result = await execute(makeCtx(root, { config: { model: "gemini-3.6-flash-high" } }));

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    const [, , command, args] = runProcessMock.mock.calls[0];
    expect(command).toBe("agy");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--print-timeout");
    expect(args[args.length - 2]).toBe("--print");
    expect(args.slice(args.indexOf("--model"))[1]).toBe("gemini-3.6-flash-high");
    expect(args).not.toContain("--conversation");

    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("conv-1");
    expect(result.summary).toBe("done");
    expect(result.provider).toBe("google");
    expect(result.billingType).toBe("subscription");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25, cachedInputTokens: 40 });
  });

  it("resumes a saved conversation when the cwd matches", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: successStdout("conv-2", "resumed"),
      stderr: "",
    });

    await execute(makeCtx(root, {
      runtime: { sessionId: "conv-2", sessionParams: { sessionId: "conv-2", cwd: root } },
    }));

    const [, , , args] = runProcessMock.mock.calls[0];
    const conversationFlag = args.indexOf("--conversation");
    expect(conversationFlag).toBeGreaterThan(-1);
    expect(args[conversationFlag + 1]).toBe("conv-2");
  });

  it("retries with a fresh conversation when the saved one is unknown", async () => {
    const root = await makeTempRoot();
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "error: conversation conv-3 not found",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: successStdout("conv-4", "fresh"),
        stderr: "",
      });

    const result = await execute(makeCtx(root, {
      runtime: { sessionId: "conv-3", sessionParams: { sessionId: "conv-3", cwd: root } },
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const [, , , retryArgs] = runProcessMock.mock.calls[1];
    expect(retryArgs).not.toContain("--conversation");
    expect(result.sessionId).toBe("conv-4");
    expect(result.errorMessage).toBeNull();
  });

  it("stages instructions as AGENTS.md, references them in the prompt, and cleans up", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "instructions.md");
    await fs.writeFile(instructionsPath, "# Role\nBe helpful.");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    let promptSeen = "";
    let stagedDuringRun = false;
    runProcessMock.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) => {
      promptSeen = args[args.length - 1];
      stagedDuringRun = await pathExists(path.join(workspace, "AGENTS.md"));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: successStdout("conv-5", "ok"),
        stderr: "",
      };
    });

    await execute(makeCtx(workspace, { config: { cwd: workspace, instructionsFilePath: instructionsPath } }));

    expect(stagedDuringRun).toBe(true);
    expect(promptSeen).toContain("Role instructions note:");
    expect(promptSeen).toContain(path.join(workspace, "AGENTS.md"));
    expect(await pathExists(path.join(workspace, "AGENTS.md"))).toBe(false);
  });

  it("reports failure with the parsed error when status is not SUCCESS", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `{"event":"result","result":{"conversation_id":"conv-6","status":"FAILED","response":""}}`,
      stderr: "",
    });

    const result = await execute(makeCtx(root));
    expect(result.errorMessage).toMatch(/status FAILED/);
  });
});
