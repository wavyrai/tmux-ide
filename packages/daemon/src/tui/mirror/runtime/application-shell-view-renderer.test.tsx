/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { batch, createSignal } from "solid-js";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import {
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../theme.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
import { terminalDisplayWidth } from "../terminal-text.ts";
import { projectApplicationShell } from "../workspace/application-shell.ts";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import { createApplicationShellBinding } from "./application-shell-binding.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import {
  ApplicationShellView,
  applicationHomeBrandVariant,
  applicationPaletteKeyAction,
  applicationShellKeyAction,
} from "./application-shell-view.tsx";
import { applicationMousePointerIngressCapability } from "./application-terminal-selection-owner.ts";
import { beginApplicationMouseIngress } from "./application-terminal-workspace.tsx";
import {
  terminalAgentStatusLabel,
  terminalPaneChromeLabel,
  terminalWindowStripLabel,
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

function shellChromeSnapshot(frame: string): string {
  const rows = frame.split("\n").map((row) => row.trimEnd());
  return [...rows.slice(0, 10), "…", ...rows.slice(-3)].join("\n").trimEnd();
}

function trimFrameRight(frame: string): string {
  return frame
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd();
}

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

function spanBackgroundAt(
  line: ReturnType<Awaited<ReturnType<typeof renderForTest>>["captureSpans"]>["lines"][number],
  column: number,
) {
  let offset = 0;
  for (const span of line.spans) {
    const width = terminalDisplayWidth(span.text);
    if (column >= offset && column < offset + width) return span.bg;
    offset += width;
  }
  return null;
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

function mixedAgentLayout() {
  const current = {
    ...terminalLayout().current,
    cols: 80,
    panes: [
      { pane: "pane.main", left: 0, top: 0, width: 40, height: 12, active: true },
      { pane: "pane.secondary", left: 40, top: 0, width: 40, height: 12, active: false },
    ],
  };
  return { current, windows: [current] };
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
    paneIdentities: [{ runtimePaneId: "pane.main", semanticPaneId: "pane.main" }],
    notification: "ready",
  });
}

function adapter(): PaneScopedTerminalAdapter {
  const renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (_paneId, buffers, width, height, _scroll, fg, bg, options) => {
      buffers.char.fill(32);
      buffers.attributes.fill(0);
      for (let cell = 0; cell < width * height; cell += 1) {
        const offset = cell * 4;
        buffers.fg.set([(fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff, 0xff], offset);
        buffers.bg.set([(bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff, 0xff], offset);
      }
      for (const [index, char] of [..."CANONICAL-CELL"].entries())
        buffers.char[index] = char.codePointAt(0)!;
      for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
      return null;
    },
  };
  return {
    renderSource,
    paneSelectionSnapshot: () => null,
    paneVersion: () => 1,
    paneSourceEpoch: () => 1,
    subscribePaneVersion: () => () => undefined,
  };
}

function selectionAdapter(): PaneScopedTerminalAdapter {
  const defaultColor = { kind: "default" as const };
  const snapshot: TerminalReplicaSnapshot = {
    cols: 132,
    rows: 41,
    history: [],
    grid: Array.from({ length: 41 }, (_, row) => ({
      wrapped: false,
      cells: Array.from({ length: 132 }, (_, column) => ({
        grapheme: row === 0 ? ("SELECT_TARGET"[column] ?? " ") : " ",
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
  const base = adapter();
  return {
    ...base,
    paneSelectionSnapshot: (paneId) => (paneId === focusPaneId ? snapshot : null),
    renderSource: {
      ...base.renderSource,
      blitPane: (_paneId, buffers, _width, height, _scroll, _fg, _bg, options) => {
        buffers.char.fill(32);
        buffers.attributes.fill(0);
        for (const [index, char] of [..."SELECT_TARGET"].entries())
          buffers.char[index] = char.codePointAt(0)!;
        for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
        return null;
      },
    },
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
  it("selects a deterministic terminal-safe Home brand for each golden viewport", () => {
    expect(applicationHomeBrandVariant(52, 21)).toBe("compact");
    expect(applicationHomeBrandVariant(92, 37)).toBe("full");
    expect(applicationHomeBrandVariant(172, 57)).toBe("full");
    expect(applicationHomeBrandVariant(24, 10)).toBe("wordmark");
  });

  it.each([
    [80, 24, "compact"],
    [120, 40, "full"],
    [200, 60, "full"],
  ] as const)(
    "renders the responsive Home identity and clickable actions at %sx%s",
    async (width, height, expectedBrand) => {
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const palette = createTerminalPaletteProjection(theme);
      const events: string[] = [];
      const setup = await renderForTest(
        () => (
          <ApplicationShellView
            dimensions={() => ({ width, height })}
            surface={() => "home"}
            semantic={() => semantic()}
            generationStatus={() => "live"}
            sessions={["main", "website"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => false}
            terminalRendererSource={() => null}
            layout={terminalLayout}
            focusedPane={() => null}
            theme={theme}
            palette={palette}
            onOpenSurface={(surface, source) => events.push(`${source}:surface:${surface}`)}
            onOpenSession={() => undefined}
            onSetPaletteOpen={(open, source) => events.push(`${source}:palette:${open}`)}
            onCycleTheme={() => events.push("mouse:theme")}
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
      expect(frame).toContain("Your tmux sessions");
      expect(frame).toContain("2 sessions · 1 working · 0 need attention");
      expect(frame).toContain("main · live");
      expect(frame).toContain("Open terminals F2");
      expect(frame).toContain("Commands F5");
      expect(frame).toContain("Theme: dark");
      expect(frame).not.toContain("website");
      if (expectedBrand === "full") expect(frame).toContain("░████████");
      else expect(frame).toContain("▀█▀ █▄█ █ █ ▀▄▀");

      const rows = frame.split("\n");
      const terminalsY = rows.findIndex((row) => row.includes("Open terminals F2"));
      const commandsY = rows.findIndex((row) => row.includes("Commands F5"));
      const themeY = rows.findIndex((row) => row.includes("Theme: dark"));
      expect(terminalsY).toBeGreaterThanOrEqual(0);
      expect(commandsY).toBeGreaterThanOrEqual(0);
      expect(themeY).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[terminalsY]!.indexOf("Open terminals") + 2, terminalsY);
      await setup.mockMouse.click(rows[commandsY]!.indexOf("Commands") + 2, commandsY);
      await setup.mockMouse.click(rows[themeY]!.indexOf("Theme") + 2, themeY);
      expect(events).toEqual(["mouse:surface:terminals", "mouse:palette:true", "mouse:theme"]);
      setup.renderer.destroy();
    },
  );

  it("repaints terminal chrome and default terminal cells across a live theme switch", async () => {
    registerPaneSurface();
    const dark = createSemanticThemeSnapshot({ mode: "dark" });
    const light = createSemanticThemeSnapshot({ mode: "light" });
    const terminal = trackedAdapter();
    let selectTheme!: (theme: typeof dark) => void;
    function Harness() {
      const [theme, setTheme] = createSignal(dark);
      selectTheme = setTheme;
      return (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => ({ adapter: terminal.adapter, rendererEpoch: 1 })}
          layout={terminalLayout}
          focusedPane={() => "pane.main"}
          theme={theme()}
          palette={createTerminalPaletteProjection(theme())}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      );
    }
    const setup = await renderForTest(() => <Harness />, { width: 120, height: 40 });
    await setup.renderOnce();

    selectTheme(light);
    await setup.renderOnce();
    const spans = setup.captureSpans();
    const topNavigation = spans.lines[0]?.spans.find((span) => span.text.includes("tmux-ide"));
    const inactiveHomeTab = spans.lines[0]?.spans.find((span) => span.text.includes("Home"));
    const sidebarTitle = spans.lines[1]?.spans.find((span) => span.text.includes("tmux-ide"));
    const agentLabel = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("Codex") && span.text.includes("WORKING"));
    const footerMessage = spans.lines.at(-1)?.spans.find((span) => span.text.includes("ready"));
    const terminalCell = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("CANONICAL-CELL"));
    const blankSidebarCell = spanBackgroundAt(spans.lines[10]!, 2);
    expect({
      topNavigation: Boolean(topNavigation),
      inactiveHomeTab: Boolean(inactiveHomeTab),
      sidebarTitle: Boolean(sidebarTitle),
      agentLabel: Boolean(agentLabel),
      footerMessage: Boolean(footerMessage),
      terminalCell: Boolean(terminalCell),
      blankSidebarCell: Boolean(blankSidebarCell),
    }).toEqual({
      topNavigation: true,
      inactiveHomeTab: true,
      sidebarTitle: true,
      agentLabel: true,
      footerMessage: true,
      terminalCell: true,
      blankSidebarCell: true,
    });
    expect(colorKey(topNavigation!.bg)).toBe(colorKey(light.roles.surfaces.header));
    expect(colorKey(inactiveHomeTab!.bg)).toBe(colorKey(light.roles.surfaces.panel));
    expect(colorKey(sidebarTitle!.bg)).toBe(colorKey(light.roles.surfaces.panel));
    expect(colorKey(agentLabel!.bg)).toBe(colorKey(light.roles.surfaces.panel));
    expect(colorKey(footerMessage!.bg)).toBe(colorKey(light.roles.surfaces.header));
    expect(colorKey(terminalCell!.bg)).toBe(colorKey(light.roles.surfaces.terminal));
    expect(colorKey(blankSidebarCell!)).toBe(colorKey(light.roles.surfaces.panel));
    expect(terminal.lifecycle).toEqual({ subscriptions: 2, unsubscriptions: 1, fullBlits: 2 });
    setup.renderer.destroy();
  });

  it("renders a catalog-backed Home as a focused full-width surface", async () => {
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
    expect(frame).not.toContain("Sessions");
    expect(frame).not.toContain("ordinary-one");
    expect(frame).toContain("2 sessions live");
    expect(frame).not.toContain("no workspace authority");
    const footer = frame.trimEnd().split("\n").at(-1)!;
    expect(footer).not.toContain("↑↓ choose");
    expect(footer).not.toContain("Enter open");
    expect(frame).toContain("Command palette");
    setup.renderer.destroy();
  });

  it("turns an authoritative empty catalog into an actionable first-run screen", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    let createCount = 0;
    let commandCount = 0;
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 80, height: 24 })}
          surface={() => "terminals"}
          semantic={() => null}
          generationStatus={() => "unavailable"}
          sessions={[]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          catalogPhase={() => "live"}
          catalogNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={(open) => {
            if (open) commandCount += 1;
          }}
          onCreateSession={() => {
            createCount += 1;
          }}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 80, height: 24 },
    );

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("tmux-ide");
    expect(frame).toContain("Home");
    expect(frame).toContain("Terminals");
    expect(frame).toContain("No tmux sessions are running");
    expect(frame).toContain("New local session N");
    expect(frame).toContain("New session N");
    expect(frame).toContain("Commands F5");
    expect(frame).not.toContain("Discovering live tmux sessions");

    const buttonRow = frame.split("\n").findIndex((line) => line.includes("New local session N"));
    const buttonColumn = frame.split("\n")[buttonRow]!.indexOf("New local session N");
    await setup.mockMouse.click(buttonColumn, buttonRow, MouseButtons.LEFT);
    await setup.renderOnce();
    expect(createCount).toBe(1);
    const rows = frame.split("\n");
    const footerY = rows.findIndex((line) => line.includes("New session N"));
    const footer = rows[footerY]!;
    await setup.mockMouse.click(footer.indexOf("New session") + 2, footerY, MouseButtons.LEFT);
    await setup.mockMouse.click(footer.indexOf("Commands") + 2, footerY, MouseButtons.LEFT);
    expect(createCount).toBe(2);
    expect(commandCount).toBe(1);
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
      expect(frame).toContain("● Codex");
      expect(frame).toContain("[WORKING]");
      expect(frame).toContain("0:main [WORKING]");
      expect(frame).toContain("⋯");
      expect(frame).not.toContain("[→][↓][×][⋯]");
      expect(frame).toContain("CANONICAL-CELL");
      expect(frame).not.toContain("Missions");
      expect(shellChromeSnapshot(frame)).toMatchSnapshot();
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

  it("routes exact SGR app mouse and keeps explicit select mode local in the real 160x44 shell", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const forwarded: Array<{ paneId: string; input: Record<string, unknown> }> = [];
    const selected: string[] = [];
    const copied: string[] = [];
    let selectionKey: ((name: string) => boolean) | null = null;
    const liveAdapter = selectionAdapter();
    liveAdapter.renderSource.paneCanonicalIdentity = (paneId) =>
      paneId === focusPaneId
        ? {
            generation: "11111111-1111-4111-8111-111111111111",
            incarnation: "11111111-1111-4111-8111-111111111111:0",
            revision: 1,
            stateHash: "selection-state",
            cols: 132,
            rows: 41,
            sourceEpoch: 1,
            historyTrim: 0,
          }
        : null;
    const connection = {};
    const client = {};
    let ingressOwnerCalls = 0;
    let ingressClockCalls = 0;
    const diagnosticsOffIngress = applicationMousePointerIngressCapability(false, () => {
      ingressOwnerCalls += 1;
      return null;
    });
    expect(
      beginApplicationMouseIngress(diagnosticsOffIngress, () => {
        ingressClockCalls += 1;
        return 1;
      }),
    ).toBeNull();
    const applicationIngress = applicationMousePointerIngressCapability(true, (input) => ({
      ...input,
      gestureId: "00000000-0000-4000-8000-000000000001",
    }));
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 160, height: 44 })}
          surface={() => "terminals"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => ({ adapter: liveAdapter, rendererEpoch: 1 })}
          terminalGestureRuntime={() => ({
            daemonGeneration: "22222222-2222-4222-8222-222222222222",
            clientGeneration: 1,
            connection,
            client,
            adapter: liveAdapter,
            rendererEpoch: 1,
          })}
          onApplicationMousePointerIngress={applicationIngress}
          layout={focusLayout}
          focusedPane={() => focusPaneId}
          rendererFocused={() => true}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onSelectPane={(paneId) => selected.push(paneId)}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
          onTerminalInput={(paneId, input) => forwarded.push({ paneId, input: { ...input } })}
          onCopyText={(text) => (copied.push(text), true)}
          onSelectionKeyOwner={(handle) => {
            selectionKey = handle;
          }}
        />
      ),
      { width: 160, height: 44 },
    );
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("SELECT_TARGET");

      await setup.mockMouse.pressDown(29, 3, MouseButtons.LEFT);
      await setup.mockMouse.release(159, 2, MouseButtons.LEFT);
      expect(forwarded.map(({ paneId, input }) => ({ paneId, data: input.data }))).toEqual([
        { paneId: focusPaneId, data: "\u001b[<0;2;1M" },
        { paneId: focusPaneId, data: "\u001b[<0;132;1m" },
      ]);
      expect(ingressOwnerCalls).toBe(0);
      expect(ingressClockCalls).toBe(0);
      expect(forwarded.map(({ input }) => input)).toEqual([
        expect.objectContaining({
          kind: "application-mouse",
          action: "down",
          column: 1,
          row: 0,
          button: 0,
          modifiers: { shift: false, alt: false, ctrl: false },
          ingress: expect.objectContaining({
            gestureId: "00000000-0000-4000-8000-000000000001",
            action: "down",
          }),
        }),
        expect.objectContaining({
          kind: "application-mouse",
          action: "up",
          column: 131,
          row: 0,
          button: 0,
          ingress: expect.objectContaining({
            gestureId: "00000000-0000-4000-8000-000000000001",
            action: "up",
          }),
        }),
      ]);
      expect(copied).toEqual([]);
      expect(selected).toEqual([focusPaneId]);

      await setup.mockMouse.click(29, 3, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Select text…");
      expect(selectionKey?.("enter")).toBe(true);
      await setup.mockMouse.pressDown(29, 3, MouseButtons.LEFT);
      await setup.mockMouse.moveTo(34, 3);
      await setup.renderOnce();
      await setup.mockMouse.release(34, 3, MouseButtons.LEFT);
      await setup.renderOnce();
      expect(forwarded).toHaveLength(2);
      expect(copied).toEqual(["ELECT_"]);
      expect(setup.captureCharFrame()).not.toContain("⧉ select");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("projects vertical and horizontal pane resize guides through the real 160x44 shell", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const run = async (
      panes: NonNullable<OpenTuiWorkspaceLayoutSnapshot["current"]>["panes"],
      gesture: { down: [number, number]; move: [number, number] },
      expected: Record<string, unknown>,
    ) => {
      const current = {
        type: "layout" as const,
        semanticWindowId: "window.main",
        windowName: "main",
        currentWindow: true,
        cols: 132,
        rows: 41,
        zoomed: false,
        paneBorderStatus: "top" as const,
        panes,
      };
      const previews: unknown[] = [];
      const submissions: unknown[] = [];
      let ingressOrdinal = 0;
      const setup = await renderForTest(
        () => (
          <ApplicationShellView
            dimensions={() => ({ width: 160, height: 44 })}
            surface={() => "terminals"}
            semantic={() => semantic()}
            generationStatus={() => "live"}
            sessions={["main"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => false}
            terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
            layout={() => ({ current, windows: [current] })}
            focusedPane={() => "pane.main"}
            rendererFocused={() => true}
            theme={theme}
            palette={palette}
            onOpenSurface={() => undefined}
            onOpenSession={() => undefined}
            onSetPaletteOpen={() => undefined}
            onSelectPane={() => undefined}
            onResizePreview={(preview) => previews.push(preview)}
            onResizePane={(preview) => submissions.push(preview)}
            onResizePointerIngress={(input) => ({
              ...input,
              gestureId: input.gestureId ?? "123e4567-e89b-42d3-a456-426614174000",
              traceId: `123e4567-e89b-42d3-a456-${String(ingressOrdinal++).padStart(12, "0")}`,
              atMicros: ingressOrdinal,
            })}
          />
        ),
        { width: 160, height: 44 },
      );
      try {
        await setup.renderOnce();
        await setup.mockMouse.pressDown(...gesture.down, MouseButtons.LEFT);
        await setup.mockMouse.moveTo(...gesture.move);
        await setup.renderOnce();
        expect(previews.at(-1)).toMatchObject(expected);
        const captured = setup.captureCharFrame().split("\n");
        const frameGuide = expected.globalGuide as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        const marker = expected.axis === "cols" ? "╎" : "╌";
        const markerCount = captured.reduce(
          (count, row) => count + [...row].filter((cell) => cell === marker).length,
          0,
        );
        expect(markerCount).toBe(frameGuide.width * frameGuide.height);
        for (let y = 0; y < frameGuide.height; y += 1)
          for (let x = 0; x < frameGuide.width; x += 1)
            expect(captured[frameGuide.y + y]?.[frameGuide.x + x]).toBe(marker);
        await setup.mockMouse.release(...gesture.move, MouseButtons.LEFT);
        await setup.renderOnce();
        expect(submissions).toHaveLength(1);
        expect(submissions[0]).toMatchObject(expected);
      } finally {
        setup.renderer.destroy();
      }
    };
    await run(
      [
        { pane: "pane.main", left: 0, top: 1, width: 65, height: 40, active: true },
        { pane: "pane.side", left: 66, top: 1, width: 66, height: 40, active: false },
      ],
      { down: [93, 10], move: [95, 10] },
      {
        semanticPaneId: "pane.main",
        axis: "cols",
        cells: 67,
        guide: { x: 67, y: 1, width: 1, height: 40 },
        globalGuide: { x: 95, y: 3, width: 1, height: 40 },
      },
    );
    await run(
      [
        { pane: "pane.main", left: 0, top: 1, width: 132, height: 19, active: true },
        { pane: "pane.lower", left: 0, top: 21, width: 132, height: 20, active: false },
      ],
      { down: [40, 22], move: [40, 24] },
      {
        semanticPaneId: "pane.main",
        axis: "rows",
        cells: 20,
        guide: { x: 0, y: 22, width: 132, height: 1 },
        globalGuide: { x: 28, y: 24, width: 132, height: 1 },
      },
    );
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
    expect(tracked.blits).toEqual([expect.objectContaining({ full: true })]);
    tracked.blits.length = 0;

    measuredStage = "warm-b";
    batch(() => {
      setFocused("pane.logs");
      setLayout({ current: activeB, windows: [inactiveA, activeB] });
    });
    await waitForMeasuredFrame(2);
    await expectQuiet(2);
    expect(tracked.blits).toEqual([expect.objectContaining({ full: true })]);
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

  it("opens an agent's session before focusing its exact pane from the sidebar", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const canonical = semantic();
    const opened: string[] = [];
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
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onOpenAgent={(sessionName, paneId, source) =>
            opened.push(`${source}:${sessionName}:${paneId}`)
          }
          onSetPaletteOpen={() => undefined}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();

    const agentRow = projected.layout.sidebar.y + canonical.sidebar.sessions.length + 3;
    await setup.mockMouse.click(projected.layout.sidebar.x + 2, agentRow, MouseButtons.LEFT);

    expect(opened).toEqual(["mouse:main:pane.main"]);
    setup.renderer.destroy();
  });

  it("activates the selected minimal palette destination by pointer", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const activated: string[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "home"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => true}
          paletteSelection={() => 1}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onPaletteActivate={(surface, source) => activated.push(`${source}:${surface}`)}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("› F2 Terminals");
    await setup.mockMouse.click(33, 17, MouseButtons.LEFT);
    expect(activated).toEqual(["mouse:terminals"]);
    setup.renderer.destroy();
  });

  it("routes the palette agent row through the same exact semantic target as the sidebar", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const opened: string[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => true}
          paletteSelection={() => 6}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onOpenSurface={() => undefined}
          onOpenSession={() => undefined}
          onSetPaletteOpen={() => undefined}
          onPaletteActivate={(command, source) => {
            if (typeof command === "object")
              opened.push(`${source}:${command.sessionName}:${command.paneId}`);
          }}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("› Jump to Codex · main");
    await setup.mockMouse.click(33, 22, MouseButtons.LEFT);
    expect(opened).toEqual(["mouse:main:pane.main"]);
    setup.renderer.destroy();
  });

  it("closes on an outside pointer without leaking through to terminal or shell chrome", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const events: string[] = [];
    const selected: string[] = [];
    const terminalInputs: unknown[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => semantic()}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => true}
          paletteSelection={() => 0}
          terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
          layout={terminalLayout}
          focusedPane={() => "pane.main"}
          theme={theme}
          palette={palette}
          onOpenSurface={(surface, source) => events.push(`${source}:${surface}`)}
          onOpenSession={() => undefined}
          onSetPaletteOpen={(open, source) => events.push(`${source}:palette:${open}`)}
          onPaletteActivate={(surface, source) => events.push(`${source}:activate:${surface}`)}
          onSelectPane={(paneId) => selected.push(paneId)}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
          onTerminalInput={(_paneId, input) => terminalInputs.push(input)}
        />
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(30, 10, MouseButtons.LEFT);
    expect(events).toEqual(["mouse:palette:false"]);
    expect(selected).toEqual([]);
    expect(terminalInputs).toEqual([]);
    setup.renderer.destroy();
  });

  it("reacts palette geometry through narrow live resizes", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    let setDimensions!: (value: { width: number; height: number }) => void;
    const setup = await renderForTest(
      () => {
        const [dimensions, setDimensionsSignal] = createSignal({ width: 28, height: 9 });
        setDimensions = setDimensionsSignal;
        return (
          <ApplicationShellView
            dimensions={dimensions}
            surface={() => "home"}
            semantic={() => semantic("home")}
            generationStatus={() => "live"}
            sessions={["main"]}
            selectedSession={() => 0}
            bootstrapNote={() => null}
            paletteOpen={() => true}
            paletteSelection={() => 0}
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
        );
      },
      { width: 28, height: 9 },
    );
    await setup.renderOnce();
    const initial = setup.captureCharFrame();
    expectFrameBounds(initial, 28, 9);
    expect(initial).toContain("Command palette");
    expect(trimFrameRight(initial)).toMatchSnapshot();

    setDimensions({ width: 20, height: 7 });
    setup.renderer.resize(20, 7);
    await setup.renderOnce();
    const resized = setup.captureCharFrame();
    expectFrameBounds(resized, 20, 7);
    expect(resized).toContain("Commands");
    expect(resized).toContain("F2 Terminals");
    expect(trimFrameRight(resized)).toMatchSnapshot();
    setup.renderer.destroy();
  });

  it("maps the production chrome keyboard contract without consuming terminal keys", () => {
    expect(applicationShellKeyAction({ name: "f1" }, false)).toBe("home");
    expect(applicationShellKeyAction({ name: "F2" }, false)).toBe("terminals");
    expect(applicationShellKeyAction({ name: "f5" }, false)).toBe("palette-open");
    expect(applicationShellKeyAction({ name: "escape" }, true)).toBe("palette-close");
    expect(applicationShellKeyAction({ name: "escape" }, false)).toBeNull();
    expect(applicationShellKeyAction({ name: "a" }, false)).toBeNull();
    expect(applicationPaletteKeyAction({ name: "down" }, true, 0)).toEqual({
      kind: "select",
      index: 1,
    });
    expect(applicationPaletteKeyAction({ name: "up" }, true, 1)).toEqual({
      kind: "select",
      index: 0,
    });
    expect(applicationPaletteKeyAction({ name: "up" }, true, 0)).toEqual({
      kind: "select",
      index: 5,
    });
    expect(applicationPaletteKeyAction({ name: "enter" }, true, 1)).toEqual({
      kind: "activate",
      command: "terminals",
    });
    expect(applicationPaletteKeyAction({ name: "escape" }, true, 1)).toEqual({ kind: "close" });
    expect(applicationPaletteKeyAction({ name: "a" }, true, 1)).toBeNull();
  });

  it("keeps canonical agent status textual in narrow pane and window chrome", () => {
    expect(terminalAgentStatusLabel("running")).toBe("WORKING");
    expect(terminalAgentStatusLabel("waiting")).toBe("BLOCKED");
    expect(terminalAgentStatusLabel("complete")).toBe("DONE");
    expect(terminalAgentStatusLabel("failed")).toBe("FAILED");
    expect(terminalAgentStatusLabel("disconnected")).toBe("UNKNOWN");
    expect(
      terminalPaneChromeLabel("pane.main", true, 22, {
        name: "Codex",
        activity: "running",
        attention: false,
      }),
    ).toBe("● Codex [WORKING]");
    expect(terminalWindowStripLabel("main", false, 22, "waiting", true)).toBe("○ main ! [BLOCKED]");
    expect(
      terminalPaneChromeLabel("pane.main", false, 9, {
        name: "Codex",
        activity: "disconnected",
        attention: false,
      }),
    ).toBe("○ UNKNOWN");
  });

  it("preserves canonical attention while prioritizing mixed window activity", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const base = semantic();
    const mixed = {
      ...base,
      sidebar: {
        ...base.sidebar,
        agents: [
          {
            id: "agent.codex",
            name: "Codex",
            harness: "codex" as const,
            activity: "running" as const,
            paneId: "pane.main",
            attention: false,
          },
          {
            id: "agent.scout",
            name: "Scout",
            harness: "claude-code" as const,
            activity: "idle" as const,
            paneId: "pane.secondary",
            attention: true,
          },
        ],
      },
    };
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 120, height: 40 })}
          surface={() => "terminals"}
          semantic={() => mixed}
          generationStatus={() => "live"}
          sessions={["main"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          terminalRendererSource={() => ({ adapter: adapter(), rendererEpoch: 1 })}
          layout={mixedAgentLayout}
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
    const frame = setup.captureCharFrame();
    expect(frame).toContain("0:main [WORKING]");
    expect(frame).toContain("● Codex");
    expect(frame).toContain("○ Scout");
    expect(frame).toContain("[IDLE]");
    expect(frame).toContain("• Codex [WORKING]");
    expect(frame).toContain("! Scout ! [IDLE]");
    expect(shellChromeSnapshot(frame)).toMatchSnapshot();
    setup.renderer.destroy();
  });

  it("routes a production window-strip click to the canonical pane selector", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const canonical = semantic();
    const selected: string[] = [];
    let createdWindows = 0;
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
          onCreateWindow={() => {
            createdWindows += 1;
          }}
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
    await setup.mockMouse.click(
      shell.content.x + shell.content.width - 2,
      shell.content.y,
      MouseButtons.LEFT,
    );
    expect(selected).toEqual(["pane.main", "pane.logs"]);
    expect(createdWindows).toBe(1);
    setup.renderer.destroy();
  });
});
