import type { PaneInteractionProjection } from "@tmux-ide/core";
/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { createSignal, type Accessor, type Setter } from "solid-js";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import {
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import {
  ApplicationTerminalWorkspace,
  beginApplicationMouseIngress,
  safeApplicationMouseIngressMicros,
  type ApplicationTerminalAgentIndicator,
} from "./application-terminal-workspace.tsx";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { PaneMenuKeyHandler } from "../workspace/pane-action-menu-model.ts";

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
    paneSelectionSnapshot: () => null,
  };
}

describe("ApplicationTerminalWorkspace", () => {
  it("follows local focus in compact view and restores the tiled view when enlarged", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const current = {
      ...layout().current!,
      cols: 50,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 50, height: 4, active: true },
        { pane: "pane.b", left: 0, top: 5, width: 50, height: 4, active: false },
      ],
    };
    const [focused, setFocused] = createSignal("pane.b");
    const [height, setHeight] = createSignal(3);
    const nativeSizes: Array<readonly { paneId: string; cols: number; rows: number }[]> = [];
    const source = adapter({ "pane.a": "A", "pane.b": "B" }, []);
    source.setNativePaneGeometries = (panes) => nativeSizes.push(panes);
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={() => ({ current, windows: [current] })}
          adapter={source}
          rendererEpoch={1}
          width={50}
          height={height()}
          focusedPane={focused()}
          theme={theme}
          palette={createTerminalPaletteProjection(theme)}
          onSelectPane={setFocused}
        />
      ),
      { width: 50, height: 12 },
    );
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Compact 2/2 · Ctrl+O: next");
      expect(setup.captureCharFrame().split("\n")[3]!.trim()).toBe("B");
      expect(nativeSizes).toEqual([
        [
          { paneId: "pane.a", cols: 50, rows: 4 },
          { paneId: "pane.b", cols: 50, rows: 4 },
        ],
      ]);
      setFocused("pane.a");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Compact 1/2 · Ctrl+O: next");
      expect(setup.captureCharFrame().split("\n")[3]!.trim()).toBe("A");
      setHeight(10);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Compact");
      expect(setup.captureCharFrame().split("\n")[3]!.trim()).toBe("A");
      expect(setup.captureCharFrame().split("\n")[8]!.trim()).toBe("B");
      expect(nativeSizes).toHaveLength(1);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("opens pane actions by keyboard, preserves the overlay tree and retires superseded menus", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    let handleKey: PaneMenuKeyHandler | null = null;
    let ownsInput: (() => boolean) | undefined;
    let setInteractive!: Setter<boolean>;
    let setLayout!: Setter<OpenTuiWorkspaceLayoutSnapshot>;
    const selected: string[] = [];
    const actions: string[] = [];
    const setup = await renderForTest(
      () => {
        const [interactive, updateInteractive] = createSignal(true);
        const [currentLayout, updateLayout] = createSignal(layout());
        setInteractive = updateInteractive;
        setLayout = updateLayout;
        return (
          <ApplicationTerminalWorkspace
            layout={currentLayout}
            adapter={adapter({ "pane.a": "A", "pane.b": "B", "pane.c": "C" }, [])}
            rendererEpoch={1}
            width={30}
            height={9}
            focusedPane="pane.a"
            interactive={interactive()}
            theme={theme}
            palette={createTerminalPaletteProjection(theme)}
            onSelectPane={(id) => selected.push(id)}
            onPaneContextAction={(_, action) => actions.push(action)}
            onSelectionKeyOwner={(handler, blocks) => {
              handleKey = handler;
              ownsInput = blocks;
            }}
          />
        );
      },
      { width: 30, height: 11 },
    );
    await setup.renderOnce();
    expect(handleKey?.("f10")).toBe(false);
    expect(handleKey?.("f10", { shift: true, eventType: "press" })).toBe(true);
    await setup.renderOnce();
    expect(selected).toEqual(["pane.a"]);
    expect(ownsInput?.()).toBe(true);
    const frame = setup.renderer.root.findDescendantById("ui-overlay-frame");
    handleKey?.("down");
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("ui-overlay-frame")).toBe(frame);
    expect(handleKey?.("y")).toBe(true);
    expect(handleKey?.("x", { ctrl: true })).toBe(true);
    expect(actions).toEqual([]);
    handleKey?.("escape");
    expect(ownsInput?.()).toBe(false);
    await setup.renderOnce();
    // Right click and keyboard opening converge on the same menu, without
    // making hover select another terminal or remounting its framebuffer.
    await setup.mockMouse.click(13, 2, MouseButtons.RIGHT);
    await setup.renderOnce();
    expect(selected.at(-1)).toBe("pane.b");
    expect(ownsInput?.()).toBe(true);
    setInteractive(false);
    await setup.renderOnce();
    expect(ownsInput?.()).toBe(false);
    expect(handleKey?.("f10", { shift: true })).toBe(false);
    setInteractive(true);
    expect(ownsInput?.()).toBe(false);
    handleKey?.("f10", { shift: true });
    const withoutA = {
      ...layout().current!,
      panes: layout().current!.panes.filter((p) => p.pane !== "pane.a"),
    };
    setLayout({ current: withoutA, windows: [withoutA] });
    await setup.renderOnce();
    expect(ownsInput?.()).toBe(false);
    expect(setup.captureCharFrame()).not.toContain("Rename pane");
    setup.renderer.destroy();
    expect(handleKey).toBeNull();
  });
  it("samples application-mouse ingress fail-open and only when enabled", () => {
    let calls = 0;
    expect(
      safeApplicationMouseIngressMicros(() => {
        calls += 1;
        return 12.345;
      }),
    ).toBe(12_345);
    expect(calls).toBe(1);
    expect(safeApplicationMouseIngressMicros(() => Number.NaN)).toBeNull();
    expect(
      safeApplicationMouseIngressMicros(() => {
        throw new Error("diagnostic clock failed");
      }),
    ).toBeNull();
    const disabledClock = () => {
      throw new Error("disabled clock must not be sampled");
    };
    expect(beginApplicationMouseIngress(undefined, disabledClock)).toBeNull();
  });
  it("retains inactive window subscriptions without waking their hidden surface", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const versions = new Map([
      ["pane.a", 1],
      ["pane.b", 1],
    ]);
    const listeners = new Map<string, (version: number, sourceEpoch: number) => void>();
    const subscriptions = new Map<string, number>();
    const unsubscriptions = new Map<string, number>();
    const blits: Array<{ paneId: string; full: boolean }> = [];
    const presentations: string[] = [];
    const windowA = {
      type: "layout" as const,
      semanticWindowId: "window.a",
      windowName: "a",
      currentWindow: true,
      cols: 30,
      rows: 9,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [{ pane: "pane.a", left: 0, top: 0, width: 30, height: 9, active: true }],
    };
    const windowB = {
      ...windowA,
      semanticWindowId: "window.b",
      windowName: "b",
      currentWindow: false,
      panes: [{ pane: "pane.b", left: 0, top: 0, width: 30, height: 9, active: true }],
    };
    const liveAdapter: PaneScopedTerminalAdapter = {
      renderSource: {
        scrollbackDepth: () => 0,
        cursorState: () => null,
        blitPane: (paneId, buffers, _width, height, _scroll, _fg, _bg, options) => {
          blits.push({ paneId, full: options.full });
          buffers.char.fill(32);
          buffers.attributes.fill(0);
          buffers.char[0] = (
            paneId === "pane.a" ? "A" : versions.get(paneId) === 2 ? "X" : "B"
          ).codePointAt(0)!;
          for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
          return null;
        },
      },
      paneVersion: (paneId) => versions.get(paneId) ?? 0,
      paneSourceEpoch: () => 1,
      subscribePaneVersion: (paneId, listener) => {
        subscriptions.set(paneId, (subscriptions.get(paneId) ?? 0) + 1);
        listeners.set(paneId, listener);
        return () => {
          unsubscriptions.set(paneId, (unsubscriptions.get(paneId) ?? 0) + 1);
          listeners.delete(paneId);
        };
      },
      paneSelectionSnapshot: () => null,
    };
    let workspaceLayout!: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
    let setWorkspaceLayout!: Setter<OpenTuiWorkspaceLayoutSnapshot>;
    const Harness = () => {
      [workspaceLayout, setWorkspaceLayout] = createSignal<OpenTuiWorkspaceLayoutSnapshot>({
        current: windowA,
        windows: [windowA, windowB],
      });
      return (
        <>
          <ApplicationTerminalWorkspace
            layout={workspaceLayout}
            adapter={liveAdapter}
            rendererEpoch={1}
            width={30}
            height={9}
            focusedPane="pane.a"
            theme={theme}
            palette={palette}
            onSelectPane={() => undefined}
            onWindowPresented={(windowId) => presentations.push(windowId)}
          />
          <text position="absolute" top={10}>
            {workspaceLayout().current?.semanticWindowId}
          </text>
        </>
      );
    };
    const setup = await renderForTest(() => <Harness />, { width: 30, height: 11 });
    await setup.renderOnce();
    expect(presentations.at(-1)).toBe("window.a");
    expect(Object.fromEntries(subscriptions)).toEqual({ "pane.a": 1, "pane.b": 1 });
    blits.length = 0;

    const inactiveA = { ...windowA, currentWindow: false };
    const activeB = { ...windowB, currentWindow: true };
    setWorkspaceLayout({ current: activeB, windows: [inactiveA, activeB] });
    expect(workspaceLayout().current?.semanticWindowId).toBe("window.b");
    await setup.renderOnce();
    expect(workspaceLayout().current?.semanticWindowId).toBe("window.b");
    expect(setup.captureCharFrame()).toContain("window.b");
    expect(blits).toEqual([{ paneId: "pane.b", full: true }]);
    expect(setup.captureCharFrame()).toContain("B");
    blits.length = 0;

    setWorkspaceLayout({ current: windowA, windows: [windowA, windowB] });
    await setup.renderOnce();
    expect(blits).toEqual([{ paneId: "pane.a", full: true }]);
    expect(setup.captureCharFrame()).toContain("A");
    blits.length = 0;

    versions.set("pane.b", 2);
    listeners.get("pane.b")?.(2, 1);
    await setup.renderOnce();
    expect(blits).toEqual([]);

    setWorkspaceLayout({ current: activeB, windows: [inactiveA, activeB] });
    await setup.renderOnce();
    expect(blits).toEqual([{ paneId: "pane.b", full: true }]);
    expect(setup.captureCharFrame()).toContain("X");
    blits.length = 0;

    setWorkspaceLayout({ current: windowA, windows: [windowA, windowB] });
    await setup.renderOnce();
    expect(blits).toEqual([{ paneId: "pane.a", full: true }]);
    blits.length = 0;
    await setup.renderOnce();
    expect(blits).toEqual([]);

    expect(Object.fromEntries(subscriptions)).toEqual({ "pane.a": 1, "pane.b": 1 });
    expect(Object.fromEntries(unsubscriptions)).toEqual({});
    setup.renderer.destroy();
  });

  it("keeps a quiet agent resident through chrome changes without coupling it to a chatty sibling", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const versions = new Map([
      ["pane.claude", 1],
      ["pane.macmon", 1],
    ]);
    const listeners = new Map<
      string,
      Parameters<PaneScopedTerminalAdapter["subscribePaneVersion"]>[1]
    >();
    const blits: Array<{ paneId: string; full: boolean }> = [];
    const terminalCells = new Map([
      ["pane.claude", "CLAUDE_QUIET"],
      ["pane.macmon", "MACMON_TICK_1"],
    ]);
    const liveAdapter: PaneScopedTerminalAdapter = {
      renderSource: {
        scrollbackDepth: () => 0,
        cursorState: () => null,
        blitPane: (paneId, buffers, width, height, _scroll, _fg, _bg, options) => {
          blits.push({ paneId, full: options.full });
          buffers.char.fill(32);
          buffers.attributes.fill(0);
          const text = terminalCells.get(paneId) ?? "";
          for (let column = 0; column < Math.min(width, text.length); column += 1)
            buffers.char[column] = text.codePointAt(column)!;
          for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
          return null;
        },
      },
      paneVersion: (paneId) => versions.get(paneId) ?? 0,
      paneSourceEpoch: () => 1,
      subscribePaneVersion: (paneId, listener) => {
        listeners.set(paneId, listener);
        return () => listeners.delete(paneId);
      },
      paneSelectionSnapshot: () => null,
    };
    const current = {
      type: "layout" as const,
      semanticWindowId: "window.agents",
      windowName: "agents",
      currentWindow: true,
      cols: 41,
      rows: 9,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [
        { pane: "pane.claude", left: 0, top: 0, width: 20, height: 9, active: true },
        { pane: "pane.macmon", left: 21, top: 0, width: 20, height: 9, active: false },
      ],
    };
    const [paneInteractions, setPaneInteractions] = createSignal<
      ReadonlyMap<string, PaneInteractionProjection>
    >(new Map());
    const [indicators, setIndicators] = createSignal<
      ReadonlyMap<string, ApplicationTerminalAgentIndicator>
    >(new Map());
    const [workspaceLayout, setWorkspaceLayout] = createSignal<OpenTuiWorkspaceLayoutSnapshot>({
      current,
      windows: [current],
    });
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={workspaceLayout}
          adapter={liveAdapter}
          rendererEpoch={1}
          width={41}
          height={9}
          focusedPane="pane.claude"
          theme={theme}
          palette={palette}
          agentIndicators={indicators}
          paneInteractions={paneInteractions}
          onSelectPane={() => undefined}
        />
      ),
      { width: 41, height: 11 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("CLAUDE_QUIET");
    blits.length = 0;

    terminalCells.set("pane.macmon", "MACMON_TICK_2");
    versions.set("pane.macmon", 2);
    listeners.get("pane.macmon")?.(2, 1, 0, "content");
    await setup.renderOnce();
    expect(blits).toEqual([{ paneId: "pane.macmon", full: false }]);
    expect(setup.captureCharFrame()).toContain("CLAUDE_QUIET");
    blits.length = 0;

    setIndicators(
      new Map([
        ["pane.claude", { name: "Claude Code", activity: "waiting", attention: true } as const],
      ]),
    );
    await setup.renderOnce();
    expect(blits).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Clau");
    expect(setup.captureCharFrame()).toContain("CLAUDE_QUIET");
    blits.length = 0;

    setPaneInteractions(
      new Map([
        [
          "pane.claude",
          {
            paneId: "pane.claude",
            direction: "incoming",
            sourcePaneId: null,
            destinationPaneId: "pane.claude",
            operationKind: "workspace.pane.read",
            operationId: "read-observation",
            phase: "observed",
            origin: "external",
            label: "read observed",
            sequence: 1,
            at: new Date().toISOString(),
          },
        ],
      ]),
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("READ");
    expect(blits).toEqual([]);
    setPaneInteractions(new Map());
    setIndicators(new Map());
    const renamed = {
      ...current,
      panes: current.panes.map((pane) =>
        pane.pane === "pane.claude"
          ? { ...pane, displayName: "builder", displayNameSource: "manual" as const }
          : pane,
      ),
    };
    setWorkspaceLayout({ current: renamed, windows: [renamed] });
    await setup.renderOnce();
    expect(blits).toEqual([]);
    expect(setup.captureCharFrame()).toContain("builder");
    expect(setup.captureCharFrame()).toContain("CLAUDE_QUIET");
    setup.renderer.destroy();
  });

  it("mounts every canonical pane, paints cells, and has no optional tool dock", async () => {
    registerPaneSurface();
    const blits: string[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout}
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

  it("keeps quiet terminal contents painted when canonical pane geometry changes", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const blits: string[] = [];
    const initial = {
      type: "layout" as const,
      semanticWindowId: "window.main",
      windowName: "main",
      currentWindow: true,
      cols: 30,
      rows: 9,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 14, height: 9, active: true },
        { pane: "pane.b", left: 15, top: 0, width: 15, height: 9, active: false },
      ],
    };
    const resized = {
      ...initial,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 19, height: 9, active: true },
        { pane: "pane.b", left: 20, top: 0, width: 10, height: 9, active: false },
      ],
    };
    const [workspaceLayout, setWorkspaceLayout] = createSignal<OpenTuiWorkspaceLayoutSnapshot>({
      current: initial,
      windows: [initial],
    });
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={workspaceLayout}
          adapter={adapter({ "pane.a": "A", "pane.b": "B" }, blits)}
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
    expect(setup.captureCharFrame()).toContain("B");

    blits.length = 0;
    setWorkspaceLayout({ current: resized, windows: [resized] });
    await setup.renderOnce();

    expect(new Set(blits)).toEqual(new Set(["pane.a", "pane.b"]));
    expect(setup.captureCharFrame()).toContain("A");
    expect(setup.captureCharFrame()).toContain("B");
    setup.renderer.destroy();
  });

  it("never presents a blank rich terminal frame during pointer, rapid canonical resize, or window return", async () => {
    registerPaneSurface();
    const darkTheme = createSemanticThemeSnapshot({ mode: "dark" });
    const lightTheme = createSemanticThemeSnapshot({ mode: "light" });
    const [appearance, setAppearance] = createSignal({
      theme: darkTheme,
      palette: createTerminalPaletteProjection(darkTheme),
    });
    const blits: string[] = [];
    const cursor = { x: 2, y: 3, hidden: false, style: "bar" as const, blink: true };
    const writeColor = (channels: Uint16Array, cell: number, packed: number) =>
      channels.set([(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff, 0xff], cell * 4);
    const writeRow = (
      buffers: Parameters<TerminalPaneRenderSource["blitPane"]>[1],
      width: number,
      row: number,
      text: string,
      foreground: number,
      background: number,
    ) => {
      for (let column = 0; column < Math.min(width, text.length); column += 1) {
        const cell = row * width + column;
        buffers.char[cell] = text.codePointAt(column)!;
        writeColor(buffers.fg, cell, foreground);
        writeColor(buffers.bg, cell, background);
      }
    };
    const richAdapter: PaneScopedTerminalAdapter = {
      renderSource: {
        scrollbackDepth: () => 0,
        cursorState: (paneId) => (paneId === "pane.a" ? cursor : null),
        blitPane: (paneId, buffers, width, height, _scroll, defaultFg, defaultBg, options) => {
          blits.push(paneId);
          buffers.char.fill(32);
          buffers.attributes.fill(0);
          for (let cell = 0; cell < width * height; cell += 1) {
            writeColor(buffers.fg, cell, defaultFg);
            writeColor(buffers.bg, cell, defaultBg);
          }
          if (paneId === "pane.a") {
            writeRow(buffers, width, 0, "NORMAL", defaultFg, defaultBg);
            writeRow(
              buffers,
              width,
              1,
              "INDEXED",
              appearance().palette.ansiForeground[196]!,
              defaultBg,
            );
            writeRow(buffers, width, 2, "TRUECOLOR", 0x010203, 0x040506);
            writeRow(buffers, width, 3, "ALT_SCREEN", defaultFg, defaultBg);
          } else {
            writeRow(buffers, width, 0, "SECONDARY", defaultFg, defaultBg);
          }
          for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
          return null;
        },
      },
      paneVersion: () => 1,
      paneSourceEpoch: () => 1,
      subscribePaneVersion: () => () => undefined,
      paneSelectionSnapshot: () => null,
    };
    const windowA = {
      type: "layout" as const,
      semanticWindowId: "window.rich",
      windowName: "rich",
      currentWindow: true,
      cols: 30,
      rows: 9,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 14, height: 9, active: true },
        { pane: "pane.b", left: 15, top: 0, width: 15, height: 9, active: false },
      ],
    };
    const windowB = {
      ...windowA,
      semanticWindowId: "window.other",
      windowName: "other",
      currentWindow: false,
      panes: [{ pane: "pane.c", left: 0, top: 0, width: 30, height: 9, active: true }],
    };
    const [workspaceLayout, setWorkspaceLayout] = createSignal<OpenTuiWorkspaceLayoutSnapshot>({
      current: windowA,
      windows: [windowA, windowB],
    });
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={workspaceLayout}
          adapter={richAdapter}
          rendererEpoch={1}
          width={30}
          height={9}
          focusedPane="pane.a"
          theme={appearance().theme}
          palette={appearance().palette}
          onSelectPane={() => undefined}
        />
      ),
      { width: 30, height: 11 },
    );
    const expectRichFrame = () => {
      const frame = setup.captureCharFrame();
      for (const marker of ["NORMAL", "INDEXED", "TRUECOLOR", "ALT_SCREEN"])
        expect(frame, `${marker} must survive the coherent frame`).toContain(marker);
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const indexed = spans.find((span) => span.text.includes("INDEXED"));
      const truecolor = spans.find((span) => span.text.includes("TRUECOLOR"));
      expect(indexed).toBeDefined();
      expect(truecolor).toBeDefined();
      expect(colorToThemeBytes(indexed!.fg)).toEqual([255, 0, 0, 255]);
      expect(colorToThemeBytes(truecolor!.fg)).toEqual([1, 2, 3, 255]);
      expect(colorToThemeBytes(truecolor!.bg)).toEqual([4, 5, 6, 255]);
      expect(richAdapter.renderSource.cursorState("pane.a")).toEqual(cursor);
    };

    await setup.renderOnce();
    expectRichFrame();

    setAppearance({
      theme: lightTheme,
      palette: createTerminalPaletteProjection(lightTheme),
    });
    await setup.renderOnce();
    expectRichFrame();

    // Pointer preview must remain an overlay; it cannot erase terminal cells.
    await setup.mockMouse.pressDown(14, 6, MouseButtons.LEFT);
    await setup.mockMouse.moveTo(16, 6);
    await setup.renderOnce();
    expectRichFrame();
    await setup.mockMouse.release(16, 6, MouseButtons.LEFT);

    for (const width of [18, 10, 16, 12]) {
      const resized = {
        ...windowA,
        panes: [
          { pane: "pane.a", left: 0, top: 0, width, height: 9, active: true },
          { pane: "pane.b", left: width + 1, top: 0, width: 29 - width, height: 9, active: false },
        ],
      };
      setWorkspaceLayout({ current: resized, windows: [resized, windowB] });
      await setup.renderOnce();
      expectRichFrame();
    }

    const hiddenA = { ...windowA, currentWindow: false };
    const visibleB = { ...windowB, currentWindow: true };
    setWorkspaceLayout({ current: visibleB, windows: [hiddenA, visibleB] });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("SECONDARY");
    setWorkspaceLayout({ current: windowA, windows: [windowA, windowB] });
    await setup.renderOnce();
    expectRichFrame();
    expect(new Set(blits)).toEqual(new Set(["pane.a", "pane.b", "pane.c"]));
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
      paneSelectionSnapshot: () => null,
    };
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={layout}
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
      paneSelectionSnapshot: () => null,
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
          layout={() => ({ current, windows: [current] })}
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
          layout={layout}
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

  it.each(["emacs", "vi"] as const)("supports local keyboard copy in %s mode", async (mode) => {
    const retainView = true;
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const defaultColor = { kind: "default" as const };
    const replica: TerminalReplicaSnapshot = {
      cols: 10,
      rows: 8,
      history: [],
      grid: Array.from({ length: 8 }, () => ({
        wrapped: false,
        cells: Array.from({ length: 10 }, (_, column) => ({
          grapheme: "selection!"[column] ?? " ",
          width: 1 as const,
          foreground: defaultColor,
          background: defaultColor,
          attributes: 0,
        })),
      })),
      cursor: { x: 0, y: 0, hidden: true, style: "block", blink: false },
      modes: {
        alternateScreen: false,
        applicationCursor: false,
        applicationKeypad: false,
        bracketedPaste: false,
        insert: false,
        origin: false,
        wraparound: true,
        mouseTracking: true,
        mouseProtocol: "drag",
        mouseEncoding: "sgr",
        synchronizedOutput: false,
      },
      placements: [],
      bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
    };
    const [workspaceHeight, setWorkspaceHeight] = createSignal(9);
    const forwarded: string[] = [];
    const copied: Array<{ text: string; bytes: number }> = [];
    const paneActions: Array<{ paneId: string; action: string }> = [];
    let handleSelectionKey: PaneMenuKeyHandler | null = null;
    let blocksPaste: (() => boolean) | undefined;
    let prepareInput: (() => void) | undefined;
    let copyCurrent: (() => boolean) | null = null;
    let canonicalRevision = 1;
    let retained: { snapshot: TerminalReplicaSnapshot; revision: number } | null = null;
    const liveAdapter: PaneScopedTerminalAdapter = {
      ...adapter({ "pane.a": "s", "pane.b": "B", "pane.c": "C" }, []),
      paneSelectionSnapshot: (paneId) =>
        paneId === "pane.a" ? (retained?.snapshot ?? replica) : null,
      ...(retainView
        ? {
            retainPaneView: () => {
              const view = { snapshot: structuredClone(replica), revision: canonicalRevision };
              retained = view;
              return () => {
                if (retained === view) retained = null;
              };
            },
          }
        : {}),
    };
    liveAdapter.renderSource.paneCanonicalIdentity = (paneId) =>
      paneId === "pane.a"
        ? {
            generation: "11111111-1111-4111-8111-111111111111",
            incarnation: "11111111-1111-4111-8111-111111111111:0",
            revision: retained?.revision ?? canonicalRevision,
            stateHash: "canonical-a",
            cols: replica.cols,
            rows: replica.rows,
            ...(retained
              ? { viewCols: retained.snapshot.cols, viewRows: retained.snapshot.rows }
              : {}),
            sourceEpoch: 1,
            historyTrim: 0,
          }
        : null;
    let connection = {};
    let client = {};
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={() => {
            const value = layout();
            return {
              ...value,
              current: value.current ? { ...value.current, modeKeys: mode } : null,
              windows: value.windows.map((window) => ({ ...window, modeKeys: mode })),
            };
          }}
          adapter={liveAdapter}
          rendererEpoch={1}
          terminalGestureRuntime={() => ({
            daemonGeneration: "22222222-2222-4222-8222-222222222222",
            clientGeneration: 1,
            connection,
            client,
            adapter: liveAdapter,
            rendererEpoch: 1,
          })}
          width={30}
          height={workspaceHeight()}
          focusedPane="pane.a"
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
          onPaneContextAction={(paneId, action) => paneActions.push({ paneId, action })}
          onTerminalInput={(_paneId, input) => forwarded.push(input.data)}
          onCopyText={(text, evidence) => {
            copied.push({ text, bytes: evidence.bytes });
            return true;
          }}
          onSelectionKeyOwner={(handle, _blocks, prepare) => {
            blocksPaste = _blocks;
            prepareInput = prepare;
            handleSelectionKey = handle;
          }}
          onSelectionCopyOwner={(copy) => {
            copyCurrent = copy;
          }}
        />
      ),
      { width: 30, height: 11 },
    );
    const cursors: Array<Parameters<typeof setup.renderer.setCursorPosition>> = [];
    const originalCursor = setup.renderer.setCursorPosition.bind(setup.renderer);
    setup.renderer.setCursorPosition = (...args) => {
      cursors.push(args);
      originalCursor(...args);
    };
    await setup.renderOnce();
    expect(handleSelectionKey?.("f10", { shift: true })).toBe(true);
    expect(handleSelectionKey?.("enter")).toBe(true);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(`copy ${mode}`);
    expect(blocksPaste?.()).toBe(true);
    expect(cursors.some(([, , visible]) => visible === true)).toBe(true);
    expect(handleSelectionKey?.("home")).toBe(true);
    expect(handleSelectionKey?.("right")).toBe(true);
    expect(handleSelectionKey?.("space", mode === "emacs" ? { ctrl: true } : undefined)).toBe(true);
    expect(handleSelectionKey?.("right")).toBe(true);
    await setup.renderOnce();
    expect(copyCurrent?.()).toBe(true);
    expect(copied.at(-1)?.text).toBe(mode === "emacs" ? "e" : "el");
    await setup.mockMouse.scroll(5, 5, "up");
    await setup.renderOnce();
    expect(retained).not.toBeNull();
    expect(blocksPaste?.()).toBe(true);
    expect(copyCurrent?.()).toBe(mode === "vi");
    if (mode === "emacs") {
      expect(handleSelectionKey?.("space", { ctrl: true })).toBe(true);
      expect(handleSelectionKey?.("left")).toBe(true);
    }
    expect(handleSelectionKey?.("x")).toBe(true);
    expect(handleSelectionKey?.("f1")).toBe(false);
    expect(handleSelectionKey?.("f2")).toBe(false);
    expect(handleSelectionKey?.("f5")).toBe(false);
    if (mode === "vi") {
      expect(handleSelectionKey?.("escape")).toBe(true);
      expect(copyCurrent?.()).toBe(false);
      expect(retained).not.toBeNull();
      expect(handleSelectionKey?.("space")).toBe(true);
      expect(handleSelectionKey?.("left")).toBe(true);
    }
    expect(
      handleSelectionKey?.(
        mode === "vi" ? "enter" : "w",
        mode === "emacs" ? { ctrl: true } : undefined,
      ),
    ).toBe(true);
    expect(retained).toBeNull();
    expect(blocksPaste?.()).toBe(false);
    expect(forwarded).toEqual([]);
    expect(handleSelectionKey?.("f10", { shift: true })).toBe(true);
    expect(handleSelectionKey?.("enter")).toBe(true);
    expect(handleSelectionKey?.("space", mode === "emacs" ? { ctrl: true } : undefined)).toBe(true);
    expect(handleSelectionKey?.("right")).toBe(true);
    await setup.renderOnce();
    await setup.mockMouse.pressDown(2, 5, MouseButtons.LEFT);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain(`copy ${mode}`);
    expect(handleSelectionKey?.("x")).toBe(false);
    expect(retained).not.toBeNull();
    await setup.mockMouse.moveTo(4, 5);
    await setup.mockMouse.release(4, 5, MouseButtons.LEFT);
    expect(copied.at(-1)?.text).toBe("lec");
    expect(copyCurrent?.()).toBe(true);
    expect(copied.at(-1)?.text).toBe("lec");
    expect(forwarded).toEqual([]);
    setup.renderer.destroy();
  });

  it.each(
    [false, true].flatMap((retainView) =>
      (["sgr", "default", "utf8"] as const).flatMap((encoding) =>
        [false, true].map((alternateScreen) => ({ retainView, encoding, alternateScreen })),
      ),
    ),
  )(
    "forwards $encoding app mouse until explicit selection (retained: $retainView, alternate: $alternateScreen)",
    async ({ retainView, encoding, alternateScreen }) => {
      registerPaneSurface();
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const palette = createTerminalPaletteProjection(theme);
      const defaultColor = { kind: "default" as const };
      const replica: TerminalReplicaSnapshot = {
        cols: 10,
        rows: 8,
        history: [],
        grid: Array.from({ length: 8 }, (_, row) => ({
          wrapped: false,
          cells: Array.from({ length: 10 }, (_, column) => ({
            grapheme: row === 0 ? ("selection!"[column] ?? " ") : " ",
            width: 1 as const,
            foreground: defaultColor,
            background: defaultColor,
            attributes: 0,
          })),
        })),
        cursor: { x: 0, y: 0, hidden: true, style: "block", blink: false },
        modes: {
          alternateScreen,
          applicationCursor: false,
          applicationKeypad: false,
          bracketedPaste: false,
          insert: false,
          origin: false,
          wraparound: true,
          mouseTracking: true,
          mouseProtocol: "drag",
          mouseEncoding: encoding,
          synchronizedOutput: false,
        },
        placements: [],
        bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
      };
      const [workspaceHeight, setWorkspaceHeight] = createSignal(9);
      const forwarded: string[] = [];
      const wireEncodings: Array<string | undefined> = [];
      const copied: Array<{ text: string; bytes: number }> = [];
      const paneActions: Array<{ paneId: string; action: string }> = [];
      let handleSelectionKey: PaneMenuKeyHandler | null = null;
      let prepareInput: (() => void) | undefined;
      let copyCurrent: (() => boolean) | null = null;
      let canonicalRevision = 1;
      let retained: { snapshot: TerminalReplicaSnapshot; revision: number } | null = null;
      const liveAdapter: PaneScopedTerminalAdapter = {
        ...adapter({ "pane.a": "s", "pane.b": "B", "pane.c": "C" }, []),
        paneSelectionSnapshot: (paneId) =>
          paneId === "pane.a" ? (retained?.snapshot ?? replica) : null,
        ...(retainView
          ? {
              retainPaneView: () => {
                const view = { snapshot: structuredClone(replica), revision: canonicalRevision };
                retained = view;
                return () => {
                  if (retained === view) retained = null;
                };
              },
            }
          : {}),
      };
      liveAdapter.renderSource.paneCanonicalIdentity = (paneId) =>
        paneId === "pane.a"
          ? {
              generation: "11111111-1111-4111-8111-111111111111",
              incarnation: "11111111-1111-4111-8111-111111111111:0",
              revision: retained?.revision ?? canonicalRevision,
              stateHash: "canonical-a",
              cols: replica.cols,
              rows: replica.rows,
              ...(retained
                ? { viewCols: retained.snapshot.cols, viewRows: retained.snapshot.rows }
                : {}),
              sourceEpoch: 1,
              historyTrim: 0,
            }
          : null;
      let connection = {};
      let client = {};
      const setup = await renderForTest(
        () => (
          <ApplicationTerminalWorkspace
            layout={layout}
            adapter={liveAdapter}
            rendererEpoch={1}
            terminalGestureRuntime={() => ({
              daemonGeneration: "22222222-2222-4222-8222-222222222222",
              clientGeneration: 1,
              connection,
              client,
              adapter: liveAdapter,
              rendererEpoch: 1,
            })}
            width={30}
            height={workspaceHeight()}
            focusedPane="pane.a"
            theme={theme}
            palette={palette}
            onSelectPane={() => undefined}
            onPaneContextAction={(paneId, action) => paneActions.push({ paneId, action })}
            onTerminalInput={(_paneId, input) => {
              forwarded.push(input.data);
              wireEncodings.push(
                input.kind === "application-mouse" ? input.dataEncoding : undefined,
              );
            }}
            onCopyText={(text, evidence) => {
              copied.push({ text, bytes: evidence.bytes });
              return true;
            }}
            onSelectionKeyOwner={(handle, _blocks, prepare) => {
              prepareInput = prepare;
              handleSelectionKey = handle;
            }}
            onSelectionCopyOwner={(copy) => {
              copyCurrent = copy;
            }}
          />
        ),
        { width: 30, height: 11 },
      );
      await setup.renderOnce();

      // The header overflow and keyboard accelerators share the exact pane-scoped
      // action model; close remains deliberately two-step.
      await setup.mockMouse.click(8, 2, MouseButtons.LEFT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Rename pane…");
      expect(handleSelectionKey?.("r")).toBe(true);
      await setup.renderOnce();
      await setup.mockMouse.click(8, 2, MouseButtons.LEFT);
      expect(handleSelectionKey?.("right")).toBe(true);
      await setup.renderOnce();
      await setup.mockMouse.click(8, 2, MouseButtons.LEFT);
      expect(handleSelectionKey?.("d")).toBe(true);
      await setup.renderOnce();
      await setup.mockMouse.click(8, 2, MouseButtons.LEFT);
      expect(handleSelectionKey?.("x")).toBe(true);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Confirm close pane");
      expect(paneActions).toEqual([
        { paneId: "pane.a", action: "rename-pane" },
        { paneId: "pane.a", action: "split-right" },
        { paneId: "pane.a", action: "split-down" },
      ]);
      expect(handleSelectionKey?.("x")).toBe(true);
      expect(paneActions.at(-1)).toEqual({ paneId: "pane.a", action: "close-pane" });
      await setup.renderOnce();

      // Mouse-reporting apps own ordinary wheel input on either screen.
      await setup.mockMouse.scroll(2, 3, "up");
      expect(forwarded).toEqual(encoding === "sgr" ? ["\u001b[<64;3;1M"] : ["1b5b4d602321"]);
      await setup.mockMouse.scroll(2, 3, "up", { modifiers: { ctrl: true } });
      expect(forwarded.at(-1)).toBe(encoding === "sgr" ? "\u001b[<80;3;1M" : "1b5b4d702321");
      // Shift always selects local history, including when Alt is also held.
      await setup.mockMouse.scroll(2, 3, "up", { modifiers: { shift: true } });
      expect(forwarded).toHaveLength(2);
      // Alt remains a compatibility routing modifier, stripped before delivery.
      await setup.mockMouse.scroll(2, 3, "up", { modifiers: { alt: true } });
      expect(forwarded.at(-1)).toBe(encoding === "sgr" ? "\u001b[<64;3;1M" : "1b5b4d602321");
      expect(forwarded).toHaveLength(3);
      await setup.mockMouse.scroll(2, 3, "up", { modifiers: { alt: true, shift: true } });
      expect(forwarded).toHaveLength(3);
      forwarded.length = 0;
      wireEncodings.length = 0;

      await setup.mockMouse.click(2, 3, MouseButtons.LEFT);
      expect(forwarded).toEqual(
        encoding === "sgr"
          ? ["\u001b[<0;3;1M", "\u001b[<0;3;1m"]
          : ["1b5b4d202321", "1b5b4d232321"],
      );
      expect(wireEncodings).toEqual(encoding === "sgr" ? [undefined, undefined] : ["hex", "hex"]);

      forwarded.length = 0;
      await setup.mockMouse.pressDown(2, 3, MouseButtons.LEFT);
      connection = {};
      await setup.mockMouse.release(3, 3, MouseButtons.LEFT);
      expect(forwarded).toEqual(encoding === "sgr" ? ["\u001b[<0;3;1M"] : ["1b5b4d202321"]);
      connection = {};

      await setup.mockMouse.click(2, 3, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Select text…");
      expect(handleSelectionKey?.("enter")).toBe(true);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("select");

      await setup.mockMouse.pressDown(1, 3, MouseButtons.LEFT);
      await setup.mockMouse.moveTo(4, 3);
      client = {};
      await setup.mockMouse.release(4, 3, MouseButtons.LEFT);
      expect(copied).toEqual([]);

      await setup.mockMouse.click(2, 3, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(handleSelectionKey?.("enter")).toBe(true);
      await setup.renderOnce();

      forwarded.length = 0;
      await setup.mockMouse.pressDown(1, 3, MouseButtons.LEFT);
      await setup.mockMouse.moveTo(4, 3);
      if (retainView) canonicalRevision++;
      await setup.renderOnce();
      await setup.mockMouse.release(4, 3, MouseButtons.LEFT);
      await Promise.resolve();
      await setup.renderOnce();
      expect(forwarded).toEqual([]);
      expect(copied).toEqual([{ text: "elec", bytes: 4 }]);
      replica.grid[0]!.cells[1]!.grapheme = "X";
      expect(copyCurrent?.()).toBe(true);
      expect(copied).toEqual([
        { text: "elec", bytes: 4 },
        { text: "elec", bytes: 4 },
      ]);
      canonicalRevision += 1;
      // Root dispatch asks the key owner before attempting Ctrl+C copy.
      expect(handleSelectionKey?.("c", { ctrl: true })).toBe(false);
      expect(copyCurrent?.()).toBe(retainView);
      if (retainView) {
        await setup.renderOnce();
        expect(setup.captureCharFrame().split("\n")[2]).toContain("select");
        expect(copied.at(-1)).toEqual({ text: "elec", bytes: 4 });
        for (const name of ["up", "down", "pageup", "pagedown", "home", "end"]) {
          expect(handleSelectionKey?.(name), name).toBe(true);
          expect(retained).not.toBeNull();
        }
        // Local presentation resizes while its original canonical identity
        // stays unchanged, as it does in the production retained adapter.
        retained!.snapshot = {
          ...retained!.snapshot,
          rows: 7,
          grid: retained!.snapshot.grid.slice(0, 7),
        };
        setWorkspaceHeight(8);
        await setup.renderOnce();
        expect(retained).not.toBeNull();
        expect(copyCurrent?.()).toBe(false);
        expect(setup.captureCharFrame().split("\n")[2]).toContain("select");
        expect(handleSelectionKey?.("escape")).toBe(true);
        expect(retained).toBeNull();
        expect(copyCurrent?.()).toBe(false);
        await setup.renderOnce();
        expect(setup.captureCharFrame().split("\n")[2]).not.toContain("select");
      }
      expect(copied).toHaveLength(retainView ? 3 : 2);
      if (retainView) {
        for (const input of ["tab", "enter", "paste"]) {
          await setup.mockMouse.click(2, 3, MouseButtons.RIGHT);
          await setup.renderOnce();
          expect(handleSelectionKey?.("enter"), `select before ${input}`).toBe(true);
          expect(retained).not.toBeNull();
          if (input !== "paste") expect(handleSelectionKey?.(input)).toBe(false);
          prepareInput?.();
          expect(retained).toBeNull();
          expect(copyCurrent?.()).toBe(false);
          await setup.renderOnce();
        }
      }

      await setup.mockMouse.click(2, 3, MouseButtons.RIGHT);
      expect(handleSelectionKey?.("down")).toBe(true);
      expect(handleSelectionKey?.("down")).toBe(true);
      expect(handleSelectionKey?.("enter")).toBe(true);
      expect(paneActions).toEqual([
        { paneId: "pane.a", action: "rename-pane" },
        { paneId: "pane.a", action: "split-right" },
        { paneId: "pane.a", action: "split-down" },
        { paneId: "pane.a", action: "close-pane" },
        { paneId: "pane.a", action: "split-right" },
      ]);
      setup.renderer.destroy();
    },
  );
});

it.each([false, true])(
  "preserves sibling content and headers while scrolling (side by side: %s)",
  async (sideBySide) => {
    registerPaneSurface();
    const { blankTerminalReplicaSnapshot } = await import("@tmux-ide/core");
    const { blitSemanticRow, visibleTerminalRowAt } =
      await import("../semantic-pane-render-source.ts");
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const blank = blankTerminalReplicaSnapshot(24, 3);
    const textRow = (text: string) => ({
      ...blank.grid[0]!,
      cells: blank.grid[0]!.cells.map((cell, index) => ({ ...cell, grapheme: text[index] ?? " " })),
    });
    const snapshots = new Map(
      ["a", "b"].map((id) => [
        id,
        {
          ...blank,
          history: Array.from({ length: 20 }, (_, i) => textRow(`history-${i}`)),
          grid: Array.from({ length: 3 }, (_, i) => textRow(`${id}-row-${i}`)),
        },
      ]),
    );
    const observations: Readonly<Record<string, unknown>>[] = [];
    const paints: string[] = [];
    const source: PaneScopedTerminalAdapter = {
      ...adapter({}, []),
      paneSelectionSnapshot: (id) => snapshots.get(id) ?? null,
      renderSource: {
        scrollbackDepth: (id) => snapshots.get(id)?.history.length ?? 0,
        cursorState: () => null,
        blitPane: (id, buffers, width, height, offset, fg, bg, options) => {
          paints.push(id);
          for (let row = 0; row < height; row++) {
            blitSemanticRow(
              visibleTerminalRowAt(snapshots.get(id) ?? null, offset, row),
              buffers,
              row,
              width,
              fg,
              bg,
              options.graphemes,
              options.palette,
            );
            options.dirtyRows.push(row);
          }
          return null;
        },
      },
    };
    const current = {
      ...layout().current!,
      cols: sideBySide ? 49 : 24,
      rows: sideBySide ? 3 : 7,
      panes: [
        { pane: "a", left: 0, top: 0, width: 24, height: 3, active: true },
        {
          pane: "b",
          left: sideBySide ? 25 : 0,
          top: sideBySide ? 0 : 4,
          width: 24,
          height: 3,
          active: false,
        },
      ],
    };
    let key: PaneMenuKeyHandler | null = null;
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={() => ({ current, windows: [current] })}
          adapter={source}
          rendererEpoch={1}
          width={sideBySide ? 49 : 24}
          height={sideBySide ? 4 : 8}
          topOffset={1}
          focusedPane="a"
          theme={theme}
          palette={createTerminalPaletteProjection(theme)}
          onWheelObservation={(event) => observations.push(event)}
          onSelectPane={() => {}}
          onSelectionKeyOwner={(handler) => {
            key = handler;
          }}
        />
      ),
      { width: sideBySide ? 49 : 24, height: sideBySide ? 5 : 9 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("a-row-2");
    expect(setup.captureCharFrame()).toContain("b-row-2");
    const beforeScroll = setup.captureCharFrame();
    paints.length = 0;
    await setup.mockMouse.scroll(5, 3, "up");
    await setup.renderOnce();
    expect(observations.at(-1)).toMatchObject({
      direction: "up",
      shift: false,
      route: "local-history",
      offsetBefore: 0,
      offsetAfter: 5,
    });
    await setup.mockMouse.scroll(5, 3, "right", { modifiers: { shift: true } });
    expect(observations.at(-1)).toMatchObject({
      direction: "right",
      shift: true,
      route: "unsupported-direction",
      offsetBefore: 5,
      offsetAfter: 5,
    });
    expect(setup.captureCharFrame()).toContain("history-15");
    expect(setup.captureCharFrame()).toContain("Scrollback");
    expect(paints).not.toContain("b");
    if (sideBySide) {
      const sibling = (frame: string) =>
        frame
          .split("\n")
          .slice(1)
          .map((row) => row.slice(25, 49));
      expect(sibling(setup.captureCharFrame())).toEqual(sibling(beforeScroll));
    }
    const regularScrollFrame = setup.captureCharFrame();
    expect(key!("escape")).toBe(true);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("a-row-2");
    expect(setup.captureCharFrame()).not.toContain("Scrollback");
    await setup.mockMouse.scroll(5, 3, "up", { modifiers: { shift: true } });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toBe(regularScrollFrame);
    setup.renderer.destroy();
  },
);

it("keeps history local through app-mode changes and fences automatic wheel delivery", async () => {
  registerPaneSurface();
  const { blankTerminalReplicaSnapshot } = await import("@tmux-ide/core");
  const blank = blankTerminalReplicaSnapshot(10, 8);
  let replica: TerminalReplicaSnapshot = {
    ...blank,
    history: Array.from({ length: 10 }, () => blank.grid[0]!),
  };
  const live = adapter({ "pane.a": "A", "pane.b": "B" }, []);
  live.paneSelectionSnapshot = () => replica;
  live.renderSource.scrollbackDepth = () => replica.history.length;
  live.renderSource.paneCanonicalIdentity = () => ({
    generation: "generation",
    incarnation: "generation:0",
    revision: 1,
    stateHash: "state",
    cols: replica.cols,
    rows: replica.rows,
    sourceEpoch: 1,
    historyTrim: 0,
  });
  const connection = {};
  const client = {};
  let staleRuntime = false;
  const events: Readonly<Record<string, unknown>>[] = [];
  const inputs: Array<{ paneId: string; data: string }> = [];
  const selected: string[] = [];
  const deliveryOrder: string[] = [];
  const [focusedPane, setFocusedPane] = createSignal("pane.a");
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const setup = await renderForTest(
    () => (
      <ApplicationTerminalWorkspace
        layout={layout}
        adapter={live}
        rendererEpoch={1}
        terminalGestureRuntime={() => ({
          daemonGeneration: "daemon",
          clientGeneration: 1,
          connection: staleRuntime ? {} : connection,
          client,
          adapter: live,
          rendererEpoch: 1,
        })}
        width={30}
        height={9}
        focusedPane={focusedPane()}
        theme={theme}
        palette={createTerminalPaletteProjection(theme)}
        onSelectPane={(paneId) => {
          selected.push(paneId);
          deliveryOrder.push(`select:${paneId}`);
          setFocusedPane(paneId);
        }}
        onWheelObservation={(event) => events.push(event)}
        onTerminalInput={(paneId, input) => {
          deliveryOrder.push(`input:${paneId}`);
          inputs.push({ paneId, data: input.data });
        }}
      />
    ),
    { width: 30, height: 11 },
  );
  try {
    await setup.renderOnce();
    // A shell gesture starts in host history, then the app enables mouse mode.
    await setup.mockMouse.scroll(2, 3, "up");
    expect(events.at(-1)).toMatchObject({ route: "local-history", offsetAfter: 5 });
    replica = {
      ...replica,
      modes: { ...replica.modes, mouseTracking: true, mouseProtocol: "drag", mouseEncoding: "sgr" },
    };
    await setup.mockMouse.scroll(2, 3, "down");
    expect(events.at(-1)).toMatchObject({ route: "local-history", offsetAfter: 0 });
    await setup.mockMouse.scroll(2, 3, "down");
    expect(events.at(-1)).toMatchObject({ route: "local-history", offsetAfter: 0 });
    expect(inputs).toEqual([]);
    expect(selected).toEqual([]);

    // A new gesture at live bottom follows the application's negotiated mode.
    await new Promise((resolve) => setTimeout(resolve, 180));
    await setup.mockMouse.scroll(2, 3, "up");
    expect(inputs).toEqual([{ paneId: "pane.a", data: "\u001b[<64;3;1M" }]);
    // An inactive app must become the input target before wheel delivery.
    await setup.mockMouse.scroll(13, 3, "down");
    expect(inputs.at(-1)).toEqual({ paneId: "pane.b", data: "\u001b[<65;3;1M" });
    expect(deliveryOrder.slice(-2)).toEqual(["select:pane.b", "input:pane.b"]);
    await setup.mockMouse.scroll(13, 3, "down");
    expect(selected).toEqual(["pane.b"]);
    expect(inputs).toHaveLength(3);

    // A runtime replacement between lease capture and dispatch must fail closed.
    staleRuntime = true;
    await setup.mockMouse.scroll(23, 3, "up");
    expect(inputs).toHaveLength(3);
    staleRuntime = false;

    // Explicit selection owns scrolling even after the pointer crosses an app pane.
    await setup.mockMouse.pressDown(2, 3, MouseButtons.LEFT, { modifiers: { shift: true } });
    await setup.mockMouse.moveTo(4, 3, { modifiers: { shift: true } });
    await setup.mockMouse.scroll(13, 3, "up");
    expect(events.at(-1)).toMatchObject({ paneId: "pane.a", route: "local-history" });
    expect(inputs).toHaveLength(3);
    await setup.mockMouse.release(4, 3, MouseButtons.LEFT, { modifiers: { shift: true } });
  } finally {
    setup.renderer.destroy();
  }
});

it("routes raw mouse multi-click, wheel-drag, edge scrolling and Ctrl-link activation", async () => {
  registerPaneSurface();
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const { blankTerminalReplicaSnapshot } = await import("@tmux-ide/core");
  const blank = blankTerminalReplicaSnapshot(30, 9);
  const makeRow = (text: string) => ({
    wrapped: false,
    cells: [...text.padEnd(30)]
      .slice(0, 30)
      .map((grapheme) => ({ ...blank.grid[0]!.cells[0]!, grapheme })),
  });
  const replica = {
    ...blank,
    history: Array.from({ length: 20 }, (_, i) => makeRow(`history-${i}`)),
    grid: Array.from({ length: 9 }, () => makeRow("hello world https://a.test")),
  };
  const live = adapter({ "pane.a": "A", "pane.b": "B" }, []);
  const scrollOffsets = new Map<string, number>();
  const blit = live.renderSource.blitPane;
  live.renderSource.blitPane = (...args) => {
    scrollOffsets.set(args[0], args[4]);
    return blit(...args);
  };
  live.paneSelectionSnapshot = () => replica;
  live.renderSource.scrollbackDepth = () => replica.history.length;
  live.renderSource.paneCanonicalIdentity = () => ({
    generation: "gen",
    incarnation: "gen:0",
    revision: 1,
    stateHash: "hash",
    cols: 30,
    rows: 9,
    sourceEpoch: 1,
    historyTrim: 0,
  });
  const connection = {},
    client = {};
  const current = {
    ...layout().current!,
    cols: 60,
    panes: [
      { pane: "pane.a", left: 0, top: 0, width: 30, height: 9, active: true },
      { pane: "pane.b", left: 30, top: 0, width: 30, height: 9, active: false },
    ],
  };
  let copy: (() => boolean) | null = null;
  const copied: string[] = [],
    opened: string[] = [];
  const setup = await renderForTest(
    () => (
      <ApplicationTerminalWorkspace
        layout={() => ({ current, windows: [current] })}
        adapter={live}
        rendererEpoch={1}
        terminalGestureRuntime={() => ({
          daemonGeneration: "daemon",
          clientGeneration: 1,
          connection,
          client,
          adapter: live,
          rendererEpoch: 1,
        })}
        width={60}
        height={10}
        focusedPane="pane.a"
        theme={theme}
        palette={createTerminalPaletteProjection(theme)}
        onSelectPane={() => {}}
        onCopyText={(text) => {
          copied.push(text);
          return true;
        }}
        onSelectionCopyOwner={(value) => {
          copy = value;
        }}
        onOpenLink={(url) => opened.push(url)}
      />
    ),
    { width: 60, height: 11 },
  );
  try {
    await setup.renderOnce();
    await setup.mockMouse.doubleClick(1, 3);
    await setup.renderOnce();
    expect(copy?.()).toBe(true);
    expect(copied.at(-1)).toBe("hello");
    await setup.mockMouse.click(1, 3);
    await setup.renderOnce();
    expect(copy?.()).toBe(true);
    expect(copied.at(-1)).toBe("hello world https://a.test");
    await setup.mockMouse.click(16, 4, MouseButtons.LEFT, { modifiers: { ctrl: true } });
    expect(opened).toEqual(["https://a.test/"]);
    await setup.mockMouse.pressDown(2, 5);
    await setup.mockMouse.scroll(40, 5, "up");
    await setup.mockMouse.moveTo(2, 3);
    await setup.mockMouse.release(2, 3);
    await setup.renderOnce();
    expect(copy?.()).toBe(true);
    expect(copied.at(-1)).toContain("history-");
    expect(copied.at(-1)).toContain("hello world");
    expect(scrollOffsets.get("pane.a")).toBe(5);
    expect(scrollOffsets.get("pane.b")).toBe(0);
    await setup.mockMouse.pressDown(2, 4);
    await setup.renderOnce();
    await setup.mockMouse.moveTo(2, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.mockMouse.release(2, 0);
    expect(copy?.()).toBe(true);
    expect(copied.at(-1)).toContain("history-");
    expect(copied.at(-1)).toContain("history-14");
  } finally {
    setup.renderer.destroy();
  }
});

it.each([false, true])(
  "focuses the inactive pane for Shift-drag while output updates (retention reflow: %s)",
  async (reflowOnRetain) => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const { blankTerminalReplicaSnapshot } = await import("@tmux-ide/core");
    const blank = blankTerminalReplicaSnapshot(30, 9);
    const makeSnapshot = (label: string) => ({
      ...blank,
      modes: {
        ...blank.modes,
        mouseProtocol: "drag" as const,
        mouseEncoding: "sgr" as const,
        mouseTracking: true,
      },
      grid: blank.grid.map((row) => ({
        ...row,
        cells: row.cells.map((cell, i) => ({ ...cell, grapheme: label.padEnd(30)[i]! })),
      })),
    });
    const replicas = new Map([
      ["pane.a", makeSnapshot("first pane")],
      ["pane.b", makeSnapshot("working pane")],
    ]);
    let revision = 1;
    const held = new Map<string, ReturnType<typeof makeSnapshot>>();
    const live = adapter({ "pane.a": "A", "pane.b": "B" }, []);
    const originalBlit = live.renderSource.blitPane;
    live.renderSource.blitPane = (...args) => {
      const result = originalBlit(...args);
      const buffers = args[1];
      for (let offset = 0; offset < buffers.fg.length; offset += 4) {
        buffers.fg.set([210, 220, 230, 255], offset);
        buffers.bg.set([20, 30, 40, 255], offset);
      }
      return result;
    };
    live.paneSelectionSnapshot = (pane) => held.get(pane) ?? replicas.get(pane) ?? null;
    live.retainPaneView = (pane) => {
      const snapshot = replicas.get(pane)!;
      held.set(
        pane,
        reflowOnRetain
          ? {
              ...snapshot,
              cols: 29,
              grid: snapshot.grid.map((row) => ({ ...row, cells: row.cells.slice(0, 29) })),
            }
          : snapshot,
      );
      return () => {
        held.delete(pane);
      };
    };
    live.renderSource.paneCanonicalIdentity = (pane) => ({
      generation: "gen",
      incarnation: "gen:0",
      revision: held.has(pane) ? 1 : revision,
      stateHash: held.has(pane) || revision === 1 ? "original" : "updated",
      cols: 30,
      rows: 9,
      ...(held.has(pane) && reflowOnRetain ? { viewCols: 29, viewRows: 9 } : {}),
      sourceEpoch: 1,
      historyTrim: 0,
    });
    const current = {
      ...layout().current!,
      cols: 60,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width: 30, height: 9, active: true },
        { pane: "pane.b", left: 30, top: 0, width: 30, height: 9, active: false },
      ],
    };
    const connection = {},
      client = {};
    const [feedback, setFeedback] = createSignal<{ paneId: string; copied: boolean } | null>(null);
    const [focus, setFocus] = createSignal("pane.a");
    let copy: (() => boolean) | null = null;
    const copied: Array<{ text: string; pane: string }> = [],
      forwarded: string[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={() => ({ current, windows: [current] })}
          adapter={live}
          rendererEpoch={1}
          terminalGestureRuntime={() => ({
            daemonGeneration: "daemon",
            clientGeneration: 1,
            connection,
            client,
            adapter: live,
            rendererEpoch: 1,
          })}
          width={60}
          height={10}
          focusedPane={focus()}
          theme={theme}
          palette={createTerminalPaletteProjection(theme)}
          copyFeedback={feedback()}
          onSelectPane={setFocus}
          onTerminalInput={(pane) => forwarded.push(pane)}
          onCopyText={(text, evidence) => {
            copied.push({ text, pane: evidence.semanticPaneId });
            setFeedback({ paneId: evidence.semanticPaneId, copied: true });
            return true;
          }}
          onSelectionCopyOwner={(value) => {
            copy = value;
          }}
        />
      ),
      { width: 60, height: 11 },
    );
    try {
      await setup.renderOnce();
      await setup.mockMouse.pressDown(31, 3, MouseButtons.LEFT, { modifiers: { shift: true } });
      expect(focus()).toBe("pane.b");
      revision = 2;
      replicas.set("pane.b", makeSnapshot("new application output"));
      await setup.renderOnce();
      await setup.mockMouse.moveTo(45, 3, { modifiers: { shift: true } });
      await setup.mockMouse.release(45, 3, MouseButtons.LEFT, { modifiers: { shift: true } });
      expect(copy?.()).toBe(true);
      expect(copied.at(-1)).toEqual({ text: "orking pane", pane: "pane.b" });
      await setup.renderOnce();
      const expectRetainedHighlight = () => {
        let x = 0;
        const selected = setup.captureSpans().lines[3]!.spans.find((span) => {
          const contains = x <= 32 && x + span.text.length > 32;
          x += span.text.length;
          return contains;
        });
        expect(selected).toBeDefined();
        expect(colorToThemeBytes(selected!.fg)).toEqual([20, 30, 40, 255]);
        expect(colorToThemeBytes(selected!.bg)).toEqual([210, 220, 230, 255]);
      };
      expectRetainedHighlight();
      await setup.renderOnce();
      expectRetainedHighlight();
      const feedbackFrame = setup.captureCharFrame();
      expect(feedbackFrame.split("\n").some((line) => line.slice(30).includes("Copied"))).toBe(
        true,
      );
      expect(feedbackFrame.split("\n").some((line) => line.slice(0, 30).includes("Copied"))).toBe(
        false,
      );
      expect(copy?.()).toBe(true);
      setFeedback({ paneId: "pane.b", copied: false });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Copy unavailable");

      await setup.renderOnce();
      await setup.mockMouse.pressDown(31, 4, MouseButtons.LEFT, { modifiers: { shift: true } });
      await setup.renderOnce();
      await setup.mockMouse.moveTo(1, 4, { modifiers: { shift: true } });
      await setup.mockMouse.release(1, 4, MouseButtons.LEFT, { modifiers: { shift: true } });
      expect(copy?.()).toBe(true);
      expect(copied.at(-1)).toEqual({ text: "wo", pane: "pane.b" });
      expect(focus()).toBe("pane.b");
      expect(forwarded).toEqual([]);
    } finally {
      setup.renderer.destroy();
    }
  },
);

it.each([12, 30])(
  "returns only the clicked inactive history pane to live at width %s",
  async (width) => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const { blankTerminalReplicaSnapshot } = await import("@tmux-ide/core");
    const blank = blankTerminalReplicaSnapshot(width, 9);
    const replica = { ...blank, history: Array.from({ length: 20 }, () => blank.grid[0]!) };
    const live = adapter({ "pane.a": "A", "pane.b": "B" }, []);
    const offsets = new Map<string, number>();
    const blit = live.renderSource.blitPane;
    live.renderSource.blitPane = (...args) => {
      offsets.set(args[0], args[4]);
      return blit(...args);
    };
    live.renderSource.scrollbackDepth = () => 20;
    live.paneSelectionSnapshot = () => replica;
    live.renderSource.paneCanonicalIdentity = () => ({
      generation: "g",
      incarnation: "g:0",
      revision: 1,
      stateHash: "hash",
      cols: width,
      rows: 9,
      sourceEpoch: 1,
      historyTrim: 0,
    });
    const current = {
      ...layout().current!,
      cols: width * 2,
      panes: [
        { pane: "pane.a", left: 0, top: 0, width, height: 9, active: true },
        { pane: "pane.b", left: width, top: 0, width, height: 9, active: false },
      ],
    };
    const connection = {},
      client = {};
    const selected: string[] = [],
      inputs: string[] = [];
    const [feedback, setFeedback] = createSignal<{ paneId: string; copied: boolean } | null>(null);
    const setup = await renderForTest(
      () => (
        <ApplicationTerminalWorkspace
          layout={() => ({ current, windows: [current] })}
          adapter={live}
          rendererEpoch={1}
          terminalGestureRuntime={() => ({
            daemonGeneration: "d",
            clientGeneration: 1,
            connection,
            client,
            adapter: live,
            rendererEpoch: 1,
          })}
          width={width * 2}
          height={10}
          focusedPane="pane.a"
          theme={theme}
          palette={createTerminalPaletteProjection(theme)}
          copyFeedback={feedback()}
          onSelectPane={(pane) => selected.push(pane)}
          onTerminalInput={(pane) => inputs.push(pane)}
        />
      ),
      { width: width * 2, height: 11 },
    );
    try {
      await setup.renderOnce();
      await setup.mockMouse.scroll(2, 3, "up");
      await setup.mockMouse.scroll(width + 2, 3, "up");
      setFeedback({ paneId: "pane.b", copied: true });
      await setup.renderOnce();
      expect(offsets.get("pane.a")).toBe(5);
      expect(offsets.get("pane.b")).toBe(5);
      expect(setup.captureCharFrame()).toContain(width < 22 ? "✓ · Live" : "Copied · Live");
      await setup.mockMouse.pressDown(2, 4, MouseButtons.LEFT, { modifiers: { shift: true } });
      await setup.renderOnce();
      await setup.mockMouse.moveTo(width * 2 - 3, 2, { modifiers: { shift: true } });
      await setup.mockMouse.release(width * 2 - 3, 2, MouseButtons.LEFT, {
        modifiers: { shift: true },
      });
      await setup.renderOnce();
      expect(offsets.get("pane.b")).toBe(5);
      expect(selected).toEqual(["pane.a"]);
      selected.length = 0;
      await setup.mockMouse.click(width * 2 - 3, 2);
      await setup.renderOnce();
      expect(offsets.get("pane.a")).toBe(5);
      expect(offsets.get("pane.b")).toBe(0);
      expect(selected).toEqual([]);
      expect(inputs).toEqual([]);
      expect(setup.captureCharFrame()).toContain("Copied");
    } finally {
      setup.renderer.destroy();
    }
  },
);
