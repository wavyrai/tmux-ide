import { describe, expect, it, vi } from "vitest";
import {
  createApplicationHomeAgentNavigator,
  type HomeAgentNavigationGeneration,
  type HomeAgentNavigationTarget,
} from "./application-home-agent-navigation.ts";
import type { ApplicationGenerationStartResult } from "./application-generation-starter.ts";

const target: HomeAgentNavigationTarget = {
  key: "daemon:incarnation:agent",
  daemonInstanceId: "daemon",
  liveSessionId: "incarnation",
  sessionName: "agents",
  agentId: "agent.exact",
  paneId: "pane.exact",
};
const generation = (): HomeAgentNavigationGeneration => ({
  generationKey: "daemon:7:1",
  daemonInstanceId: target.daemonInstanceId,
  liveSessionId: target.liveSessionId,
  sessionName: target.sessionName,
  agents: [{ id: target.agentId, paneId: target.paneId }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function harness(initial: HomeAgentNavigationGeneration | null = generation()) {
  const state = { current: initial, targetCurrent: true };
  const startGeneration = vi.fn(async (): Promise<ApplicationGenerationStartResult> => {
    state.current = generation();
    return {
      opened: true,
      sessionName: target.sessionName,
      generationKey: state.current.generationKey,
    };
  });
  const events: string[] = [];
  const selectPane = vi.fn((pane: string, source: string) =>
    events.push(`select:${pane}:${source}`),
  );
  const showTerminals = vi.fn((source: string) => events.push(`show:${source}`));
  const setNote = vi.fn();
  const owner = createApplicationHomeAgentNavigator({
    currentGeneration: () => state.current,
    isCurrentTarget: () => state.targetCurrent,
    startGeneration,
    selectPane,
    showTerminals,
    setNote,
  });
  return { state, startGeneration, events, selectPane, showTerminals, setNote, owner };
}

describe("Home exact agent navigation", () => {
  it.each(["keyboard", "mouse"] as const)(
    "warm %s selection is synchronous and reveals terminals",
    async (source) => {
      const h = harness();
      const result = h.owner.open(target, source);
      expect(h.events).toEqual([`select:pane.exact:${source}`, `show:${source}`]);
      await expect(result).resolves.toEqual({ opened: true });
      expect(h.startGeneration).not.toHaveBeenCalled();
    },
  );

  it("opens the target session without generic first-pane focus and preserves source", async () => {
    const h = harness({ ...generation(), sessionName: "other" });
    await expect(h.owner.open(target, "keyboard")).resolves.toEqual({ opened: true });
    expect(h.startGeneration).toHaveBeenCalledWith(
      "agents",
      false,
      "keyboard",
      false,
      expect.any(Function),
    );
    expect(h.events).toEqual(["select:pane.exact:keyboard", "show:keyboard"]);
  });

  it.each([
    ["daemon", { daemonInstanceId: "new-daemon" }],
    ["incarnation", { liveSessionId: "recreated-same-name" }],
    ["missing-incarnation", { liveSessionId: null }],
  ] as const)(
    "rejects the old attached %s even when catalog and names match",
    async (_name, changed) => {
      const h = harness({ ...generation(), ...changed });
      await expect(h.owner.open(target)).resolves.toEqual({
        opened: false,
        failure: "generation-changed",
      });
      expect(h.events).toEqual([]);
      expect(h.setNote).toHaveBeenCalledWith(expect.stringContaining("session changed"));
    },
  );

  it("never substitutes another agent with the same pane or another pane with the same agent", async () => {
    const h = harness({
      ...generation(),
      agents: [
        { id: "agent.other", paneId: target.paneId },
        { id: target.agentId, paneId: "pane.other" },
      ],
    });
    await expect(h.owner.open(target)).resolves.toEqual({ opened: false, failure: "pane-removed" });
    expect(h.events).toEqual([]);
  });

  it("rejects unavailable and removed rows before making a session request", async () => {
    const h = harness(null);
    await expect(h.owner.open({ ...target, paneId: null })).resolves.toMatchObject({
      opened: false,
      failure: "unavailable",
    });
    h.state.targetCurrent = false;
    await expect(h.owner.open(target)).resolves.toMatchObject({
      opened: false,
      failure: "stale-target",
    });
    expect(h.startGeneration).not.toHaveBeenCalled();
  });

  it("revalidates target incarnation after asynchronous attach", async () => {
    const h = harness(null),
      opening = deferred<ApplicationGenerationStartResult>();
    h.startGeneration.mockImplementation(() => opening.promise);
    const result = h.owner.open(target);
    h.state.current = generation();
    h.state.targetCurrent = false;
    opening.resolve({
      opened: true,
      sessionName: "agents",
      generationKey: generation().generationKey,
    });
    await expect(result).resolves.toMatchObject({ opened: false, failure: "stale-target" });
    expect(h.events).toEqual([]);
  });

  it("rejects a replaced generation after attach resolves", async () => {
    const h = harness(null);
    h.startGeneration.mockImplementation(async () => {
      h.state.current = { ...generation(), generationKey: "daemon:8:2" };
      return { opened: true, sessionName: "agents", generationKey: generation().generationKey };
    });
    await expect(h.owner.open(target)).resolves.toMatchObject({
      opened: false,
      failure: "generation-changed",
    });
    expect(h.events).toEqual([]);
  });

  it.each(["cancel", "dispose"] as const)(
    "%s retires pending work without touching focus or newer notes",
    async (method) => {
      const h = harness(null),
        opening = deferred<ApplicationGenerationStartResult>();
      h.startGeneration.mockImplementation(() => opening.promise);
      const result = h.owner.open(target);
      h.owner[method]();
      const noteCalls = h.setNote.mock.calls.length;
      h.state.current = generation();
      opening.resolve({
        opened: true,
        sessionName: "agents",
        generationKey: generation().generationKey,
      });
      await expect(result).resolves.toEqual({ opened: false, failure: "superseded" });
      expect(h.events).toEqual([]);
      expect(h.setNote).toHaveBeenCalledTimes(noteCalls);
    },
  );

  it("a newer agent open supersedes an older session response", async () => {
    const h = harness(null),
      opening = deferred<ApplicationGenerationStartResult>();
    h.startGeneration.mockImplementationOnce(() => opening.promise);
    const first = h.owner.open(target);
    h.state.current = generation();
    await h.owner.open(target, "keyboard");
    opening.resolve({
      opened: true,
      sessionName: "agents",
      generationKey: generation().generationKey,
    });
    await expect(first).resolves.toMatchObject({ opened: false, failure: "superseded" });
    expect(h.events).toEqual(["select:pane.exact:keyboard", "show:keyboard"]);
  });

  it("contains attach rejection and displays actionable failure", async () => {
    const h = harness(null);
    h.startGeneration.mockRejectedValue(new Error("offline"));
    await expect(h.owner.open(target)).resolves.toMatchObject({
      opened: false,
      failure: "attach-failed",
    });
    expect(h.events).toEqual([]);
    expect(h.setNote).toHaveBeenLastCalledWith(expect.stringContaining("retry"));
  });

  it("does not overwrite newer ordinary-navigation notes when the shared starter supersedes it", async () => {
    const h = harness(null);
    h.startGeneration.mockResolvedValue({
      opened: false,
      sessionName: "agents",
      generationKey: null,
      failure: "superseded",
    });
    await expect(h.owner.open(target)).resolves.toEqual({ opened: false, failure: "superseded" });
    expect(h.setNote.mock.calls).toEqual([["Opening agent in agents…"]]);
    expect(h.events).toEqual([]);
  });
});
