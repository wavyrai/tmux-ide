import { describe, expect, it } from "vitest";
import {
  RESERVED_DISCOVERED_TERMINAL_ID_PREFIX,
  projectAgentGraphOverlay,
  type AgentGraphOverlay,
  type FleetCatalogResourceV1,
} from "@tmux-ide/contracts";

import { mergeFleetGraphOverlay } from "./fleet-graph-merge.ts";
import { FLEET_FIXTURE_DAEMON, mixedFleetCatalog } from "../runtime/fleet-catalog-fixture.ts";

/** An open-workspace overlay with two real semantic nodes and one mission group. */
function openOverlay(): AgentGraphOverlay {
  return projectAgentGraphOverlay({
    nodes: [
      {
        windowId: "window.alpha",
        status: "working",
        statusSource: "authority",
        attention: false,
        label: "Alpha",
      },
      {
        windowId: "window.beta",
        status: "idle",
        statusSource: "authority",
        attention: false,
        label: "Beta",
      },
    ],
    edges: [{ from: "window.alpha", to: "window.beta", kind: "mission" }],
    groups: [
      { id: "group.openaaaaaaaaaaaa", label: "Open mission", memberWindowIds: ["window.alpha"] },
    ],
  }).overlay;
}

function largeFleet(sessionCount: number): FleetCatalogResourceV1 {
  const sessions = Array.from({ length: sessionCount }, (_, index) => {
    const token = String(index).padStart(15, "0");
    return {
      sessionId: `session.s${token}`,
      label: `session-${index}`,
      projectLabel: `project-${index}`,
      appCreated: false,
      paneCount: 1,
      agents: [
        {
          agentId: `agent.a${token}`,
          name: `Agent ${index}`,
          harness: "custom" as const,
          activity: "running" as const,
          attention: false,
          statusSource: "authority" as const,
        },
      ],
    };
  });
  return { version: 1, daemon: FLEET_FIXTURE_DAEMON, sessions };
}

describe("mergeFleetGraphOverlay", () => {
  it("folds the fleet's other sessions in alongside the open overlay", () => {
    const merged = mergeFleetGraphOverlay({
      openOverlay: openOverlay(),
      fleet: mixedFleetCatalog(),
    });
    expect(merged.fleetIncluded).toBe(true);
    expect(merged.truncated).toBe(false);

    // The open nodes survive unchanged.
    expect(merged.overlay.nodes["window.alpha"]).toMatchObject({ status: "working" });
    expect(merged.overlay.nodes["window.beta"]).toBeTruthy();

    // Fleet nodes are display-only: keyed under the reserved discovered prefix.
    const fleetNodeIds = Object.keys(merged.overlay.nodes).filter((id) =>
      id.startsWith(RESERVED_DISCOVERED_TERMINAL_ID_PREFIX),
    );
    expect(fleetNodeIds).toContain(
      `${RESERVED_DISCOVERED_TERMINAL_ID_PREFIX}agent.aaaaaaaaaaaaaaaa`,
    );
    // Three fleet agents across the mixed fixture become three display nodes.
    expect(fleetNodeIds).toHaveLength(3);
    // One group per open mission + one per fleet session (three sessions).
    expect(merged.overlay.groups).toHaveLength(4);
  });

  it("maps a blocked (waiting) fleet agent to the blocked node status", () => {
    const merged = mergeFleetGraphOverlay({
      openOverlay: openOverlay(),
      fleet: mixedFleetCatalog(),
    });
    const blocked =
      merged.overlay.nodes[`${RESERVED_DISCOVERED_TERMINAL_ID_PREFIX}agent.bbbbbbbbbbbbbbbb`];
    expect(blocked).toMatchObject({ status: "blocked", attention: true });
  });

  it("leaves the open overlay untouched for an empty fleet", () => {
    const open = openOverlay();
    const merged = mergeFleetGraphOverlay({
      openOverlay: open,
      fleet: { version: 1, daemon: FLEET_FIXTURE_DAEMON, sessions: [] },
    });
    expect(merged.fleetIncluded).toBe(false);
    expect(merged.truncated).toBe(false);
    expect(merged.overlay).toBe(open);
  });

  it("excludes a named session (e.g. the open workspace's own session)", () => {
    const merged = mergeFleetGraphOverlay({
      openOverlay: openOverlay(),
      fleet: mixedFleetCatalog(),
      excludeSessionIds: new Set(["session.aaaaaaaaaaaaaaaa"]),
    });
    const fleetNodeIds = Object.keys(merged.overlay.nodes).filter((id) =>
      id.startsWith(RESERVED_DISCOVERED_TERMINAL_ID_PREFIX),
    );
    // The two agents of the excluded session are gone; only the blocked one remains.
    expect(fleetNodeIds).toEqual([
      `${RESERVED_DISCOVERED_TERMINAL_ID_PREFIX}agent.bbbbbbbbbbbbbbbb`,
    ]);
  });

  it("rejects the whole merge and degrades to open-only when a cap would be exceeded", () => {
    const open = openOverlay();
    // 64 fleet sessions => 64 groups; plus the open mission group => 65 > 64 cap.
    const merged = mergeFleetGraphOverlay({ openOverlay: open, fleet: largeFleet(64) });
    expect(merged.fleetIncluded).toBe(false);
    expect(merged.truncated).toBe(true);
    expect(merged.overlay).toBe(open);
  });
});
