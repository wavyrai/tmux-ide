import { AppWindowDocumentV1SchemaZ } from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import { AppWindowCanvas } from "./app-window-canvas.tsx";

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
