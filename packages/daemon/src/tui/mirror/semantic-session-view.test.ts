import type { ApplicationShellTerminalInventory } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { SemanticSessionView } from "./semantic-session-view.ts";

describe("SemanticSessionView local runtime identity", () => {
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
        title: "Editor",
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
