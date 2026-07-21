import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  CANONICAL_SURFACE_REGISTRY,
  COHESION_FIXTURE_V1,
  applicationShellActionTraceV1,
  applicationShellCommandInvocation,
  replayApplicationShellActionTraceV1,
} from "@tmux-ide/contracts";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocation,
  openTuiRuntimePaneId,
  openTuiSemanticPaneId,
  projectOpenTuiApplicationShell,
  reduceOpenTuiApplicationShellCommand,
} from "./application-shell-controller.ts";

function projection(overrides: { paletteOpen?: boolean; focusZone?: "canvas" | "dock-tabs" } = {}) {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "main",
    activeMode: "terminals",
    dockMode: "open",
    activeDockTool: "missions",
    focusZone: overrides.focusZone ?? "dock-tabs",
    focusedPaneId: null,
    terminalInputPaneId: null,
    paletteOpen: overrides.paletteOpen ?? false,
    sessions: [{ name: "main", status: "working" }],
    activeSession: "main",
    agents: [
      { paneId: "%7", name: "Codex", kind: "codex", status: "working" },
      { paneId: "%8", name: "Fable", kind: "claude", status: "blocked" },
    ],
    notification: "live",
  });
}

describe("OpenTUI canonical application-shell controller", () => {
  it("projects exactly the canonical surface identity, order, shortcuts, and commands", () => {
    const shell = projection();
    const projected = [...shell.primaryNavigation.items, ...shell.bottomDock.tools].map(
      ({ id, icon, label, order, shortcut, activation }) => ({
        id,
        icon,
        label,
        order,
        shortcut,
        activation,
      }),
    );
    expect(projected).toEqual(
      CANONICAL_SURFACE_REGISTRY.map(({ id, icon, label, order, shortcut, activation }) => ({
        id,
        icon,
        label,
        order,
        shortcut,
        activation,
      })),
    );
    expect(shell.sidebar.agents.map(({ harness }) => harness)).toEqual(["codex", "claude-code"]);
  });

  it("reduces canonical surface commands before adapting to existing renderer effects", () => {
    const shell = projection();
    const canvas = reduceOpenTuiApplicationShellCommand(
      shell,
      applicationShellSurfaceInvocation(shell, "home", {
        kind: "keyboard",
        surface: "application-bar",
      }),
    );
    expect(canvas.next.activeMode).toBe("home");
    expect(canvas.effect).toMatchObject({
      kind: "renderer-command",
      invocation: { id: "workspace.canvas.activate", args: { panel: "home" } },
    });

    const dock = reduceOpenTuiApplicationShellCommand(
      shell,
      applicationShellSurfaceInvocation(shell, "changes", {
        kind: "mouse",
        surface: "bottom-dock",
      }),
    );
    expect(dock.next.activeDockTool).toBe("changes");
    expect(dock.effect).toMatchObject({
      kind: "renderer-command",
      invocation: { id: "workspace.dock.activate", args: { tab: "changes" } },
    });
  });

  it("opens the palette as the sole overlay owner and restores focus on close", () => {
    const closed = projection({ focusZone: "dock-tabs" });
    const opened = reduceOpenTuiApplicationShellCommand(
      closed,
      applicationShellPaletteInvocation(closed, true, {
        kind: "keyboard",
        surface: "application-bar",
      }),
    );
    expect(opened.next.focus.overlays).toEqual([
      expect.objectContaining({ kind: "command-palette" }),
    ]);
    expect(opened.effect).toMatchObject({
      kind: "renderer-command",
      invocation: { id: "app.palette.open", args: {} },
    });

    const openProjection = projection({ paletteOpen: true, focusZone: "dock-tabs" });
    const closedAgain = reduceOpenTuiApplicationShellCommand(
      openProjection,
      applicationShellPaletteInvocation(openProjection, false, {
        kind: "keyboard",
        surface: "command-palette",
      }),
    );
    expect(closedAgain.next.focus.overlays).toEqual([]);
    expect(closedAgain.effect).toEqual({
      kind: "palette-close",
      restore: { kind: "zone", zone: "dock-tabs" },
    });
  });

  it("correlates terminal palette return to the same live pane and rejects stale panes", () => {
    const terminalProjection = (paletteOpen: boolean) =>
      projectOpenTuiApplicationShell({
        projectName: "tmux-ide",
        rootLabel: "/workspace/tmux-ide",
        workspaceName: "main",
        activeMode: "terminals",
        dockMode: "open",
        activeDockTool: "files",
        focusZone: "terminal",
        focusedPaneId: "%7",
        terminalInputPaneId: "%7",
        paletteOpen,
        sessions: [{ name: "main", status: "working" }],
        activeSession: "main",
        agents: [],
      });
    const closed = terminalProjection(false);
    const opened = reduceOpenTuiApplicationShellCommand(
      closed,
      applicationShellPaletteInvocation(closed, true, {
        kind: "keyboard",
        surface: "terminal",
      }),
    );
    expect(opened.next.focus.overlays[0]?.focusReturnTarget).toEqual({
      kind: "pane",
      paneId: openTuiSemanticPaneId("%7"),
      input: "terminal",
    });

    const open = terminalProjection(true);
    const close = reduceOpenTuiApplicationShellCommand(
      open,
      applicationShellPaletteInvocation(open, false, {
        kind: "keyboard",
        surface: "command-palette",
      }),
    );
    expect(close.effect).toEqual({
      kind: "palette-close",
      restore: {
        kind: "pane",
        paneId: openTuiSemanticPaneId("%7"),
        input: "terminal",
      },
    });
    expect(openTuiRuntimePaneId(openTuiSemanticPaneId("%7"), ["%6", "%7"])).toBe("%7");
    expect(openTuiRuntimePaneId(openTuiSemanticPaneId("%7"), ["%6"])).toBeNull();
  });

  it("replays the shared canonical trace deterministically", () => {
    const input = {
      project: COHESION_FIXTURE_V1.project,
      workspace: COHESION_FIXTURE_V1.workspace,
      dock: COHESION_FIXTURE_V1.dock,
      focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
      connection: COHESION_FIXTURE_V1.connection,
    };
    const trace = applicationShellActionTraceV1(input, {
      kind: "program",
      surface: "opentui",
    });
    expect(replayApplicationShellActionTraceV1(trace)).toEqual(trace.finalState);
    expect(trace.invocations.map(({ id }) => id)).toContain(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
    );
    expect(trace.invocations.map(({ id }) => id)).toContain(
      APPLICATION_SHELL_COMMAND_IDS.closePalette,
    );
  });

  it("audits removal of every former local shell registry/activation owner", () => {
    const workbench = readFileSync(
      fileURLToPath(new URL("./workbench-shell.ts", import.meta.url)),
      "utf8",
    );
    const app = readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8");
    expect(workbench).not.toContain("const DOCK_TABS");
    expect(app).not.toContain("<ShellTabBar");
    expect(app).not.toContain("RENDERER_COMMAND_IDS.openPalette");
    expect(app).not.toContain("rendererInvocationForCanvas(");
    expect(app).not.toContain("rendererInvocationForDock(");
    expect(app).toContain("if (runtimePaneId && mirror) mirror.focus(runtimePaneId)");
    expect(app.match(/<ApplicationShell\b/gu)).toHaveLength(1);
    expect(app.match(/<WorkbenchShell\b/gu)).toHaveLength(1);
    expect(app.match(/\buseKeyboard\(/gu)).toHaveLength(1);
    expect(app.match(/\busePaste\(/gu)).toHaveLength(1);

    const canonicalIds = new Set(Object.values(APPLICATION_SHELL_COMMAND_IDS));
    expect(canonicalIds.size).toBe(Object.values(APPLICATION_SHELL_COMMAND_IDS).length);
    expect(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode: "maximized" },
        { kind: "program", surface: "audit" },
      ).id,
    ).toBe("application.shell.dock.mode.set");
  });
});
