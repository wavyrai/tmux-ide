/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { Show, createSignal, onCleanup } from "solid-js";
import { describe, expect, it } from "bun:test";
import { SelectableRow } from "../recipes.tsx";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  expectFrameBounds,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { applicationShellHitTest, projectApplicationShell } from "./application-shell.ts";
import { ApplicationShell } from "./application-shell.tsx";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocation,
  projectOpenTuiApplicationShell,
  reduceOpenTuiApplicationShellCommand,
} from "./application-shell-controller.ts";
import {
  projectWorkbenchShell,
  workbenchShellHitTest,
  type WorkbenchDockMode,
  type WorkbenchFocusZone,
} from "./workbench-shell.ts";
import { WorkbenchShell } from "./workbench-shell.tsx";

async function renderProductionShell(
  width: number,
  height: number,
  initialDockMode: WorkbenchDockMode,
  disposed?: () => void,
) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const events: string[] = [];
  let activeValue: "home" | "terminals" = "terminals";
  let dockModeValue = initialDockMode;
  let focusValue: WorkbenchFocusZone = "canvas";
  let paletteValue = false;
  let drivePalette = (_open: boolean) => {};
  let driveFocus = () => {};

  function Harness() {
    const [active, setActive] = createSignal(activeValue);
    const [dockMode, setDockMode] = createSignal(dockModeValue);
    const [focus, setFocus] = createSignal(focusValue);
    const [palette, setPalette] = createSignal(paletteValue);
    const semantic = () =>
      projectOpenTuiApplicationShell({
        projectName: "tmux-ide",
        rootLabel: "/workspace/tmux-ide",
        workspaceName: "main",
        activeMode: active(),
        dockMode: dockMode(),
        activeDockTool: "missions",
        focusZone:
          focus() === "canvas" ? "canvas" : focus() === "dock-tabs" ? "dock-tabs" : "dock-body",
        focusedPaneId: null,
        terminalInputPaneId: null,
        paletteOpen: palette(),
        sessions: [
          { name: "main", status: "working" },
          { name: "website", status: "blocked" },
        ],
        activeSession: "main",
        agents: [{ paneId: "%7", name: "Codex", kind: "codex", status: "working" }],
        notification: palette() ? "Command palette open" : "ready",
      });
    const shell = () =>
      projectApplicationShell({
        width,
        height,
        preferredSidebarWidth: 28,
        shell: semantic(),
        hoveredTabIndex: null,
        quitHint: "^q quit",
      });
    const workbench = () =>
      projectWorkbenchShell({
        width: shell().content.width,
        height: shell().content.height,
        dockMode: dockMode(),
        persistedDockHeight: null,
        activeDockTab: "missions",
        focusZone: focus(),
        dockTools: semantic().bottomDock.tools,
      });
    const activate = (surface: "home" | "terminals") => {
      const result = reduceOpenTuiApplicationShellCommand(
        semantic(),
        applicationShellSurfaceInvocation(semantic(), surface, {
          kind: "keyboard",
          surface: "application-bar",
        }),
      );
      activeValue = result.next.activeMode;
      setActive(activeValue);
      events.push(`surface:${surface}`);
    };
    const setPaletteOpen = (open: boolean) => {
      reduceOpenTuiApplicationShellCommand(
        semantic(),
        applicationShellPaletteInvocation(semantic(), open, {
          kind: "keyboard",
          surface: open ? "application-bar" : "command-palette",
        }),
      );
      paletteValue = open;
      setPalette(open);
      events.push(open ? "palette:open" : "palette:close");
    };
    drivePalette = setPaletteOpen;
    driveFocus = () => {
      focusValue = focus() === "canvas" ? "dock-tabs" : "canvas";
      setFocus(focusValue);
    };
    useKeyboard((event) => {
      const key = event.name.toLowerCase();
      if (key === "left") activate("home");
      else if (key === "f5") setPaletteOpen(true);
      else if (key === "escape" && palette()) setPaletteOpen(false);
      else if (key === "tab") driveFocus();
    });
    onCleanup(() => disposed?.());
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const shellHit = applicationShellHitTest(shell(), event.x, event.y);
          if (shellHit?.kind === "view") activate(shellHit.viewId);
          if (shellHit?.kind === "palette") setPaletteOpen(true);
          const dockHit = workbenchShellHitTest(
            workbench(),
            event.x - shell().layout.sidebar.width,
            event.y - shell().layout.tabbar.height,
          );
          if (dockHit?.kind === "dock-action") {
            dockModeValue = dockHit.nextMode;
            setDockMode(dockModeValue);
            events.push(`dock:${dockModeValue}`);
          }
        }}
      >
        <ApplicationShell
          theme={theme}
          projection={shell()}
          help="F5 palette · tab focus · ^q quit"
          note="production application root"
        >
          <WorkbenchShell
            theme={theme}
            projection={workbench()}
            canvas={
              <SelectableRow
                theme={theme}
                label="Native terminal canvas"
                meta={`${active()} · ${focus()}`}
                width={workbench().canvasBody.width}
                focused={focus() === "canvas"}
              />
            }
            dockBody={
              <SelectableRow
                theme={theme}
                label="Native Missions surface"
                meta={dockMode()}
                width={workbench().dockBodyContent.width}
                focused={focus() === "dock-body"}
              />
            }
          />
        </ApplicationShell>
        <Show when={palette()}>
          <box
            position="absolute"
            left={Math.max(1, Math.floor(width / 4))}
            top={3}
            width={Math.max(20, Math.floor(width / 2))}
            border
            borderColor={theme.colors.focus}
            backgroundColor={theme.colors.surface}
          >
            <text fg={theme.colors.foreground}>Command palette</text>
          </box>
        </Show>
      </box>
    );
  }

  const setup = await renderForTest(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    setup,
    events,
    active: () => activeValue,
    dockMode: () => dockModeValue,
    focus: () => focusValue,
    palette: () => paletteValue,
    setPaletteOpen: (open: boolean) => drivePalette(open),
    toggleFocus: () => driveFocus(),
    shell: () =>
      projectApplicationShell({
        width,
        height,
        preferredSidebarWidth: 28,
        shell: projectOpenTuiApplicationShell({
          projectName: "tmux-ide",
          rootLabel: "/workspace/tmux-ide",
          workspaceName: "main",
          activeMode: activeValue,
          dockMode: dockModeValue,
          activeDockTool: "missions",
          focusZone:
            focusValue === "canvas"
              ? "canvas"
              : focusValue === "dock-tabs"
                ? "dock-tabs"
                : "dock-body",
          focusedPaneId: null,
          terminalInputPaneId: null,
          paletteOpen: paletteValue,
          sessions: [{ name: "main", status: "working" }],
          activeSession: "main",
          agents: [],
          notification: "ready",
        }),
        hoveredTabIndex: null,
        quitHint: "^q quit",
      }),
    frame: () => setup.captureCharFrame(),
  };
}

describe("production ApplicationShell → WorkbenchShell OpenTUI renderer", () => {
  it.each([
    [80, 24, "collapsed"],
    [120, 40, "open"],
    [200, 60, "maximized"],
  ] as const)("records the %sx%s %s dock acceptance baseline", async (width, height, dockMode) => {
    const harness = await renderProductionShell(width, height, dockMode);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("production application");
    expect(stableFrame(frame)).toContain("F5 palette");
    expect(harness.dockMode()).toBe(dockMode);
  });

  it("routes palette open/close, focus, and canonical surface pointer input", async () => {
    const harness = await renderProductionShell(120, 40, "open");
    harness.setPaletteOpen(true);
    await harness.setup.renderOnce();
    expect(harness.palette()).toBe(true);
    expect(stableFrame(harness.frame())).toContain("Command palette");

    harness.setPaletteOpen(false);
    harness.toggleFocus();
    await harness.setup.renderOnce();
    expect(harness.palette()).toBe(false);
    expect(harness.focus()).toBe("dock-tabs");

    const home = harness.shell().tabs.find(({ id }) => id === "home")!;
    await harness.setup.mockMouse.click(
      home.span.start + Math.floor(home.span.width / 2),
      0,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.active()).toBe("home");
    expect(harness.events).toEqual(["palette:open", "palette:close", "surface:home"]);
  });

  it("destroys the renderer and disposes the Solid root", async () => {
    let disposed = false;
    const harness = await renderProductionShell(80, 24, "open", () => {
      disposed = true;
    });
    destroyTestRenderer(harness.setup);
    expect(disposed).toBe(true);
  });
});
