import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  /**
   * "release" when running a pinned deploy produced by scripts/deploy/build-release.sh
   * (AUR-3937); "untracked" when running from a mutable checkout or any build that
   * did not go through the release pipeline.
   */
  source: "release" | "untracked";
  sha: string | null;
  ref: string | null;
  builtAt: string | null;
};

const UNTRACKED: BuildInfo = { source: "untracked", sha: null, ref: null, builtAt: null };

function resolveBuildInfoPath(): string {
  const fromEnv = process.env.PAPERCLIP_BUILD_INFO?.trim();
  if (fromEnv) return fromEnv;
  // build-info.json sits at the monorepo root of the release tree; this module is
  // two levels below it from both server/src (tsx) and server/dist (compiled).
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "../../build-info.json");
}

export function readBuildInfo(): BuildInfo {
  try {
    const infoPath = resolveBuildInfoPath();
    if (!existsSync(infoPath)) return UNTRACKED;
    const raw = JSON.parse(readFileSync(infoPath, "utf-8")) as Partial<BuildInfo>;
    if (typeof raw.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(raw.sha)) return UNTRACKED;
    return {
      source: "release",
      sha: raw.sha,
      ref: typeof raw.ref === "string" ? raw.ref : null,
      builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null,
    };
  } catch {
    return UNTRACKED;
  }
}
