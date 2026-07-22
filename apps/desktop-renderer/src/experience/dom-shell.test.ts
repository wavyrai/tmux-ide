import { describe, expect, it } from "vitest";

import {
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellReplayStateV1SchemaZ,
  applicationShellActionTraceV1,
  type ApplicationShellDockMode,
} from "@tmux-ide/contracts";
import {
  createDefaultDomShellInput,
  createDomShellReplayState,
  domShellVariant,
  projectDomApplicationShell,
  projectDomWorkbenchDock,
  reconcileDomShellReplayState,
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
      workbench: 418,
      canvas: 292,
      dock: { x: 48, y: 332, width: 672, height: 126 },
    },
    {
      viewport: { width: 1_280, height: 820 },
      variant: "standard",
      sidebar: 216,
      workbench: 758,
      canvas: 531,
      dock: { x: 216, y: 571, width: 1_064, height: 227 },
    },
    {
      viewport: { width: 1_600, height: 1_000 },
      variant: "wide",
      sidebar: 232,
      workbench: 938,
      canvas: 657,
      dock: { x: 232, y: 697, width: 1_368, height: 281 },
    },
  ])("uses bottom-dock geometry at $viewport.width×$viewport.height", (fixture) => {
    const dock = projectDomWorkbenchDock(projection(), fixture.viewport);

    expect(domShellVariant(fixture.viewport)).toBe(fixture.variant);
    expect(dock.variant).toBe(fixture.variant);
    expect(dock.dock).toEqual(fixture.dock);
    expect(dock.dock.x).toBe(fixture.sidebar);
    expect(dock.dock.y - 40).toBe(fixture.canvas);
    expect(dock.dock.y + dock.dock.height).toBe(fixture.viewport.height - 22);
    expect(dock.dockTabs).toEqual({
      x: fixture.sidebar,
      y: fixture.dock.y,
      width: fixture.dock.width,
      height: 36,
    });
    expect(dock.dockBody.height).toBe(fixture.dock.height - 36);
    expect(dock.dockBodyContent.width).toBe(fixture.dock.width - 36);
    expect(dock.dock.width).toBe(fixture.viewport.width - fixture.sidebar);
  });

  it("projects collapsed and maximized modes on the vertical workbench axis", () => {
    const viewport = { width: 1_280, height: 820 };
    const collapsed = projectDomWorkbenchDock(projection("collapsed"), viewport);
    const maximized = projectDomWorkbenchDock(projection("maximized"), viewport);

    expect(collapsed.dock).toEqual({ x: 216, y: 762, width: 1_064, height: 36 });
    expect(collapsed.dockBody.height).toBe(0);
    expect(maximized.dock).toEqual({ x: 216, y: 40, width: 1_064, height: 758 });
    expect(maximized.dockBody.height).toBe(722);
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

  it("preserves valid local state for fresh snapshots of the same project and workspace", () => {
    const previous = createDefaultDomShellInput();
    const current = ApplicationShellReplayStateV1SchemaZ.parse({
      ...createDomShellReplayState(previous),
      activeMode: "home",
      dockMode: "maximized",
      activeDockTool: "files",
      focus: { ...previous.focus, focusZone: "dock-tabs", terminalInputPaneId: null },
      selectedResources: [{ surface: "terminals", resourceId: "session.docs" }],
    });
    const next = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...previous,
      project: { ...previous.project, name: "Fresh project data" },
      workspace: { ...previous.workspace, name: "Fresh workspace data" },
      connection: { ...previous.connection, message: "Fresh connection data" },
    });

    expect(reconcileDomShellReplayState(previous, next, current)).toEqual(current);
  });

  it("preserves plain terminal selection across refresh while the durable resource remains", () => {
    const legacy = createDefaultDomShellInput();
    const agentResources = legacy.workspace.sidebar.agents.flatMap((agent) =>
      agent.paneId === null
        ? []
        : [
            {
              id: agent.paneId,
              title: agent.name,
              kind: "agent" as const,
              active: agent.paneId === "pane.implementer",
              attachability: {
                status: "available" as const,
                semanticPaneId: agent.paneId,
              },
            },
          ],
    );
    const previous = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...legacy,
      terminalInventory: {
        activeResourceId: "pane.implementer",
        resources: [
          ...agentResources,
          {
            id: "terminal.discovered.plain-shell",
            title: "Plain shell",
            kind: "terminal",
            active: false,
            attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
          },
        ],
      },
    });
    const current = ApplicationShellReplayStateV1SchemaZ.parse({
      ...createDomShellReplayState(previous),
      selectedResources: [{ surface: "terminals", resourceId: "terminal.discovered.plain-shell" }],
    });
    const refreshed = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...previous,
      project: { ...previous.project, name: "Refreshed" },
    });

    expect(reconcileDomShellReplayState(previous, refreshed, current).selectedResources).toEqual(
      current.selectedResources,
    );
    const withoutPlain = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...refreshed,
      terminalInventory: {
        activeResourceId: "pane.implementer",
        resources: agentResources,
      },
    });
    expect(
      reconcileDomShellReplayState(refreshed, withoutPlain, current).selectedResources,
    ).toEqual([]);
  });

  it("falls back from unavailable local targets and resets renderer state on identity change", () => {
    const previous = createDefaultDomShellInput();
    const current = ApplicationShellReplayStateV1SchemaZ.parse({
      ...createDomShellReplayState(previous),
      activeMode: "home",
      dockMode: "maximized",
      activeDockTool: "files",
      focus: {
        ...previous.focus,
        focusZone: "canvas",
        appFocusedPaneId: "pane.reviewer",
        terminalInputPaneId: null,
        layoutSelectedPaneId: "pane.reviewer",
      },
      selectedResources: [{ surface: "terminals", resourceId: "session.docs" }],
    });
    const next = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...previous,
      workspace: {
        ...previous.workspace,
        sidebar: {
          sessions: previous.workspace.sidebar.sessions.filter(
            (session) => session.id !== "session.docs",
          ),
          agents: previous.workspace.sidebar.agents.filter(
            (agent) => agent.id !== "agent.reviewer",
          ),
        },
      },
      dock: {
        ...previous.dock,
        activeTool: "activity",
        tools: previous.dock.tools.map((tool) =>
          tool.id === "files" ? { ...tool, disabledReason: "Files are unavailable" } : tool,
        ),
      },
      focus: {
        ...previous.focus,
        appFocusedPaneId: "pane.implementer",
        terminalInputPaneId: "pane.implementer",
        layoutSelectedPaneId: "pane.implementer",
      },
    });
    const reconciled = reconcileDomShellReplayState(previous, next, current);

    expect(reconciled).toMatchObject({
      activeMode: "home",
      dockMode: "maximized",
      activeDockTool: "activity",
      focus: next.focus,
      selectedResources: [],
    });

    const replacement = ApplicationShellProjectionInputV1SchemaZ.parse({
      ...next,
      project: { ...next.project, id: "project.replacement" },
      workspace: {
        ...next.workspace,
        id: "workspace.replacement",
        activeMode: "terminals",
      },
      dock: { ...next.dock, mode: "collapsed" },
    });
    expect(reconcileDomShellReplayState(next, replacement, reconciled)).toEqual(
      createDomShellReplayState(replacement),
    );
  });
});
