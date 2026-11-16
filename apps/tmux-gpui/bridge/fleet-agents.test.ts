import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  MachineAgentGroup,
  createMachineAgents,
} from "../../../packages/daemon/src/lib/machine-agents.ts";
import type {
  HomeAgentRow,
  HomeAgentSnapshot,
} from "../../../packages/presentation/src/home-agent-roster.ts";
import { createFleetAgentRoster, sameAgentTarget, verifyFleetAgentTarget } from "./fleet-agents.ts";
import { homeAgentPublication } from "./home-agent-publication.ts";

const row: HomeAgentRow = {
  key: "session\0agent",
  sessionKey: "session",
  sessionName: "Workspace",
  liveSessionId: "live-session.aaaaaaaaaaaaaaaaaaaa",
  daemonInstanceId: "generation",
  server: { serverId: "server", generation: "generation" },
  agentId: "agent",
  paneId: "pane.agent",
  name: "Agent",
  harness: "codex",
  activity: "running",
  attention: false,
  projectName: "Project",
  nativeIdentity: null,
  interactionEndpoint: null,
};
function fixture(count = 1) {
  let machine: string | null = null;
  let palette: string | null = null;
  let workspace = false;
  let starts = 0,
    publications = 0;
  let groups: MachineAgentGroup[] = ["local", "remote"].map((machineId) => ({
    machineId,
    available: true,
    observation: {
      phase: "live",
      rows: [],
      observedSessions: 1,
      totalSessions: 1,
      loadingSessions: 0,
      unavailableSessions: 0,
      truncatedSessions: 0,
      refreshingSessionKeys: [],
      unavailableSessionKeys: [],
      note: null,
    },
    agents: Array.from({ length: count }, (_, i) => ({
      ...row,
      key: `${row.key}${i}`,
      id: `${machineId}:${i}`,
      machineId,
      disabled: false,
    })),
  }));
  let listener: (() => void) | undefined;
  const recoveries: string[] = [];
  let live = true;
  let stopped = false;
  let route = "route-1";
  let snapshot: HomeAgentSnapshot;
  const source: ReturnType<typeof createMachineAgents> = {
    getSnapshot: () => groups,
    subscribe(fn) {
      listener = () => fn(groups);
      listener();
      return () => {
        listener = undefined;
      };
    },
    isCurrentTarget: () => live && !stopped,
    isRefreshing: () => false,
    whenCurrentTarget: async () => live && !stopped,
    start() {
      starts++;
    },
    retry() {
      recoveries.push("retry");
    },
    loadMore() {
      recoveries.push("load-more");
    },
    dispose() {
      stopped = true;
    },
  };
  const owner = createFleetAgentRoster(
    source,
    (id) => `${id}/${route}`,
    (id) => (id === "local" ? "Local" : "Spark"),
    (value) => {
      snapshot = value;
      publications++;
    },
    () => "ready",
    () => machine,
    undefined,
    () => palette,
    () => workspace,
  );
  owner.start();
  return {
    owner,
    workspace(active: boolean) {
      workspace = active;
      owner.refresh();
    },
    palette(query: string | null) {
      palette = query;
      owner.refresh();
    },
    filter(id: string | null) {
      machine = id;
      owner.refresh(false);
    },
    groups: () => groups,
    starts: () => starts,
    publications: () => publications,
    recoveries,
    snapshot: () => snapshot!,
    emit: () => listener?.(),
    replace: () => {
      route = "replacement";
    },
    unavailable: () => {
      live = false;
    },
    setRows(next: MachineAgentGroup[]) {
      groups = next;
      listener?.();
    },
    stopped: () => stopped,
  };
}

test("duplicate host identities resolve through distinct opaque machine routes and stable keys", () => {
  const f = fixture();
  const [local, remote] = f.snapshot().rows;
  assert.notEqual(local!.key, remote!.key);
  assert.equal(f.owner.resolve(local!.key)?.selection, "local/route-1");
  assert.equal(f.owner.resolve(remote!.key)?.selection, "remote/route-1");
  assert.equal(remote!.sessionName, "Workspace");
  assert.equal(remote!.machineLabel, "Spark");
  f.emit();
  assert.deepEqual(
    f.snapshot().rows.map((r) => r.key),
    [local!.key, remote!.key],
  );
  const detached = f.owner.resolve(remote!.key)!;
  (detached.row as { paneId: string }).paneId = "forged";
  assert.equal(f.owner.resolve(remote!.key)?.row.paneId, row.paneId);
  const wire = JSON.stringify(homeAgentPublication(f.snapshot(), 1));
  assert.equal(wire.includes("route-1"), false);
  assert.equal(wire.includes("server"), false);
  f.owner.dispose();
});

test("replacement and unavailable authority reject old keys even before next publication", () => {
  const f = fixture();
  const key = f.snapshot().rows[0]!.key;
  f.replace();
  assert.equal(f.owner.resolve(key), null);
  f.emit();
  assert.notEqual(f.snapshot().rows[0]!.key, key);
  const current = f.snapshot().rows[0]!.key;
  f.unavailable();
  assert.equal(f.owner.resolve(current), null);
  f.emit();
  assert.ok(f.snapshot().rows.every((row) => row.disabled));
  f.owner.dispose();
  assert.equal(f.stopped(), true);
  assert.equal(f.owner.resolve(current), null);
});

test("global roster cap also caps selectable targets and removed rows are revoked", () => {
  const f = fixture(200);
  const snapshot = f.snapshot();
  const wire = homeAgentPublication(snapshot, 1);
  assert.equal(wire.rows.length, 256);
  assert.equal(wire.truncatedRows, 144);
  assert.ok(wire.rows.every((row) => f.owner.resolve(row.key)));
  assert.ok(snapshot.rows.slice(256).every((row) => f.owner.resolve(row.key) === null));
  const key = wire.rows[0]!.key;
  f.setRows([]);
  assert.equal(f.owner.resolve(key), null);
  f.owner.dispose();
});

test("fresh agent identity comparison rejects changed session, pane, agent or server", () => {
  assert.equal(sameAgentTarget(row, structuredClone(row)), true);
  for (const changed of [
    { ...row, paneId: "other" },
    { ...row, agentId: "replacement" },
    { ...row, liveSessionId: "replacement" },
    { ...row, daemonInstanceId: "replacement" },
    { ...row, server: { ...row.server!, generation: "replacement" } },
  ])
    assert.equal(sameAgentTarget(row, changed), false);
});

test("empty initial, settled unavailable and mixed empty fleets preserve observation state", () => {
  const f = fixture(0);
  assert.equal(f.snapshot().phase, "live");
  f.setRows([]);
  assert.equal(f.snapshot().phase, "loading");
  const unavailable: MachineAgentGroup = {
    machineId: "remote",
    available: false,
    agents: [],
    observation: {
      phase: "unavailable",
      rows: [],
      observedSessions: 0,
      totalSessions: 1,
      loadingSessions: 0,
      unavailableSessions: 1,
      truncatedSessions: 0,
      refreshingSessionKeys: [],
      unavailableSessionKeys: [],
      note: null,
    },
  };
  f.setRows([unavailable]);
  assert.equal(f.snapshot().phase, "unavailable");
  f.setRows([
    unavailable,
    {
      machineId: "local",
      available: true,
      agents: [],
      observation: {
        ...unavailable.observation!,
        phase: "live",
        observedSessions: 1,
        unavailableSessions: 0,
      },
    },
  ]);
  assert.equal(f.snapshot().phase, "partial");
  f.owner.dispose();
});

test("fresh inventory rejects removed or replaced agents and never opens another pane", async () => {
  let verified = 0;
  const verify = async () => {
    verified++;
  };
  assert.equal(
    await verifyFleetAgentTarget(
      row,
      async () => [row],
      verify,
      () => true,
    ),
    row.paneId,
  );
  assert.equal(verified, 1);
  for (const rows of [[], [{ ...row, agentId: "replacement" }]]) {
    await assert.rejects(
      verifyFleetAgentTarget(
        row,
        async () => rows,
        verify,
        () => true,
      ),
      /no longer available/,
    );
  }
  assert.equal(verified, 1);
});

test("navigation/presence and route replacement fence delayed inventory and route verification", async () => {
  for (const boundary of ["inventory", "route"]) {
    let current = true;
    let release!: () => void;
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = verifyFleetAgentTarget(
      row,
      async () => {
        if (boundary === "inventory") await delay;
        return [row];
      },
      async () => {
        if (boundary === "route") await delay;
      },
      () => current,
    );
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    release();
    await assert.rejects(pending, /selection changed/);
  }
  await assert.rejects(
    verifyFleetAgentTarget(
      row,
      async () => [row],
      async () => {
        throw new Error("route replaced");
      },
      () => true,
    ),
    /route replaced/,
  );
});

test("roster recovery delegates to resident source and stops after disposal", () => {
  const f = fixture();
  f.owner.recover("retry");
  f.owner.recover("load-more");
  assert.deepEqual(f.recoveries, ["retry", "load-more"]);
  assert.equal(f.stopped(), false);
  f.owner.dispose();
  f.owner.recover("retry");
  assert.equal(f.recoveries.length, 2);
});

test("Home machine projection precedes row cap and preserves global attention targets", () => {
  const f = fixture(300);
  // Equal display labels are not machine identity; the last rows require attention.
  const groups = f.groups().map((group) => ({
    ...group,
    agents: group.agents.map((agent, i) => ({
      ...agent,
      name: "Duplicate",
      attention: i >= 290,
    })),
  }));
  f.setRows(groups);
  const global = f.snapshot();
  const attentionKeys = global.rows.filter((row) => row.attention).map((row) => row.key);
  assert.ok(attentionKeys.every((key) => f.owner.resolve(key)));
  const before = f.publications();
  f.filter("remote");
  const selected = f.owner.homeSnapshot()!;
  const wire = homeAgentPublication(selected, 2);
  assert.equal(selected.totalSessions, 1);
  assert.equal(selected.observedSessions, 1);
  assert.equal(selected.phase, "live");
  assert.equal(wire.rows.length, 256);
  assert.equal(wire.truncatedRows, 44);
  assert.ok(wire.rows.every((row) => f.owner.resolve(row.key)?.machineId === "remote"));
  assert.ok(attentionKeys.every((key) => f.owner.resolve(key)));
  assert.equal(f.publications(), before, "filter must not republish F7's global observation");
  assert.equal(f.starts(), 1);
  assert.ok(f.snapshot().rows.filter((row) => f.owner.resolve(row.key)).length <= 512);
  f.owner.dispose();
});
test("selected machine coverage and failure exclude healthy siblings", () => {
  const f = fixture();
  const groups = f.groups();
  f.setRows(
    groups.map((group) =>
      group.machineId === "remote"
        ? {
            ...group,
            available: false,
            observation: {
              ...group.observation!,
              phase: "unavailable",
              observedSessions: 0,
              totalSessions: 9,
              unavailableSessions: 9,
              truncatedSessions: 3,
            },
          }
        : group,
    ),
  );
  f.filter("remote");
  const value = f.owner.homeSnapshot()!;
  assert.equal(value.phase, "unavailable");
  assert.equal(value.totalSessions, 9);
  assert.equal(value.observedSessions, 0);
  assert.equal(value.unavailableSessions, 9);
  assert.equal(value.truncatedSessions, 3);
  f.filter(null);
  assert.equal(f.owner.homeSnapshot()!.totalSessions, 10);
  f.owner.dispose();
});

test("connected partial Home coverage does not claim machine disconnection", () => {
  const f = fixture();
  f.setRows(
    f.groups().map((group) => ({
      ...group,
      available: false,
      observation: { ...group.observation!, phase: "partial", truncatedSessions: 1 },
    })),
  );
  f.filter("remote");
  assert.equal(f.owner.homeSnapshot()!.phase, "partial");
  assert.equal(f.owner.homeSnapshot()!.note, "Agent activity observation is incomplete.");
  assert.equal(
    f.snapshot().note,
    "Some machines are connecting or unavailable.",
    "F7 global projection remains unchanged",
  );
  f.owner.dispose();
});

test("palette query retains beyond Home/attention caps and releases only its budget", () => {
  const f = fixture(300);
  f.setRows(
    f.groups().map((group) => ({
      ...group,
      agents: group.agents.map((agent, i) =>
        group.machineId === "remote" && i === 299 ? { ...agent, name: "Zebra late agent" } : agent,
      ),
    })),
  );
  f.filter("local");
  f.emit();
  let late = f.snapshot().rows.find((r) => r.name === "Zebra late agent")!;
  assert.equal(f.owner.resolve(late.key), null);
  f.palette("agent zebra");
  late = f.snapshot().rows.find((r) => r.name === "Zebra late agent")!;
  assert.ok(f.owner.resolve(late.key));
  assert.equal(f.starts(), 1);
  assert.ok(f.snapshot().rows.filter((r) => f.owner.resolve(r.key)).length <= 768);
  const homeKey = f.owner.homeSnapshot()!.rows[0]!.key;
  f.palette(null);
  assert.equal(f.owner.resolve(late.key), null);
  assert.ok(f.owner.resolve(homeKey));
  f.owner.dispose();
});

test("Workspace grouped cap retains later team rows independently of Home and F5 retention", () => {
  const f = fixture(300);
  const team = { id: "team.abcdefghijklmnop", name: "Same", source: "manual" as const };
  f.setRows(
    f.groups().map((group, index) => ({
      ...group,
      agents: group.agents.map((agent, i) =>
        index === 0 && i === 299 ? { ...agent, team } : agent,
      ),
    })),
  );
  f.emit();
  f.filter("remote");
  f.workspace(true);
  const workspace = f.owner.workspaceSnapshot()!;
  const late = workspace.rows.find((r) => r.team)!;
  assert.equal(workspace.rows[0]!.key, late.key);
  assert.ok(f.owner.resolve(late.key));
  f.palette("missing-query");
  assert.ok(f.owner.resolve(late.key));
  const stable = f.owner.workspaceSnapshot()!.rows.find((r) => r.team)!.key;
  assert.equal(stable, late.key);
  f.palette(null);
  assert.ok(f.owner.resolve(late.key));
  f.workspace(false);
  assert.equal(f.owner.resolve(late.key), null);
  assert.ok(f.owner.resolve(f.owner.homeSnapshot()!.rows[0]!.key));
  f.owner.dispose();
});

test("four independent projections retain at most 1024 exact targets and release Workspace-only routes", () => {
  const f = fixture(1200);
  f.setRows(
    f.groups().map((group) => ({
      ...group,
      agents: group.agents.map((agent, i) => ({
        ...agent,
        attention: group.machineId === "local" && i >= 256 && i < 512,
        name: group.machineId === "local" && i >= 512 && i < 768 ? "Palette needle" : "Agent",
        ...(group.machineId === "local" && i >= 768 && i < 1024
          ? { team: { id: "team.abcdefghijklmnop", name: "Team", source: "manual" as const } }
          : {}),
        server: { serverId: group.machineId + "-server", generation: "generation" },
      })),
    })),
  );
  f.filter("remote");
  f.palette("needle");
  f.workspace(true);
  const retained = f.snapshot().rows.filter((row) => f.owner.resolve(row.key));
  assert.equal(retained.length, 1024);
  const workspaceOnly = f.owner.workspaceSnapshot()!.rows[0]!;
  assert.equal(f.owner.resolve(workspaceOnly.key)?.row.server?.serverId, "local-server");
  f.workspace(false);
  assert.equal(f.owner.resolve(workspaceOnly.key), null);
  assert.equal(f.snapshot().rows.filter((row) => f.owner.resolve(row.key)).length, 768);
  f.owner.dispose();
});
