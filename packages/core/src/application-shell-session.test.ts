import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  COHESION_FIXTURE_V1,
  applicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
} from "@tmux-ide/contracts";

import {
  createApplicationShellReplayState,
  projectApplicationShellSession,
  reconcileApplicationShellReplayState,
  reduceApplicationShellTransaction,
} from "./application-shell-session.ts";

function input(): ApplicationShellProjectionInputV1 {
  return {
    project: COHESION_FIXTURE_V1.project,
    workspace: COHESION_FIXTURE_V1.workspace,
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
  };
}

describe("application shell client session", () => {
  it("applies a semantic command transaction identically for every renderer", () => {
    const initial = createApplicationShellReplayState(input());
    const source = { kind: "program" as const, surface: "parity-test" };
    const transaction = reduceApplicationShellTransaction(initial, [
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode: "maximized" },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
        { tool: "changes" },
        source,
      ),
    ]);

    expect(transaction.state).toMatchObject({ dockMode: "maximized", activeDockTool: "changes" });
    expect(
      transaction.steps.map(({ previous, next }) => [previous.dockMode, next.dockMode]),
    ).toEqual([
      [initial.dockMode, "maximized"],
      ["maximized", "maximized"],
    ]);
  });

  it("keeps authority facts while projecting renderer-local view state", () => {
    const authority = input();
    const replay = {
      ...createApplicationShellReplayState(authority),
      activeMode: "home" as const,
      dockMode: "maximized" as const,
      activeDockTool: "changes" as const,
    };

    const projection = projectApplicationShellSession(authority, replay);
    expect(projection.project).toEqual(authority.project);
    expect(projection.sidebar.sessions).toHaveLength(authority.workspace.sidebar.sessions.length);
    expect(projection.workspaceCanvas.activeMode).toBe("home");
    expect(projection.bottomDock).toMatchObject({ mode: "maximized", activeTool: "changes" });
  });

  it("retains safe local state but rejects stale pane focus and resource selection", () => {
    const previous = input();
    const current = {
      ...createApplicationShellReplayState(previous),
      focus: {
        ...previous.focus,
        appFocusedPaneId: "pane.removed",
        terminalInputPaneId: "pane.removed",
      },
      selectedResources: [{ surface: "terminals" as const, resourceId: "pane.removed" }],
    };
    const next = { ...previous, terminalInventory: { activeResourceId: null, resources: [] } };

    const reconciled = reconcileApplicationShellReplayState(previous, next, current);
    expect(reconciled.focus).toEqual(next.focus);
    expect(reconciled.selectedResources).toEqual([]);
  });

  it("resets all renderer-local state when workspace authority changes", () => {
    const previous = input();
    const current = {
      ...createApplicationShellReplayState(previous),
      dockMode: "maximized" as const,
    };
    const next = {
      ...previous,
      workspace: {
        ...previous.workspace,
        id: "workspace.replacement",
        activeMode: "home" as const,
      },
    };

    expect(reconcileApplicationShellReplayState(previous, next, current)).toEqual(
      createApplicationShellReplayState(next),
    );
  });
});
