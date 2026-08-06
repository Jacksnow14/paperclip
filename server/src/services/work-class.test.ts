import { describe, expect, it } from "vitest";
import { deriveWorkClass, SELF_IMPROVEMENT_PROJECT_ID } from "./work-class.js";

describe("deriveWorkClass", () => {
  it("prefers an explicit exec.work_class token over everything else", () => {
    expect(
      deriveWorkClass({
        description: "exec.work_class: self_improvement\nsome text",
        projectId: "1ed2097c-fe42-46b1-9b04-8c20955a8876",
        workspaceRepoUrl: "https://github.com/Jacksnow14/Auranode.git",
      }),
    ).toBe("self_improvement");

    expect(
      deriveWorkClass({
        description: "exec.work_class: revenue",
        projectId: SELF_IMPROVEMENT_PROJECT_ID,
      }),
    ).toBe("revenue");
  });

  it("maps the SGI project to self_improvement", () => {
    expect(deriveWorkClass({ projectId: SELF_IMPROVEMENT_PROJECT_ID })).toBe("self_improvement");
  });

  it("maps known revenue projects to revenue even if their repo is paperclip", () => {
    expect(
      deriveWorkClass({
        projectId: "1ed2097c-fe42-46b1-9b04-8c20955a8876",
        workspaceRepoUrl: "https://github.com/Jacksnow14/paperclip.git",
      }),
    ).toBe("revenue");
  });

  it("falls back to the paperclip-repo heuristic when projectId is unmapped or absent", () => {
    expect(
      deriveWorkClass({
        projectId: null,
        workspaceRepoUrl: "https://github.com/Jacksnow14/paperclip.git",
      }),
    ).toBe("self_improvement");
  });

  it("defaults to revenue so the cap can never silently starve product work", () => {
    expect(deriveWorkClass({})).toBe("revenue");
    expect(
      deriveWorkClass({
        projectId: null,
        workspaceRepoUrl: "https://github.com/Jacksnow14/Auranode.git",
      }),
    ).toBe("revenue");
  });
});
