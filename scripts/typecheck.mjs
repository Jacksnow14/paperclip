#!/usr/bin/env node
// Memory-safe workspace typecheck runner (AUR-3545 / AUR-4064).
//
// This host OOMs when `pnpm -r typecheck` fans 26 packages across 4 parallel
// workers (>5 GB concurrent demand vs ~2.4-4.4 GB available) — the kernel
// reaps the biggest child silently, producing zero cost events. Measured
// 2026-07-25: server `tsc --noEmit` peaks at 2529 MB RSS and completes in 42s
// at --max-old-space-size=3072. Mirrors the proven precedent at
// scripts/deploy/build-release.sh:70-76 (serial + 3072 cap). Never raise the
// cap without re-measuring on this host — see the AUR-3924 OOM cluster.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OLD_SPACE_SIZE_MB = 3072;
const FULL_RUN_MEMORY_FLOOR_MB = 3000;
// Lower floor for --changed mode when the pnpm-resolved package set (the
// filter-expanded set that will actually run, not the changed set) excludes
// `server` (the only package measured above ~600 MB peak RSS). Still a real
// gate, not a bypass: packages/shared peaked at 515 MB, so 1200 MB leaves
// >2x headroom for a single serial `tsc` process.
const CHANGED_MODE_MEMORY_FLOOR_MB = 1200;
const CHANGED_MODE_SMALL_SET_LIMIT = 3;

// AUR-5012: AUR-4536 landed after AUR-4064 shipped this gate and now wraps
// every agent run in a transient systemd --user scope with a hard per-run
// memcg ceiling (1168 MB on the 7747 MB host this was derived on — see
// packages/adapter-utils/src/server-utils.ts's resolveRunMemoryCeilingMb).
// The gate above only reads HOST `MemAvailable`, so it green-lights a run
// the kernel then reaps at 1168 MB — the original AUR-3545 signature
// (process_lost, zero cost events) via a different mechanism. The floors
// above stay the HOST-side gate, unchanged; the constants and functions
// below add a SECOND, cgroup-side gate on top, using the SAME floors (a run
// must clear both the host floor and the cgroup floor to proceed in-process).
//
// Measured 2026-08-05: server `tsc --noEmit` only completes (exit 0, 62s,
// peak RSS 2489 MB) inside a `systemd-run --user --scope -p MemoryMax=3500M`
// with heap 3072 — that is the proven relaunch scope size. Never raise it
// without re-measuring; never touch server-utils.ts's per-run ceiling to
// "fix" this from the other side (AUR-4536 owns that number).
const RELAUNCH_SCOPE_MEMORY_MB = 3500;
// Recursion guard: set on the relaunched child's env so it never attempts to
// relaunch itself again, however tight its own cgroup headroom looks.
const RELAUNCH_SENTINEL_ENV_VAR = "PAPERCLIP_TYPECHECK_SCOPED";
// cgroup v1's memory.limit_in_bytes reports a huge sentinel (near LLONG_MAX,
// rounded to a page boundary) rather than the literal "max" string cgroup v2
// uses for "no limit". Any reading past this threshold (a petabyte — orders
// of magnitude beyond any real host) is treated as unlimited.
const CGROUP_V1_UNLIMITED_THRESHOLD_BYTES = 1e15;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export function clampNodeOptions(nodeOptionsEnv) {
  const raw = (nodeOptionsEnv ?? "").trim();
  const tokens = raw.length > 0 ? raw.split(/\s+/) : [];
  const kept = tokens.filter((token) => !/^--max-old-space-size=/.test(token));
  kept.push(`--max-old-space-size=${MAX_OLD_SPACE_SIZE_MB}`);
  return kept.join(" ");
}

export function evaluateMemoryGate(memAvailableMB, floorMB = FULL_RUN_MEMORY_FLOOR_MB, options = {}) {
  const { mode = "full" } = options;
  if (memAvailableMB < floorMB) {
    const advice =
      mode === "changed"
        ? "Retry when the host is quieter, or split your change so it touches fewer widely-depended-on packages."
        : "Run 'pnpm typecheck:changed' to check only your touched packages, or retry when the host is quieter.";
    return {
      ok: false,
      message: `insufficient memory: ${memAvailableMB} MB available, need ${floorMB} MB. ${advice}`,
    };
  }
  return { ok: true, message: null };
}

// --- cgroup awareness (AUR-5012) ---------------------------------------
//
// Pure parsing/decision functions below take injected text/readings so they
// can be unit-tested without manufacturing real memory pressure on a host.
// The IO wrappers that actually read /proc and /sys/fs/cgroup live further
// down, alongside the other real-filesystem helpers (currentMemAvailableMB
// etc.).

// cgroup v2: a single line "0::<slice-path>". Returns the slice path (e.g.
// "/user.slice/.../run-u123.scope") or null if this isn't a v2-only cgroup.
export function parseCgroupV2LeafPath(procSelfCgroupText) {
  for (const rawLine of (procSelfCgroupText ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("0::")) {
      const path = line.slice(3);
      return path.length > 0 ? path : null;
    }
  }
  return null;
}

// cgroup v1: one line per controller, "<hierarchy-id>:<controllers>:<path>".
// Finds the line whose comma-separated controller list includes "memory".
export function parseCgroupV1MemoryPath(procSelfCgroupText) {
  for (const rawLine of (procSelfCgroupText ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1].split(",");
    if (controllers.includes("memory")) {
      const path = parts.slice(2).join(":");
      return path.length > 0 ? path : null;
    }
  }
  return null;
}

// Handles cgroup v2's literal "max" (no limit) and v1's huge sentinel value
// for the same meaning. Returns null for "no limit" or an unparseable
// reading — both mean "this file imposes no additional constraint".
export function parseCgroupMemoryMaxMB(rawText) {
  const trimmed = (rawText ?? "").trim();
  if (trimmed === "" || trimmed === "max") return null;
  const bytes = Number(trimmed);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes >= CGROUP_V1_UNLIMITED_THRESHOLD_BYTES) return null;
  return Math.floor(bytes / (1024 * 1024));
}

export function parseCgroupMemoryCurrentMB(rawText) {
  const trimmed = (rawText ?? "").trim();
  const bytes = Number(trimmed);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return Math.floor(bytes / (1024 * 1024));
}

// null propagates "no cgroup constraint known" (unlimited max, or either
// reading missing/unparseable) rather than a false 0 that would refuse
// every run on a host where the cgroup files simply don't exist.
export function computeCgroupHeadroomMB(maxMB, currentMB) {
  if (maxMB === null || currentMB === null) return null;
  return Math.max(0, maxMB - currentMB);
}

// The single effective-limit / relaunch decision. Takes plain numbers (or
// null for "no cgroup reading") so every branch is unit-testable by
// injection, per AUR-3545's "inject the readings, don't manufacture real
// memory pressure" precedent.
//
// - cgroupHeadroomMB === null: no cgroup constraint (unreadable or
//   unlimited) — falls back to the host-only floor check, exactly AUR-4064's
//   original behaviour.
// - Both host AND cgroup must clear floorMB for "run" (in-process).
// - If only the cgroup reading is short, and a relaunch could plausibly fix
//   it (not already scoped, systemd-run available, and a scope sized off
//   the proven need would itself clear the floor), relaunch instead of
//   refusing.
// - Otherwise refuse — including when the HOST itself is short (a bigger
//   scope can never exceed real host memory, so relaunching cannot help).
export function decideExecutionPlan({
  hostAvailableMB,
  cgroupHeadroomMB,
  floorMB,
  alreadyScoped,
  systemdAvailable,
  scopeSizeMB = RELAUNCH_SCOPE_MEMORY_MB,
}) {
  const effectiveAvailableMB =
    cgroupHeadroomMB === null ? hostAvailableMB : Math.min(hostAvailableMB, cgroupHeadroomMB);

  if (effectiveAvailableMB >= floorMB) {
    return { action: "run", effectiveAvailableMB };
  }

  if (hostAvailableMB < floorMB) {
    // Host memory itself is the binding constraint. A relaunch scope can
    // never exceed real host memory, so it cannot help here.
    return { action: "refuse", effectiveAvailableMB, reason: "host" };
  }

  if (!alreadyScoped && systemdAvailable) {
    const sizedMB = Math.min(scopeSizeMB, hostAvailableMB);
    if (sizedMB >= floorMB) {
      return { action: "relaunch", sizedMB, effectiveAvailableMB, reason: "cgroup" };
    }
  }

  return { action: "refuse", effectiveAvailableMB, reason: "cgroup" };
}

export function readMemAvailableMB(meminfoText) {
  const match = meminfoText.match(/^MemAvailable:\s*(\d+)\s*kB$/m);
  if (!match) {
    throw new Error("could not find MemAvailable in /proc/meminfo output");
  }
  return Math.floor(Number(match[1]) / 1024);
}

export function resolvePackageForFile(filePath, packageDirs) {
  let best = null;
  for (const dir of packageDirs) {
    if (filePath === dir || filePath.startsWith(`${dir}/`)) {
      if (best === null || dir.length > best.length) {
        best = dir;
      }
    }
  }
  return best;
}

export function mapChangedFilesToPackages(changedFiles, packageDirs) {
  const packages = new Set();
  const unmapped = [];
  let rootLevelChange = false;
  for (const file of changedFiles) {
    const pkg = resolvePackageForFile(file, packageDirs);
    if (pkg) {
      packages.add(pkg);
    } else if (!file.includes("/")) {
      // A file living directly in the repo root (tsconfig.base.json,
      // package.json, pnpm-workspace.yaml, ...) can affect every package's
      // typecheck. Files in non-package subdirectories (docs/, scripts/)
      // that don't map to a package are skipped — but reported, so a
      // no-op run is distinguishable from an empty diff.
      rootLevelChange = true;
    } else {
      unmapped.push(file);
    }
  }
  return { packages: [...packages].sort(), rootLevelChange, unmapped };
}

// pnpm filter semantics: a LEADING `...` selects the package plus its
// DEPENDENTS; a trailing `...` selects its dependencies. Changed-mode must
// re-check everything that depends on what changed, so leading it is.
// (`...@paperclipai/shared` → 14 pkgs incl. server; `@paperclipai/shared...`
// → 1 pkg. Getting this backwards false-greens cross-package breaks.)
export function buildFilterArgs(packageDirs, nameByDir) {
  return packageDirs.flatMap((dir) => ["--filter", `...${nameByDir.get(dir)}`]);
}

export function parseResolvedPackageDirs(pnpmLsJsonText, rootPath) {
  const entries = JSON.parse(pnpmLsJsonText);
  if (!Array.isArray(entries)) {
    throw new Error("unexpected pnpm ls output: not an array");
  }
  return entries
    .map((entry) => relative(rootPath, entry.path))
    .filter((dir) => dir !== "")
    .sort();
}

// The floor is chosen from the RESOLVED set (what pnpm will actually run
// after filter expansion), never the changed set — a one-file edit in a
// widely-depended-on package expands to a set containing server (2529 MB
// peak). Empty/unknown resolution gets the conservative floor.
export function selectMemoryFloor(resolvedDirs) {
  const smallAndServerFree =
    resolvedDirs.length > 0 &&
    resolvedDirs.length <= CHANGED_MODE_SMALL_SET_LIMIT &&
    !resolvedDirs.includes("server");
  return smallAndServerFree ? CHANGED_MODE_MEMORY_FLOOR_MB : FULL_RUN_MEMORY_FLOOR_MB;
}

export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split("\n");
  const globs = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!match) {
      if (line.trim() === "") continue;
      inPackages = false;
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    globs.push(value);
  }
  return globs;
}

function expandGlob(root, pattern) {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    const baseAbs = join(root, base);
    if (!existsSync(baseAbs)) return [];
    return readdirSync(baseAbs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}/${entry.name}`);
  }
  return [pattern];
}

function isExcluded(dir, excludePatterns) {
  return excludePatterns.some((pattern) => {
    const base = pattern.replace(/\/\*\*$/, "");
    return dir === base || dir.startsWith(`${base}/`);
  });
}

export function discoverWorkspacePackages(root, workspaceYamlText) {
  const globs = parseWorkspaceGlobs(workspaceYamlText);
  const includes = globs.filter((glob) => !glob.startsWith("!"));
  const excludes = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));

  const dirs = new Set();
  for (const pattern of includes) {
    for (const dir of expandGlob(root, pattern)) dirs.add(dir);
  }
  for (const dir of [...dirs]) {
    if (isExcluded(dir, excludes)) dirs.delete(dir);
  }

  const packages = [];
  for (const dir of dirs) {
    const pkgPath = join(root, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts && typeof pkg.scripts.typecheck === "string") {
      packages.push({ dir, name: pkg.name });
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, stdout: "" };
  }
  return { ok: true, stdout: result.stdout };
}

function resolveBaseRef() {
  // origin/HEAD is the remote's actual default branch; hardcoded names are
  // fallbacks only. This repo's default is master — a stale origin/main
  // mirror preferred over it would silently under-scope the diff.
  const symbolic = git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim().replace(/^refs\/remotes\//, "");
    if (git(["rev-parse", "--verify", "--quiet", ref]).ok) return ref;
  }
  for (const ref of ["origin/master", "origin/main"]) {
    if (git(["rev-parse", "--verify", "--quiet", ref]).ok) return ref;
  }
  return null;
}

// Returns { files, failures }. Any failed git probe is recorded in
// `failures` — the caller must NOT treat the (possibly empty) file list as
// trustworthy when failures is non-empty. Swallowing a git error as "zero
// changed files" turns a broken environment into a passing typecheck.
function getChangedFiles() {
  const files = new Set();
  const failures = [];
  const collect = (result, label) => {
    if (!result.ok) {
      failures.push(label);
      return;
    }
    for (const line of result.stdout.split("\n")) {
      if (line.trim()) files.add(line.trim());
    }
  };

  const baseRef = resolveBaseRef();
  if (baseRef === null) {
    failures.push("no usable base ref (origin/HEAD, origin/master, origin/main)");
  } else {
    const mergeBase = git(["merge-base", "HEAD", baseRef]);
    if (!mergeBase.ok) {
      failures.push(`git merge-base HEAD ${baseRef}`);
    } else {
      collect(
        git(["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`]),
        "git diff <merge-base>...HEAD",
      );
    }
  }
  collect(git(["diff", "--name-only", "HEAD"]), "git diff --name-only HEAD");
  collect(git(["ls-files", "--others", "--exclude-standard"]), "git ls-files --others");
  return { files: [...files], failures };
}

// Resolve the set pnpm will actually run for these filter args. Returns
// workspace-relative dirs, or null if resolution failed (caller applies the
// conservative floor).
function resolveEffectivePackageDirs(filterArgs) {
  const result = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", ...filterArgs, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  try {
    return parseResolvedPackageDirs(result.stdout, repoRoot);
  } catch {
    return null;
  }
}

function currentMemAvailableMB() {
  return readMemAvailableMB(readFileSync("/proc/meminfo", "utf8"));
}

// Real-filesystem counterpart to the pure cgroup parsers above. Tries
// cgroup v2 first (this host, and every modern systemd host), falls back to
// v1, and returns a `source` that is always logged so a fallback is never
// silent. Any unreadable/missing file degrades to "unavailable" rather than
// throwing — the caller then falls back to the host-only reading, exactly
// like the existing `resolvedDirs === null` fallback above.
function readCgroupState() {
  let cgroupText;
  try {
    cgroupText = readFileSync("/proc/self/cgroup", "utf8");
  } catch (err) {
    return { headroomMB: null, source: "unavailable", detail: `/proc/self/cgroup unreadable: ${err.message}` };
  }

  const v2Path = parseCgroupV2LeafPath(cgroupText);
  if (v2Path !== null) {
    try {
      const maxRaw = readFileSync(`/sys/fs/cgroup${v2Path}/memory.max`, "utf8");
      const currentRaw = readFileSync(`/sys/fs/cgroup${v2Path}/memory.current`, "utf8");
      const maxMB = parseCgroupMemoryMaxMB(maxRaw);
      const currentMB = parseCgroupMemoryCurrentMB(currentRaw);
      return { headroomMB: computeCgroupHeadroomMB(maxMB, currentMB), source: "v2", maxMB, currentMB };
    } catch {
      // v2 mount present but this leaf's memory files aren't (unusual, but
      // fall through to a v1 attempt rather than giving up outright).
    }
  }

  const v1Path = parseCgroupV1MemoryPath(cgroupText);
  if (v1Path !== null) {
    try {
      const maxRaw = readFileSync(`/sys/fs/cgroup/memory${v1Path}/memory.limit_in_bytes`, "utf8");
      const currentRaw = readFileSync(`/sys/fs/cgroup/memory${v1Path}/memory.usage_in_bytes`, "utf8");
      const maxMB = parseCgroupMemoryMaxMB(maxRaw);
      const currentMB = parseCgroupMemoryCurrentMB(currentRaw);
      return { headroomMB: computeCgroupHeadroomMB(maxMB, currentMB), source: "v1", maxMB, currentMB };
    } catch (err) {
      return { headroomMB: null, source: "unavailable", detail: `cgroup v1 memory files unreadable: ${err.message}` };
    }
  }

  return { headroomMB: null, source: "unavailable", detail: "no cgroup v2 or v1 memory-controller path in /proc/self/cgroup" };
}

// Mirrors resolveSystemdRunPath in packages/adapter-utils/src/server-utils.ts
// (same two checks: systemd as PID 1, then a PATH scan) without importing
// that module — this script runs standalone via `node scripts/typecheck.mjs`
// pre-build, and AUR-4536 owns that file; this only reads the same signal.
function resolveSystemdRunPathSync(env) {
  if (process.platform !== "linux") return null;
  if (!existsSync("/run/systemd/system")) return null;
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(":").filter(Boolean)) {
    const candidate = join(dir, "systemd-run");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildEscapeCommand(sizedMB, changedMode) {
  const cmd = changedMode ? "pnpm typecheck:changed" : "pnpm typecheck";
  return `systemd-run --user --scope -p MemoryMax=${sizedMB}M -p MemorySwapMax=0 -- ${cmd}`;
}

function describeCgroupState(cgroupState) {
  if (cgroupState.headroomMB !== null) {
    return `headroom ${cgroupState.headroomMB} MB (limit ${cgroupState.maxMB} MB, in-use ${cgroupState.currentMB} MB, source ${cgroupState.source})`;
  }
  return `unavailable (${cgroupState.source}${cgroupState.detail ? `: ${cgroupState.detail}` : ""})`;
}

function runPnpm(filterArgs, label) {
  const pnpmArgs = [...filterArgs, "--workspace-concurrency=1", "typecheck"];
  console.log(`[typecheck] ${label}: pnpm ${pnpmArgs.join(" ")}`);
  const result = spawnSync("pnpm", pnpmArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[typecheck] failed to spawn pnpm: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Re-execs this same script (same argv) inside a fresh, bounded systemd
// --user scope. `systemd-run --scope` execs directly into the target (no
// wrapper pid), and the child's cgroup is a NEW scope entirely separate
// from the parent run's 1168 MB ceiling — so headroom there is the full
// sized MB, not this run's leftover. The recursion sentinel travels via env
// so the child's own gate check refuses instead of relaunching again.
function relaunchInScope(systemdRunPath, sizedMB, cliArgs) {
  const scopeArgs = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "-p",
    `MemoryMax=${sizedMB}M`,
    "-p",
    "MemorySwapMax=0",
    "--",
    process.execPath,
    fileURLToPath(import.meta.url),
    ...cliArgs,
  ];
  console.log(`[typecheck] cgroup headroom insufficient; relaunching inside a bounded scope: MemoryMax=${sizedMB}M`);
  const result = spawnSync(systemdRunPath, scopeArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, [RELAUNCH_SENTINEL_ENV_VAR]: "1" },
  });
  if (result.error) {
    console.error(`[typecheck] failed to relaunch inside a systemd scope: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Single choke point for both the full-run and changed-mode paths: reads
// host + cgroup memory, decides run/relaunch/refuse, and either invokes
// `run()` in-process, relaunches into a scope (never returns), or refuses
// loudly (never returns) — never a silent kill.
function gateAndRun(floorMB, mode, run) {
  const hostAvailableMB = currentMemAvailableMB();
  const cgroupState = readCgroupState();
  const alreadyScoped = process.env[RELAUNCH_SENTINEL_ENV_VAR] === "1";
  const systemdRunPath = resolveSystemdRunPathSync(process.env);

  console.log(`[typecheck] host MemAvailable ${hostAvailableMB} MB; cgroup ${describeCgroupState(cgroupState)}`);

  const plan = decideExecutionPlan({
    hostAvailableMB,
    cgroupHeadroomMB: cgroupState.headroomMB,
    floorMB,
    alreadyScoped,
    systemdAvailable: systemdRunPath !== null,
  });

  if (plan.action === "run") {
    console.log(`[typecheck] memory gate cleared: effective ${plan.effectiveAvailableMB} MB >= floor ${floorMB} MB`);
    run();
    return;
  }

  if (plan.action === "relaunch") {
    relaunchInScope(systemdRunPath, plan.sizedMB, process.argv.slice(2));
    return;
  }

  // refuse — never proceed into a run the kernel would silently reap.
  if (plan.reason === "host") {
    const gate = evaluateMemoryGate(hostAvailableMB, floorMB, { mode });
    console.error(`[typecheck] ${gate.message}`);
  } else {
    const lines = [
      `insufficient cgroup memory: need ${floorMB} MB, but ${describeCgroupState(cgroupState)}.`,
    ];
    if (alreadyScoped) {
      lines.push(
        `already relaunched into a bounded scope once (${RELAUNCH_SENTINEL_ENV_VAR}=1) — refusing rather than relaunching again.`,
      );
    } else if (systemdRunPath === null) {
      lines.push(
        `systemd-run is unavailable on this host, so this runner cannot self-relaunch. Escape: ${buildEscapeCommand(RELAUNCH_SCOPE_MEMORY_MB, mode === "changed")}`,
      );
    }
    console.error(`[typecheck] ${lines.join(" ")}`);
  }
  process.exit(1);
}

function runFull(reason) {
  if (reason) console.log(`[typecheck] ${reason}`);
  gateAndRun(FULL_RUN_MEMORY_FLOOR_MB, "full", () => runPnpm(["-r"], "full serial run"));
}

function main() {
  const args = process.argv.slice(2);
  const changedMode = args.includes("--changed");

  const clamped = clampNodeOptions(process.env.NODE_OPTIONS);
  process.env.NODE_OPTIONS = clamped;
  console.log(`[typecheck] effective NODE_OPTIONS: ${clamped}`);

  if (!changedMode) {
    runFull(null);
    return;
  }

  const { files: changedFiles, failures: gitFailures } = getChangedFiles();
  if (gitFailures.length > 0) {
    // A failed git probe means the changed set cannot be trusted — an empty
    // list here is indistinguishable from "git broke". Fail safe by running
    // everything, loudly, instead of reporting a pass on nothing.
    runFull(`git probe failed (${gitFailures.join("; ")}); cannot trust the changed set — falling back to full serial run`);
    return;
  }

  const workspacePackages = discoverWorkspacePackages(repoRoot, readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const packageDirs = workspacePackages.map((pkg) => pkg.dir);
  const { packages, rootLevelChange, unmapped } = mapChangedFilesToPackages(changedFiles, packageDirs);

  if (unmapped.length > 0) {
    console.log(
      `[typecheck] ${unmapped.length} changed path(s) do not map to a typecheck-capable workspace package (skipped): ${unmapped.join(", ")}`,
    );
  }

  if (rootLevelChange) {
    runFull("root-level file changed; falling back to full serial run");
    return;
  }

  if (packages.length === 0) {
    if (changedFiles.length === 0) {
      console.log("[typecheck] working tree matches the base ref; no changed files; nothing to typecheck");
    } else {
      console.log("[typecheck] no changed files map to a workspace package; nothing to typecheck");
    }
    process.exit(0);
    return;
  }

  const nameByDir = new Map(workspacePackages.map((pkg) => [pkg.dir, pkg.name]));
  const filterArgs = buildFilterArgs(packages, nameByDir);

  // Gate on the filter-EXPANDED set pnpm will actually run, not the changed
  // set: one changed file in a widely-depended-on package pulls in server
  // (2529 MB peak) via dependents. Unknown resolution → conservative floor.
  const resolvedDirs = resolveEffectivePackageDirs(filterArgs);
  let floor;
  if (resolvedDirs === null) {
    console.warn("[typecheck] could not resolve the effective package set via pnpm ls; applying the conservative full-run memory floor");
    floor = FULL_RUN_MEMORY_FLOOR_MB;
  } else {
    console.log(`[typecheck] changed packages (${packages.join(", ")}) expand to ${resolvedDirs.length} package(s) incl. dependents: ${resolvedDirs.join(", ")}`);
    floor = selectMemoryFloor(resolvedDirs);
  }

  gateAndRun(floor, "changed", () => runPnpm(filterArgs, `changed-package run (${packages.join(", ")})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
