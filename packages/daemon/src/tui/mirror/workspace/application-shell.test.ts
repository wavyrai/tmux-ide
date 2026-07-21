import { describe, expect, it } from "vitest";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import {
  applicationShellHitTest,
  projectApplicationShell,
  type ApplicationShellInput,
} from "./application-shell.ts";
import { projectOpenTuiApplicationShell } from "./application-shell-controller.ts";
import { projectWorkbenchShell } from "./workbench-shell.ts";

function semantic() {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "web",
    activeMode: "terminals",
    dockMode: "open",
    activeDockTool: "missions",
    focusZone: "canvas",
    focusedPaneId: null,
    terminalInputPaneId: null,
    paletteOpen: false,
    sessions: [
      { name: "web", status: "working" },
      { name: "api", status: "blocked" },
    ],
    activeSession: "web",
    agents: [],
    notification: "live",
  });
}

function input(overrides: Partial<ApplicationShellInput> = {}): ApplicationShellInput {
  return {
    width: 120,
    height: 40,
    preferredSidebarWidth: 28,
    shell: semantic(),
    hoveredTabIndex: null,
    quitHint: "^q quit",
    ...overrides,
  };
}

describe("application shell projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("projects one bounded %sx%s %s workspace", (width, height, variant) => {
    const projection = projectApplicationShell(input({ width, height }));
    expect(projection.layout.variant).toBe(variant);
    expect(projection.layout.width).toBe(width);
    expect(projection.layout.height).toBe(height);
    expect(projection.content.width).toBe(projection.layout.main.width);
    expect(projection.content.height + projection.layout.status.height).toBe(
      projection.layout.main.height,
    );
    expect(projection.tabs.map(({ id }) => id)).toEqual(["home", "terminals"]);
    expect(projection.tabs.find((tab) => tab.id === "terminals")?.selected).toBe(true);
  });

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "subtracts the %sx%s status row exactly once from terminal truth",
    (width, height) => {
      const shell = projectApplicationShell(input({ width, height }));
      const workbench = projectWorkbenchShell({
        width: shell.content.width,
        height: shell.content.height,
        dockMode: shell.semantic.bottomDock.mode,
        persistedDockHeight: null,
        activeDockTab: shell.semantic.bottomDock.activeTool,
        focusZone: "canvas",
        dockTools: shell.semantic.bottomDock.tools,
      });
      const terminal = projectAgentTerminalCanvas({
        width: workbench.canvasBody.width,
        height: workbench.canvasBody.height,
        chromeRows: 2,
        footerRows: 0,
      });

      expect(workbench.height).toBe(
        height - shell.layout.tabbar.height - shell.layout.status.height,
      );
      expect(workbench.canvas.height + workbench.dock.height).toBe(shell.content.height);
      expect(terminal.framebuffer.height + terminal.chrome.height + terminal.footer.height).toBe(
        workbench.canvasBody.height,
      );
      expect(terminal.tmuxSize?.rows).toBe(terminal.framebuffer.height);
    },
  );

  it("routes canonical tabs, sessions, palette, and status-strip ownership", () => {
    const projection = projectApplicationShell(input());
    const terminals = projection.tabs.find((tab) => tab.id === "terminals")!;
    expect(
      applicationShellHitTest(
        projection,
        terminals.span.start + Math.floor(terminals.span.width / 2),
        0,
      ),
    ).toEqual({ kind: "view", viewId: "terminals", index: 1 });

    expect(applicationShellHitTest(projection, 2, projection.layout.sidebar.y + 1)).toEqual({
      kind: "session",
      session: "web",
      index: 0,
    });

    const hint = projection.sidebarHint.buttonSpan;
    expect(
      applicationShellHitTest(
        projection,
        projection.layout.sidebar.x + hint.start,
        projection.layout.sidebar.y + projection.layout.sidebar.height - 1,
      ),
    ).toEqual({ kind: "palette" });
    expect(
      applicationShellHitTest(projection, projection.layout.status.x, projection.layout.status.y),
    ).toEqual({ kind: "status-strip" });
  });

  it("leaves only content and out-of-bounds cells to child surfaces", () => {
    const projection = projectApplicationShell(input());
    expect(
      applicationShellHitTest(projection, projection.content.x + 2, projection.content.y + 2),
    ).toBeNull();
    expect(applicationShellHitTest(projection, -1, 0)).toBeNull();
    expect(applicationShellHitTest(projection, projection.layout.width, 0)).toBeNull();
  });
});
