import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("codex remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: codexHomeDir,
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/codex/home`,
      followSymlinks: true,
    }));

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    runChildProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "session-123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    runChildProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "session-123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("rotates to a fresh session and clears the persisted session when a resumed run returns no progress", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-no-progress-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    const emptyRun = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    };
    runChildProcess.mockResolvedValueOnce(emptyRun).mockResolvedValueOnce(emptyRun);

    const result = await execute({
      runId: "run-no-progress",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-stale",
        sessionParams: {
          sessionId: "session-stale",
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-stale",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
        cwd: workspaceDir,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const firstCall = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[]]
      | undefined;
    const secondCall = runChildProcess.mock.calls[1] as unknown as
      | [string, string, string[]]
      | undefined;
    expect(firstCall?.[2]).toEqual(["exec", "--json", "resume", "session-stale", "-"]);
    expect(secondCall?.[2]).toEqual(["exec", "--json", "-"]);
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).toBeNull();
  });

  it("drops the persisted session when a resumed run times out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-resume-timeout-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    runChildProcess.mockResolvedValueOnce({
      exitCode: 143,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 124,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-resume-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-hung",
        sessionParams: {
          sessionId: "session-hung",
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-hung",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
        cwd: workspaceDir,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(true);
    expect(result.clearSession).toBe(true);
  });
});
