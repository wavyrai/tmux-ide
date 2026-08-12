import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const missionWorkspaceSource = readFileSync(
  new URL("./missions-workspace.ts", import.meta.url),
  "utf8",
);
const legacyLoaderSource = readFileSync(
  new URL("./legacy/missions-workspace-loader.ts", import.meta.url),
  "utf8",
);

describe("missions workspace dependency boundary", () => {
  it("keeps presentation independent from the filesystem-backed mission runtime", () => {
    expect(missionWorkspaceSource).not.toContain("mission-repository.ts");
    expect(missionWorkspaceSource).not.toContain("project-runtime-repository.ts");
    expect(missionWorkspaceSource).not.toContain("readMissionWorkspace");
    expect(missionWorkspaceSource).not.toContain("class MissionWorkspaceLoader");
  });

  it("isolates compatibility loading behind an explicit legacy adapter", () => {
    expect(legacyLoaderSource).toContain("mission-repository.ts");
    expect(legacyLoaderSource).toContain("project-runtime-repository.ts");
    expect(legacyLoaderSource).toContain("export function readMissionWorkspace");
    expect(legacyLoaderSource).toContain("export class MissionWorkspaceLoader");
  });
});
