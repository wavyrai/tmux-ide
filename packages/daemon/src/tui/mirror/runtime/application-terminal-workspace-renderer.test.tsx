/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";

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
      { pane: "pane.b", left: 11, top: 0, width: 9, height: 9, active: false },
      { pane: "pane.c", left: 21, top: 0, width: 9, height: 9, active: false },
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
    let character = "A";
    let sourceEpoch = 1;
    const firstBlits: string[] = [];
    const secondBlits: string[] = [];
    const listeners = new Map<string, (version: number, sourceEpoch: number) => void>();
    let subscribed = 0;
    let cleaned = 0;
    const renderSource: TerminalPaneRenderSource = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (paneId, buffers, width, height, _scroll, _fg, _bg, options) => {
        (sourceEpoch === 1 ? firstBlits : secondBlits).push(paneId);
        buffers.char.fill(32);
        buffers.attributes.fill(0);
        buffers.char[0] = character.codePointAt(0)!;
        for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
        return null;
      },
    };
    const generationAdapter: PaneScopedTerminalAdapter = {
      renderSource,
      paneVersion: () => 1,
      paneSourceEpoch: () => sourceEpoch,
      subscribePaneVersion: (paneId, listener) => {
        subscribed += 1;
        listeners.set(paneId, listener);
        return () => {
          cleaned += 1;
          listeners.delete(paneId);
        };
      },
    };
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout()}
          adapter={generationAdapter}
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
    expect(setup.captureCharFrame()).toContain("A");
    expect({ subscribed, cleaned, listeners: listeners.size }).toEqual({
      subscribed: 3,
      cleaned: 0,
      listeners: 3,
    });

    character = "B";
    sourceEpoch = 2;
    for (const listener of listeners.values()) listener(1, sourceEpoch);
    await setup.renderOnce();

    expect(new Set(secondBlits)).toEqual(new Set(["pane.a", "pane.b", "pane.c"]));
    expect(setup.captureCharFrame()).toContain("B");
    setup.renderer.destroy();
  });

  it("independently invalidates and paints both visible pane rectangles after mount", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const cells: Record<string, string> = {
      "pane.a": "A-seed",
      "pane.b": "B-seed",
      "pane.c": "C-seed",
    };
    const versions: Record<string, number> = {
      "pane.a": 1,
      "pane.b": 1,
      "pane.c": 1,
    };
    const listeners = new Map<string, (version: number, sourceEpoch: number) => void>();
    const blits: string[] = [];
    const renderSource: TerminalPaneRenderSource = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (paneId, buffers, width, height, _scroll, _fg, _bg, options) => {
        blits.push(paneId);
        buffers.char.fill(32);
        buffers.attributes.fill(0);
        const value = cells[paneId] ?? "";
        for (let column = 0; column < Math.min(width, value.length); column += 1)
          buffers.char[column] = value.codePointAt(column)!;
        for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
        return null;
      },
    };
    const liveAdapter: PaneScopedTerminalAdapter = {
      renderSource,
      paneVersion: (paneId) => versions[paneId] ?? 0,
      paneSourceEpoch: () => 1,
      subscribePaneVersion: (paneId, listener) => {
        listeners.set(paneId, listener);
        return () => listeners.delete(paneId);
      },
    };
    const twoPaneLayout = layout();
    const current = {
      ...twoPaneLayout.current!,
      cols: 101,
      rows: 31,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 50, height: 31, active: true },
        { pane: "pane.b", left: 51, top: 0, width: 50, height: 31, active: false },
      ],
    };
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={{ current, windows: [current] }}
          adapter={liveAdapter}
          rendererEpoch={1}
          width={101}
          height={31}
          focusedPane="pane.a"
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
        />
      ),
      { width: 101, height: 33 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("B-seed");

    blits.length = 0;
    cells["pane.a"] = "__pane_a_marker__";
    versions["pane.a"]! += 1;
    listeners.get("pane.a")?.(versions["pane.a"]!, 1);
    await setup.renderOnce();

    expect(blits).toEqual(["pane.a"]);
    let rows = setup.captureCharFrame().split("\n");
    let paneABody = rows
      .slice(3, 33)
      .map((row) => row.slice(0, 50))
      .join("\n");
    let paneBBody = rows
      .slice(3, 33)
      .map((row) => row.slice(51, 101))
      .join("\n");
    expect(paneABody).toContain("__pane_a_marker__");
    expect(paneBBody).toContain("B-seed");
    expect(paneBBody).not.toContain("__pane_a_marker__");

    blits.length = 0;
    cells["pane.b"] = "__pane_b_marker__";
    versions["pane.b"]! += 1;
    listeners.get("pane.b")?.(versions["pane.b"]!, 1);
    await setup.renderOnce();

    expect(blits).toEqual(["pane.b"]);
    rows = setup.captureCharFrame().split("\n");
    paneABody = rows
      .slice(3, 33)
      .map((row) => row.slice(0, 50))
      .join("\n");
    paneBBody = rows
      .slice(3, 33)
      .map((row) => row.slice(51, 101))
      .join("\n");
    expect(paneABody).toContain("__pane_a_marker__");
    expect(paneBBody).toContain("__pane_b_marker__");
    setup.renderer.destroy();
  });

  it("paints a local divider guide during drag and submits one semantic resize on release", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const previews: Array<{ semanticPaneId: string; axis: string; cells: number }> = [];
    const submissions: Array<{ semanticPaneId: string; axis: string; cells: number }> = [];
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout()}
          adapter={adapter({ "pane.a": "A", "pane.b": "B", "pane.c": "C" }, [])}
          rendererEpoch={1}
          width={30}
          height={9}
          focusedPane="pane.a"
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
          onResizePreview={(preview) => previews.push(preview)}
          onResizePane={(preview) => submissions.push(preview)}
        />
      ),
      { width: 30, height: 11 },
    );
    await setup.renderOnce();

    // Canonical pane.a is 10 cells wide; its tmux divider occupies x=10.
    // coordinates include the two app-owned rows above the tmux framebuffer.
    await setup.mockMouse.pressDown(10, 5, MouseButtons.LEFT);
    await setup.mockMouse.moveTo(12, 5);
    await setup.renderOnce();
    expect(previews.at(-1)).toMatchObject({
      semanticPaneId: "pane.a",
      axis: "cols",
      cells: 12,
    });
    await setup.mockMouse.release(12, 5, MouseButtons.LEFT);
    await setup.renderOnce();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      semanticPaneId: "pane.a",
      axis: "cols",
      cells: 12,
    });
    setup.renderer.destroy();
  });
});
