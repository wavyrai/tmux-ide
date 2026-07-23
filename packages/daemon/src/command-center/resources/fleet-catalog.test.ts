import { describe, expect, it } from "vitest";
import {
  FLEET_MAX_PANES_PER_SESSION,
  FLEET_MAX_SESSIONS,
  FLEET_MAX_TOTAL_AGENTS,
  FleetCatalogResourceV1SchemaZ,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";
import { projectFleetCatalog } from "./fleet-catalog.ts";
import type { FleetPaneFacts, FleetSessionFacts } from "../discovery.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "3f1c9a2e-6d4b-4a1c-8e2f-0a1b2c3d4e5f",
  startedAt: "2026-07-22T00:00:00.000Z",
};

const NOW_SEC = 1_800_000_000;
const SESSION_ID = /^session\.[A-Za-z0-9_-]{16,64}$/u;
const AGENT_ID = /^agent\.[A-Za-z0-9_-]{16,64}$/u;

function pane(overrides: Partial<FleetPaneFacts> = {}): FleetPaneFacts {
  return {
    runtimePaneId: "%1",
    active: true,
    currentCommand: "zsh",
    currentPath: "/home/dev/project",
    agentStateRaw: null,
    agentStatusTextRaw: null,
    agentDisplayNameRaw: null,
    ...overrides,
  };
}

function session(overrides: Partial<FleetSessionFacts> = {}): FleetSessionFacts {
  return {
    name: "alpha",
    appCreated: false,
    cwd: "/home/dev/project",
    panes: [],
    ...overrides,
  };
}

describe("projectFleetCatalog", () => {
  it("is a valid, stamped, path-free resource", () => {
    const resource = projectFleetCatalog(
      [
        session({
          panes: [pane({ agentStateRaw: `working:${NOW_SEC}`, currentCommand: "claude" })],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
    expect(resource.version).toBe(1);
    expect(resource.daemon).toEqual(DAEMON);
    const wire = JSON.stringify(resource);
    // No pane id, absolute path, or raw tmux id crosses the wire.
    expect(wire).not.toContain("%1");
    expect(wire).not.toContain("/home/dev/project");
  });

  it("mints opaque ids and a basename-only project label", () => {
    const resource = projectFleetCatalog(
      [
        session({
          name: "alpha",
          cwd: "/Users/dev/work/my-project",
          panes: [pane({ agentStateRaw: `working:${NOW_SEC}`, currentCommand: "claude" })],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    const [entry] = resource.sessions;
    expect(entry!.sessionId).toMatch(SESSION_ID);
    expect(entry!.projectLabel).toBe("my-project");
    expect(entry!.agents[0]!.agentId).toMatch(AGENT_ID);
  });

  it("passes appCreated through for registry-backed and adopted-only sessions", () => {
    const resource = projectFleetCatalog(
      [
        session({ name: "registered", appCreated: true }),
        session({ name: "adopted-only", appCreated: false }),
      ],
      DAEMON,
      NOW_SEC,
    );
    expect(resource.sessions.map((s) => [s.label, s.appCreated])).toEqual([
      ["registered", true],
      ["adopted-only", false],
    ]);
  });

  it("resolves a fresh authority stamp to its ground-truth status", () => {
    const resource = projectFleetCatalog(
      [
        session({
          panes: [
            pane({
              currentCommand: "node",
              agentStateRaw: `working:${NOW_SEC}`,
              agentDisplayNameRaw: "Backend agent",
            }),
          ],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    const agent = resource.sessions[0]!.agents[0]!;
    expect(agent.activity).toBe("running");
    expect(agent.statusSource).toBe("authority");
    expect(agent.attention).toBe(false);
    expect(agent.name).toBe("Backend agent");
    expect(agent.harness).toBe("custom");
  });

  it("routes a blocked stamp to attention", () => {
    const resource = projectFleetCatalog(
      [
        session({
          panes: [pane({ currentCommand: "codex", agentStateRaw: `blocked:${NOW_SEC}` })],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    const agent = resource.sessions[0]!.agents[0]!;
    expect(agent.activity).toBe("waiting");
    expect(agent.attention).toBe(true);
    expect(agent.harness).toBe("codex");
  });

  it("settles a stale stamp and an unstamped agent pane to unknown WITHOUT scraping", () => {
    const resource = projectFleetCatalog(
      [
        session({
          name: "s",
          panes: [
            pane({
              runtimePaneId: "%1",
              currentCommand: "claude",
              agentStateRaw: `working:${NOW_SEC - 3600}`,
            }),
            pane({ runtimePaneId: "%2", currentCommand: "claude", agentStateRaw: null }),
          ],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    const agents = resource.sessions[0]!.agents;
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent.activity).toBe("disconnected");
      expect(agent.statusSource).toBe("unknown");
    }
  });

  it("excludes non-agent panes but still counts them", () => {
    const resource = projectFleetCatalog(
      [
        session({
          panes: [
            pane({ runtimePaneId: "%1", currentCommand: "zsh" }),
            pane({
              runtimePaneId: "%2",
              currentCommand: "claude",
              agentStateRaw: `working:${NOW_SEC}`,
            }),
          ],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    expect(resource.sessions[0]!.paneCount).toBe(2);
    expect(resource.sessions[0]!.agents).toHaveLength(1);
  });

  it("sanitizes hostile session names and display names to control-free labels", () => {
    const resource = projectFleetCatalog(
      [
        session({
          name: "danger\u0007\u001b[31m",
          cwd: "/tmp/proj\u0007ect",
          panes: [
            pane({
              currentCommand: "claude",
              agentStateRaw: `working:${NOW_SEC}`,
              agentDisplayNameRaw: "evil\u001b[2Jname\u0007",
            }),
          ],
        }),
      ],
      DAEMON,
      NOW_SEC,
    );
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
    const entry = resource.sessions[0]!;
    const controlFree = (value: string): boolean =>
      [...value].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127);
    expect(controlFree(entry.label)).toBe(true);
    expect(controlFree(entry.projectLabel)).toBe(true);
    expect(entry.projectLabel).not.toContain("/");
    expect(controlFree(entry.agents[0]!.name)).toBe(true);
  });

  it("trims an oversized fleet to the session cap", () => {
    const sessions = Array.from({ length: FLEET_MAX_SESSIONS + 10 }, (_, i) =>
      session({ name: `s${i}` }),
    );
    const resource = projectFleetCatalog(sessions, DAEMON, NOW_SEC);
    expect(resource.sessions).toHaveLength(FLEET_MAX_SESSIONS);
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
  });

  it("clamps paneCount to its cap", () => {
    const many = Array.from({ length: FLEET_MAX_PANES_PER_SESSION + 50 }, (_, i) =>
      pane({ runtimePaneId: `%${i}`, currentCommand: "zsh" }),
    );
    const resource = projectFleetCatalog([session({ name: "huge", panes: many })], DAEMON, NOW_SEC);
    expect(resource.sessions[0]!.paneCount).toBe(FLEET_MAX_PANES_PER_SESSION);
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
  });

  it("holds the total-agent cap across sessions", () => {
    const agentPanes = Array.from({ length: 64 }, (_, i) =>
      pane({
        runtimePaneId: `%${i}`,
        currentCommand: "claude",
        agentStateRaw: `working:${NOW_SEC}`,
      }),
    );
    const sessions = Array.from({ length: 6 }, (_, i) =>
      session({ name: `s${i}`, panes: agentPanes }),
    );
    const resource = projectFleetCatalog(sessions, DAEMON, NOW_SEC);
    const total = resource.sessions.reduce((sum, s) => sum + s.agents.length, 0);
    expect(total).toBe(FLEET_MAX_TOTAL_AGENTS);
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
  });

  it("degrades an empty fleet to a valid empty resource", () => {
    const resource = projectFleetCatalog([], DAEMON, NOW_SEC);
    expect(resource.sessions).toEqual([]);
    expect(FleetCatalogResourceV1SchemaZ.safeParse(resource).success).toBe(true);
  });
});
