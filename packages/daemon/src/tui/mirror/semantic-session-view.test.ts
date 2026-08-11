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

    view.setRuntimeDescriptors([
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
});
