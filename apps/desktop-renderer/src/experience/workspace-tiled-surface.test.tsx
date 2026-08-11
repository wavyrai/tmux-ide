/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  PANE_COMMUNICATION_HIGHLIGHT_MS,
  WorkspaceTiledSurface,
  paneCommunicationCopy,
  renderedTerminalGridRect,
  terminalGridOverlayBox,
} from "./workspace-tiled-surface.tsx";
import type { PaneStreamLayoutEvent } from "../terminal/pane-stream-transport.ts";
import { createRecordingMirrorRendererFactory } from "../terminal/mirror-pane-fixture.ts";
import type { AppWindowCanvasMirrorProps } from "./app-window-canvas.tsx";
import { createDefaultDomPaneFrames } from "./dom-shell.ts";

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
    paneBorderStatus: "top",
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

const SWAPPED_SPLIT = layout({
  panes: [
    { pane: "pane.a", left: 100, top: 0, width: 100, height: 50, active: true },
    { pane: "pane.b", left: 0, top: 0, width: 99, height: 50, active: false },
  ],
});

const STACKED = layout({
  panes: [
    { pane: "pane.a", left: 0, top: 0, width: 200, height: 24, active: true },
    { pane: "pane.b", left: 0, top: 25, width: 200, height: 25, active: false },
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
  it("anchors pane chrome to the xterm grid instead of its padded viewport", () => {
    /*
     * The viewport includes the terminal-background gutter. Using its rect for
     * row-based pane chrome shifts the header above xterm and clips the first
     * output row. The stable outer xterm box is the grid, while the viewport is
     * retained only as the pre-mount fallback.
     */
    const area = document.createElement("div");
    const viewport = document.createElement("div");
    const grid = document.createElement("div");
    viewport.className = "terminal-surface__viewport";
    grid.className = "xterm";
    viewport.append(grid);
    area.append(viewport);

    const areaRect = {
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      width: 800,
      height: 500,
    } as DOMRect;
    const viewportRect = {
      x: 101,
      y: 51,
      left: 101,
      top: 51,
      width: 798,
      height: 498,
    } as DOMRect;
    const gridRect = {
      x: 108,
      y: 57,
      left: 108,
      top: 57,
      width: 784,
      height: 486,
    } as DOMRect;
    area.getBoundingClientRect = () => areaRect;
    viewport.getBoundingClientRect = () => viewportRect;
    grid.getBoundingClientRect = () => gridRect;
    Object.defineProperties(area, {
      clientLeft: { value: 1 },
      clientTop: { value: 1 },
      clientWidth: { value: 798 },
      clientHeight: { value: 498 },
    });

    expect(renderedTerminalGridRect(area)).toBe(gridRect);
    expect(terminalGridOverlayBox(area)).toEqual({ left: 7, top: 6, width: 784, height: 486 });
    grid.remove();
    expect(renderedTerminalGridRect(area)).toBe(viewportRect);
    expect(terminalGridOverlayBox(area)).toEqual({ left: 0, top: 0, width: 798, height: 498 });
  });

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

  it("places the tiles at exactly the frame's proportions, meeting on the border cell", () => {
    const { root } = renderSurface([SPLIT]);
    const tiles = [...root.querySelectorAll<HTMLElement>(".pane-tile")];
    expect(tiles.map((tile) => tile.dataset.pane)).toEqual(["pane.a", "pane.b"]);
    // Each box claims half of the one cell tmux spends on the border between
    // them, so the left tile ends exactly where the right one starts and the two
    // outlines coincide (m50.2, gap 4).
    expect(tiles[0]!.style.width).toBe("49.7500%");
    expect(tiles[1]!.style.left).toBe("49.7500%");
  });

  it("composes each terminal below a real chrome row without remounting it on stream state", () => {
    const recording = createRecordingMirrorRendererFactory();
    const node = (pane: string, state: "connecting" | "live") => ({
      pane,
      title: pane,
      frame: null,
      state:
        state === "connecting"
          ? ({ kind: "connecting" } as const)
          : ({ kind: "live", flowPaused: false } as const),
      registerSink: () => () => undefined,
    });
    const initial: AppWindowCanvasMirrorProps = {
      enabled: true,
      onToggle: vi.fn(),
      nodes: [node("pane.a", "connecting"), node("pane.b", "connecting")],
      connection: { kind: "connected" },
      onRetry: vi.fn(),
      rendererFactory: recording.factory,
    };
    const [mirror, setMirror] = createSignal(initial);
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <WorkspaceTiledSurface
            layouts={[SPLIT]}
            workspaceName="workspace.product"
            transport={null}
            paneFrames={[]}
            verbs={{ workspaceConnected: true, invoke: vi.fn() }}
            mirror={mirror()}
          />
        ),
        root,
      ),
    );

    expect(root.querySelector(".tiled-pane-area")?.getAttribute("data-pane-compositor")).toBe(
      "true",
    );
    expect(root.querySelectorAll('.pane-tile[data-composed="true"]')).toHaveLength(2);
    expect(root.querySelectorAll(".pane-tile__body > .mirror-pane-node")).toHaveLength(2);
    expect(root.querySelectorAll(".mirror-deck")).toHaveLength(0);
    expect(recording.renderers).toHaveLength(2);

    setMirror({
      ...initial,
      nodes: [node("pane.a", "live"), node("pane.b", "live")],
    });

    // A seed changes node state before it paints. Re-keying on the node object
    // here used to destroy both renderers at that exact boundary and lose the
    // seed, leaving six blank panes marked "live" in the real workspace.
    expect(recording.renderers).toHaveLength(2);
    const headers = [...root.querySelectorAll<HTMLElement>(".pane-tile__header")];
    expect(headers.every((header) => header.style.top === "0px")).toBe(true);
    expect(headers.every((header) => !header.style.height.includes("calc"))).toBe(true);
  });

  it("keeps a single-pane window on its one interactive terminal renderer", () => {
    const recording = createRecordingMirrorRendererFactory();
    const mirror: AppWindowCanvasMirrorProps = {
      enabled: true,
      onToggle: vi.fn(),
      nodes: [
        {
          pane: "pane.a",
          title: "Editor",
          frame: null,
          state: { kind: "live", flowPaused: false },
          registerSink: () => () => undefined,
        },
      ],
      connection: { kind: "connected" },
      onRetry: vi.fn(),
      rendererFactory: recording.factory,
    };
    const { root } = renderSurface([layout()], { mirror });

    expect(root.querySelector(".tiled-pane-area")?.getAttribute("data-pane-compositor")).toBe(
      "false",
    );
    expect(root.querySelectorAll('.pane-tile[data-composed="true"]')).toHaveLength(0);
    expect(root.querySelectorAll(".pane-tile__body > .mirror-pane-node")).toHaveLength(0);
  });

  it("selects and copies text from the visible composed pane", () => {
    const recording = createRecordingMirrorRendererFactory();
    const onFocusPane = vi.fn();
    const mirror: AppWindowCanvasMirrorProps = {
      enabled: true,
      onToggle: vi.fn(),
      nodes: [
        {
          pane: "pane.a",
          title: "Editor",
          frame: null,
          state: { kind: "live", flowPaused: false },
          registerSink: () => () => undefined,
        },
        {
          pane: "pane.b",
          title: "Tests",
          frame: null,
          state: { kind: "live", flowPaused: false },
          registerSink: () => () => undefined,
        },
      ],
      connection: { kind: "connected" },
      onRetry: vi.fn(),
      rendererFactory: recording.factory,
    };
    const { root } = renderSurface([SPLIT], { mirror, onFocusPane });
    const body = root.querySelector<HTMLElement>(
      '.pane-tile[data-composed="true"] > .pane-tile__body',
    )!;

    body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(onFocusPane).toHaveBeenCalledWith("pane.a", "mouse");

    recording.renderers[0]!.emitSelection("selected terminal text");
    const setData = vi.fn();
    const copy = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    body.dispatchEvent(copy);

    expect(setData).toHaveBeenCalledWith("text/plain", "selected terminal text");
    expect(copy.defaultPrevented).toBe(true);
  });

  it("highlights both endpoints of an authenticated pane relationship", () => {
    vi.useFakeTimers();
    const [feed, setFeed] = createSignal<{
      sequence: number;
      panes: NonNullable<Parameters<typeof WorkspaceTiledSurface>[0]["paneInteractions"]>;
    }>({ sequence: 0, panes: {} });
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <WorkspaceTiledSurface
            layouts={[SPLIT]}
            workspaceName="workspace.product"
            transport={null}
            paneFrames={[]}
            paneTitles={
              new Map([
                ["pane.a", "Editor"],
                ["pane.b", "Tests"],
              ])
            }
            verbs={{ workspaceConnected: true, invoke: vi.fn() }}
            paneInteractions={feed().panes}
            interactionSequence={feed().sequence}
          />
        ),
        root,
      ),
    );

    setFeed({
      sequence: 41,
      panes: {
        "pane.b": {
          paneId: "pane.b",
          direction: "incoming",
          sourcePaneId: null,
          destinationPaneId: "pane.b",
          operationKind: "workspace.pane.read",
          operationId: "10000000-0000-4000-8000-000000000041",
          phase: "observed",
          origin: "external",
          label: "external observed · pane read observed",
          sequence: 41,
          at: "2026-08-10T00:00:00.000Z",
        },
      },
    });
    expect(
      root.querySelector<HTMLElement>('.pane-tile[data-pane="pane.b"]')!.dataset
        .communicationActive,
    ).toBeUndefined();

    setFeed({
      sequence: 42,
      panes: {
        "pane.a": {
          paneId: "pane.a",
          direction: "outgoing",
          sourcePaneId: "pane.a",
          destinationPaneId: "pane.b",
          operationKind: "workspace.pane.send",
          operationId: "10000000-0000-4000-8000-000000000042",
          phase: "applied",
          origin: "sdk",
          label: "sdk applied · delivered 12 characters + Enter",
          sequence: 42,
          at: new Date().toISOString(),
        },
        "pane.b": {
          paneId: "pane.b",
          direction: "incoming",
          sourcePaneId: "pane.a",
          destinationPaneId: "pane.b",
          operationKind: "workspace.pane.send",
          operationId: "10000000-0000-4000-8000-000000000042",
          phase: "applied",
          origin: "sdk",
          label: "sdk applied · delivered 12 characters + Enter",
          sequence: 42,
          at: new Date().toISOString(),
        },
      },
    });

    const source = root.querySelector<HTMLElement>('.pane-tile[data-pane="pane.a"]')!;
    const target = root.querySelector<HTMLElement>('.pane-tile[data-pane="pane.b"]')!;
    expect(source.dataset.communicationActive).toBe("true");
    expect(source.dataset.communicationDirection).toBe("outgoing");
    expect(source.dataset.communicationRole).toBe("send-source");
    expect(source.dataset.communicationTreatment).toBe("transfer");
    expect(source.querySelector(".pane-tile__communication")?.textContent).toContain(
      "Editor → Tests",
    );
    expect(target.dataset.communicationActive).toBe("true");
    expect(target.dataset.communicationDirection).toBe("incoming");
    expect(target.dataset.communicationRole).toBe("send-target");
    expect(target.dataset.communicationTreatment).toBe("transfer");
    expect(target.querySelector(".pane-tile__communication")?.textContent).toContain(
      "Editor → Tests",
    );

    vi.advanceTimersByTime(PANE_COMMUNICATION_HIGHLIGHT_MS);
    expect(source.dataset.communicationActive).toBeUndefined();
    expect(target.dataset.communicationActive).toBeUndefined();
    expect(target.querySelector(".pane-tile__communication")).toBeNull();
    vi.useRealTimers();
  });

  it("uses honest privacy-safe copy for observed and authored pane sends", () => {
    const common = {
      paneId: "pane.b",
      direction: "incoming" as const,
      sourcePaneId: null,
      destinationPaneId: "pane.b",
      operationKind: "workspace.pane.send" as const,
      operationId: "10000000-0000-4000-8000-000000000042",
      sequence: 42,
      at: "2026-08-10T10:00:00.000Z",
    } as const;
    expect(
      paneCommunicationCopy({
        ...common,
        phase: "observed",
        origin: "external",
        label: "external observed · input observed",
      }),
    ).toEqual({ headline: "RECEIVED", detail: "External input → pane.b" });
    expect(
      paneCommunicationCopy({
        ...common,
        phase: "applied",
        origin: "sdk",
        label: "sdk applied · delivered 12 characters + Enter",
      }),
    ).toEqual({
      headline: "RECEIVED",
      detail: "SDK input → pane.b",
    });
    expect(
      paneCommunicationCopy({
        ...common,
        operationKind: "workspace.pane.read",
        phase: "observed",
        origin: "external",
        label: "external observed · pane read observed",
      }),
    ).toEqual({ headline: "READ", detail: "External reader reads pane.b" });
  });

  it("renders agent identity and live state in both the process tab and pane card", () => {
    const base = createDefaultDomPaneFrames()[0]!;
    const frame = {
      ...base,
      pane: {
        ...base.pane,
        id: "pane.a",
        kind: "terminal" as const,
        icon: "agent-claude" as const,
      },
      title: "Claude Code",
      status: base.status ? { ...base.status, label: "Running" } : null,
    };
    const { root } = renderSurface([layout()], { paneFrames: [frame] });

    expect(root.querySelector(".window-tabs__tab")?.getAttribute("data-identity-icon")).toBe(
      "agent-claude",
    );
    expect(root.querySelector(".pane-tile")?.getAttribute("data-identity-icon")).toBe(
      "agent-claude",
    );
    expect(root.querySelector(".pane-tile__icon-badge")?.getAttribute("data-identity-icon")).toBe(
      "agent-claude",
    );
    expect(root.querySelector(".pane-tile__status")?.textContent).toContain("Running");
  });

  it("hoists a pane's header into the separator row tmux draws above it", () => {
    /*
     * Bug this catches: the header is drawn inside the pane's own box, so it
     * covers the first row of that pane's output for as long as the app is open
     * — a line of every pane's terminal spent on a title bar. The row above the
     * pane is one tmux already spends on a separator, and the height proves the
     * header is sized from the frame rather than from a CSS constant that would
     * drift out of the row as the window resizes.
     */
    const stacked = layout({
      paneBorderStatus: "off",
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 200, height: 24, active: true },
        { pane: "pane.b", left: 0, top: 25, width: 200, height: 25, active: false },
      ],
    });
    const { root } = renderSurface([stacked]);
    const headers = [...root.querySelectorAll<HTMLElement>(".pane-tile__header")];
    // The top pane is flush with the window's top edge: no separator row exists
    // above it, so its header stays hidden rather than covering terminal output.
    expect(headers.map((header) => header.dataset.hoisted)).toEqual(["false", "true"]);
    // One row of a tile that is 25 pane rows plus the borrowed separator row.
    expect(headers[1]!.style.top).toBe("1px");
    expect(headers[1]!.style.height).toBe(`calc(${((1 / 26) * 100).toFixed(4)}% - 1px)`);
  });

  it("arms the pane header's close before it kills anything", () => {
    /*
     * Bug this catches: close fires on the first click. It sits one row tall,
     * next to the menu button, over a terminal a user is typing into — exactly
     * the geometry a mis-aimed click happens in — and killing a pane takes the
     * process and its scrollback with it.
     */
    const { root, invoke } = renderSurface([SPLIT]);
    const close = root.querySelector<HTMLButtonElement>('[data-pane-close="pane.a"]')!;
    close.click();
    expect(invoke).not.toHaveBeenCalled();
    expect(close.dataset.confirmPending).toBe("true");
    expect(close.getAttribute("aria-label")).toContain("cannot be undone");
    close.click();
    expect(invoke).toHaveBeenCalledWith("pane.kill", "pane.a");
    expect(root.querySelector<HTMLElement>('[data-pane="pane.a"]')!.dataset.ending).toBe("true");
  });

  it("toggles tmux zoom from a double pointer-click on panel chrome", () => {
    const { root, invoke } = renderSurface([SPLIT]);
    const header = root.querySelector<HTMLElement>(".pane-tile__header")!;
    header.setPointerCapture = () => undefined;
    const pointer = (type: string): PointerEvent => {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        isPrimary: { value: true },
        pointerType: { value: "mouse" },
      });
      return event as PointerEvent;
    };
    header.dispatchEvent(pointer("pointerdown"));
    header.dispatchEvent(pointer("pointerup"));
    header.dispatchEvent(pointer("pointerdown"));
    expect(invoke).toHaveBeenCalledWith("window.zoom.toggle", "pane.a", {
      desiredZoom: "zoomed",
    });
  });

  it("opens the pane menu from the header's own control, under that control", () => {
    const opened = vi.fn();
    const { root } = renderSurface([SPLIT], { onOpenPaneMenu: opened });
    root.querySelector<HTMLButtonElement>('[data-pane-menu="pane.b"]')!.click();
    expect(opened).toHaveBeenCalledWith("pane.b", expect.objectContaining({ x: 0, y: 0 }));
  });

  it("re-tiles from the next frame with no renderer-owned geometry in between", () => {
    // The view is a pure function of the frame, so the same surface fed a split
    // frame IS the split having re-tiled it — there is no stored rectangle in
    // between that could have survived and disagreed.
    expect(renderSurface([layout()]).root.querySelectorAll(".pane-tile")).toHaveLength(1);
    expect(renderSurface([SPLIT]).root.querySelectorAll(".pane-tile")).toHaveLength(2);
  });

  it("uses the whole panel header as the drag handle", () => {
    const { root, invoke } = renderSurface([SPLIT]);
    const overlay = root.querySelector<HTMLElement>(".tiled-pane-area__overlay")!;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1_000, height: 500, right: 1_000, bottom: 500 }) as DOMRect;
    const header = root.querySelector<HTMLElement>(".pane-tile__header")!;
    header.setPointerCapture = () => undefined;
    header.releasePointerCapture = () => undefined;
    const pointer = (type: string, x: number): PointerEvent => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 10 });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        isPrimary: { value: true },
        pointerType: { value: "mouse" },
      });
      return event as PointerEvent;
    };
    header.dispatchEvent(pointer("pointerdown", 250));
    header.dispatchEvent(pointer("pointermove", 750));
    expect(root.querySelector(".pane-drop-ghost__label")?.textContent).toContain(
      "Swap with Terminal",
    );
    header.dispatchEvent(pointer("pointerup", 750));

    expect(invoke).toHaveBeenCalledWith("pane.swap", "pane.a", {
      swapTargetSemanticPaneId: "pane.b",
    });
    expect(root.querySelector(".pane-drop-ghost")).toBeNull();
    expect(root.querySelector<HTMLElement>(".tiled-pane-area")!.dataset.manipulationPhase).toBe(
      "swap-committing",
    );
    expect(root.querySelector<HTMLElement>('[data-pane="pane.a"]')!.dataset.elevated).toBe("false");
  });

  it("adopts the confirming tmux swap without replaying a FLIP transition", async () => {
    /*
     * Regression: release painted the optimistic destination, then the
     * confirming frame cleared its transform under an idle CSS transition and
     * FLIP sampled that interpolated box. The pane visibly moved, reverted and
     * moved again. A confirmed direct manipulation is already at its final
     * pixels, so adopting the authoritative base geometry must be animation-free.
     */
    const [frames, setFrames] = createSignal<readonly PaneStreamLayoutEvent[]>([SPLIT]);
    const invoke = vi.fn((verb: string) => {
      if (verb === "pane.swap") setFrames([SWAPPED_SPLIT]);
      return Promise.resolve({ status: "ok" as const });
    });
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <WorkspaceTiledSurface
            layouts={frames()}
            workspaceName="workspace.product"
            transport={null}
            paneFrames={[]}
            verbs={{ workspaceConnected: true, invoke }}
          />
        ),
        root,
      ),
    );
    const overlay = root.querySelector<HTMLElement>(".tiled-pane-area__overlay")!;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1_000, height: 500, right: 1_000, bottom: 500 }) as DOMRect;
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      finished: Promise.resolve(),
    }));
    for (const tile of root.querySelectorAll<HTMLElement>(".pane-tile")) {
      Object.defineProperty(tile, "animate", { configurable: true, value: animate });
    }
    // Let the initial authoritative snapshot seed before the gesture begins.
    await Promise.resolve();

    const header = root.querySelector<HTMLElement>('[data-pane="pane.a"] .pane-tile__header')!;
    header.setPointerCapture = () => undefined;
    header.releasePointerCapture = () => undefined;
    const pointer = (type: string, x: number): PointerEvent => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 10 });
      Object.defineProperties(event, {
        pointerId: { value: 8 },
        isPrimary: { value: true },
        pointerType: { value: "mouse" },
      });
      return event as PointerEvent;
    };
    header.dispatchEvent(pointer("pointerdown", 250));
    header.dispatchEvent(pointer("pointermove", 750));
    header.dispatchEvent(pointer("pointerup", 750));
    await Promise.resolve();
    await Promise.resolve();

    const area = root.querySelector<HTMLElement>(".tiled-pane-area")!;
    expect(area.dataset.manipulationPhase).toBe("idle");
    expect(area.dataset.layoutTransitionRevision).toBe("0");
    expect(animate).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('[data-pane="pane.a"]')!.style.left).toBe("49.7500%");
    expect(root.querySelector<HTMLElement>('[data-pane="pane.a"]')!.style.transform).toBe("");
  });

  it("puts a draggable border on tmux's own border cell, and none when there is one pane", () => {
    const { root } = renderSurface([SPLIT]);
    const border = root.querySelector<HTMLElement>(".pane-border")!;
    expect(border.dataset.orientation).toBe("vertical");
    expect(border.style.left).toBe("calc(49.7500% - 4px)");
    expect(border.style.width).toBe("8px");
    expect(border.tabIndex).toBe(0);
    expect(border.getAttribute("aria-valuenow")).toBe("99");
    expect(border.getAttribute("aria-valuemax")).toBe("200");
    expect(renderSurface([layout()]).root.querySelectorAll(".pane-border")).toHaveLength(0);
  });

  it("keeps pointer resize on the compositor and commits to tmux only on release", () => {
    const { root, invoke } = renderSurface([SPLIT]);
    const overlay = root.querySelector<HTMLElement>(".tiled-pane-area__overlay")!;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1_000, height: 500, right: 1_000, bottom: 500 }) as DOMRect;
    const border = root.querySelector<HTMLElement>('.pane-border[data-orientation="vertical"]')!;
    border.setPointerCapture = () => undefined;
    border.releasePointerCapture = () => undefined;
    const pointer = (type: string, x: number): PointerEvent => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 200 });
      Object.defineProperties(event, {
        pointerId: { value: 9 },
        isPrimary: { value: true },
        pointerType: { value: "mouse" },
      });
      return event as PointerEvent;
    };
    const left = root.querySelector<HTMLElement>('[data-pane="pane.a"]')!;
    const right = root.querySelector<HTMLElement>('[data-pane="pane.b"]')!;
    const baseWidths = [left.style.width, right.style.width];

    border.dispatchEvent(pointer("pointerdown", 500));
    border.dispatchEvent(pointer("pointermove", 550));

    expect([left.style.width, right.style.width]).toEqual(baseWidths);
    expect(left.style.transform).toContain("scale(");
    expect(right.style.transform).toContain("scale(");
    expect(invoke.mock.calls.filter(([verb]) => verb === "pane.resize")).toHaveLength(0);

    border.dispatchEvent(pointer("pointerup", 550));
    expect(invoke.mock.calls.filter(([verb]) => verb === "pane.resize")).toEqual([
      ["pane.resize", "pane.a", { resize: { axis: "cols", cells: 109 } }],
    ]);
  });

  it("keeps horizontal resize authority on the edge instead of consuming panel chrome", () => {
    const { root } = renderSurface([STACKED]);
    const border = root.querySelector<HTMLElement>('.pane-border[data-orientation="horizontal"]')!;
    expect(border.style.top).toMatch(/^calc\(.+% - 4px\)$/u);
    expect(border.style.height).toBe("8px");
  });

  it("resizes a focused separator one cell with its directional arrow key", () => {
    const { root, invoke } = renderSurface([SPLIT]);
    const overlay = root.querySelector<HTMLElement>(".tiled-pane-area__overlay")!;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1_000, height: 500, right: 1_000, bottom: 500 }) as DOMRect;
    const border = root.querySelector<HTMLElement>('.pane-border[data-orientation="vertical"]')!;
    border.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    expect(invoke).toHaveBeenCalledWith("pane.resize", "pane.a", {
      resize: { axis: "cols", cells: 100 },
    });
    expect(root.querySelector<HTMLElement>(".tiled-pane-area")!.dataset.manipulationPhase).toBe(
      "resize-committing",
    );
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

  it("moves the border while the pointer drags, throttled, and flushes on release", async () => {
    /*
     * Bug this catches at both ends: a resize per pointermove spends a
     * serialized daemon round trip per frame of mouse movement, and sending
     * nothing until release leaves the user dragging a handle over panes that
     * do not move. It also pins the ABSOLUTE form — under a throttle a dropped
     * delta silently loses its movement and the border drifts off the pointer,
     * while a restated size is self-correcting.
     */
    const { root, invoke } = renderSurface([SPLIT]);
    const border = root.querySelector<HTMLElement>(".pane-border")!;
    const overlay = root.querySelector<HTMLElement>(".tiled-pane-area__overlay")!;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1_000, height: 500, right: 1_000, bottom: 500 }) as DOMRect;
    border.setPointerCapture = () => undefined;
    border.releasePointerCapture = () => undefined;
    const pointer = (type: string, x: number): PointerEvent => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: 200,
      });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        isPrimary: { value: true },
      });
      return event as PointerEvent;
    };
    border.dispatchEvent(pointer("pointerdown", 495));
    expect(root.querySelector<HTMLElement>(".tiled-pane-area")!.dataset.manipulationPhase).toBe(
      "resize-preview",
    );
    border.dispatchEvent(pointer("pointermove", 505));
    expect(
      root.querySelector<HTMLElement>(".tiled-pane-area")!.dataset.manipulationPreviewCells,
    ).toBe("101");
    expect(root.querySelector(".pane-resize-hud")?.textContent).toContain("101 cols");
    expect(root.querySelector(".pane-resize-hud")?.textContent).toContain("+2");
    border.dispatchEvent(pointer("pointerup", 505));
    expect(root.querySelector(".pane-resize-hud")).toBeNull();
    expect(root.querySelector<HTMLElement>(".tiled-pane-area")!.dataset.manipulationPhase).toBe(
      "resize-committing",
    );

    const resizes = invoke.mock.calls.filter(([verbId]) => verbId === "pane.resize");
    expect(resizes.length, "the release did not flush a resize").toBe(1);
    expect(resizes[0]![1]).toBe("pane.a");
    expect(resizes[0]![2]).toEqual({ resize: { axis: "cols", cells: 101 } });
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
