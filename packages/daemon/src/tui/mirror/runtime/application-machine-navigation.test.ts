import type { ApplicationMachineAgentGroup } from "./application-machine-agents.ts";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  selected: "local",
  agentGroups: [] as readonly ApplicationMachineAgentGroup[],
  agentCurrent: true,
  preferenceOptions: null as null | {
    onError(message: string): void;
    onRecovered(message: string): void;
  },
  handles: new Map<
    string,
    {
      id: string;
      label: string;
      kind: string;
      ready: Promise<boolean>;
      endpoint: () => { state: string };
      read: () => { instanceId: string };
    }
  >(),
  trace: [] as string[],
  listener: null as null | ((value: unknown) => void),
  catalogStart: vi.fn(),
  catalogDispose: vi.fn(),
  add: vi.fn(),
}));
vi.mock("./application-machine-authority.ts", () => ({
  applicationMachineAuthorityManager: {
    snapshot: () => ({
      selectedMachineId: state.selected,
      machines: [...state.handles.values()].map((handle) => ({
        id: handle.id,
        label: handle.label,
        kind: handle.kind,
        sshTarget: handle.id === "local" ? undefined : handle.id,
      })),
    }),
    getMachine: (id: string) => state.handles.get(id),
    select: (id: string) => {
      state.trace.push(`select:${id}`);
      state.selected = id;
      return true;
    },
    add: state.add,
  },
}));
vi.mock("./application-machine-catalog.ts", () => ({
  createApplicationMachineCatalog: () => ({
    getSnapshot: () => ({ selectedMachineId: state.selected, groups: [] }),
    subscribe: (listener: (value: unknown) => void) => {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    },
    start: state.catalogStart,
    dispose: state.catalogDispose,
  }),
}));
vi.mock("./application-machine-agents.ts", () => ({
  createApplicationMachineAgents: () => ({
    getSnapshot: () => state.agentGroups,
    subscribe: () => () => {},
    start: () => {},
    dispose: () => {},
    isCurrentTarget: () => state.agentCurrent,
  }),
}));
vi.mock("../../../lib/local-fleet-request.ts", () => ({
  saveMachineProfiles: vi.fn(async () => ({ version: 1, machines: [] })),
}));
vi.mock("./application-fleet-preferences.ts", () => ({
  createApplicationFleetPreferences: (options: NonNullable<typeof state.preferenceOptions>) => {
    state.preferenceOptions = options;
    return {
      getSnapshot: () => ({ version: 1, favorites: [], collapsed: [], recent: [], catalog: [] }),
      subscribe: () => () => {},
      change: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));
import { createApplicationMachineNavigation } from "./application-machine-navigation.ts";
let dispose: () => void;
const options = () => ({
  attachedTarget: vi.fn(
    (): {
      liveSessionId: string;
      daemonGeneration: string;
      server?: import("@tmux-ide/contracts").TmuxServerScope;
    } | null => null,
  ),
  resetWorkspace: vi.fn(() => {
    state.trace.push("reset");
  }),
  cancelOpen: vi.fn(() => {
    state.trace.push("cancel");
  }),
  openSession: vi.fn(async (name: string) => {
    state.trace.push(`open:${state.selected}:${name}`);
  }),
  openAgent: vi.fn(async () => {
    state.trace.push(`agent:${state.selected}`);
  }),
  sessionName: (): string | null => null,
  setSurface: vi.fn(),
  setNote: vi.fn(),
});
function publishSessions(rows = ["same"]) {
  state.listener?.({
    selectedMachineId: state.selected,
    groups: [...state.handles.values()].map((handle) => ({
      id: handle.id,
      label: handle.id,
      state: handle.endpoint().state,
      sessions: rows.map((name) => ({
        id: `${handle.id}:${name}`,
        name,
        paneCount: 1,
        disabled: false,
      })),
      note: null,
    })),
  });
}
function navigation() {
  const callbacks = options();
  const owner = createRoot((cleanup) => {
    dispose = cleanup;
    return createApplicationMachineNavigation(callbacks);
  });
  publishSessions();
  return { owner, callbacks };
}

it("clears a recovered preference warning without clearing a newer unrelated note", () => {
  const { callbacks } = navigation();
  state.preferenceOptions!.onRecovered("preferences failed");
  const update = callbacks.setNote.mock.calls.at(-1)![0] as (
    current: string | null,
  ) => string | null;
  expect(update("preferences failed")).toBeNull();
  expect(update("session disconnected")).toBe("session disconnected");
  expect(update(null)).toBeNull();
});
function machine(id: string, ready: Promise<boolean> = Promise.resolve(true), status = "ready") {
  state.handles.set(id, {
    id,
    label: id,
    kind: id === "local" ? "local" : "ssh",
    ready,
    endpoint: () => ({ state: status }),
    read: () => ({ instanceId: `generation-${id}` }),
  });
}
beforeEach(() => {
  state.selected = "local";
  state.agentGroups = [];
  state.agentCurrent = true;
  state.handles.clear();
  state.trace = [];
  state.catalogStart.mockReset();
  state.catalogDispose.mockReset();
  state.add.mockReset();
  machine("local");
  machine("A");
  machine("B");
});
afterEach(() => dispose?.());
describe("machine navigation ownership", () => {
  it("cancels agent admission before a same-machine session intent without resetting the workspace", () => {
    const { owner, callbacks } = navigation();
    owner.sidebar.onOpen("local", "same", "mouse");
    expect(state.trace).toEqual(["cancel", "open:local:same"]);
    expect(callbacks.cancelOpen).toHaveBeenCalledOnce();
    expect(callbacks.resetWorkspace).not.toHaveBeenCalled();
  });
  it("cancels and removes the old workspace before each rapid A to B to A switch", async () => {
    const { owner, callbacks } = navigation();
    let finish!: () => void;
    callbacks.openSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    owner.sidebar.onOpen("A", "same", "mouse");
    owner.sidebar.onOpen("B", "same", "mouse");
    owner.sidebar.onOpen("A", "same", "keyboard");
    expect(state.trace).toEqual([
      "cancel",
      "reset",
      "select:A",
      "cancel",
      "reset",
      "select:B",
      "cancel",
      "reset",
      "select:A",
    ]);
    expect(callbacks.openSession.mock.calls.map((call) => call[0])).toEqual([
      "same",
      "same",
      "same",
    ]);
    finish();
    await Promise.resolve();
    expect(state.selected).toBe("A");
    expect(callbacks.resetWorkspace).toHaveBeenCalledTimes(3);
  });
  it("waits for the initially selected SSH machine and never sends the target to local", async () => {
    let ready!: (value: boolean) => void;
    machine(
      "A",
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    state.selected = "A";
    const { owner, callbacks } = navigation();
    owner.start("remote-target");
    expect(callbacks.openSession).not.toHaveBeenCalled();
    expect(state.catalogStart).toHaveBeenCalledOnce();
    ready(true);
    publishSessions(["remote-target"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.openSession).toHaveBeenCalledExactlyOnceWith("remote-target", "keyboard");
  });
  it("does not open a late initial target after the user selects another machine", async () => {
    let ready!: (value: boolean) => void;
    machine(
      "A",
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    state.selected = "A";
    const { owner, callbacks } = navigation();
    owner.start("remote-target");
    owner.sidebar.onSelectMachine("local", "mouse");
    ready(true);
    await Promise.resolve();
    expect(callbacks.openSession).not.toHaveBeenCalled();
  });
  it("cancels pending initial targets when choosing Home on the same machine or focusing its sidebar", async () => {
    for (const action of ["home", "focus"] as const) {
      let ready!: (value: boolean) => void;
      machine(
        "A",
        new Promise((resolve) => {
          ready = resolve;
        }),
      );
      state.selected = "A";
      const { owner, callbacks } = navigation();
      owner.start("remote-target");
      if (action === "home") owner.sidebar.onSelectMachine("A", "mouse");
      else owner.sidebar.onFocus?.();
      ready(true);
      await Promise.resolve();
      expect(callbacks.cancelOpen).toHaveBeenCalled();
      expect(callbacks.openSession).not.toHaveBeenCalled();
      expect(callbacks.resetWorkspace).not.toHaveBeenCalled();
      dispose();
    }
  });
  it("rejects disconnected session activation without retaining the previous machine input owner", () => {
    machine("B", Promise.resolve(false), "disconnected");
    const { owner, callbacks } = navigation();
    owner.sidebar.onOpen("B", "old-session", "mouse");
    expect(state.trace).toEqual(["cancel", "reset", "select:B"]);
    expect(callbacks.openSession).not.toHaveBeenCalled();
    expect(callbacks.setNote).toHaveBeenCalledWith(expect.stringContaining("disconnected"));
  });
  it("cancels initial target readiness when its navigation owner is disposed", async () => {
    let ready!: (value: boolean) => void;
    machine(
      "A",
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    state.selected = "A";
    const { owner, callbacks } = navigation();
    owner.start("target");
    dispose();
    ready(true);
    await Promise.resolve();
    expect(callbacks.openSession).not.toHaveBeenCalled();
    expect(state.catalogDispose).toHaveBeenCalledOnce();
  });
  it("admits local-only automatic open only before the user begins navigation or adding a machine", () => {
    state.handles.delete("A");
    state.handles.delete("B");
    const { owner } = navigation();
    expect(owner.automaticOpen).toBe(true);
    expect(owner.automaticOpenAllowed()).toBe(true);
    owner.sidebar.onAddMachine?.();
    expect(owner.automaticOpenAllowed()).toBe(false);
    owner.cancelAdd();
    expect(owner.automaticOpenAllowed()).toBe(false);
  });
  it("keeps invalid add-machine input in the dialog without changing active authority", () => {
    const { owner } = navigation();
    owner.sidebar.onAddMachine?.();
    owner.setAlias("host;command");
    owner.add();
    expect(owner.adding()).toBe(true);
    expect(owner.error()).not.toBeNull();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.selected).toBe("local");
    owner.cancelAdd();
    expect(owner.adding()).toBe(false);
    expect(owner.focused()).toBe(true);
  });
});

it("opens a background agent only after switching to its machine, even with a shared session name", () => {
  const row = {
    id: "A-agent",
    machineId: "A",
    disabled: false,
    key: "key",
    sessionKey: "session",
    sessionName: "same",
    liveSessionId: "live",
    daemonInstanceId: "daemon",
    agentId: "agent",
    paneId: "pane",
    name: "Codex",
    harness: "codex",
    activity: "running" as const,
    attention: false,
    projectName: "project",
  };
  state.agentGroups = [{ machineId: "A", agents: [row] }];
  const { owner, callbacks } = navigation();
  owner.sidebar.onOpenAgent?.("A", "same", "pane", "mouse");
  expect(callbacks.openAgent).toHaveBeenCalledWith(row, "mouse");
  expect(state.trace.indexOf("reset")).toBeLessThan(state.trace.indexOf("select:A"));
  expect(state.trace.indexOf("select:A")).toBeLessThan(state.trace.indexOf("agent:A"));
  expect(callbacks.openSession).not.toHaveBeenCalled();
  state.agentCurrent = false;
  owner.sidebar.onOpenAgent?.("A", "same", "pane", "mouse");
  expect(callbacks.openAgent).toHaveBeenCalledTimes(1);
  expect(callbacks.setNote).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
});

it("F5 routes same-name sessions explicitly and rejects an obsolete generation", async () => {
  const { owner, callbacks } = navigation();
  state.listener?.({
    selectedMachineId: "local",
    groups: ["A", "B"].map((id) => ({
      id,
      label: id,
      state: "ready",
      sessions: [{ id: `${id}:same`, name: "same", liveSessionId: `live-${id}`, disabled: false }],
    })),
  });
  const commands = owner
    .paletteCommands()
    .filter((c) => typeof c === "object" && c.kind !== "open-machine");
  expect(commands).toHaveLength(2);
  const b = commands[1];
  if (typeof b !== "object") throw Error("Missing fleet command");
  await owner.openPalette(b, "keyboard");
  expect(state.selected).toBe("B");
  expect(callbacks.openSession).toHaveBeenCalledWith("same", "keyboard");
  expect(callbacks.resetWorkspace).toHaveBeenCalledWith("B", "live-B");
  callbacks.openSession.mockClear();
  await owner.openPalette(
    { ...b, fleet: { ...b.fleet!, daemonInstanceId: "obsolete" } },
    "keyboard",
  );
  expect(callbacks.openSession).not.toHaveBeenCalled();
  expect(callbacks.setNote).toHaveBeenCalledWith("That fleet target changed. Select it again.");
});

it("reselects exact same-machine incarnation when sidebar leaves a pinned tab for another session", async () => {
  const { owner, callbacks } = navigation();
  state.listener?.({
    selectedMachineId: "local",
    groups: [
      {
        id: "local",
        label: "Local",
        state: "ready",
        sessions: [
          { id: "local:shared", name: "shared", liveSessionId: "live-shared", disabled: false },
          {
            id: "local:recreated",
            name: "recreated",
            liveSessionId: "live-recreated",
            disabled: false,
          },
        ],
      },
    ],
  });
  const shared = owner
    .paletteCommands()
    .find(
      (command) =>
        typeof command === "object" &&
        command.kind === "open-session" &&
        command.sessionName === "shared",
    );
  if (!shared || typeof shared !== "object") throw Error("Missing shared command");
  await owner.openPalette(shared, "keyboard");
  expect(callbacks.resetWorkspace).toHaveBeenLastCalledWith("local", "live-shared");
  callbacks.resetWorkspace.mockClear();
  const currentSession = vi.spyOn(callbacks, "sessionName").mockReturnValue("shared");
  state.trace = [];
  owner.sidebar.onOpen("local", "recreated", "mouse");
  expect(callbacks.resetWorkspace).toHaveBeenCalledWith("local", "live-recreated");
  expect(state.trace.indexOf("reset")).toBeLessThan(state.trace.indexOf("open:local:recreated"));
  currentSession.mockReturnValue("recreated");
  callbacks.resetWorkspace.mockClear();
  owner.sidebar.onOpen("local", "recreated", "mouse");
  expect(callbacks.resetWorkspace).not.toHaveBeenCalled();
});

it("routes duplicate names by exact server session and rejects replaced tabs/history/palette", async () => {
  const { owner, callbacks } = navigation();
  const serverA = {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "11111111-1111-4111-8111-111111111111",
  };
  const serverB = {
    serverId: `tmux-server.${"b".repeat(32)}`,
    generation: "22222222-2222-4222-8222-222222222222",
  };
  const row = (server: typeof serverA) => ({
    id: JSON.stringify([server, "live-session.same"]),
    server,
    serverLabel: "same label",
    liveSessionId: "live-session.same",
    name: "same",
    paneCount: 1,
    disabled: false,
  });
  const a = row(serverA),
    b = row(serverB);
  const publish = (rows: (typeof a)[]) =>
    state.listener?.({
      selectedMachineId: "local",
      groups: [{ id: "local", label: "Local", state: "ready", sessions: rows, note: null }],
    });
  publish([a, b]);
  owner.sidebar.onOpen("local", "same", "mouse");
  expect(callbacks.openSession).not.toHaveBeenCalled();
  owner.sidebar.onOpen("local", "same", "mouse", b.id);
  await Promise.resolve();
  expect(callbacks.resetWorkspace).toHaveBeenLastCalledWith("local", "live-session.same", serverB);
  expect(callbacks.openSession).toHaveBeenCalledOnce();
  const staleTab = owner.sidebar.tabs!()[0]!;
  const stalePalette = owner
    .paletteCommands()
    .find(
      (entry) =>
        typeof entry === "object" &&
        entry.kind === "open-session" &&
        entry.fleet?.server?.serverId === serverB.serverId,
    )!;
  publish([a, row({ ...serverB, generation: "33333333-3333-4333-8333-333333333333" })]);
  callbacks.openSession.mockClear();
  owner.sidebar.onOpenTab!(staleTab.key);
  expect(owner.sidebar.tabs!()[0]!.available).toBe(false);
  if (typeof stalePalette === "object") await owner.openPalette(stalePalette, "keyboard");
  expect(callbacks.openSession).not.toHaveBeenCalled();
  expect(callbacks.setNote).toHaveBeenLastCalledWith("That fleet target changed. Select it again.");
});

it("offers empty registered servers as scoped creation targets and filters the selected server", () => {
  const { owner } = navigation();
  const server = {
    serverId: `tmux-server.${"b".repeat(32)}`,
    generation: "22222222-2222-4222-8222-222222222222",
  };
  state.listener?.({
    selectedMachineId: "local",
    groups: [
      {
        id: "local",
        label: "Local",
        state: "ready",
        sessions: [],
        servers: [{ ...server, state: "online", label: "empty server" }],
        note: null,
      },
    ],
  });
  owner.sidebar.onSelectServer?.("local", server);
  expect(owner.switching()).toBe(true);
  const commands = owner.paletteCommands().filter(owner.switcherFilter);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    kind: "open-machine",
    fleet: { server, liveSessionId: "", disabled: false },
  });
});

it("retains the exact attached default session for agent jumps but resets a different owner with colliding live IDs", () => {
  const daemonGeneration = state.handles.get("local")!.read().instanceId;
  const server = { serverId: `tmux-server.${"a".repeat(32)}`, generation: daemonGeneration };
  const row = {
    id: "agent",
    machineId: "local",
    disabled: false,
    key: "key",
    sessionKey: "session",
    sessionName: "same",
    liveSessionId: "live-session.same",
    daemonInstanceId: daemonGeneration,
    agentId: "agent",
    paneId: "pane",
    name: "Codex",
    harness: "codex",
    activity: "running" as const,
    attention: false,
    projectName: "project",
  };
  state.agentGroups = [{ machineId: "local", agents: [row] }];
  const { owner, callbacks } = navigation();
  const session = {
    id: "exact",
    name: "same",
    liveSessionId: row.liveSessionId,
    server,
    paneCount: 1,
    disabled: false,
  };
  state.listener?.({
    selectedMachineId: "local",
    groups: [{ id: "local", label: "Local", state: "ready", sessions: [session] }],
  });
  callbacks.attachedTarget.mockReturnValue({ liveSessionId: row.liveSessionId, daemonGeneration });
  owner.sidebar.onOpenAgent?.("local", "same", "pane", "mouse");
  expect(callbacks.resetWorkspace).not.toHaveBeenCalled();
  expect(callbacks.openAgent).toHaveBeenCalledWith(row, "mouse");
  callbacks.attachedTarget.mockReturnValue({
    liveSessionId: row.liveSessionId,
    daemonGeneration,
    server: { ...server, serverId: `tmux-server.${"b".repeat(32)}` },
  });
  owner.sidebar.onOpenAgent?.("local", "same", "pane", "mouse");
  expect(callbacks.resetWorkspace).toHaveBeenCalledWith("local", row.liveSessionId, server);
  callbacks.resetWorkspace.mockClear();
  callbacks.attachedTarget.mockReturnValue({
    liveSessionId: "live-session.replacement",
    daemonGeneration,
    server,
  });
  owner.sidebar.onOpenAgent?.("local", "same", "pane", "mouse");
  expect(callbacks.resetWorkspace).toHaveBeenCalledOnce();
});

it("opens Home agents through exact server identity and rejects replaced generations", () => {
  const first = { serverId: `tmux-server.${"a".repeat(32)}`, generation: "first" };
  const second = { serverId: `tmux-server.${"b".repeat(32)}`, generation: "second" };
  const row = {
    id: "agent",
    machineId: "local",
    disabled: false,
    key: "key",
    sessionKey: "session",
    sessionName: "same",
    liveSessionId: "same-live-id",
    daemonInstanceId: "second",
    agentId: "agent",
    paneId: "same-pane-id",
    name: "Codex",
    harness: "codex",
    activity: "running" as const,
    attention: false,
    projectName: "project",
    server: second,
  };
  state.agentGroups = [{ machineId: "local", agents: [row] }];
  const { owner, callbacks } = navigation();
  const publish = (replacement = false) =>
    state.listener?.({
      selectedMachineId: "local",
      groups: [
        {
          id: "local",
          label: "Local",
          state: "ready",
          sessions: [first, replacement ? { ...second, generation: "replacement" } : second].map(
            (server) => ({
              id: server.serverId,
              name: "same",
              liveSessionId: row.liveSessionId,
              server,
              paneCount: 1,
              disabled: false,
            }),
          ),
        },
      ],
    });
  publish();
  owner.openHomeAgent(row, "mouse");
  expect(callbacks.resetWorkspace).toHaveBeenCalledWith("local", row.liveSessionId, second);
  expect(callbacks.openAgent).toHaveBeenCalledWith(row, "mouse");
  publish(true);
  owner.openHomeAgent(row, "mouse");
  expect(callbacks.openAgent).toHaveBeenCalledTimes(1);
});
