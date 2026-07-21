import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SemanticFocusTarget } from "@tmux-ide/contracts";
import { TuiCleanupRegistry } from "../input-lifecycle.ts";
import {
  createApplicationRootController,
  routeApplicationSidebarResizePointer,
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

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "releases both sidebar seam cells over the status strip at %i×%i",
    (width, height) => {
      const sidebarWidth = width === 80 ? 22 : width === 120 ? 28 : 36;
      for (const seamX of [sidebarWidth - 1, sidebarWidth]) {
        let active = false;
        let terminalEvents = 0;
        let statusEvents = 0;
        const effects = {
          start: () => {
            active = true;
          },
          resize: vi.fn(),
          end: () => {
            active = false;
          },
        };
        const route = (event: { type: string; x: number; y: number }) => {
          const input = {
            ...event,
            active,
            button: 0,
            sidebarWidth,
            tabbarHeight: 1,
          };
          // This is the production ordering in app.tsx: an active owner first,
          // then status chrome, then inactive seam-start, then normal routing.
          if (active && routeApplicationSidebarResizePointer(input, effects)) return "resize";
          if (event.y === height - 1) {
            statusEvents += 1;
            return "status";
          }
          if (routeApplicationSidebarResizePointer({ ...input, active: false }, effects)) {
            return "resize";
          }
          terminalEvents += 1;
          return "terminal";
        };

        expect(route({ type: "down", x: seamX, y: 4 })).toBe("resize");
        expect(active).toBe(true);
        expect(route({ type: "up", x: seamX + 4, y: height - 1 })).toBe("resize");
        expect(active).toBe(false);
        expect(statusEvents).toBe(0);
        expect(effects.resize).toHaveBeenCalledWith(seamX + 4);
        expect(route({ type: "down", x: sidebarWidth + 2, y: 4 })).toBe("terminal");
        expect(terminalEvents).toBe(1);
      }
    },
  );

  it("keeps active resize ownership before status and inactive starts after it in app.tsx", () => {
    const app = readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8");
    const active = app.indexOf(
      'if (dragging?.kind === "sidebar" && routeSidebarResizePointer(e, true)) return;',
    );
    const status = app.indexOf('applicationChromeHit?.kind === "status-strip"');
    const start = app.indexOf("if (routeSidebarResizePointer(e, false)) return;");
    expect(active).toBeGreaterThan(-1);
    expect(active).toBeLessThan(status);
    expect(status).toBeLessThan(start);
  });
});
