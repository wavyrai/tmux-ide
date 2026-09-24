import { describe, expect, it } from "vitest";
import { projectHomeFleet } from "./application-home-fleet.ts";
import type { ApplicationMachineAgent } from "./application-machine-agents.ts";
import type { ApplicationMachineCatalogSnapshot } from "./application-machine-catalog.ts";
const catalog: ApplicationMachineCatalogSnapshot = {
  selectedMachineId: "local",
  groups: [
    { id: "local", label: "Mac", state: "ready", sessions: [], note: null },
    { id: "spark", label: "Spark", state: "disconnected", sessions: [], note: null },
  ],
};
const agent = (machineId: string, id: string, disabled = false): ApplicationMachineAgent => ({
  id,
  key: id,
  machineId,
  disabled,
  sessionKey: "session",
  sessionName: "work",
  liveSessionId: "$1",
  daemonInstanceId: "daemon",
  agentId: "agent",
  paneId: "pane.one",
  name: "Claude",
  harness: "claude",
  activity: "running",
  attention: false,
  projectName: "work",
});
describe("fleet Home projection", () => {
  it("shows healthy machines immediately alongside explicitly stale rows", () => {
    const result = projectHomeFleet(
      catalog,
      [
        { machineId: "local", available: true, agents: [agent("local", "local-agent")] },
        { machineId: "spark", available: false, agents: [agent("spark", "remote-agent", true)] },
      ],
      { machineId: null, attentionOnly: false },
    );
    expect(result.phase).toBe("partial");
    expect(result.rows.map((row) => row.machineLabel)).toEqual(["Mac", "Spark"]);
    expect(result.rows[1]?.disabled).toBe(true);
    expect(result.unavailableSessionKeys).toContain(JSON.stringify(["spark", "session"]));
  });
  it("filters without identifying same-named sessions by their names", () => {
    const groups = [
      { machineId: "local", available: true, agents: [agent("local", "one")] },
      { machineId: "spark", agents: [{ ...agent("spark", "two"), attention: true }] },
    ];
    expect(
      projectHomeFleet(catalog, groups, { machineId: "spark", attentionOnly: true }).rows.map(
        (row) => row.key,
      ),
    ).toEqual(["two"]);
    expect(
      projectHomeFleet(catalog, groups, { machineId: "local", attentionOnly: true }).rows,
    ).toEqual([]);
  });
  it("deduplicates linked physical panes within a machine and server but retains different servers", () => {
    const one = agent("local", "one");
    const groups = [
      {
        machineId: "local",
        available: true,
        agents: [
          one,
          { ...one, id: "two", sessionKey: "linked" },
          { ...one, id: "three", daemonInstanceId: "other-owner" },
        ],
      },
    ];
    expect(
      projectHomeFleet(catalog, groups, { machineId: "local", attentionOnly: false }).rows.map(
        (row) => row.key,
      ),
    ).toEqual(["one", "three"]);
  });
  it("does not reorder rows when activity changes", () => {
    const one = agent("local", "one"),
      two = { ...agent("local", "two"), paneId: "pane.two" };
    const view = (attention: boolean) =>
      projectHomeFleet(catalog, [{ machineId: "local", agents: [one, { ...two, attention }] }], {
        machineId: null,
        attentionOnly: false,
      }).rows.map((row) => row.key);
    expect(view(true)).toEqual(view(false));
  });
});

it("searches observed names and host context without changing coverage or stale meaning", () => {
  const groups = [
    { machineId: "local", available: true, agents: [agent("local", "one")] },
    {
      machineId: "spark",
      available: false,
      agents: [{ ...agent("spark", "two", true), name: "Renderer", serverLabel: "build" }],
    },
  ];
  const view = (query: string) =>
    projectHomeFleet(catalog, groups, { machineId: null, attentionOnly: false, query });
  expect(view("BUILD").rows.map((row) => row.key)).toEqual(["two"]);
  expect(view("Spark").rows[0]?.disabled).toBe(true);
  expect(view("missing").rows).toEqual([]);
  expect(view("missing").phase).toBe("partial");
  expect(view("missing").note).toContain("disconnected");
  expect(view("missing").totalSessions).toBe(view("").totalSessions);
});
