import { describe, expect, it, vi } from "vitest";

import { OpenTuiLocalViewController } from "./local-view-controller.ts";

describe("renderer-local view controller", () => {
  it("keeps valid local navigation independent from canonical active focus", () => {
    const controller = new OpenTuiLocalViewController({
      workspaceId: "alpha",
      focusedPaneId: "pane.editor",
    });
    controller.update({ surface: "files", focusZone: "dock-body" });
    const before = controller.getState();

    controller.reconcile({
      workspaceIds: ["alpha", "beta"],
      paneIds: ["pane.editor", "pane.tests"],
      activeWorkspaceId: "beta",
      activePaneId: "pane.tests",
    });

    expect(controller.getState()).toBe(before);
    expect(controller.getState()).toMatchObject({
      workspaceId: "alpha",
      focusedPaneId: "pane.editor",
      surface: "files",
      focusZone: "dock-body",
    });
  });

  it("reconciles removed IDs once and never notifies after disposal", () => {
    const controller = new OpenTuiLocalViewController({
      workspaceId: "gone",
      focusedPaneId: "pane.gone",
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.reconcile({
      workspaceIds: ["alpha"],
      paneIds: ["pane.one"],
      activeWorkspaceId: "alpha",
      activePaneId: "pane.one",
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      revision: 1,
      workspaceId: "alpha",
      focusedPaneId: "pane.one",
    });

    controller.dispose();
    controller.update({ surface: "activity" });
    expect(listener).toHaveBeenCalledOnce();
    expect(controller.getState().surface).toBe("terminals");
  });

  it("rejects stale canonical active IDs in favor of the live inventory", () => {
    const controller = new OpenTuiLocalViewController({
      workspaceId: "gone",
      focusedPaneId: "pane.gone",
    });

    controller.reconcile({
      workspaceIds: ["alpha"],
      paneIds: ["pane.one"],
      activeWorkspaceId: "stale-workspace",
      activePaneId: "pane.stale",
    });

    expect(controller.getState()).toMatchObject({
      workspaceId: "alpha",
      focusedPaneId: "pane.one",
    });
  });
});
