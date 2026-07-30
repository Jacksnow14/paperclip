import assert from "node:assert/strict";
import test from "node:test";

import {
  clampNodeOptions,
  evaluateMemoryGate,
  readMemAvailableMB,
  resolvePackageForFile,
  mapChangedFilesToPackages,
  parseWorkspaceGlobs,
} from "./typecheck.mjs";

test("clampNodeOptions: strips an inherited --max-old-space-size and preserves other flags", () => {
  const result = clampNodeOptions("--max-old-space-size=6144 --enable-source-maps");
  assert.equal(result, "--enable-source-maps --max-old-space-size=3072");
});

test("clampNodeOptions: empty/absent NODE_OPTIONS yields the clamp alone", () => {
  assert.equal(clampNodeOptions(""), "--max-old-space-size=3072");
  assert.equal(clampNodeOptions(undefined), "--max-old-space-size=3072");
});

test("clampNodeOptions: preserves multiple other flags, still forces 3072", () => {
  const result = clampNodeOptions("--enable-source-maps --max-old-space-size=8192 --trace-warnings");
  assert.equal(result, "--enable-source-maps --trace-warnings --max-old-space-size=3072");
});

test("evaluateMemoryGate: refuses below the floor with the actionable message", () => {
  const gate = evaluateMemoryGate(2446, 3000);
  assert.equal(gate.ok, false);
  assert.equal(
    gate.message,
    "insufficient memory: 2446 MB available, need 3000 MB. Run 'pnpm typecheck:changed' to check only your touched packages, or retry when the host is quieter.",
  );
});

test("evaluateMemoryGate: allows above the floor", () => {
  const gate = evaluateMemoryGate(4400, 3000);
  assert.equal(gate.ok, true);
  assert.equal(gate.message, null);
});

test("readMemAvailableMB: parses /proc/meminfo MemAvailable in kB to MB", () => {
  const meminfo = "MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4534892 kB\n";
  assert.equal(readMemAvailableMB(meminfo), Math.floor(4534892 / 1024));
});

test("resolvePackageForFile: longest-prefix match, not first match", () => {
  const packageDirs = ["server", "packages/adapters/claude-local", "packages/adapters/claude-local-extra"];
  assert.equal(resolvePackageForFile("server/src/foo.ts", packageDirs), "server");
  assert.equal(
    resolvePackageForFile("packages/adapters/claude-local/src/x.ts", packageDirs),
    "packages/adapters/claude-local",
  );
  assert.equal(
    resolvePackageForFile("packages/adapters/claude-local-extra/src/x.ts", packageDirs),
    "packages/adapters/claude-local-extra",
  );
});

test("resolvePackageForFile: no match returns null", () => {
  assert.equal(resolvePackageForFile("doc/plans/foo.md", ["server", "packages/shared"]), null);
});

test("mapChangedFilesToPackages: maps files to owning packages", () => {
  const packageDirs = ["server", "packages/adapters/claude-local", "packages/shared"];
  const { packages, rootLevelChange } = mapChangedFilesToPackages(
    ["server/src/foo.ts", "packages/adapters/claude-local/src/x.ts", "packages/shared/src/y.ts"],
    packageDirs,
  );
  assert.deepEqual(packages, ["packages/adapters/claude-local", "packages/shared", "server"]);
  assert.equal(rootLevelChange, false);
});

test("mapChangedFilesToPackages: a root-level file triggers full-run fallback", () => {
  const packageDirs = ["server", "packages/shared"];
  const { packages, rootLevelChange } = mapChangedFilesToPackages(
    ["tsconfig.base.json", "server/src/foo.ts"],
    packageDirs,
  );
  assert.equal(rootLevelChange, true);
  assert.deepEqual(packages, ["server"]);
});

test("mapChangedFilesToPackages: a non-package subdirectory file is ignored, not a root-level fallback", () => {
  const packageDirs = ["server", "packages/shared"];
  const { packages, rootLevelChange } = mapChangedFilesToPackages(["doc/plans/foo.md", "scripts/x.mjs"], packageDirs);
  assert.deepEqual(packages, []);
  assert.equal(rootLevelChange, false);
});

test("parseWorkspaceGlobs: reads the packages: list from pnpm-workspace.yaml, ignoring comments", () => {
  const yaml = [
    "packages:",
    "  - packages/*",
    "  - packages/adapters/*",
    "  # a comment line",
    '  - "!packages/plugins/sandbox-providers/**"',
    "  - server",
    "  - ui",
  ].join("\n");
  assert.deepEqual(parseWorkspaceGlobs(yaml), [
    "packages/*",
    "packages/adapters/*",
    "!packages/plugins/sandbox-providers/**",
    "server",
    "ui",
  ]);
});
