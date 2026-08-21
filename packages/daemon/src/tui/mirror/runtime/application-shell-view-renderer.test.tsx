/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { batch, createSignal } from "solid-js";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
import { projectApplicationShell } from "../workspace/application-shell.ts";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import { createApplicationShellBinding } from "./application-shell-binding.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { ApplicationShellView, applicationShellKeyAction } from "./application-shell-view.tsx";
import {
  terminalPaneChromeLabel,
  terminalWindowStripSlotWidth,
} from "./application-terminal-workspace.tsx";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import {
  decodeFocusFramebufferCapture,
  inspectFocusFramebufferCapture,
  projectFocusFramebufferRect,
} from "../../../../../../scripts/lib/product-focus.mjs";

function terminalLayout() {
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols: 40,
    rows: 12,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ pane: "pane.main", left: 0, top: 0, width: 40, height: 12, active: true }],
  };
  return { current, windows: [current] };
}

function twoWindowLayout() {
  const main = terminalLayout().current;
  const logs = {
    ...main,
    semanticWindowId: "window.logs",
    windowName: "logs",
    currentWindow: false,
    panes: [{ pane: "pane.logs", left: 0, top: 0, width: 40, height: 12, active: true }],
  };
  return { current: main, windows: [main, logs] };
}

const focusPaneId = "pane.promoted.4d2e6ef021a27f2ffc19";

function focusLayout() {
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols: 132,
    rows: 41,
    zoomed: false,
    paneBorderStatus: "top" as const,
    panes: [{ pane: focusPaneId, left: 0, top: 0, width: 132, height: 41, active: true }],
  };
  return { current, windows: [current] };
}

function semantic() {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "main",
    activeMode: "terminals",
    dockMode: "collapsed",
    activeDockTool: "missions",
    focusZone: "terminal",
    focusedPaneId: "pane.main",
    terminalInputPaneId: "pane.main",
    paletteOpen: false,
    sessions: [
      { name: "main", status: "working" },
      { name: "website", status: "blocked" },
    ],
    activeSession: "main",
    agents: [{ paneId: "pane.main", name: "Codex", kind: "codex", status: "working" }],
    notification: "ready",
  });
}

function adapter(): PaneScopedTerminalAdapter {
  const renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (_paneId, buffers, _width, height, _scroll, _fg, _bg, options) => {
      buffers.char.fill(32);
      buffers.attributes.fill(0);
      for (const [index, char] of [..."CANONICAL-CELL"].entries())
        buffers.char[index] = char.codePointAt(0)!;
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

function trackedAdapter() {
  const lifecycle = { subscriptions: 0, unsubscriptions: 0, fullBlits: 0 };
  const blits: Array<{
    full: boolean;
    forceRows: readonly number[] | null;
    writtenRows: readonly number[];
  }> = [];
  const base = adapter();
  const tracked: PaneScopedTerminalAdapter = {
    ...base,
    renderSource: {
      ...base.renderSource,
      cursorState: () => ({ x: 2, y: 2, hidden: false, style: "block", blink: false }),
      blitPane: (paneId, buffers, width, height, scroll, fg, bg, options) => {
        if (options.full) lifecycle.fullBlits += 1;
        const result = options.full
          ? base.renderSource.blitPane(paneId, buffers, width, height, scroll, fg, bg, options)
          : (() => {
              options.dirtyRows.push(...(options.forceRows ?? []));
              return null;
            })();
        blits.push({
          full: options.full,
          forceRows: options.forceRows ? [...options.forceRows] : null,
          writtenRows: [...options.dirtyRows],
        });
        return result;
      },
    },
    subscribePaneVersion: () => {
      lifecycle.subscriptions += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        lifecycle.unsubscriptions += 1;
      };
    },
  };
  return { adapter: tracked, lifecycle, blits };
}

function rendererShellClient(initial: ReturnType<typeof semantic>) {
  const listeners = new Set<(value: ReturnType<typeof semantic> | null) => void>();
  const client = {
    getSnapshot: () => ({ phase: "live", semantic: initial, authority: null }),
    subscribe: (scope: string, listener: (value: unknown) => void) => {
      if (scope === "semantic")
        listeners.add(listener as (value: ReturnType<typeof semantic> | null) => void);
      return () =>
        listeners.delete(listener as (value: ReturnType<typeof semantic> | null) => void);
    },
    dispatch: async () => ({ kind: "application-shell", operationId: null }),
  } as unknown as OpenTuiProductionWorkspaceClient;
  return {
    client,
    publishNull() {
      for (const listener of listeners) listener(null);
    },
  };
}

describe("production ApplicationShellView", () => {
  it("renders a catalog-backed configless shell with a real sidebar", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 80, height: 24 })}
          surface={() => "home"}
          semantic={() => null}
          generationStatus={() => "unavailable"}
          sessions={["ordinary-one", "ordinary-two"]}
          selectedSession={() => 1}
          bootstrapNote={() => null}
          paletteOpen={() => true}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 80, height: 24 },
    );

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("F1 Home");
    expect(frame).toContain("F2 Terminals");
    expect(frame).toContain("Sessions");
    expect(frame).toContain("ordinary-one");
    expect(frame).toContain("› ordinary");
    expect(frame).toContain("no workspace authority");
    expect(frame).toContain("Command palette");
    setup.renderer.destroy();
  });

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "retains shell, window strip, pane chrome, and canvas at %sx%s",
    async (width, height) => {
      registerPaneSurface();
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const palette = createTerminalPaletteProjection(theme);
      const canonical = semantic();
      const setup = await renderForTest(
        () => (
          <ApplicationShellView
            dimensions={() => ({ width, height })}
            surface={() => "terminals"}
            semantic={() => canonical}
            generationStatus={() => "live"}
            sessions={["main", "website"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => false}
            terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
            layout={terminalLayout}
            focusedPane={() => "pane.main"}
            theme={theme}
            palette={palette}
            onOpenSurface={() => undefined}
            onOpenSession={() => undefined}
            onSetPaletteOpen={() => undefined}
            onSelectPane={() => undefined}
            onResizePreview={() => undefined}
            onResizePane={() => undefined}
          />
        ),
        { width, height },
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, width, height);
      expect(frame).toContain("⌂");
      expect(frame).toContain("❯");
      expect(frame).toContain("website");
      expect(frame).toContain("Agents");
      expect(frame).toContain("Codex");
      expect(frame).toContain("main");
      expect(frame).toContain("● pane.main");
      expect(frame).toContain("CANONICAL-CELL");
      expect(frame).not.toContain("Missions");
      setup.renderer.destroy();
    },
  );

  it("keeps the ProductRig focus projection exact through active-inactive-active frames", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const canonical = semantic();
    const selected: string[] = [];
    let setRendererFocused!: (focused: boolean) => void;
    const setup = await renderForTest(
      () => {
        const [rendererFocused, setRendererFocusedSignal] = createSignal(true);
        setRendererFocused = setRendererFocusedSignal;
        return (
          <ApplicationShellView
            dimensions={() => ({ width: 160, height: 44 })}
            surface={() => "terminals"}
            semantic={() => canonical}
            generationStatus={() => "live"}
            sessions={["main", "inactive"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => false}
            terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
            layout={focusLayout}
            focusedPane={() => (rendererFocused() ? focusPaneId : null)}
            rendererFocused={rendererFocused}
            theme={theme}
            palette={palette}
            onOpenSurface={() => undefined}
            onOpenSession={() => undefined}
            onSetPaletteOpen={() => undefined}
            onSelectPane={(paneId) => selected.push(paneId)}
            onResizePreview={() => undefined}
            onResizePane={() => undefined}
          />
        );
      },
      { width: 160, height: 44 },
    );
    const projectedRect = projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: focusLayout().current,
      canonicalPaneId: focusPaneId,
    });
    expect(terminalPaneChromeLabel(focusPaneId, true, 132)).toBe(`● ${focusPaneId}`);
    expect(terminalPaneChromeLabel(focusPaneId, false, 132)).toBe(`○ ${focusPaneId}`);
    const inspect = (expectedMarker: "●" | "○") => {
      const rendererRows = setup.captureCharFrame().split("\n");
      while (rendererRows.length > 44 && rendererRows.at(-1) === "") rendererRows.pop();
      while (rendererRows.length < 44) rendererRows.push("");
      return inspectFocusFramebufferCapture({
        ansiFrame: decodeFocusFramebufferCapture({
          version: 1,
          cols: 160,
          rows: 44,
          ansi: rendererRows.map((row) => row.padEnd(160)).join("\n"),
        }).ansi,
        semanticPaneId: focusPaneId,
        expectedMarker,
        projectedRect,
        cursorRow: 0,
      });
    };

    await setup.renderOnce();
    expect(projectedRect).toMatchObject({ left: 28, chromeRow: 2, firstBodyRow: 3 });
    expect(inspect("●")).toMatchObject({ valid: true, reason: null });
    setRendererFocused(false);
    await setup.renderOnce();
    expect(inspect("○")).toMatchObject({ valid: true, reason: null });
    setRendererFocused(true);
    await setup.renderOnce();
    expect(inspect("●")).toMatchObject({ valid: true, reason: null });
    await setup.mockMouse.click(28, 2, MouseButtons.LEFT);
    expect(selected).toEqual([focusPaneId]);
    setup.renderer.destroy();
  });

  it("retains two 132x41 window surfaces through warm switches and an active rename", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const tracked = trackedAdapter();
    const windowA = {
      type: "layout" as const,
      semanticWindowId: "window.a",
      windowName: "alpha",
      currentWindow: true,
      cols: 132,
      rows: 41,
      zoomed: false,
      paneBorderStatus: "top" as const,
      panes: [{ pane: "pane.main", left: 0, top: 0, width: 132, height: 41, active: true }],
    };
    const windowB = {
      ...windowA,
      semanticWindowId: "window.b",
      windowName: "beta",
      currentWindow: false,
      panes: [{ pane: "pane.logs", left: 0, top: 0, width: 132, height: 41, active: true }],
    };
    let setLayout!: (value: OpenTuiWorkspaceLayoutSnapshot) => void;
    let setFocused!: (value: string) => void;
    const Harness = () => {
      const [layout, updateLayout] = createSignal<OpenTuiWorkspaceLayoutSnapshot>({
        current: windowA,
        windows: [windowA, windowB],
      });
      const [focused, updateFocused] = createSignal("pane.main");
      setLayout = updateLayout;
      setFocused = updateFocused;
      return (
        <ApplicationShellView
          dimensions={() => ({ width: 160, height: 44 })}
          surface={() => "terminals"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => ({ adapter: tracked.adapter, rendererEpoch: 1 })}
          layout={layout}
          focusedPane={focused}
          rendererFocused={() => true}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      );
    };
    const setup = await renderForTest(() => <Harness />, { width: 160, height: 44 });
    await setup.renderOnce();
    expect(tracked.lifecycle.subscriptions).toBe(2);
    tracked.blits.length = 0;

    const inactiveA = { ...windowA, currentWindow: false };
    const activeB = { ...windowB, currentWindow: true };
    batch(() => {
      setFocused("pane.logs");
      setLayout({ current: activeB, windows: [inactiveA, activeB] });
    });
    await setup.renderOnce();
    expect(tracked.blits).toEqual([expect.objectContaining({ full: true })]);
    tracked.blits.length = 0;
    await Bun.sleep(30);
    let measuredFrames = 0;
    let measuredStage = "warm-a";
    const measuredFrameStages: string[] = [];
    const onMeasuredFrame = () => {
      measuredFrames += 1;
      measuredFrameStages.push(measuredStage);
    };
    setup.renderer.on("frame", onMeasuredFrame);
    const waitForMeasuredFrame = async (expected: number): Promise<void> => {
      const deadline = performance.now() + 250;
      while (measuredFrames < expected && performance.now() < deadline) await Bun.sleep(1);
      expect(measuredFrames).toBe(expected);
    };
    const expectQuiet = async (expected: number): Promise<void> => {
      await Bun.sleep(320);
      expect(measuredFrames).toBe(expected);
    };

    batch(() => {
      setFocused("pane.main");
      setLayout({ current: windowA, windows: [windowA, windowB] });
    });
    await waitForMeasuredFrame(1);
    await expectQuiet(1);
    expect(tracked.blits).toEqual([]);
    tracked.blits.length = 0;

    measuredStage = "warm-b";
    batch(() => {
      setFocused("pane.logs");
      setLayout({ current: activeB, windows: [inactiveA, activeB] });
    });
    await waitForMeasuredFrame(2);
    await expectQuiet(2);
    expect(tracked.blits).toEqual([]);
    tracked.blits.length = 0;

    measuredStage = "rename";
    const renamedB = { ...activeB, windowName: "renamed-beta" };
    setLayout({ current: renamedB, windows: [inactiveA, renamedB] });
    await waitForMeasuredFrame(3);
    await expectQuiet(3);
    expect(setup.captureCharFrame()).toContain("renamed-beta");
    expect(tracked.blits).toEqual([]);
    expect(tracked.lifecycle.subscriptions).toBe(2);
    expect(tracked.lifecycle.unsubscriptions).toBe(0);
    expect(measuredFrameStages).toEqual(["warm-a", "warm-b", "rename"]);
    setup.renderer.off("frame", onMeasuredFrame);
    setup.renderer.destroy();
  });

  it("keeps the coherent shell and canonical framebuffer mounted through rebinding only", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const fake = rendererShellClient(semantic());
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    const [bound, setBound] = createSignal(binding.getSnapshot());
    const stop = binding.subscribe(setBound);
    const retainedAdapter = adapter();
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => bound().semantic}
          generationStatus={() => bound().status}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() =>
            bound().status === "live" || bound().status === "rebinding"
              ? { adapter: retainedAdapter, rendererEpoch: 1 }
              : null
          }
          layout={terminalLayout}
          focusedPane={() => "pane.main"}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );

    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("CANONICAL-CELL");
    fake.publishNull();
    binding.adoptGeneration({ status: "rebinding", client: fake.client });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("CANONICAL-CELL");

    binding.adoptGeneration({ status: "unavailable", client: null });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("CANONICAL-CELL");
    stop();
    binding.dispose();
    setup.renderer.destroy();
  });

  it("preserves one terminal owner across fresh semantic bursts and remounts only for availability or renderer identity", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const first = trackedAdapter();
    const second = trackedAdapter();
    let setSemantic!: (value: ReturnType<typeof semantic>) => void;
    let setStatus!: (value: string) => void;
    let setRendererFocused!: (value: boolean) => void;
    let setSource!: (
      value: { adapter: PaneScopedTerminalAdapter; rendererEpoch: number } | null,
    ) => void;
    const setup = await renderForTest(
      () => {
        const [semanticProjection, setSemanticProjection] = createSignal(semantic());
        const [status, setStatusSignal] = createSignal("live");
        const [rendererFocused, setRendererFocusedSignal] = createSignal(true);
        const [source, setSourceSignal] = createSignal<{
          adapter: PaneScopedTerminalAdapter;
          rendererEpoch: number;
        } | null>({ adapter: first.adapter, rendererEpoch: 1 });
        setSemantic = setSemanticProjection;
        setStatus = setStatusSignal;
        setRendererFocused = setRendererFocusedSignal;
        setSource = setSourceSignal;
        return (
          <ApplicationShellView
            dimensions={() => ({ width: 120, height: 40 })}
            surface={() => "terminals"}
            semantic={semanticProjection}
            generationStatus={status}
            sessions={["main"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => false}
            terminalRendererSource={() => {
              const current = source();
              return current
                ? { adapter: current.adapter, rendererEpoch: current.rendererEpoch }
                : null;
            }}
            layout={terminalLayout}
            focusedPane={() => (rendererFocused() ? "pane.main" : null)}
            rendererFocused={rendererFocused}
            theme={theme}
            palette={palette}
            onOpenSurface={() => undefined}
            onOpenSession={() => undefined}
            onSetPaletteOpen={() => undefined}
            onSelectPane={() => undefined}
            onResizePreview={() => undefined}
            onResizePane={() => undefined}
          />
        );
      },
      { width: 120, height: 40 },
    );

    await setup.renderOnce();
    expect(first.lifecycle).toEqual({ subscriptions: 1, unsubscriptions: 0, fullBlits: 1 });
    for (const notification of ["authority-release", "background", "authority-settled"]) {
      const next = structuredClone(semantic());
      next.notification = notification;
      setSemantic(next);
      await setup.renderOnce();
    }
    setStatus("rebinding");
    setSemantic(structuredClone(semantic()));
    await setup.renderOnce();
    expect(first.lifecycle).toEqual({ subscriptions: 1, unsubscriptions: 0, fullBlits: 1 });
    expect(first.blits).toEqual([
      {
        full: true,
        forceRows: null,
        writtenRows: Array.from({ length: 11 }, (_, row) => row),
      },
    ]);

    setRendererFocused(false);
    await setup.renderOnce();
    setRendererFocused(true);
    await setup.renderOnce();
    expect(first.blits.slice(1)).toEqual([
      { full: false, forceRows: [2], writtenRows: [2] },
      { full: false, forceRows: [2], writtenRows: [2] },
    ]);
    expect(first.lifecycle).toEqual({ subscriptions: 1, unsubscriptions: 0, fullBlits: 1 });

    // A fresh wrapper around the same adapter/epoch is not a renderer replacement.
    setSource({ adapter: first.adapter, rendererEpoch: 1 });
    await setup.renderOnce();
    expect(first.lifecycle).toEqual({ subscriptions: 1, unsubscriptions: 0, fullBlits: 1 });

    setSource({ adapter: first.adapter, rendererEpoch: 2 });
    await setup.renderOnce();
    expect(first.lifecycle).toEqual({ subscriptions: 2, unsubscriptions: 1, fullBlits: 2 });

    setSource({ adapter: second.adapter, rendererEpoch: 2 });
    await setup.renderOnce();
    expect(first.lifecycle.unsubscriptions).toBe(2);
    expect(second.lifecycle).toEqual({ subscriptions: 1, unsubscriptions: 0, fullBlits: 1 });

    setSource(null);
    await setup.renderOnce();
    expect(second.lifecycle.unsubscriptions).toBe(1);
    expect(setup.captureCharFrame()).not.toContain("CANONICAL-CELL");
    setup.renderer.destroy();
  });

  it("routes tab, sidebar, and palette pointer selection through pure shell hit testing", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const canonical = semantic();
    const events: string[] = [];
    const projected = projectApplicationShell({
      width: 120,
      height: 40,
      preferredSidebarWidth: 28,
      shell: canonical,
      hoveredTabIndex: null,
      quitHint: "^q quit",
    });
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => canonical}
          generationStatus={() => "live"}
          sessions={["main", "website"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onOpenSurface={(surface, source) => events.push(`${source}:${surface}`)}
          onOpenSession={(session, source) => events.push(`${source}:session:${session}`)}
          onSetPaletteOpen={(open, source) => events.push(`${source}:palette:${open}`)}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();

    const home = projected.tabs.find((tab) => tab.id === "home")!;
    await setup.mockMouse.click(home.span.start + 1, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(2, projected.layout.sidebar.y + 2, MouseButtons.LEFT);
    await setup.mockMouse.click(
      projected.layout.sidebar.x + projected.sidebarHint.buttonSpan.start,
      projected.layout.sidebar.y + projected.layout.sidebar.height - 1,
      MouseButtons.LEFT,
    );

    expect(events).toEqual(["mouse:home", "mouse:session:website", "mouse:palette:true"]);
    setup.renderer.destroy();
  });

  it("maps the production chrome keyboard contract without consuming terminal keys", () => {
    expect(applicationShellKeyAction({ name: "f1" }, false)).toBe("home");
    expect(applicationShellKeyAction({ name: "F2" }, false)).toBe("terminals");
    expect(applicationShellKeyAction({ name: "f5" }, false)).toBe("palette-open");
    expect(applicationShellKeyAction({ name: "escape" }, true)).toBe("palette-close");
    expect(applicationShellKeyAction({ name: "escape" }, false)).toBeNull();
    expect(applicationShellKeyAction({ name: "a" }, false)).toBeNull();
  });

  it("routes a production window-strip click to the canonical pane selector", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const canonical = semantic();
    const selected: string[] = [];
    const shell = projectApplicationShell({
      width: 120,
      height: 40,
      preferredSidebarWidth: 28,
      shell: canonical,
      hoveredTabIndex: null,
      quitHint: "^q quit",
    });
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => canonical}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
          layout={twoWindowLayout}
          focusedPane={() => "pane.main"}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={(paneId) => selected.push(paneId)}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();

    // " main " occupies six cells; the next window begins immediately after it.
    await setup.mockMouse.click(shell.content.x + 1, shell.content.y, MouseButtons.LEFT);
    await setup.mockMouse.click(
      shell.content.x + terminalWindowStripSlotWidth(shell.content.width, 2) + 1,
      shell.content.y,
      MouseButtons.LEFT,
    );
    expect(selected).toEqual(["pane.main", "pane.logs"]);
    setup.renderer.destroy();
  });
});
