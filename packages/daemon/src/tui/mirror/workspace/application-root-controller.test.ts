import { describe, expect, it, vi } from "vitest";
import type { SemanticFocusTarget } from "@tmux-ide/contracts";
import { TuiCleanupRegistry } from "../input-lifecycle.ts";
import {
  applicationSidebarResizePointerPhase,
  createApplicationRootController,
} from "./application-root-controller.ts";
import {
  openTuiRuntimePaneId,
  projectOpenTuiApplicationShell,
  type OpenTuiApplicationShellEffect,
} from "./application-shell-controller.ts";

describe("production application root controller", () => {
  it("captures the exact pane at palette open and never redirects a stale return", () => {
    let paneId = "%7";
    let paletteOpen = false;
    let captured: SemanticFocusTarget | null = null;
    let livePaneIds = ["%7", "%8"];
    const focused: string[] = [];
    const cleanup = new TuiCleanupRegistry();
    const projection = () =>
      projectOpenTuiApplicationShell({
        projectName: "tmux-ide",
        rootLabel: "/workspace/tmux-ide",
        workspaceName: "main",
        activeMode: "terminals",
        dockMode: "open",
        activeDockTool: "files",
        focusZone: "terminal",
        focusedPaneId: paneId,
        terminalInputPaneId: paneId,
        paletteOpen,
        paletteFocusReturnTarget: captured,
        sessions: [{ name: "main", status: "working" }],
        activeSession: "main",
        agents: [],
      });
    const applyEffect = (effect: OpenTuiApplicationShellEffect) => {
      if (effect.kind === "renderer-command" && effect.invocation.id === "app.palette.open") {
        paletteOpen = true;
      } else if (effect.kind === "palette-close") {
        paletteOpen = false;
        if (effect.restore.kind === "pane") {
          const runtimePaneId = openTuiRuntimePaneId(effect.restore.paneId, livePaneIds);
          if (runtimePaneId) focused.push(runtimePaneId);
        }
      }
    };
    const controller = createApplicationRootController({
      projection,
      applyEffect,
      capturePaletteFocusReturn: (target) => {
        captured = target;
      },
      pasteTerminal: vi.fn(),
      pasteFilesEditor: vi.fn(),
      ctrlC: {
        copyEditorSelection: vi.fn(),
        copyTerminalSelection: vi.fn(),
        forwardTerminalCtrlC: vi.fn(),
      },
      runLifecycle: vi.fn(),
      cleanupRegistry: cleanup,
    });

    controller.openPalette({ kind: "keyboard", surface: "terminal" });
    paneId = "%8";
    controller.closePalette({ kind: "keyboard", surface: "command-palette" });
    expect(focused).toEqual(["%7"]);

    paneId = "%7";
    controller.openPalette({ kind: "keyboard", surface: "terminal" });
    paneId = "%8";
    livePaneIds = ["%8"];
    controller.closePalette({ kind: "keyboard", surface: "command-palette" });
    expect(focused).toEqual(["%7"]);
  });

  it("owns paste, Ctrl-C, Ctrl-Q and renderer cleanup through one production seam", () => {
    const calls: string[] = [];
    const cleanup = new TuiCleanupRegistry();
    cleanup.set("mirror", () => calls.push("cleanup"));
    const shell = projectOpenTuiApplicationShell({
      projectName: "tmux-ide",
      rootLabel: "/workspace/tmux-ide",
      workspaceName: "main",
      activeMode: "terminals",
      dockMode: "open",
      activeDockTool: "files",
      focusZone: "canvas",
      focusedPaneId: "%7",
      terminalInputPaneId: "%7",
      paletteOpen: false,
      sessions: [{ name: "main", status: "working" }],
      activeSession: "main",
      agents: [],
    });
    const controller = createApplicationRootController({
      projection: () => shell,
      applyEffect: vi.fn(),
      capturePaletteFocusReturn: vi.fn(),
      pasteTerminal: (text) => calls.push(`terminal:${text}`),
      pasteFilesEditor: (text) => calls.push(`editor:${text}`),
      ctrlC: {
        copyEditorSelection: () => calls.push("copy-editor"),
        copyTerminalSelection: () => calls.push("copy-terminal"),
        forwardTerminalCtrlC: () => calls.push("ctrl-c"),
      },
      runLifecycle: (command) => calls.push(command.kind),
      cleanupRegistry: cleanup,
    });

    expect(
      controller.paste("one", {
        focusZone: "canvas",
        focusedPanel: "terminals",
        filesEditorFocused: false,
        filesEditorWritable: false,
        terminalAvailable: true,
      }),
    ).toBe("terminal");
    expect(
      controller.paste("two", {
        focusZone: "dock-body",
        focusedPanel: "files",
        filesEditorFocused: true,
        filesEditorWritable: true,
        terminalAvailable: true,
      }),
    ).toBe("files-editor");
    controller.handleCtrlC({ layer: "editor", hasEditorSelection: true });
    controller.handleCtrlC({ layer: "terminal", mirrorAvailable: true });
    expect(controller.quit({ hosted: false }, "keyboard").kind).toBe("destroy-renderer");
    expect(controller.dispose().names).toEqual(["mirror"]);
    expect(controller.dispose().names).toEqual([]);
    expect(calls).toEqual([
      "terminal:one",
      "editor:two",
      "copy-editor",
      "ctrl-c",
      "destroy-renderer",
      "cleanup",
    ]);
  });

  it.each([80, 120, 200])(
    "keeps both sidebar seam cells ahead of terminal routing at width %i",
    (width) => {
      const sidebarWidth = width === 80 ? 22 : width === 120 ? 28 : 36;
      let active = false;
      let terminalEvents = 0;
      const route = (type: string, x: number) => {
        const phase = applicationSidebarResizePointerPhase({
          type,
          active,
          x,
          y: 4,
          button: 0,
          sidebarWidth,
          tabbarHeight: 1,
        });
        if (phase === "start") active = true;
        else if (phase === "end") active = false;
        if (!phase) terminalEvents += 1;
        return phase;
      };

      for (const seamX of [sidebarWidth - 1, sidebarWidth]) {
        active = false;
        expect(route("down", seamX)).toBe("start");
        expect(route("drag", seamX + 3)).toBe("update");
        expect(route("up", seamX + 4)).toBe("end");
      }
      expect(terminalEvents).toBe(0);
      expect(route("down", sidebarWidth + 1)).toBeNull();
      expect(terminalEvents).toBe(1);
    },
  );
});
