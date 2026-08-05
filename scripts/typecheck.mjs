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

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export function clampNodeOptions(nodeOptionsEnv) {
  const raw = (nodeOptionsEnv ?? "").trim();
  const tokens = raw.length > 0 ? raw.split(/\s+/) : [];
  const kept = tokens.filter((token) => !/^--max-old-space-size=/.test(token));
  kept.push(`--max-old-space-size=${MAX_OLD_SPACE_SIZE_MB}`);
  return kept.join(" ");
}

export function evaluateMemoryGate(memAvailableMB, floorMB = FULL_RUN_MEMORY_FLOOR_MB) {
  if (memAvailableMB < floorMB) {
    return {
      ok: false,
      message: `insufficient memory: ${memAvailableMB} MB available, need ${floorMB} MB. Run 'pnpm typecheck:changed' to check only your touched packages, or retry when the host is quieter.`,
    };
  }
  return { ok: true, message: null };
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

function runFull(reason) {
  if (reason) console.log(`[typecheck] ${reason}`);
  const gate = evaluateMemoryGate(currentMemAvailableMB());
  if (!gate.ok) {
    console.error(`[typecheck] ${gate.message}`);
    process.exit(1);
  }
  runPnpm(["-r"], "full serial run");
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
  const gate = evaluateMemoryGate(currentMemAvailableMB(), floor);
  if (!gate.ok) {
    console.error(`[typecheck] ${gate.message}`);
    process.exit(1);
  }

  runPnpm(filterArgs, `changed-package run (${packages.join(", ")})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
