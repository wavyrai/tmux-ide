import { describe, expect, it } from "vitest";

import { applicationShellActionTraceV1, type ApplicationShellDockMode } from "@tmux-ide/contracts";
import {
  createDefaultDomShellInput,
  createDomShellReplayState,
  domShellVariant,
  projectDomApplicationShell,
  projectDomWorkbenchDock,
} from "./dom-shell.ts";

function projection(mode: ApplicationShellDockMode = "open") {
  const input = createDefaultDomShellInput();
  const state = { ...createDomShellReplayState(input), dockMode: mode };
  return projectDomApplicationShell(input, state);
}

describe("DOM application-shell projection", () => {
  it.each([
    {
      viewport: { width: 720, height: 480 },
      variant: "compact",
      sidebar: 48,
      workbench: 434,
      canvas: 304,
      dock: { x: 48, y: 332, width: 672, height: 130 },
    },
    {
      viewport: { width: 1_280, height: 820 },
      variant: "standard",
      sidebar: 168,
      workbench: 774,
      canvas: 542,
      dock: { x: 168, y: 570, width: 1_112, height: 232 },
    },
    {
      viewport: { width: 1_600, height: 1_000 },
      variant: "wide",
      sidebar: 184,
      workbench: 954,
      canvas: 668,
      dock: { x: 184, y: 696, width: 1_416, height: 286 },
    },
  ])("uses bottom-dock geometry at $viewport.width×$viewport.height", (fixture) => {
    const dock = projectDomWorkbenchDock(projection(), fixture.viewport);

    expect(domShellVariant(fixture.viewport)).toBe(fixture.variant);
    expect(dock.variant).toBe(fixture.variant);
    expect(dock.dock).toEqual(fixture.dock);
    expect(dock.dock.x).toBe(fixture.sidebar);
    expect(dock.dock.y - 28).toBe(fixture.canvas);
    expect(dock.dock.y + dock.dock.height).toBe(fixture.viewport.height - 18);
    expect(dock.dockTabs).toEqual({
      x: fixture.sidebar,
      y: fixture.dock.y,
      width: fixture.dock.width,
      height: 28,
    });
    expect(dock.dockBody.height).toBe(fixture.dock.height - 28);
    expect(dock.dockBodyContent.width).toBe(fixture.dock.width - 28);
    expect(dock.dock.width).toBe(fixture.viewport.width - fixture.sidebar);
  });

  it("projects collapsed and maximized modes on the vertical workbench axis", () => {
    const viewport = { width: 1_280, height: 820 };
    const collapsed = projectDomWorkbenchDock(projection("collapsed"), viewport);
    const maximized = projectDomWorkbenchDock(projection("maximized"), viewport);

    expect(collapsed.dock).toEqual({ x: 168, y: 774, width: 1_112, height: 28 });
    expect(collapsed.dockBody.height).toBe(0);
    expect(maximized.dock).toEqual({ x: 168, y: 28, width: 1_112, height: 774 });
    expect(maximized.dockBody.height).toBe(746);
  });

  it("starts from the canonical closed-overlay fixture and trace", () => {
    const input = createDefaultDomShellInput();
    const shell = projectDomApplicationShell(input, createDomShellReplayState(input));

    expect(shell.focus.palette.open).toBe(false);
    expect(shell.primaryNavigation.items.map(({ id }) => id)).toEqual(["home", "terminals"]);
    expect(shell.bottomDock.tools.map(({ id }) => id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(applicationShellActionTraceV1(input).invocations).toHaveLength(20);
  });
});
