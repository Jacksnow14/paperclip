/**
 * Regression tests for LAR-479: claude_local PATH hardening for user-local installs.
 *
 * The Paperclip server process may start without a fully-sourced user shell,
 * leaving ~/.local/bin absent from process.env.PATH even when the Claude CLI
 * lives there. These tests verify that execute() successfully resolves the
 * command in that situation.
 */
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, prepareClaudePromptBundle } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "result", session_id: "s1", result: "hi", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  prepareClaudePromptBundle: vi.fn(async () => ({
    addDir: "/tmp/skills",
    bundleKey: "bundle-test",
    instructionsFilePath: null,
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

vi.mock("./prompt-cache.js", async () => {
  const actual = await vi.importActual<typeof import("./prompt-cache.js")>("./prompt-cache.js");
  return { ...actual, prepareClaudePromptBundle };
});

import { execute } from "./execute.js";

describe("claude_local PATH hardening for user-local installs", () => {
  let rootDir: string;
  let homeDir: string;
  let localBinDir: string;
  let claudeBin: string;
  let workspaceDir: string;
  let savedHome: string | undefined;
  let savedPath: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-path-"));
    homeDir = path.join(rootDir, "home");
    localBinDir = path.join(homeDir, ".local", "bin");
    claudeBin = path.join(localBinDir, "claude");
    workspaceDir = path.join(rootDir, "workspace");

    await mkdir(localBinDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    // Write a minimal fake claude binary
    await writeFile(
      claudeBin,
      "#!/bin/sh\necho '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\"}'\n",
    );
    await chmod(claudeBin, 0o755);

    savedHome = process.env.HOME;
    savedPath = process.env.PATH;

    // Simulate a server process PATH that omits ~/.local/bin
    process.env.HOME = homeDir;
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(rootDir, { recursive: true, force: true });
  });

  it("resolves a claude binary in ~/.local/bin even when PATH omits that directory", async () => {
    // PATH is /usr/local/bin:/usr/bin:/bin — does NOT include ~/.local/bin
    // claude lives at $HOME/.local/bin/claude
    // execute() should augment PATH and succeed
    const result = await execute({
      runId: "run-path-test",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspaceDir,
      },
      context: {},
      onLog: async () => {},
    });

    // The run should succeed — runChildProcess must be called, meaning
    // ensureAdapterExecutionTargetCommandResolvable found the binary in the
    // augmented PATH (which now includes ~/.local/bin).
    expect(runChildProcess).toHaveBeenCalled();
    if (result.errorMessage != null) {
      expect(result.errorMessage).not.toMatch(/Command not found in PATH/i);
    }
  });
});
