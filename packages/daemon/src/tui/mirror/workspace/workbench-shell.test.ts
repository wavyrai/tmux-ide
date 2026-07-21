import { describe, expect, it } from "vitest";
import { COHESION_FIXTURE_V1, projectApplicationShellV1 } from "@tmux-ide/contracts";
import {
  projectWorkbenchShell,
  moveWorkbenchDockTab,
  workbenchShellHitTest,
  workbenchVariant,
  type WorkbenchDockTabId,
  type WorkbenchShellInput,
} from "./workbench-shell.ts";

const DOCK_EXCLUDES_TERMINAL_AND_HOME: Extract<
  WorkbenchDockTabId,
  "terminals" | "home"
> extends never
  ? true
  : false = true;

function input(overrides: Partial<WorkbenchShellInput> = {}): WorkbenchShellInput {
  const shell = projectApplicationShellV1(COHESION_FIXTURE_V1);
  return {
    width: 120,
    height: 40,
    dockMode: "open",
    persistedDockHeight: 14,
    activeDockTab: "missions",
    focusZone: "canvas",
    hoveredDockTab: null,
    attentionDockTabs: new Set(["activity"]),
    dockTools: shell.bottomDock.tools,
    ...overrides,
  };
}

describe("WorkbenchShell projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("projects a bounded %s×%s %s workbench", (width, height, variant) => {
    expect(workbenchVariant(width, height)).toBe(variant);
    const projection = projectWorkbenchShell(input({ width, height }));
    expect(projection.variant).toBe(variant);
    expect(projection.canvas.height + projection.dock.height).toBe(height);
    expect(projection.canvasBody.width + projection.canvasRail.width).toBe(width);
    expect(projection.dockBodyContent.width + projection.dockBodyRail.width).toBe(width);
    expect(projection.dock.y).toBe(projection.canvas.height);
    expect(projection.tabs.map((tab) => tab.id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(
      [...projection.tabs, ...projection.actions].every(
        (item) => item.x >= 0 && item.x + item.width <= width,
      ),
    ).toBe(true);
  });

  it("preserves the persisted open height while resolving all three dock modes", () => {
    const collapsed = projectWorkbenchShell(
      input({ dockMode: "collapsed", persistedDockHeight: 15 }),
    );
    const open = projectWorkbenchShell(input({ dockMode: "open", persistedDockHeight: 15 }));
    const maximized = projectWorkbenchShell(
      input({ dockMode: "maximized", persistedDockHeight: 15 }),
    );

    expect(collapsed.persistedDockHeight).toBe(15);
    expect(open.persistedDockHeight).toBe(15);
    expect(maximized.persistedDockHeight).toBe(15);
    expect(collapsed.dock.height).toBe(1);
    expect(open.dock.height).toBe(15);
    expect(maximized.dock.height).toBe(40);
    expect(collapsed.dockBody.height).toBe(0);
    expect(open.canvas.height).toBe(25);
    expect(maximized.canvas.height).toBe(0);
    expect(maximized.actions.find((action) => action.id === "toggle-maximize")).toMatchObject({
      nextMode: "open",
      active: true,
    });
  });

  it("clamps the open dock without replacing the user's persisted preference", () => {
    const tooSmall = projectWorkbenchShell(input({ persistedDockHeight: 2 }));
    const tooLarge = projectWorkbenchShell(input({ persistedDockHeight: 200 }));
    expect(tooSmall.persistedDockHeight).toBe(2);
    expect(tooSmall.dock.height).toBe(tooSmall.constraints.minimumOpenDockHeight);
    expect(tooLarge.persistedDockHeight).toBe(200);
    expect(tooLarge.dock.height).toBe(tooLarge.constraints.maximumOpenDockHeight);
    expect(tooLarge.canvas.height).toBe(tooLarge.constraints.minimumCanvasHeight);
  });

  it("resolves focus away from unavailable canvas and dock-body zones", () => {
    expect(
      projectWorkbenchShell(input({ dockMode: "maximized", focusZone: "canvas" })).focusZone,
    ).toBe("dock-body");
    expect(
      projectWorkbenchShell(input({ dockMode: "collapsed", focusZone: "dock-body" })).focusZone,
    ).toBe("dock-tabs");
    const tiny = projectWorkbenchShell(
      input({ height: 1, dockMode: "maximized", focusZone: "canvas" }),
    );
    expect(tiny.dockMode).toBe("collapsed");
    expect(tiny.focusZone).toBe("dock-tabs");
  });

  it("projects exact canvas, tab, action, and dock-body hit cells", () => {
    const projection = projectWorkbenchShell(input());
    expect(workbenchShellHitTest(projection, projection.canvasBody.x + 4, 4)).toEqual({
      kind: "canvas",
      localX: 4,
      localY: 4,
    });
    expect(workbenchShellHitTest(projection, projection.canvasRail.x, 4)).toEqual({
      kind: "canvas-rail",
    });
    expect(workbenchShellHitTest(projection, projection.canvasBody.x, 4)).toEqual({
      kind: "canvas",
      localX: 0,
      localY: 4,
    });
    expect(
      workbenchShellHitTest(
        projection,
        projection.canvasBody.x + projection.canvasBody.width - 1,
        4,
      ),
    ).toEqual({
      kind: "canvas",
      localX: projection.canvasBody.width - 1,
      localY: 4,
    });

    const files = projection.tabs.find((tab) => tab.id === "files")!;
    expect(workbenchShellHitTest(projection, files.x, projection.dockTabs.y)).toEqual({
      kind: "dock-tab",
      tabId: "files",
      index: 0,
    });

    const maximize = projection.actions.find((action) => action.id === "toggle-maximize")!;
    expect(workbenchShellHitTest(projection, maximize.x, projection.dockTabs.y)).toEqual({
      kind: "dock-action",
      actionId: "toggle-maximize",
      nextMode: "maximized",
      index: 1,
    });
    expect(
      workbenchShellHitTest(
        projection,
        projection.dockBodyContent.x + 5,
        projection.dockBodyContent.y,
      ),
    ).toEqual({
      kind: "dock-body",
      tabId: "missions",
      localX: 5,
      localY: 0,
    });
    expect(
      workbenchShellHitTest(projection, projection.dockBodyRail.x, projection.dockBodyRail.y),
    ).toEqual({ kind: "dock-body-rail", tabId: "missions" });
    expect(workbenchShellHitTest(projection, -1, 0)).toBeNull();
    expect(workbenchShellHitTest(projection, projection.width, 0)).toBeNull();
  });

  it("keeps dock controls bounded when the workbench is only a few cells wide", () => {
    for (const width of [0, 1, 2, 3, 6]) {
      const projection = projectWorkbenchShell(input({ width, height: 8 }));
      expect(
        [...projection.tabs, ...projection.actions].every(
          (item) => item.x >= 0 && item.width >= 0 && item.x + item.width <= width,
        ),
      ).toBe(true);
    }
  });

  it("keeps terminal and home out of the canonical dock contract", () => {
    const projection = projectWorkbenchShell(input());
    expect(DOCK_EXCLUDES_TERMINAL_AND_HOME).toBe(true);
    expect(projection.tabs.map((tab) => tab.id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(projection.tabs.some((tab) => tab.id === ("terminals" as WorkbenchDockTabId))).toBe(
      false,
    );
    expect(projection.tabs.some((tab) => tab.id === ("home" as WorkbenchDockTabId))).toBe(false);
  });

  it("keeps disabled tabs visible, inert, and out of keyboard traversal", () => {
    const disabled = new Set<WorkbenchDockTabId>(["changes", "missions"]);
    const dockTools = input().dockTools;
    const projection = projectWorkbenchShell(
      input({ activeDockTab: "changes", disabledDockTabs: disabled, focusZone: "dock-tabs" }),
    );
    expect(projection.requestedActiveDockTab).toBe("changes");
    expect(projection.activeDockTab).toBe("activity");
    expect(projection.tabs.find((tab) => tab.id === "changes")).toMatchObject({
      disabled: true,
      selected: false,
      focused: false,
    });
    const changes = projection.tabs.find((tab) => tab.id === "changes")!;
    expect(workbenchShellHitTest(projection, changes.x, projection.dockTabs.y)).toEqual({
      kind: "dock-tabs",
    });
    expect(moveWorkbenchDockTab("files", "next", dockTools, disabled)).toBe("activity");
    expect(moveWorkbenchDockTab("activity", "previous", dockTools, disabled)).toBe("files");
  });

  it("routes every padded tab/action edge and leaves the blank strip inert", () => {
    const projection = projectWorkbenchShell(input());
    const tabBarY = projection.dockTabs.y;
    for (const [index, tab] of projection.tabs.entries()) {
      const expected = { kind: "dock-tab", tabId: tab.id, index };
      expect(workbenchShellHitTest(projection, tab.x, tabBarY)).toEqual(expected);
      expect(workbenchShellHitTest(projection, tab.x + Math.floor(tab.width / 2), tabBarY)).toEqual(
        expected,
      );
      expect(workbenchShellHitTest(projection, tab.x + tab.width - 1, tabBarY)).toEqual(expected);
    }
    for (const [index, action] of projection.actions.entries()) {
      const expected = {
        kind: "dock-action",
        actionId: action.id,
        nextMode: action.nextMode,
        index,
      };
      expect(workbenchShellHitTest(projection, action.x, tabBarY)).toEqual(expected);
      expect(
        workbenchShellHitTest(projection, action.x + Math.floor(action.width / 2), tabBarY),
      ).toEqual(expected);
      expect(workbenchShellHitTest(projection, action.x + action.width - 1, tabBarY)).toEqual(
        expected,
      );
    }
    const blankX = projection.tabs.at(-1)!.x + projection.tabs.at(-1)!.width;
    expect(blankX).toBeLessThan(projection.actions[0]!.x);
    expect(workbenchShellHitTest(projection, blankX, tabBarY)).toEqual({ kind: "dock-tabs" });
  });
});
