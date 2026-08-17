/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
import { projectApplicationShell } from "../workspace/application-shell.ts";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import { createApplicationShellBinding } from "./application-shell-binding.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { ApplicationShellView, applicationShellKeyAction } from "./application-shell-view.tsx";

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
      expect(frame).toContain("pane.main");
      expect(frame).toContain("CANONICAL-CELL");
      expect(frame).not.toContain("Missions");
      setup.renderer.destroy();
    },
  );

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
    await setup.mockMouse.click(shell.content.x + 7, shell.content.y, MouseButtons.LEFT);
    expect(selected).toEqual(["pane.logs"]);
    setup.renderer.destroy();
  });
});
