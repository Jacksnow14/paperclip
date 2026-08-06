import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFilterArgs,
  clampNodeOptions,
  computeCgroupHeadroomMB,
  decideExecutionPlan,
  evaluateMemoryGate,
  mapChangedFilesToPackages,
  parseCgroupMemoryCurrentMB,
  parseCgroupMemoryMaxMB,
  parseCgroupV1MemoryPath,
  parseCgroupV2LeafPath,
  parseResolvedPackageDirs,
  parseWorkspaceGlobs,
  readMemAvailableMB,
  resolvePackageForFile,
  selectMemoryFloor,
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

test("evaluateMemoryGate: changed-mode refusal does not advise re-running the command just run", () => {
  const gate = evaluateMemoryGate(900, 1200, { mode: "changed" });
  assert.equal(gate.ok, false);
  assert.match(gate.message, /insufficient memory: 900 MB available, need 1200 MB\./);
  assert.doesNotMatch(gate.message, /typecheck:changed/);
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

test("mapChangedFilesToPackages: unmappable subdirectory paths are reported, not silently dropped", () => {
  const packageDirs = ["server", "packages/shared"];
  const { packages, rootLevelChange, unmapped } = mapChangedFilesToPackages(
    ["doc/plans/foo.md", "scripts/x.mjs", "packages/shared/src/y.ts"],
    packageDirs,
  );
  assert.deepEqual(packages, ["packages/shared"]);
  assert.equal(rootLevelChange, false);
  assert.deepEqual(unmapped, ["doc/plans/foo.md", "scripts/x.mjs"]);
});

test("buildFilterArgs: uses a LEADING ... (package plus dependents), never trailing", () => {
  const nameByDir = new Map([
    ["packages/shared", "@paperclipai/shared"],
    ["server", "@paperclipai/server"],
  ]);
  assert.deepEqual(buildFilterArgs(["packages/shared", "server"], nameByDir), [
    "--filter",
    "...@paperclipai/shared",
    "--filter",
    "...@paperclipai/server",
  ]);
});

test("parseResolvedPackageDirs: maps pnpm ls --json absolute paths to workspace-relative dirs", () => {
  const json = JSON.stringify([
    { name: "@paperclipai/shared", path: "/repo/packages/shared" },
    { name: "@paperclipai/server", path: "/repo/server" },
  ]);
  assert.deepEqual(parseResolvedPackageDirs(json, "/repo"), ["packages/shared", "server"]);
});

test("parseResolvedPackageDirs: rejects non-array pnpm ls output", () => {
  assert.throws(() => parseResolvedPackageDirs('{"error": "x"}', "/repo"));
});

test("selectMemoryFloor: small server-free resolved set gets the lower floor", () => {
  assert.equal(selectMemoryFloor(["packages/shared"]), 1200);
  assert.equal(selectMemoryFloor(["cli", "packages/shared", "ui"]), 1200);
});

test("selectMemoryFloor: any resolved set containing server gets the full floor", () => {
  assert.equal(selectMemoryFloor(["server"]), 3000);
  assert.equal(selectMemoryFloor(["packages/shared", "server"]), 3000);
});

test("selectMemoryFloor: large or empty resolved sets get the full floor", () => {
  assert.equal(selectMemoryFloor(["a", "b", "c", "d"]), 3000);
  assert.equal(selectMemoryFloor([]), 3000);
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

// --- cgroup awareness (AUR-5012) ---------------------------------------

test("parseCgroupV2LeafPath: extracts the slice path from the '0::' line", () => {
  const text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u37800.scope\n";
  assert.equal(
    parseCgroupV2LeafPath(text),
    "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u37800.scope",
  );
});

test("parseCgroupV2LeafPath: returns null when there is no '0::' line (pure v1 host)", () => {
  const text = "5:memory:/user.slice\n4:cpu,cpuacct:/user.slice\n";
  assert.equal(parseCgroupV2LeafPath(text), null);
});

test("parseCgroupV1MemoryPath: finds the line whose controller list includes memory", () => {
  const text = "11:pids:/user.slice\n5:memory,hugetlb:/user.slice/user-1000.slice\n1:name=systemd:/\n";
  assert.equal(parseCgroupV1MemoryPath(text), "/user.slice/user-1000.slice");
});

test("parseCgroupV1MemoryPath: returns null when no controller line lists memory", () => {
  const text = "11:pids:/user.slice\n1:name=systemd:/\n";
  assert.equal(parseCgroupV1MemoryPath(text), null);
});

test("parseCgroupMemoryMaxMB: v2 numeric bytes convert to MB, floored", () => {
  assert.equal(parseCgroupMemoryMaxMB("1224736768\n"), 1168);
});

test("parseCgroupMemoryMaxMB: v2 literal 'max' means unlimited (null)", () => {
  assert.equal(parseCgroupMemoryMaxMB("max\n"), null);
});

test("parseCgroupMemoryMaxMB: v1 huge sentinel means unlimited (null)", () => {
  assert.equal(parseCgroupMemoryMaxMB("9223372036854771712\n"), null);
});

test("parseCgroupMemoryMaxMB: missing/empty/garbage text is null, not a crash", () => {
  assert.equal(parseCgroupMemoryMaxMB(""), null);
  assert.equal(parseCgroupMemoryMaxMB(undefined), null);
  assert.equal(parseCgroupMemoryMaxMB("not-a-number\n"), null);
});

test("parseCgroupMemoryCurrentMB: numeric bytes convert to MB, floored", () => {
  assert.equal(parseCgroupMemoryCurrentMB("472846336\n"), 450);
});

test("parseCgroupMemoryCurrentMB: garbage text is null", () => {
  assert.equal(parseCgroupMemoryCurrentMB("max\n"), null);
});

test("computeCgroupHeadroomMB: max minus current, floored at 0", () => {
  assert.equal(computeCgroupHeadroomMB(1168, 450), 718);
  assert.equal(computeCgroupHeadroomMB(1168, 1168), 0);
  assert.equal(computeCgroupHeadroomMB(1168, 1300), 0);
});

test("computeCgroupHeadroomMB: either reading missing propagates null (no constraint), not a false 0", () => {
  assert.equal(computeCgroupHeadroomMB(null, 450), null);
  assert.equal(computeCgroupHeadroomMB(1168, null), null);
});

test("decideExecutionPlan: runs in-process when both host and cgroup clear the floor", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 5000,
    floorMB: 1200,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "run");
  assert.equal(plan.effectiveAvailableMB, 4400);
});

test("decideExecutionPlan: no cgroup reading falls back to host-only behaviour (AUR-4064 parity)", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: null,
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "run");
  assert.equal(plan.effectiveAvailableMB, 4400);
});

test("decideExecutionPlan: relaunches into a sized scope when cgroup headroom is the binding constraint (AC1 shape)", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 718, // this host's measured headroom inside the 1168 MB memcg
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "relaunch");
  assert.equal(plan.sizedMB, 3500);
});

test("decideExecutionPlan: caps the relaunch scope size at host MemAvailable, never exceeding it", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 3200,
    cgroupHeadroomMB: 718,
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "relaunch");
  assert.equal(plan.sizedMB, 3200);
});

test("decideExecutionPlan: refuses without relaunching when host memory itself is the constraint (AC2-adjacent)", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 2000,
    cgroupHeadroomMB: 718,
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "refuse");
  assert.equal(plan.reason, "host");
});

test("decideExecutionPlan: AC2 control — already-scoped sentinel refuses instead of recursing", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 718,
    floorMB: 3000,
    alreadyScoped: true,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "refuse");
  assert.equal(plan.reason, "cgroup");
});

test("decideExecutionPlan: AC2 control — systemd-run unavailable refuses instead of relaunching", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 718,
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: false,
  });
  assert.equal(plan.action, "refuse");
  assert.equal(plan.reason, "cgroup");
});

test("decideExecutionPlan: AC4 — a small (non-server) changed set does not relaunch when cgroup headroom is ample", () => {
  const smallSetPlan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 1500, // a lighter/fresher run than this host's current session
    floorMB: 1200, // CHANGED_MODE_MEMORY_FLOOR_MB
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(smallSetPlan.action, "run");

  // Same headroom, but a server-inclusive (full) floor still can't clear it —
  // proves the decision discriminates on the actual floor, not a blanket
  // "small sets never relaunch" shortcut.
  const fullSetPlan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 1500,
    floorMB: 3000,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(fullSetPlan.action, "relaunch");
});

test("decideExecutionPlan: AC4 — a small changed set still relaunches (not refuses-silently) under genuinely tight cgroup headroom", () => {
  const plan = decideExecutionPlan({
    hostAvailableMB: 4400,
    cgroupHeadroomMB: 718, // this host's actual measured headroom mid-session
    floorMB: 1200,
    alreadyScoped: false,
    systemdAvailable: true,
  });
  assert.equal(plan.action, "relaunch");
});
