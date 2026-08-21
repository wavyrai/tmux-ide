import type {
  DaemonProjectsResponse,
  DaemonSessionsResponse,
  FleetCatalogResourceV1,
} from "@tmux-ide/contracts";
import type { WorkspaceCatalogV2State } from "@tmux-ide/daemon-client/workspace-catalog-v2";
import { describe, expect, it } from "vitest";

import {
  projectAuthoritativeAgentRows,
  projectTuiFleetResources,
} from "./tool-resource-projection.ts";

describe("TUI fleet resource projection", () => {
  it("renders durable no-tmux intent as stopped without synthesizing a live pane", () => {
    const catalog = {
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      intents: [
        {
          workspaceName: "saved-workspace",
          sessionName: "saved-session",
          source: "workspace",
          availability: "stopped",
        },
      ],
      liveSessions: [],
    } satisfies WorkspaceCatalogV2State;
    const result = projectTuiFleetResources({
      sessions: { sessions: [] },
      projects: { projects: [] },
      catalog,
      fleet: {
        version: 1,
        daemon: {
          protocolVersion: 1,
          productVersion: "test",
          instanceId: catalog.daemonInstanceId,
          startedAt: "2026-08-12T00:00:00.000Z",
        },
        sessions: [],
      },
    });

    expect(result).toEqual([
      {
        name: "saved-workspace",
        dir: null,
        registered: true,
        running: false,
        status: "idle",
        sessions: [],
      },
    ]);
  });

  it("attaches a live catalog intent only when an actionable tmux session also exists", () => {
    const catalog = {
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      intents: [
        {
          workspaceName: "workspace-alpha",
          sessionName: "runtime-alpha",
          source: "workspace",
          availability: "live",
        },
      ],
      liveSessions: [
        {
          sessionName: "runtime-alpha",
          fleetSessionId: "session.aaaaaaaaaaaaaaaaaaaa",
          paneCount: 2,
        },
      ],
    } satisfies WorkspaceCatalogV2State;
    const fleet = {
      version: 1,
      daemon: {
        protocolVersion: 1,
        productVersion: "test",
        instanceId: catalog.daemonInstanceId,
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      sessions: [],
    } satisfies FleetCatalogResourceV1;

    expect(
      projectTuiFleetResources({
        sessions: { sessions: [{ name: "runtime-alpha", dir: "/work/alpha" }] },
        projects: { projects: [] },
        catalog,
        fleet,
      }),
    ).toMatchObject([
      {
        name: "workspace-alpha",
        running: true,
        sessions: [{ name: "runtime-alpha" }],
      },
    ]);

    expect(
      projectTuiFleetResources({
        sessions: { sessions: [] },
        projects: { projects: [] },
        catalog,
        fleet,
      })[0],
    ).toMatchObject({ name: "workspace-alpha", running: false, sessions: [] });
  });

  it("joins semantic agent identities only to unique local raw tmux pane targets", () => {
    const descriptor = (runtimePaneId: string, semanticPaneId: string | null) => ({
      runtimePaneId,
      semanticPaneId,
      role: null,
      type: null,
      currentCommand: null,
      cwd: null,
      title: null,
      windowIndex: 3,
      windowName: null,
      windowId: null,
    });
    const agents = [
      {
        paneId: "pane.editor",
        name: "Editor",
        harness: "claude-code",
        activity: "running" as const,
      },
      { paneId: "pane.opaque", name: "Opaque", harness: "codex", activity: "idle" as const },
      {
        paneId: "pane.ambiguous",
        name: "Duplicate",
        harness: "codex",
        activity: "waiting" as const,
      },
      { paneId: null, name: "Missing", harness: "codex", activity: "idle" as const },
    ];

    const rows = projectAuthoritativeAgentRows({
      workspaceName: "real-session",
      agents,
      paneDescriptors: [
        descriptor("%7", "pane.editor"),
        descriptor("terminal.discovered.opaque", "pane.opaque"),
        descriptor("%8", "pane.ambiguous"),
        descriptor("%9", "pane.ambiguous"),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({ paneId: "%7", windowIndex: 3, displayName: "Editor" }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/pane\.|terminal\.discovered/u);
  });

  it("never promotes an opaque fleet label into an action target", () => {
    const sessions: DaemonSessionsResponse = {
      sessions: [{ name: "real-session", dir: "/work/alpha" }],
    };
    const projects: DaemonProjectsResponse = { projects: [] };
    const fleet = {
      version: 1,
      daemon: {
        protocolVersion: 1,
        productVersion: "test",
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      sessions: [
        {
          sessionId: "session.abcdefghijklmnop",
          label: "display-only-label",
          projectLabel: "alpha",
          appCreated: false,
          paneCount: 99,
          agents: [],
        },
      ],
    } satisfies FleetCatalogResourceV1;

    const result = projectTuiFleetResources({ sessions, projects, fleet });
    expect(result.flatMap((project) => project.sessions.map((session) => session.name))).toEqual([
      "real-session",
    ]);
    expect(JSON.stringify(result)).not.toContain("display-only-label");
  });

  it("retains registered inactive projects and tmux sessions outside the fleet decoration", () => {
    const sessions: DaemonSessionsResponse = {
      sessions: [{ name: "plain-tmux", dir: "/work/plain" }],
    };
    const projects: DaemonProjectsResponse = {
      projects: [
        {
          name: "saved",
          dir: "/work/saved",
          hasIdeYml: false,
          gitOrigin: null,
          gitBranch: null,
          registeredAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    };
    const fleet = {
      version: 1,
      daemon: {
        protocolVersion: 1,
        productVersion: "test",
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      sessions: [],
    } satisfies FleetCatalogResourceV1;

    expect(projectTuiFleetResources({ sessions, projects, fleet })).toMatchObject([
      { running: true, sessions: [{ name: "plain-tmux" }] },
      { name: "saved", running: false, registered: true, sessions: [] },
    ]);
  });

  it("attaches only authenticated application-shell agents to real session targets", () => {
    const sessions: DaemonSessionsResponse = {
      sessions: [{ name: "real-session", dir: "/work/alpha" }],
    };
    const fleet = {
      version: 1,
      daemon: {
        protocolVersion: 1,
        productVersion: "test",
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      sessions: [
        {
          sessionId: "session.abcdefghijklmnop",
          label: "real-session",
          projectLabel: "alpha",
          appCreated: false,
          paneCount: 1,
          agents: [
            {
              agentId: "agent.abcdefghijklmnop",
              name: "display-only-agent",
              harness: "claude-code",
              activity: "running",
              attention: false,
              statusSource: "authority",
            },
          ],
        },
      ],
    } satisfies FleetCatalogResourceV1;
    const authoritative = {
      paneId: "%7",
      windowIndex: 0,
      session: "real-session",
      kind: "claude-code",
      state: "working" as const,
      since: null,
      displayName: "Editor",
    };

    const result = projectTuiFleetResources({
      sessions,
      projects: { projects: [] },
      fleet,
      authoritativeAgents: [authoritative],
    });
    expect(result[0]?.sessions[0]?.agents).toEqual([authoritative]);
    expect(JSON.stringify(result)).not.toContain("display-only-agent");
  });
});
