import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deferred Missions and Activity feature boundary", () => {
  it("keeps the production root free of eager Missions and Activity implementation imports", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    for (const specifier of [
      "../missions-surface.tsx",
      "../activity-surface-view.tsx",
      "../missions-dashboard.ts",
      "../missions-surface-controller.ts",
      "../missions-workspace.ts",
      "../features/missions-activity/session.ts",
    ]) {
      expect(source).not.toContain(`from "${specifier}"`);
    }
    expect(source).toContain('optionalFeatures.request("missionsActivity")');
    expect(source).toContain("component={feature().MissionsSurface}");
    expect(source).toContain("component={feature().ActivitySurface}");
    expect(source).toContain("feature.createMissionsActivityFeatureSession(");
    expect(source).toContain("missionsActivitySession()?.dispose()");
  });

  it("owns catalog conversion, projections, controllers, and disposal in one feature session", () => {
    const source = readFileSync(
      new URL("../features/missions-activity/session.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("createRoot((disposeOwner)");
    expect(source).toContain("missionDashboardProjection(");
    expect(source).toContain("projectActivitySurface({");
    expect(source).toContain("handleMissionSurfaceKey(");
    expect(source).toContain("disposeOwner();");
  });

  it("keeps Missions and Activity outside bootstrap, resource demand, and restore", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    expect(source).toContain("missionsActivityIdentityScope");
    expect(source).toContain("isDefaultProductDockTool(activeDockTab())");
    expect(source).toContain("toolResources.setOpenDock(null)");
    expect(source).toContain('setDockMode("collapsed")');
    const restoreStart = source.indexOf("const requestedDockTab =");
    const restoreEnd = source.indexOf("panelHostResolved = true", restoreStart);
    const restore = source.slice(restoreStart, restoreEnd);
    expect(restore).not.toContain("loadMissionsWorkspace");
  });
});
