import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

describe("production OpenTUI data path", () => {
  it("contains no recurring catalog work or legacy direct observation path", () => {
    for (const forbidden of [
      "setInterval(",
      'team", "--json',
      "readMissionWorkspace",
      "MissionRepository",
      "watchDirectory",
      "filesStatusPoll",
      "fleetTimer",
      "diffTimer",
      "fleetRefresh",
    ]) {
      expect(source, `production app contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("publishes input readiness before admitting daemon tool demand", () => {
    const readiness = source.indexOf('publishTuiInputReady("app")');
    const demand = source.indexOf("publishToolReadiness()", readiness);
    expect(readiness).toBeGreaterThan(0);
    expect(demand).toBeGreaterThan(readiness);
  });

  it("cuts production through the lifecycle bootstrap, terminal adapter, and local view owner", () => {
    expect(source).toContain("await startTuiApplication");
    expect(source).toContain("new TuiApplicationLifecycle");
    expect(source).toContain("new OpenTuiTerminalWorkspaceAdapter");
    expect(source).toContain("new OpenTuiLocalViewController");
    expect(source).toContain('applicationLifecycle.registerCloser("tool-resources"');
    expect(source).toContain('applicationLifecycle.registerCloser("local-view"');
  });

  it("releases tools only when the dock collapses", () => {
    expect(source).toContain('dockMode() === "collapsed"');
    expect(source).toContain("toolResources.setOpenDock(null)");
  });
});
