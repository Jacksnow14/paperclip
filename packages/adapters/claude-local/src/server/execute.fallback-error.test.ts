import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// AUR-4598 (carried from the AUR-4557 adversarial review): parseFallbackErrorMessage
// used to take the FIRST non-empty stderr line via `.find(Boolean)`. When the CLI
// prints a banner/warning before the real failure, that buries the actual API
// rejection behind boilerplate the caller never sees.
const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "not json",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

describe("claude-local fallback error message (AUR-4598)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runWithStderr(stderr: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-fallback-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "not json",
      stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    return execute({
      runId: "run-fallback-error",
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
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });
  }

  it("FIRE: reflects the real error line, not a leading CLI banner", async () => {
    const result = await runWithStderr(
      [
        "(node:12345) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
        "API Error: 529 Overloaded",
      ].join("\n"),
    );

    expect(result.errorMessage).toContain("API Error: 529 Overloaded");
    expect(result.errorMessage).not.toContain("DeprecationWarning");
  });

  // Control: a single-line stderr must still surface unchanged.
  it("PASS: a single-line stderr is still used as-is", async () => {
    const result = await runWithStderr("API Error: 529 Overloaded");

    expect(result.errorMessage).toContain("API Error: 529 Overloaded");
  });
});
