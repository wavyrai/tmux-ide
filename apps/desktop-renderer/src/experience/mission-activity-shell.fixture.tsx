import { ApplicationShellProjectionInputV3SchemaZ } from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import { createBrowserHostCapabilities } from "../host-capabilities.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { DomApplicationShell } from "./application-shell.tsx";
import { createDomExperience } from "./dom-experience.ts";
import { createMissionActivityFixture } from "./mission-activity-fixture.ts";
import { createDefaultDomPaneFrames, createDefaultDomShellInput } from "./dom-shell.ts";

const base = createDefaultDomShellInput();
const paneFrames = createDefaultDomPaneFrames();

function input(mode: "missions" | "activity") {
  return ApplicationShellProjectionInputV3SchemaZ.parse({
    ...base,
    project: {
      ...base.project,
      readiness: {
        state: "ready",
        facts: ["Native tmux workspace connected", "Mission history verified"],
        warnings: [],
      },
    },
    workspace: {
      ...base.workspace,
      activeMode: "terminals",
      session: { ...base.workspace.session, state: "connected" },
      sidebar: {
        sessions: base.workspace.sidebar.sessions.map((session) => ({
          ...session,
          state: "connected" as const,
        })),
        agents: base.workspace.sidebar.agents.map((agent) => ({
          ...agent,
          activity: agent.activity === "disconnected" ? ("waiting" as const) : agent.activity,
          attention: agent.activity === "disconnected" ? false : agent.attention,
        })),
      },
    },
    dock: { ...base.dock, mode: "maximized", activeTool: mode },
    connection: {
      state: "connected",
      message: "Native tmux workspace connected",
      safeState: "Mission history verified",
      nextAction: "3 terminals ready",
    },
    terminalInventory: {
      activeResourceId: base.focus.appFocusedPaneId,
      resources: paneFrames.map((frame) => ({
        id: frame.pane.id,
        title: frame.title,
        kind: "agent" as const,
        active: frame.pane.id === base.focus.appFocusedPaneId,
        attachability: { status: "available" as const, semanticPaneId: frame.pane.id },
      })),
    },
    appWindows: {
      version: 1,
      revision: 0,
      updatedAt: "2026-07-22T15:30:00.000Z",
      windows: {},
      dockRoot: null,
      dockState: { mode: "maximized", preferredHeight: null, focusZone: "dock-body" },
      floatingOrder: [],
      focusedWindowId: null,
      activeLayoutId: null,
      layouts: {},
    },
    missionWorkspace: createMissionActivityFixture(),
  });
}

/** Full-window visual acceptance fixture for durable Missions and Activity. */
export function mountMissionActivityShellFixture(
  root: HTMLElement,
  mode: "missions" | "activity",
  appearance: "dark" | "light" = "dark",
): () => void {
  const experience = createDomExperience({ hostTheme: { mode: appearance } });
  let disposeStyle: (() => void) | null = null;
  const dispose = render(
    () => (
      <div
        ref={(element) => {
          const binding = createRuntimeStyleBinding(element);
          binding.update(experience.variables);
          disposeStyle = () => binding.dispose();
        }}
        class="app"
        data-theme={appearance}
        data-platform="darwin"
        data-reduced-motion="false"
        data-shell-source="mission-activity-visual"
      >
        <DomApplicationShell
          host={createBrowserHostCapabilities()}
          runtime="browser"
          platform="darwin"
          experimentalSurfaces
          input={input(mode)}
          dataMode="runtime"
          paneFrames={paneFrames}
          terminalTransport={null}
          onAppWindowCommand={() => undefined}
          onRefreshResource={() => undefined}
        />
      </div>
    ),
    root,
  );
  return () => {
    dispose();
    disposeStyle?.();
  };
}
