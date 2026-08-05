/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { WorkspaceTiledSurface } from "./workspace-tiled-surface.tsx";
import type { PaneStreamLayoutEvent } from "../terminal/pane-stream-transport.ts";

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
  document.body.replaceChildren();
});

function layout(overrides: Partial<PaneStreamLayoutEvent> = {}): PaneStreamLayoutEvent {
  return {
    semanticWindowId: "window.editor",
    windowName: "editor",
    currentWindow: true,
    cols: 200,
    rows: 50,
    zoomed: false,
    panes: [{ pane: "pane.a", left: 0, top: 0, width: 200, height: 50, active: true }],
    ...overrides,
  };
}

const SPLIT = layout({
  panes: [
    { pane: "pane.a", left: 0, top: 0, width: 99, height: 50, active: true },
    { pane: "pane.b", left: 100, top: 0, width: 100, height: 50, active: false },
  ],
});

function renderSurface(
  layouts: readonly PaneStreamLayoutEvent[],
  overrides: Partial<Parameters<typeof WorkspaceTiledSurface>[0]> = {},
) {
  const invoke = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(
    render(
      () => (
        <WorkspaceTiledSurface
          layouts={layouts}
          workspaceName="workspace.product"
          transport={null}
          paneFrames={[]}
          verbs={{ workspaceConnected: true, invoke }}
          {...overrides}
        />
      ),
      root,
    ),
  );
  return { root, invoke };
}

describe("the layout-faithful workspace view", () => {
  it("renders one tab per tmux window, labelled and marked from the live frames", () => {
    const { root } = renderSurface([
      layout({ semanticWindowId: "window.editor", windowName: "editor", currentWindow: false }),
      layout({ semanticWindowId: "window.shell", windowName: "shell", currentWindow: true }),
    ]);
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".window-tabs__tab")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["editor", "shell"]);
    expect(tabs.map((tab) => tab.dataset.active)).toEqual(["false", "true"]);
  });

  it("selects a window through tmux when its tab is clicked", () => {
    /*
     * Bug this catches: the tab switches which window the APP shows and never
     * tells tmux, so an attached ssh client stays on the old window and the two
     * views of one session disagree about where the user is.
     */
    const { root, invoke } = renderSurface([
      layout({ semanticWindowId: "window.editor", currentWindow: true }),
      layout({
        semanticWindowId: "window.shell",
        windowName: "shell",
        currentWindow: false,
        panes: [{ pane: "pane.z", left: 0, top: 0, width: 200, height: 50, active: true }],
      }),
    ]);
    root.querySelectorAll<HTMLButtonElement>(".window-tabs__tab")[1]!.click();
    expect(invoke).toHaveBeenCalledWith("pane.select", "pane.z");
  });

  it("does not re-select the window the user is already in", () => {
    const { root, invoke } = renderSurface([layout()]);
    root.querySelector<HTMLButtonElement>(".window-tabs__tab")!.click();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a tab whose window has no addressable pane", () => {
    const { root } = renderSurface([
      layout({ panes: [{ pane: null, left: 0, top: 0, width: 200, height: 50, active: true }] }),
    ]);
    expect(root.querySelector<HTMLButtonElement>(".window-tabs__tab")!.disabled).toBe(true);
  });

  it("places the tiles at exactly the frame's proportions", () => {
    const { root } = renderSurface([SPLIT]);
    const tiles = [...root.querySelectorAll<HTMLElement>(".pane-tile")];
    expect(tiles.map((tile) => tile.dataset.pane)).toEqual(["pane.a", "pane.b"]);
    expect(tiles[0]!.style.width).toBe("49.5000%");
    expect(tiles[1]!.style.left).toBe("50.0000%");
  });

  it("re-tiles from the next frame with no renderer-owned geometry in between", () => {
    // The view is a pure function of the frame, so the same surface fed a split
    // frame IS the split having re-tiled it — there is no stored rectangle in
    // between that could have survived and disagreed.
    expect(renderSurface([layout()]).root.querySelectorAll(".pane-tile")).toHaveLength(1);
    expect(renderSurface([SPLIT]).root.querySelectorAll(".pane-tile")).toHaveLength(2);
  });

  it("puts a draggable border on tmux's own border cell, and none when there is one pane", () => {
    const { root } = renderSurface([SPLIT]);
    const border = root.querySelector<HTMLElement>(".pane-border")!;
    expect(border.dataset.orientation).toBe("vertical");
    expect(border.style.left).toBe("49.5000%");
    expect(renderSurface([layout()]).root.querySelectorAll(".pane-border")).toHaveLength(0);
  });

  it("leaves the pointer to the terminal underneath", () => {
    /*
     * Bug this catches, and it cost a live e2e run: the tiles took the pointer,
     * so a click aimed at the terminal landed on an overlay instead and every
     * keystroke after it went nowhere. Pane hit testing lives on the pane AREA,
     * which follows the click without swallowing it — and the terminal beneath
     * is a real tmux client, so tmux selects the pane itself either way.
     */
    const { root } = renderSurface([SPLIT]);
    for (const tile of root.querySelectorAll<HTMLElement>(".pane-tile")) {
      expect(tile.getAttribute("data-pane")).toBeTruthy();
      expect(tile.onpointerdown).toBeNull();
      expect(tile.oncontextmenu).toBeNull();
    }
  });

  it("prunes a window whose panes the daemon no longer reports as attachable", () => {
    /*
     * Bug this catches: the pane-stream wire carries no "window closed" frame,
     * so a killed window's last layout frame sits in the tab strip forever and
     * clicking it addresses a pane that is gone.
     */
    const { root } = renderSurface(
      [
        layout({ semanticWindowId: "window.editor" }),
        layout({
          semanticWindowId: "window.dead",
          windowName: "dead",
          currentWindow: false,
          panes: [{ pane: "pane.gone", left: 0, top: 0, width: 200, height: 50, active: true }],
        }),
      ],
      { livePanes: new Set(["pane.a"]) },
    );
    expect([...root.querySelectorAll(".window-tabs__tab")].map((tab) => tab.textContent)).toEqual([
      "editor",
    ]);
  });

  it("says so rather than blanking when no window is addressable yet", () => {
    const { root } = renderSurface([]);
    expect(root.querySelector(".tiled-pane-area__empty")?.textContent).toContain(
      "No addressable window",
    );
  });
});
