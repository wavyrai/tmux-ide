import { describe, expect, it, vi } from "vitest";
import { createApplicationMachineAgentNavigator } from "./application-machine-agent-navigation.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { HomeAgentNavigationTarget } from "./application-home-agent-navigation.ts";

const target: HomeAgentNavigationTarget = {
  key: "row",
  daemonInstanceId: "daemon",
  liveSessionId: "live",
  sessionName: "shared",
  agentId: "agent",
  paneId: "%7",
};
function harness() {
  const state = {
    selected: "remote",
    attached: "remote",
    valid: true,
    semantic: true,
    session: "shared",
    daemon: "daemon",
    live: "live",
    pane: "%7",
  };
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: () => ({
      generation: 1,
      semantic: state.semantic
        ? { sidebar: { agents: [{ id: "agent", paneId: state.pane }] } }
        : null,
    }),
    subscribe: (_scope: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const events: string[] = [];
  const start = vi.fn(
    async (
      _session: string,
      _prepared: boolean,
      _source: string,
      _focus: boolean,
      admission?: () => boolean,
    ) => {
      if (!admission?.())
        return {
          opened: false,
          sessionName: "shared",
          generationKey: null,
          failure: "superseded" as const,
        };
      state.attached = state.selected;
      return { opened: true, sessionName: "shared", generationKey: "daemon:1:1" };
    },
  );
  const owner = createApplicationMachineAgentNavigator({
    selectedMachineId: () => state.selected,
    generationMachineId: () => state.attached,
    isCurrentTarget: (machine, row) => machine === "remote" && row === target && state.valid,
    generation: () =>
      ({
        status: "live",
        daemonGeneration: state.daemon,
        rendererEpoch: 1,
        connection: { liveSessionId: state.live },
        client,
      }) as unknown as OpenTuiGenerationHostSnapshot,
    sessionName: () => state.session,
    startGeneration: start,
    selectPane: (pane) => events.push(`select:${pane}`),
    showTerminals: () => events.push("show"),
    setNote: vi.fn(),
  });
  return {
    state,
    listeners,
    start,
    events,
    owner,
    publish: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("machine agent navigation", () => {
  it("keeps input admission closed when a cancelled request settles behind its replacement", async () => {
    const h = harness();
    h.state.semantic = false;
    const first = h.owner.open("remote", target);
    await Promise.resolve();
    h.owner.cancel();
    expect(h.owner.opening()).toBe(false);
    const second = h.owner.open("remote", target);
    await Promise.resolve();
    await first;
    expect(h.owner.opening()).toBe(true);
    h.state.semantic = true;
    h.publish();
    expect(await second).toEqual({ opened: true });
    expect(h.owner.opening()).toBe(false);
    expect(h.events).toEqual(["select:%7", "show"]);
  });
  it("selects exact warm target synchronously before showing terminals", async () => {
    const h = harness();
    const result = h.owner.open("remote", target);
    expect(h.events).toEqual(["select:%7", "show"]);
    expect(await result).toEqual({ opened: true });
    expect(h.start).not.toHaveBeenCalled();
  });
  it("does not reuse an identically named local generation even with matching daemon IDs", async () => {
    const h = harness();
    h.state.attached = "local";
    expect(await h.owner.open("remote", target, "keyboard")).toEqual({ opened: true });
    expect(h.start).toHaveBeenCalledWith("shared", false, "keyboard", false, expect.any(Function));
  });
  it("waits for semantic readiness without focusing the first pane", async () => {
    const h = harness();
    h.state.semantic = false;
    const result = h.owner.open("remote", target);
    await Promise.resolve();
    expect(h.events).toEqual([]);
    expect(h.owner.opening()).toBe(true);
    expect(h.listeners.size).toBeGreaterThan(0);
    h.state.semantic = true;
    h.publish();
    expect(await result).toEqual({ opened: true });
    expect(h.events).toEqual(["select:%7", "show"]);
    expect(h.listeners.size).toBe(0);
    expect(h.owner.opening()).toBe(false);
  });
  it.each(["machine", "cancel", "stale", "dispose"])(
    "rejects competing %s while waiting",
    async (cause) => {
      const h = harness();
      h.state.semantic = false;
      const result = h.owner.open("remote", target);
      await Promise.resolve();
      if (cause === "machine") h.state.selected = "local";
      if (cause === "cancel") h.owner.cancel();
      if (cause === "stale") h.state.valid = false;
      if (cause === "dispose") h.owner.dispose();
      h.state.semantic = true;
      h.publish();
      expect((await result).opened).toBe(false);
      expect(h.events).toEqual([]);
      expect(h.listeners.size).toBe(0);
      expect(h.owner.opening()).toBe(false);
    },
  );
  it.each(["daemon", "live", "pane", "session"] as const)(
    "rejects mismatched %s identity",
    async (field) => {
      const h = harness();
      h.state[field] = "different";
      expect((await h.owner.open("remote", target)).opened).toBe(false);
      expect(h.events).toEqual([]);
    },
  );
});
