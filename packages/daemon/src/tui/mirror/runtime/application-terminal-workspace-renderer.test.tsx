/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { ApplicationTerminalWorkspace } from "./application-terminal-workspace.tsx";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";

function layout(): OpenTuiWorkspaceLayoutSnapshot {
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols: 30,
    rows: 9,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [
      { pane: "pane.a", left: 0, top: 0, width: 10, height: 9, active: true },
      { pane: "pane.b", left: 10, top: 0, width: 10, height: 9, active: false },
      { pane: "pane.c", left: 20, top: 0, width: 10, height: 9, active: false },
    ],
  };
  return Object.freeze({ current, windows: Object.freeze([current]) });
}

function adapter(
  cells: Readonly<Record<string, string>>,
  blits: string[],
): PaneScopedTerminalAdapter {
  const renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (paneId, buffers, width, height, _scroll, _fg, _bg, options) => {
      blits.push(paneId);
      buffers.char.fill(32);
      buffers.attributes.fill(0);
      buffers.char[0] = (cells[paneId] ?? "?").codePointAt(0)!;
      for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
      return null;
    },
  };
  return {
    renderSource,
    paneVersion: () => 1,
    paneSourceEpoch: () => 1,
    subscribePaneVersion: () => () => undefined,
  };
}

describe("ApplicationTerminalWorkspace", () => {
  it("mounts every canonical pane, paints cells, and has no optional tool dock", async () => {
    registerPaneSurface();
    const blits: string[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout()}
          adapter={adapter({ "pane.a": "A", "pane.b": "B", "pane.c": "C" }, blits)}
          rendererEpoch={1}
          width={30}
          height={9}
          focusedPane="pane.a"
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
        />
      ),
      { width: 30, height: 11 },
    );

    await setup.renderOnce();

    expect(new Set(blits)).toEqual(new Set(["pane.a", "pane.b", "pane.c"]));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("A");
    expect(frame).toContain("B");
    expect(frame).toContain("C");
    expect(frame).not.toContain("Files");
    expect(frame).not.toContain("Changes");
    expect(frame).not.toContain("Missions");
    expect(frame).not.toContain("Activity");
    setup.renderer.destroy();
  });

  it("fully repaints generation B seed v1 over generation A seed v1", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const firstBlits: string[] = [];
    const secondBlits: string[] = [];
    const [source, setSource] = createSignal({
      adapter: adapter({ "pane.a": "A", "pane.b": "A", "pane.c": "A" }, firstBlits),
      epoch: 1,
    });
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout()}
          adapter={source().adapter}
          rendererEpoch={source().epoch}
          width={30}
          height={9}
          focusedPane="pane.a"
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
        />
      ),
      { width: 30, height: 11 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("A");

    setSource({
      adapter: adapter({ "pane.a": "B", "pane.b": "B", "pane.c": "B" }, secondBlits),
      epoch: 2,
    });
    await setup.renderOnce();

    expect(new Set(secondBlits)).toEqual(new Set(["pane.a", "pane.b", "pane.c"]));
    expect(setup.captureCharFrame()).toContain("B");
    setup.renderer.destroy();
  });
});
