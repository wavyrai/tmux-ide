/* @vitest-environment happy-dom */
import {
  AppWindowDocumentV1SchemaZ,
  resolvePaneAppearance,
  type ApplicationShellTerminalInventory,
  type AppWindowDocumentV1,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { AppWindowCanvas } from "./app-window-canvas.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function documentFixture(): AppWindowDocumentV1 {
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 3,
    updatedAt: "2026-07-22T10:00:00.000Z",
    windows: {
      "window.lead": {
        id: "window.lead",
        source: { kind: "terminal", terminalSourceId: "terminal.lead" },
        title: "Lead terminal",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.canvas", index: 0 },
          floating: null,
        },
      },
    },
    dockRoot: {
      type: "stack",
      id: "stack.canvas",
      windowIds: ["window.lead"],
      activeWindowId: "window.lead",
    },
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: [],
    focusedWindowId: "window.lead",
    activeLayoutId: null,
    layouts: {},
  });
}

function frame(): PaneFrameModel {
  const appearance = resolvePaneAppearance({
    structure: "docked",
    applicationFocus: { pane: false, terminalInput: false, windowActive: true },
    agentActivity: "running",
    domainStatus: "running",
    attention: "none",
    layoutInteraction: {
      editable: true,
      selected: false,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: false,
      loading: false,
    },
  });
  return {
    pane: { id: "terminal.lead", kind: "terminal" },
    appearance,
    title: "Live terminal title",
    subtitle: "Codex",
    status: {
      id: "terminal.lead.status",
      label: "Running",
      description: "Terminal is running",
      tone: appearance.status.tone,
      busy: true,
    },
    chips: [],
    actions: [],
  };
}

const inventory: ApplicationShellTerminalInventory = {
  activeResourceId: "terminal.lead",
  resources: [
    {
      id: "terminal.lead",
      title: "Lead terminal",
      kind: "agent",
      active: true,
      attachability: { status: "available", semanticPaneId: "terminal.lead" },
    },
  ],
};

describe("AppWindowCanvas", () => {
  it("renders terminal content under canonical window identity and durable geometry", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={documentFixture()}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );

    const card = root.querySelector<HTMLElement>('.app-window-card[data-window-id="window.lead"]');
    expect(card?.dataset.terminalSourceId).toBe("terminal.lead");
    expect(card?.getAttribute("style")).toContain("width: 900px");
    expect(card?.getAttribute("style")).toContain("height: 540px");
    expect(card?.querySelector(".web-pane-frame")?.getAttribute("data-pane-id")).toBe(
      "window.lead",
    );
    expect(card?.querySelector(".terminal-surface")).not.toBeNull();
    expect(root.querySelector(".agent-grid")).toBeNull();
    expect(root.innerHTML).toMatchSnapshot();
  });

  it("emits canonical focus commands from window chrome interaction", () => {
    const value = documentFixture();
    const unfocused = AppWindowDocumentV1SchemaZ.parse({ ...value, focusedWindowId: null });
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={unfocused}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );
    root
      .querySelector<HTMLElement>(".app-window-card")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onCommand).toHaveBeenCalledWith({
      command: { type: "window.focus", windowId: "window.lead" },
      source: "mouse",
    });
  });
});
