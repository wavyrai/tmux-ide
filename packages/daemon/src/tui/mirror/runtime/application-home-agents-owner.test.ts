import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  createApplicationHomeAgentsOwner,
  createApplicationHomeNavigationOwner,
} from "./application-home-agents-owner.ts";
import { createApplicationShellBinding } from "./application-shell-binding.ts";
import type { ApplicationHomeAgentObserver } from "./application-home-agent-observer.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

const row: HomeAgentRow = {
  key: "daemon:live\u0000agent",
  sessionKey: "daemon:live",
  sessionName: "alpha",
  liveSessionId: "live",
  daemonInstanceId: "daemon",
  agentId: "agent",
  paneId: "pane.exact",
  name: "Agent",
  harness: "codex",
  activity: "running",
  attention: false,
  projectName: "alpha",
};
const live: HomeAgentSnapshot = {
  phase: "live",
  rows: [row],
  observedSessions: 1,
  totalSessions: 1,
  loadingSessions: 0,
  unavailableSessions: 0,
  truncatedSessions: 0,
  note: null,
};

function rig() {
  let sessionName = "alpha";
  let semanticReady = true;
  let listedPane = "pane.exact";
  const semanticListeners = new Set<() => void>();
  let snapshot = live;
  let notify: (value: HomeAgentSnapshot) => void = () => undefined;
  const observer: ApplicationHomeAgentObserver = {
    adoptCatalog: vi.fn(),
    setActive: vi.fn(),
    invalidate: vi.fn(),
    retry: vi.fn(),
    loadMore: vi.fn(),
    dispose: vi.fn(),
    getSnapshot: () => snapshot,
    isCurrentTarget: (target) =>
      snapshot.rows.some((row) => row.key === target.key && row.paneId === target.paneId),
    subscribe(fn) {
      notify = fn;
      fn(snapshot);
      return vi.fn();
    },
  };
  const selectPane = vi.fn();
  const showTerminals = vi.fn();
  const restoreHome = vi.fn<(_source: "keyboard" | "mouse") => void | Promise<void>>();
  const setNote = vi.fn();
  const startGeneration = vi.fn(async () => ({
    opened: true,
    sessionName: "alpha",
    generationKey: "daemon:1:1",
  }));
  const generation = {
    status: "live",
    daemonGeneration: "daemon",
    rendererEpoch: 1,
    connection: { liveSessionId: "live" },
    client: {
      getSnapshot: () => ({
        generation: 1,
        semantic: semanticReady
          ? { sidebar: { agents: [{ id: "agent", paneId: listedPane }] } }
          : null,
      }),
      subscribe(_scope: string, fn: () => void) {
        semanticListeners.add(fn);
        fn();
        return () => semanticListeners.delete(fn);
      },
    },
  } as unknown as OpenTuiGenerationHostSnapshot;
  let dispose!: () => void;
  let setActive!: (value: boolean) => void;
  const owner = createRoot((close) => {
    dispose = close;
    const [active, update] = createSignal(true);
    setActive = update;
    return createApplicationHomeAgentsOwner({
      catalog: () => ({
        phase: "live",
        daemonInstanceId: "daemon",
        sessions: [{ id: "daemon:live", liveSessionId: "live", name: "alpha", paneCount: 1 }],
        note: null,
      }),
      active,
      inputActive: active,
      observer,
      generation: () => generation,
      sessionName: () => sessionName,
      startGeneration,
      selectPane,
      showTerminals,
      restoreHome,
      setNote,
    });
  });
  return {
    owner,
    observer,
    dispose,
    setActive,
    selectPane,
    showTerminals,
    restoreHome,
    startGeneration,
    setNote,
    semanticListeners,
    generation,
    setSessionName(name: string) {
      sessionName = name;
    },
    /** The attached session lists the agent on `pane` (#764). */
    setListedPane(pane: string) {
      listedPane = pane;
      for (const listener of semanticListeners) listener();
    },
    setSemanticReady(value: boolean) {
      semanticReady = value;
      for (const listener of semanticListeners) listener();
    },
    publish(next: HomeAgentSnapshot) {
      snapshot = next;
      notify(next);
    },
  };
}

describe("resident agent Home composition", () => {
  it("explains transient terminal admission without enabling blocked palette actions", async () => {
    const r = rig();
    const binding = createApplicationShellBinding();
    let current: OpenTuiGenerationHostSnapshot | null = null;
    let focused: string | null = "pane.exact";
    const zoomPane = vi.fn(async () => "zoomed pane");
    const setNote = vi.fn();
    let dispose!: () => void;
    const navigation = createRoot((close) => {
      dispose = close;
      return createApplicationHomeNavigationOwner({
        focusedPane: () => focused,
        catalog: {
          snapshot: () => ({ phase: "live", daemonInstanceId: "daemon", sessions: [], note: null }),
          sessionNames: () => ["alpha"],
        },
        activeSurface: () => "terminals",
        shell: binding.getSnapshot,
        binding,
        sessionOwner: () => ({
          snapshot: () => current,
          sessionName: () => "alpha",
          open: async () => true,
          dispose: async () => undefined,
        }),
        generationStarter: r.startGeneration,
        startGeneration: r.startGeneration,
        interaction: {
          selectPane: vi.fn(),
          renamePane: vi.fn(async () => "renamed"),
          newWindow: vi.fn(async () => "created"),
          newAgent: vi.fn(async () => "created"),
          splitPane: vi.fn(async () => "split"),
          closePane: vi.fn(async () => "closed"),
        },
        zoomPane,
        rendererFocused: () => true,
        setSurface: vi.fn(),
        setNote,
        observer: r.observer,
      });
    });
    try {
      for (const [status, reason] of [
        [null, "Open a live session first"],
        ["connecting", "Opening terminal…"],
        ["rebinding", "Terminal is updating. Try again shortly."],
        ["empty", "Open a live session first"],
        ["unavailable", "Open a live session first"],
        ["disposed", "Open a live session first"],
      ] as const) {
        current = status ? { ...r.generation, status } : null;
        expect(navigation.paletteCommands.disabledReason("zoom-pane")).toBe(reason);
        navigation.paletteCommands.activate("zoom-pane", "keyboard");
        expect(setNote).toHaveBeenLastCalledWith(reason);
        expect(zoomPane).not.toHaveBeenCalled();
        expect(navigation.paletteCommands.disabledReason("home")).toBeNull();
      }
      current = { ...r.generation, status: "live" };
      focused = null;
      expect(navigation.paletteCommands.disabledReason("zoom-pane")).toBe(
        "Select a live pane first",
      );
      navigation.paletteCommands.activate("zoom-pane", "keyboard");
      expect(zoomPane).not.toHaveBeenCalled();
      focused = "pane.exact";
      expect(navigation.paletteCommands.disabledReason("zoom-pane")).toBeNull();
      navigation.paletteCommands.activate("zoom-pane", "keyboard");
      await vi.waitFor(() => expect(zoomPane).toHaveBeenCalledOnce());
    } finally {
      dispose();
      binding.dispose();
      r.dispose();
    }
  });

  it("waits for semantic details after terminal-first cross-session attach, then selects the exact agent", async () => {
    const r = rig();
    r.setSessionName("beta");
    r.setSemanticReady(false);
    r.startGeneration.mockImplementation(async () => {
      r.setSessionName("alpha");
      return { opened: true, sessionName: "alpha", generationKey: "daemon:1:1" };
    });
    r.owner.presentation.onOpenAgent!(row, "keyboard");
    await Promise.resolve();
    expect(r.semanticListeners.size).toBeGreaterThan(0);
    expect(r.selectPane).not.toHaveBeenCalled();
    expect(r.owner.opening()).toBe(true);
    r.setSemanticReady(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.selectPane).toHaveBeenCalledExactlyOnceWith("pane.exact");
    expect(r.showTerminals).toHaveBeenCalledWith("keyboard");
    expect(r.setNote).not.toHaveBeenCalledWith(expect.stringContaining("session changed"));
    expect(r.semanticListeners.size).toBe(0);
    await vi.waitFor(() => expect(r.owner.opening()).toBe(false));
    r.dispose();
  });

  it.each(["cancel", "dispose", "timeout"] as const)(
    "releases pending semantic subscriptions on %s without late selection",
    async (reason) => {
      vi.useFakeTimers();
      const r = rig();
      try {
        r.setSessionName("beta");
        r.setSemanticReady(false);
        r.startGeneration.mockImplementation(async () => {
          r.setSessionName("alpha");
          return { opened: true, sessionName: "alpha", generationKey: "daemon:1:1" };
        });
        r.owner.presentation.onOpenAgent!(row, "mouse");
        await Promise.resolve();
        expect(r.semanticListeners.size).toBeGreaterThan(0);
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(5_000);
        else if (reason === "dispose") r.dispose();
        else r.owner.cancel();
        r.setSemanticReady(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(r.semanticListeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(r.selectPane).not.toHaveBeenCalled();
        expect(r.showTerminals).not.toHaveBeenCalled();
        if (reason === "timeout")
          expect(r.setNote).toHaveBeenCalledWith(expect.stringContaining("details are not ready"));
        else expect(r.restoreHome).not.toHaveBeenCalled();
      } finally {
        r.dispose();
        vi.useRealTimers();
      }
    },
  );

  // #764: Home lists the agent before the attached session does.
  it("hands the controller the admission while the session catches up, with a wait note", async () => {
    const r = rig();
    r.setListedPane("pane.previous");
    r.owner.presentation.onOpenAgent!(row, "mouse");
    // Not a bare id: the controller selects only once this admission is true.
    expect(r.selectPane).toHaveBeenCalledExactlyOnceWith("pane.exact", expect.any(Promise));
    const admission = r.selectPane.mock.calls[0]![1] as Promise<boolean>;
    expect(r.setNote).toHaveBeenLastCalledWith("Waiting for agent in alpha…");
    expect(r.showTerminals).not.toHaveBeenCalled();
    expect(r.owner.opening()).toBe(true);
    r.setListedPane("pane.exact");
    await expect(admission).resolves.toBe(true);
    await vi.waitFor(() => expect(r.showTerminals).toHaveBeenCalledWith("mouse"));
    expect(r.setNote).toHaveBeenLastCalledWith(null);
    await vi.waitFor(() => expect(r.owner.opening()).toBe(false));
    r.dispose();
  });

  it("Esc during the warm wait cancels it, selects nothing and returns the keyboard", async () => {
    const r = rig();
    r.setListedPane("pane.previous");
    r.owner.presentation.onOpenAgent!(row, "keyboard");
    const admission = r.selectPane.mock.calls[0]![1] as Promise<boolean>;
    expect(r.owner.opening()).toBe(true);
    expect(r.owner.presentation.agentInputActive).toBe(false);
    // Other keys are owned (ignored) while opening.
    expect(r.owner.ownsKey("a")).toBe(true);
    expect(r.owner.opening()).toBe(true);

    expect(r.owner.ownsKey("escape")).toBe(true);
    expect(r.owner.opening()).toBe(false);
    expect(r.owner.presentation.agentInputActive).toBe(true);
    // The controller never selects a pane whose admission is false.
    await expect(admission).resolves.toBe(false);
    r.setListedPane("pane.exact");
    await Promise.resolve();
    expect(r.showTerminals).not.toHaveBeenCalled();
    expect(r.setNote).toHaveBeenLastCalledWith(null);
    // Not opening: keys, Esc included, reach the rest of the root again.
    expect(r.owner.ownsKey("escape")).toBe(false);
    expect(r.owner.ownsKey("a")).toBe(false);
    r.dispose();
  });

  it("still rejects a changed incarnation after semantic readiness", async () => {
    const r = rig();
    r.setSessionName("beta");
    r.setSemanticReady(false);
    r.startGeneration.mockImplementation(async () => {
      r.setSessionName("alpha");
      return { opened: true, sessionName: "alpha", generationKey: "daemon:1:1" };
    });
    r.owner.presentation.onOpenAgent!(row, "mouse");
    await Promise.resolve();
    Object.assign(r.generation.connection!, { liveSessionId: "recreated" });
    r.setSemanticReady(true);
    await Promise.resolve();
    expect(r.selectPane).not.toHaveBeenCalled();
    expect(r.setNote).toHaveBeenCalledWith(expect.stringContaining("session changed"));
    r.dispose();
  });

  it("restores Home before releasing the input fence after failed exact admission", async () => {
    const r = rig();
    let restored!: () => void;
    r.restoreHome.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          restored = resolve;
        }),
    );
    r.setSessionName("beta");
    r.startGeneration.mockImplementation(async () => {
      r.setSessionName("alpha");
      Object.assign(r.generation.connection!, { liveSessionId: "recreated" });
      return { opened: true, sessionName: "alpha", generationKey: "daemon:1:1" };
    });
    r.owner.presentation.onOpenAgent!(row, "mouse");
    await vi.waitFor(() => expect(r.restoreHome).toHaveBeenCalledWith("mouse"));
    expect(r.owner.opening()).toBe(true);
    expect(r.owner.presentation.agentInputActive).toBe(false);
    expect(r.selectPane).not.toHaveBeenCalled();
    restored();
    await vi.waitFor(() => expect(r.owner.opening()).toBe(false));
    r.dispose();
  });

  it("composes chrome admission and cancels pending agent navigation before a competing surface", async () => {
    const r = rig();
    const binding = createApplicationShellBinding();
    const startGeneration = vi.fn(() => new Promise<never>(() => undefined));
    const selectPane = vi.fn();
    const setSurface = vi.fn();
    let dispose!: () => void;
    let setFocused!: (focused: boolean) => void;
    let setShell!: (snapshot: ReturnType<typeof binding.getSnapshot>) => void;
    const navigation = createRoot((close) => {
      dispose = close;
      const [focused, updateFocused] = createSignal(true);
      const [shell, updateShell] = createSignal(binding.getSnapshot());
      setFocused = updateFocused;
      setShell = updateShell;
      return createApplicationHomeNavigationOwner({
        catalog: {
          snapshot: () => ({
            phase: "live",
            daemonInstanceId: "daemon",
            sessions: [{ id: "daemon:live", liveSessionId: "live", name: "alpha", paneCount: 1 }],
            note: null,
          }),
          sessionNames: () => ["alpha"],
        },
        activeSurface: () => "home",
        shell,
        binding,
        sessionOwner: () => null,
        generationStarter: startGeneration,
        startGeneration,
        interaction: {
          selectPane,
          renamePane: vi.fn(async () => "renamed"),
          newWindow: vi.fn(async () => "created"),
          splitPane: vi.fn(async () => "split"),
          closePane: vi.fn(async () => "closed"),
        },
        rendererFocused: focused,
        setSurface,
        setNote: vi.fn(),
        observer: r.observer,
      });
    });
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(true);
    navigation.paneRename.begin("pane.exact", "Agent");
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(false);
    navigation.paneRename.cancel();
    setFocused(false);
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(false);
    setFocused(true);
    setShell({ ...binding.getSnapshot(), localPaletteOpen: true });
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(false);
    setShell(binding.getSnapshot());
    navigation.homeAgents.presentation.onOpenAgent!(row, "keyboard");
    expect(navigation.homeAgents.opening()).toBe(true);
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(false);
    navigation.paletteCommands.openSurface("home", "keyboard");
    expect(navigation.homeAgents.opening()).toBe(false);
    expect(navigation.homeAgents.presentation.agentInputActive).toBe(true);
    expect(selectPane).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(setSurface).toHaveBeenCalledWith("home");
    dispose();
    binding.dispose();
    r.dispose();
  });

  it("connects presentation intent to exact pane navigation and preserves selection across return", async () => {
    const r = rig();
    r.owner.presentation.onOpenAgent!(row, "keyboard");
    expect(r.selectPane).toHaveBeenCalledWith("pane.exact");
    expect(r.showTerminals).toHaveBeenCalledWith("keyboard");
    expect(r.startGeneration).not.toHaveBeenCalled();
    await Promise.resolve();
    r.setActive(false);
    r.setActive(true);
    r.publish({ ...live, phase: "loading", rows: [], loadingSessions: 1 });
    expect(r.owner.presentation.agentSelection?.selectedKey).toBe(row.key);
    r.publish(live);
    expect(r.owner.presentation.agentSelection?.selectedKey).toBe(row.key);
    r.dispose();
    expect(r.observer.dispose).toHaveBeenCalledOnce();
  });

  it("does not let a stale presentation row activate after authoritative removal", async () => {
    const r = rig();
    r.publish({ ...live, rows: [] });
    expect(r.owner.presentation.agentSelection?.selectedKey).toBeNull();
    r.owner.presentation.onOpenAgent!(row, "mouse");
    await Promise.resolve();
    expect(r.selectPane).not.toHaveBeenCalled();
    expect(r.showTerminals).not.toHaveBeenCalled();
    r.dispose();
  });

  it("routes retry/load-more to the observation owner, not the view", () => {
    const r = rig();
    r.owner.presentation.onRetryAgents!();
    r.owner.presentation.onLoadMoreAgents!();
    expect(r.observer.retry).toHaveBeenCalledOnce();
    expect(r.observer.loadMore).toHaveBeenCalledOnce();
    r.dispose();
  });
});
