import type { ApplicationMachineAgentGroup } from "./application-machine-agents.ts";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  selected: "local",
  agentGroups: [] as readonly ApplicationMachineAgentGroup[],
  agentCurrent: true,
  handles: new Map<
    string,
    {
      id: string;
      label: string;
      kind: string;
      ready: Promise<boolean>;
      endpoint: () => { state: string };
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
import { createApplicationMachineNavigation } from "./application-machine-navigation.ts";
let dispose: () => void;
const options = () => ({
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
  sessionName: () => null,
  setSurface: vi.fn(),
  setNote: vi.fn(),
});
function navigation() {
  const callbacks = options();
  const owner = createRoot((cleanup) => {
    dispose = cleanup;
    return createApplicationMachineNavigation(callbacks);
  });
  return { owner, callbacks };
}
function machine(id: string, ready: Promise<boolean> = Promise.resolve(true), status = "ready") {
  state.handles.set(id, {
    id,
    label: id,
    kind: id === "local" ? "local" : "ssh",
    ready,
    endpoint: () => ({ state: status }),
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
