import { ApplicationShellProjectionInputV3SchemaZ } from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import { createBrowserHostCapabilities } from "../host-capabilities.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { DomApplicationShell } from "./application-shell.tsx";
import { createDomExperience } from "./dom-experience.ts";
import { createDefaultDomPaneFrames, createDefaultDomShellInput } from "./dom-shell.ts";

const paneFrames = createDefaultDomPaneFrames();
const base = createDefaultDomShellInput();
const terminalFrames = paneFrames.slice(0, 2);
const windows = Object.fromEntries(
  terminalFrames.map((frame, index) => {
    const id = `window.first-run.${index}`;
    return [
      id,
      {
        id,
        source: { kind: "terminal" as const, terminalSourceId: frame.pane.id },
        title: frame.title,
        placement: {
          mode: "floating" as const,
          docked: null,
          floating: {
            x: 48 + index * 32,
            y: 40 + index * 28,
            width: 840,
            height: 520,
          },
        },
      },
    ];
  }),
);
const floatingOrder = Object.keys(windows);
const focusedWindowId = floatingOrder.at(-1) ?? null;
const input = ApplicationShellProjectionInputV3SchemaZ.parse({
  ...base,
  workspace: { ...base.workspace, activeMode: "terminals" },
  dock: { ...base.dock, mode: "collapsed" },
  terminalInventory: {
    activeResourceId: terminalFrames.at(-1)?.pane.id ?? null,
    resources: paneFrames.map((frame) => ({
      id: frame.pane.id,
      title: frame.title,
      kind: "agent" as const,
      active: frame.pane.id === terminalFrames.at(-1)?.pane.id,
      attachability: { status: "available" as const, semanticPaneId: frame.pane.id },
    })),
  },
  appWindows: {
    version: 1,
    revision: 0,
    updatedAt: "2026-07-22T16:00:00.000Z",
    windows,
    dockRoot: null,
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder,
    focusedWindowId,
    activeLayoutId: null,
    layouts: {},
  },
});

/** Full-window visual acceptance fixture for the native first-run canvas. */
export function mountDesktopCanvasFirstRunFixture(
  root: HTMLElement,
  appearance: "dark" | "light" = "dark",
): () => void {
  const experience = createDomExperience({ hostTheme: { mode: appearance } });
  let disposeStyle: (() => void) | null = null;
  const dispose = render(
    () => (
      <div
        ref={(element) => {
          const binding = createRuntimeStyleBinding(element);
          binding.update(experience.variables);
          disposeStyle = () => binding.dispose();
        }}
        class="app"
        data-theme={appearance}
        data-platform="darwin"
        data-reduced-motion="false"
        data-shell-source="visual-smoke"
      >
        <DomApplicationShell
          host={createBrowserHostCapabilities()}
          runtime="browser"
          platform="darwin"
          input={input}
          dataMode="runtime"
          paneFrames={paneFrames}
          terminalTransport={null}
          onAppWindowCommand={() => undefined}
        />
      </div>
    ),
    root,
  );
  return () => {
    dispose();
    disposeStyle?.();
  };
}
