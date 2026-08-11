import type {
  DaemonProjectsResponse,
  DaemonSessionsResponse,
  FleetCatalogResourceV1,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { projectTuiFleetResources } from "./tool-resource-projection.ts";

describe("TUI fleet resource projection", () => {
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
