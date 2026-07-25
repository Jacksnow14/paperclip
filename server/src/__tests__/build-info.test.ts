import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBuildInfo } from "../build-info.js";

describe("readBuildInfo (AUR-3937)", () => {
  const originalEnv = process.env.PAPERCLIP_BUILD_INFO;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "build-info-test-"));
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PAPERCLIP_BUILD_INFO;
    else process.env.PAPERCLIP_BUILD_INFO = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a release build from build-info.json", () => {
    const infoPath = path.join(tmpDir, "build-info.json");
    writeFileSync(
      infoPath,
      JSON.stringify({
        sha: "0123456789abcdef0123456789abcdef01234567",
        ref: "origin/master",
        builtAt: "2026-07-25T00:00:00Z",
      }),
    );
    process.env.PAPERCLIP_BUILD_INFO = infoPath;
    expect(readBuildInfo()).toEqual({
      source: "release",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "origin/master",
      builtAt: "2026-07-25T00:00:00Z",
    });
  });

  it("reports untracked when no build-info file exists", () => {
    process.env.PAPERCLIP_BUILD_INFO = path.join(tmpDir, "does-not-exist.json");
    expect(readBuildInfo()).toEqual({ source: "untracked", sha: null, ref: null, builtAt: null });
  });

  it("reports untracked for malformed or non-sha content", () => {
    const infoPath = path.join(tmpDir, "bad.json");
    writeFileSync(infoPath, JSON.stringify({ sha: "not-a-sha" }));
    process.env.PAPERCLIP_BUILD_INFO = infoPath;
    expect(readBuildInfo().source).toBe("untracked");

    writeFileSync(infoPath, "{ not json");
    expect(readBuildInfo().source).toBe("untracked");
  });
});
