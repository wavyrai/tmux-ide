import { describe, expect, it } from "vitest";
import type { FleetCatalogResourceV1 } from "@tmux-ide/contracts";
import type { Settings } from "@superlogical/shared/model";
import {
  mergeMachineCatalogs,
  projectMachineFleet,
  updateMachineCatalogs,
  type MachineCatalogs,
} from "./machine-catalog";

const settings: Settings = { darkTheme: "dark", lightTheme: "light", mode: "system", fontSize: 13 };
function catalog(instanceId = "daemon.a", environmentId = "environment.a"): FleetCatalogResourceV1 {
  return {
    version: 1,
    daemon: {
      instanceId,
      environmentId,
      protocolVersion: 1,
      productVersion: "test",
      startedAt: "2026-09-10T00:00:00Z",
    },
    sessions: [
      {
        sessionId: "session.same",
        label: "api",
        projectLabel: "api",
        appCreated: false,
        paneCount: 1,
        agents: [
          {
            agentId: "agent.same",
            name: "Codex",
            harness: "codex",
            activity: "running",
            attention: false,
            statusSource: "authority",
          },
        ],
      },
    ],
  };
}
function connected(state: MachineCatalogs, connectionId: string, value = catalog()) {
  state = updateMachineCatalogs(state, {
    type: "bind",
    connectionId,
    label: "Same label",
    epoch: 1,
    daemonInstanceId: value.daemon.instanceId,
  });
  return updateMachineCatalogs(state, {
    type: "catalog",
    connectionId,
    epoch: 1,
    catalog: value,
    routes: new Map([["session.same", "workspace.a"]]),
  });
}

describe("independent machine catalog projection", () => {
  it("preserves local pane and tab IDs without browser singleton dependencies", () => {
    const projected = projectMachineFleet(catalog(), {
      settings,
      revision: 5,
      machineId: "environment.a",
      machineLabel: "Local",
    });
    expect(projected.tabs[0]!.id).toBe("daemon.a:session.same");
    expect(Object.keys(projected.panes)).toEqual(["daemon.a:agent.same"]);
    expect(projected.revision).toBe(5);
  });

  it("namespaces identical IDs from independently supplied connections and keeps lookup explicit", () => {
    const state = connected(
      connected(new Map(), "connection:a"),
      "connection:b",
      catalog("daemon.a", "environment.b"),
    );
    const merged = mergeMachineCatalogs(state, settings, 7);
    expect(merged.workspace.tabs).toHaveLength(2);
    expect(Object.keys(merged.workspace.panes)).toHaveLength(2);
    expect(new Set(merged.workspace.tabs.map((tab) => tab.id)).size).toBe(2);
    expect(merged.workspace.tabs.map((tab) => merged.tabConnections.get(tab.id))).toEqual([
      "connection:a",
      "connection:b",
    ]);
    expect(merged.machines.map((m) => [m.connectionId, m.environmentId])).toEqual([
      ["connection:a", "environment.a"],
      ["connection:b", "environment.b"],
    ]);
  });

  it("retains offline machine catalog and stable display IDs without retaining an actionable workspace route", () => {
    const before = connected(connected(new Map(), "a"), "b", catalog("daemon.b"));
    const offline = updateMachineCatalogs(before, {
      type: "status",
      connectionId: "a",
      epoch: 1,
      status: "offline",
      reason: "SSH disconnected",
    });
    const original = mergeMachineCatalogs(before, settings, 1);
    const result = mergeMachineCatalogs(offline, settings, 2);
    expect(result.workspace.tabs.map((t) => t.id)).toEqual(
      original.workspace.tabs.map((t) => t.id),
    );
    expect(result.workspace.tabs[0]!.workspaceName).toBeUndefined();
    expect(result.workspace.tabs[1]!.workspaceName).toBe("workspace.a");
    expect(result.machines[0]).toMatchObject({
      status: "offline",
      stale: true,
      reason: "SSH disconnected",
    });
    expect(result.machines[1]).toMatchObject({ status: "paired", stale: false });
  });

  it("rejects late updates independently per connection and mismatched daemon incarnations", () => {
    const first = connected(new Map(), "a");
    const rebound = updateMachineCatalogs(first, {
      type: "bind",
      connectionId: "a",
      label: "Renamed",
      epoch: 2,
      daemonInstanceId: "daemon.new",
    });
    expect(
      updateMachineCatalogs(rebound, {
        type: "status",
        connectionId: "a",
        epoch: 1,
        status: "offline",
      }),
    ).toBe(rebound);
    expect(
      updateMachineCatalogs(rebound, {
        type: "catalog",
        connectionId: "a",
        epoch: 2,
        catalog: catalog(),
      }),
    ).toBe(rebound);
    const fresh = updateMachineCatalogs(rebound, {
      type: "catalog",
      connectionId: "a",
      epoch: 2,
      catalog: catalog("daemon.new"),
    });
    const result = mergeMachineCatalogs(fresh, settings, 3);
    expect(result.workspace.tabs[0]!.daemonInstanceId).toBe("daemon.new");
    expect(result.workspace.tabs[0]!.workspaceName).toBeUndefined();
    expect(result.machines[0]).toMatchObject({ label: "Renamed", status: "paired", stale: false });
  });

  it("does not drop a machine that has not provided its first catalog", () => {
    const state = updateMachineCatalogs(new Map(), {
      type: "bind",
      connectionId: "new",
      label: "New",
      epoch: 1,
      daemonInstanceId: "daemon.new",
    });
    const result = mergeMachineCatalogs(state, settings, 1);
    expect(result.workspace.tabs).toEqual([]);
    expect(result.machines).toEqual([
      expect.objectContaining({ connectionId: "new", status: "connecting", stale: true }),
    ]);
  });
});
