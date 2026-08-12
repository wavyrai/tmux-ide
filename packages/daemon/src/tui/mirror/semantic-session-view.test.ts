import type { ApplicationShellTerminalInventory, PaneStreamServerFrame } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { SemanticSessionView } from "./semantic-session-view.ts";

describe("SemanticSessionView local runtime identity", () => {
  it("projects each window with its own activation pane identity", async () => {
    const view = new SemanticSessionView({ target: "alpha" });
    const layout = (
      semanticWindowId: string,
      windowName: string,
      pane: string,
      currentWindow: boolean,
    ): Extract<PaneStreamServerFrame, { type: "layout" }> => ({
      type: "layout",
      semanticWindowId,
      windowName,
      currentWindow,
      cols: 80,
      rows: 24,
      zoomed: false,
      panes: [{ pane, left: 0, top: 0, width: 80, height: 24, active: true }],
    });
    view.acceptLayout(layout("window.editor", "Editor", "pane.editor", true));
    view.acceptLayout(layout("window.tests", "Tests", "pane.tests", false));

    expect(await view.windows()).toEqual([
      expect.objectContaining({
        index: 0,
        semanticWindowId: "window.editor",
        activePaneId: "pane.editor",
        active: true,
      }),
      expect.objectContaining({
        index: 1,
        semanticWindowId: "window.tests",
        activePaneId: "pane.tests",
        active: false,
      }),
    ]);
  });

  it("keeps a window actionable while its layout identity converges", async () => {
    const view = new SemanticSessionView({ target: "alpha" });
    view.setInventory({
      activeResourceId: "terminal.editor",
      resources: [
        {
          id: "terminal.editor",
          title: "Editor",
          kind: "terminal",
          active: true,
          attachability: { status: "available", semanticPaneId: "pane.editor" },
          windowResourceId: "terminal-window.006869769f156e2088f2",
        },
        {
          id: "terminal.tests",
          title: "Tests",
          kind: "terminal",
          active: false,
          attachability: { status: "available", semanticPaneId: "pane.tests" },
          windowResourceId: "terminal-window.fe0a211aa297f1b5834f",
        },
      ],
    });
    view.acceptLayout({
      type: "layout",
      semanticWindowId: "window.tests",
      windowName: "Tests",
      currentWindow: false,
      cols: 80,
      rows: 24,
      zoomed: false,
      panes: [{ pane: null, left: 0, top: 0, width: 80, height: 24, active: true }],
    });

    expect(await view.windows()).toEqual([
      expect.objectContaining({
        semanticWindowId: "window.tests",
        activePaneId: "pane.tests",
      }),
    ]);
  });

  it("joins wire-safe inventory identity to process-local raw tmux descriptors", () => {
    const view = new SemanticSessionView({ target: "alpha" });
    view.setInventory({
      activeResourceId: "terminal.discovered.abcdefghijklmnop",
      resources: [
        {
          id: "terminal.discovered.abcdefghijklmnop",
          title: "Editor",
          kind: "agent",
          active: true,
          attachability: { status: "available", semanticPaneId: "pane.editor" },
        },
      ],
    } as ApplicationShellTerminalInventory);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("terminal.discovered.abcdefghijklmnop");

    view.setRuntimeAuthorityGeneration("lane-1");
    view.setRuntimeDescriptors("lane-1", [
      {
        runtimePaneId: "%7",
        semanticPaneId: "pane.editor",
        role: "agent",
        type: "agent",
        currentCommand: "claude",
        cwd: "/work/alpha",
        title: "raw-zsh-title",
        windowIndex: 2,
        windowName: "main",
        windowId: "@1",
      },
    ]);

    expect(view.paneDescriptors()).toEqual([
      expect.objectContaining({
        runtimePaneId: "%7",
        semanticPaneId: "pane.editor",
        windowIndex: 2,
        title: "Editor",
      }),
    ]);
  });

  it("cannot revive raw pane identity from a retired physical authority", () => {
    const view = new SemanticSessionView({ target: "alpha" });
    const inventory = {
      activeResourceId: "terminal.discovered.abcdefghijklmnop",
      resources: [
        {
          id: "terminal.discovered.abcdefghijklmnop",
          title: "Editor",
          kind: "agent",
          active: true,
          attachability: { status: "available", semanticPaneId: "pane.editor" },
        },
      ],
    } as ApplicationShellTerminalInventory;
    const descriptor = (runtimePaneId: string) => ({
      runtimePaneId,
      semanticPaneId: "pane.editor",
      role: "agent",
      type: "agent",
      currentCommand: "claude",
      cwd: "/work/alpha",
      title: "Editor",
      windowIndex: 2,
      windowName: "main",
      windowId: "@1",
    });
    view.setInventory(inventory);
    view.setRuntimeAuthorityGeneration("lane-1");
    expect(view.setRuntimeDescriptors("lane-1", [descriptor("%7")])).toBe(true);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("%7");

    view.setRuntimeAuthorityGeneration("lane-2");
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("terminal.discovered.abcdefghijklmnop");
    expect(view.setRuntimeDescriptors("lane-1", [descriptor("%7")])).toBe(false);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("terminal.discovered.abcdefghijklmnop");
    expect(view.setRuntimeDescriptors("lane-2", [descriptor("%9")])).toBe(true);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("%9");

    view.retireRuntimeAuthority();
    expect(view.setRuntimeDescriptors("lane-2", [descriptor("%9")])).toBe(false);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("terminal.discovered.abcdefghijklmnop");
    view.setRuntimeAuthorityGeneration("lane-3");
    expect(view.setRuntimeDescriptors("lane-3", [descriptor("%11")])).toBe(true);

    view.setInventory({ activeResourceId: null, resources: [] });
    view.setInventory(inventory);
    expect(view.setRuntimeDescriptors("lane-3", [descriptor("%11")])).toBe(false);
    expect(view.paneDescriptors()[0]?.runtimePaneId).toBe("terminal.discovered.abcdefghijklmnop");
  });
});
