import {
  AppWindowDocumentV1SchemaZ,
  resolvePaneAppearance,
  type ApplicationShellTerminalInventory,
  type AppWindowInstance,
} from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { AppWindowCanvas } from "./app-window-canvas.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";

const document = AppWindowDocumentV1SchemaZ.parse({
  version: 1,
  revision: 1,
  updatedAt: "2026-07-22T00:00:00.000Z",
  windows: {
    "window.docked": {
      id: "window.docked",
      source: { kind: "terminal", terminalSourceId: "terminal.docked" },
      title: "Docked smoke window",
      placement: {
        mode: "docked",
        docked: { stackId: "stack.smoke", index: 0 },
        floating: null,
      },
    },
    "window.floating": {
      id: "window.floating",
      source: { kind: "terminal", terminalSourceId: "terminal.floating" },
      title: "Floating smoke window",
      placement: {
        mode: "floating",
        docked: null,
        floating: { x: 42, y: 36, width: 360, height: 220 },
      },
    },
  },
  dockRoot: {
    type: "stack",
    id: "stack.smoke",
    windowIds: ["window.docked"],
    activeWindowId: "window.docked",
  },
  dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
  floatingOrder: ["window.floating"],
  focusedWindowId: "window.floating",
  activeLayoutId: null,
  layouts: {},
});

/** Real-browser strict-CSP geometry probe; never mounted by the product shell. */
export function mountAppWindowCanvasSmokeFixture(root: HTMLElement): () => void {
  return render(
    () => (
      <AppWindowCanvas
        document={document}
        paneFrames={[]}
        workspaceName="csp-smoke"
        viewport={{ width: 800, height: 500 }}
      />
    ),
    root,
  );
}

const GROUPED_WINDOW_ID = "terminal-window.0123456789abcdef0123";
const GROUPED_PANE_COUNT = 9;

function fixturePaneFrame(sourceId: string, title: string): PaneFrameModel {
  const appearance = resolvePaneAppearance({
    structure: "floating",
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
    pane: { id: sourceId, kind: "terminal" },
    appearance,
    title,
    subtitle: "tmux",
    status: null,
    chips: [],
    actions: [],
  };
}

/**
 * A nine-pane window (grouped into ONE card) beside a single-pane window
 * (unchanged). Exercises the attach-5 coalescing + size-passive letterbox in a
 * real browser under strict CSP; never mounted by the product shell.
 */
export function mountAppWindowCanvasGroupedFixture(
  root: HTMLElement,
  options: { readonly transport?: NativeTerminalTransport | null } = {},
): () => void {
  const windows: Record<string, AppWindowInstance> = {};
  const floatingOrder: string[] = [];
  for (let index = 0; index < GROUPED_PANE_COUNT; index += 1) {
    const windowId = `window.grid.${index}`;
    windows[windowId] = {
      id: windowId,
      source: { kind: "terminal", terminalSourceId: `terminal.grid.${index}` },
      title: null,
      placement: {
        mode: "floating",
        docked: null,
        floating: { x: 40 + index * 12, y: 30 + index * 10, width: 420, height: 260 },
      },
    };
    floatingOrder.push(windowId);
  }
  windows["window.solo"] = {
    id: "window.solo",
    source: { kind: "terminal", terminalSourceId: "terminal.solo" },
    title: "Solo shell",
    placement: {
      mode: "floating",
      docked: null,
      floating: { x: 520, y: 60, width: 360, height: 240 },
    },
  };
  floatingOrder.push("window.solo");
  const groupedDocument = AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 2,
    updatedAt: "2026-07-22T00:00:00.000Z",
    windows,
    dockRoot: null,
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder,
    focusedWindowId: null,
    activeLayoutId: null,
    layouts: {},
  });
  const inventory: ApplicationShellTerminalInventory = {
    activeResourceId: "terminal.grid.0",
    resources: [
      ...Array.from({ length: GROUPED_PANE_COUNT }, (_unused, index) => ({
        id: `terminal.grid.${index}`,
        title: `Pane ${index}`,
        kind: "terminal" as const,
        active: index === 0,
        attachability: {
          status: "available" as const,
          semanticPaneId: `terminal.grid.${index}`,
        },
        windowResourceId: GROUPED_WINDOW_ID,
      })),
      {
        id: "terminal.solo",
        title: "Solo shell",
        kind: "terminal" as const,
        active: false,
        attachability: { status: "available" as const, semanticPaneId: "terminal.solo" },
      },
    ],
  };
  const paneFrames = [
    ...Array.from({ length: GROUPED_PANE_COUNT }, (_unused, index) =>
      fixturePaneFrame(`terminal.grid.${index}`, `Nine-pane window`),
    ),
    fixturePaneFrame("terminal.solo", "Solo shell"),
  ];
  return render(
    () => (
      <AppWindowCanvas
        document={groupedDocument}
        paneFrames={paneFrames}
        terminalInventory={inventory}
        workspaceName="csp-smoke"
        viewport={{ width: 1_000, height: 640 }}
        transport={options.transport}
      />
    ),
    root,
  );
}
