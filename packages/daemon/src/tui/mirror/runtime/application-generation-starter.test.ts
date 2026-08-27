import { describe, expect, it, vi } from "vitest";

import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import {
  applicationGenerationNavigationKey,
  createApplicationAgentNavigator,
  createApplicationGenerationStarter,
  type ApplicationGenerationStartResult,
} from "./application-generation-starter.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function generation(
  daemonGeneration: string,
  clientGeneration: number,
  rendererEpoch = 3,
): OpenTuiGenerationHostSnapshot {
  return {
    status: "live",
    daemonGeneration,
    rendererEpoch,
    client: { getSnapshot: () => ({ generation: clientGeneration }) },
  } as unknown as OpenTuiGenerationHostSnapshot;
}

function result(
  sessionName: string,
  snapshot: OpenTuiGenerationHostSnapshot,
): ApplicationGenerationStartResult {
  return {
    opened: true,
    sessionName,
    generationKey: applicationGenerationNavigationKey(snapshot),
  };
}

function sessionOwner(state: {
  sessionName: string | null;
  snapshot: OpenTuiGenerationHostSnapshot | null;
}): OpenTuiSessionOwner {
  return {
    sessionName: () => state.sessionName,
    snapshot: () => state.snapshot,
    open: async () => true,
    dispose: async () => undefined,
  };
}

describe("application generation starter", () => {
  it("lets an exact agent jump replace generic first-pane focus", async () => {
    const snapshot = generation("daemon-a", 7);
    const focusOwner = { request: vi.fn(), adopt: vi.fn(), dispose: vi.fn() };
    const owner = sessionOwner({ sessionName: "agents", snapshot });
    const start = createApplicationGenerationStarter({
      binding: {
        openSession: async (_sessionName, _source, open) => ({
          opened: await open("agents"),
          activated: true,
        }),
      },
      sessionOwner: () => owner,
      focusOwner: () => focusOwner,
      setNote: vi.fn(),
      setSurface: vi.fn(),
    });

    await expect(start("agents", false, "mouse", false)).resolves.toEqual(
      result("agents", snapshot),
    );
    expect(focusOwner.request).not.toHaveBeenCalled();
  });

  it("does not focus a generation superseded by a newer ordinary session open", async () => {
    const staleOpen = deferred<{ readonly opened: boolean; readonly activated: boolean }>();
    const secondGeneration = generation("daemon-second", 2);
    const state = {
      sessionName: "main" as string | null,
      snapshot: null as OpenTuiGenerationHostSnapshot | null,
    };
    const focusOwner = { request: vi.fn(), adopt: vi.fn(), dispose: vi.fn() };
    const start = createApplicationGenerationStarter({
      binding: {
        openSession: async (sessionName) => {
          if (sessionName === "first") return staleOpen.promise;
          state.sessionName = sessionName;
          state.snapshot = secondGeneration;
          return { opened: true, activated: true };
        },
      },
      sessionOwner: () => sessionOwner(state),
      focusOwner: () => focusOwner,
      setNote: vi.fn(),
      setSurface: vi.fn(),
    });

    const first = start("first");
    await expect(start("second")).resolves.toEqual(result("second", secondGeneration));
    staleOpen.resolve({ opened: true, activated: true });

    await expect(first).resolves.toEqual({
      opened: true,
      sessionName: "first",
      generationKey: null,
    });
    expect(focusOwner.request).toHaveBeenCalledTimes(1);
  });
});

describe("application agent navigation", () => {
  it("opens the owning session before selecting the exact semantic pane", async () => {
    const snapshot = generation("daemon-agents", 4);
    const state = {
      sessionName: "main" as string | null,
      snapshot: null as typeof snapshot | null,
    };
    const events: string[] = [];
    const startGeneration = vi.fn(async (sessionName: string) => {
      events.push(`open:${sessionName}`);
      state.sessionName = sessionName;
      state.snapshot = snapshot;
      return result(sessionName, snapshot);
    });
    const navigate = createApplicationAgentNavigator({
      startGeneration,
      sessionOwner: () => sessionOwner(state),
      selectPane: (paneId) => events.push(`select:${paneId}`),
    });

    await expect(navigate("agents", "pane.agent")).resolves.toBe(true);
    expect(startGeneration).toHaveBeenCalledWith("agents", false, "mouse", false);
    expect(events).toEqual(["open:agents", "select:pane.agent"]);
  });

  it("does not select a stale pane when the requested session did not open", async () => {
    const snapshot = generation("daemon-main", 1);
    const selectPane = vi.fn();
    const navigate = createApplicationAgentNavigator({
      startGeneration: async (sessionName) => ({
        opened: false,
        sessionName,
        generationKey: null,
      }),
      sessionOwner: () => sessionOwner({ sessionName: "main", snapshot }),
      selectPane,
    });

    await expect(navigate("agents", "pane.agent")).resolves.toBe(false);
    expect(selectPane).not.toHaveBeenCalled();
  });

  it("fences a superseded navigation before its late session open can select", async () => {
    const stale = deferred<ApplicationGenerationStartResult>();
    const firstGeneration = generation("daemon-first", 1);
    const secondGeneration = generation("daemon-second", 2);
    const state = {
      sessionName: "main" as string | null,
      snapshot: null as OpenTuiGenerationHostSnapshot | null,
    };
    const selected: string[] = [];
    const navigate = createApplicationAgentNavigator({
      startGeneration: async (sessionName) => {
        if (sessionName === "first") return stale.promise;
        state.sessionName = sessionName;
        state.snapshot = secondGeneration;
        return result(sessionName, secondGeneration);
      },
      sessionOwner: () => sessionOwner(state),
      selectPane: (paneId) => selected.push(paneId),
    });

    const first = navigate("first", "pane.stale");
    await expect(navigate("second", "pane.live", "keyboard")).resolves.toBe(true);
    state.sessionName = "first";
    state.snapshot = firstGeneration;
    stale.resolve(result("first", firstGeneration));

    await expect(first).resolves.toBe(false);
    expect(selected).toEqual(["pane.live"]);
  });

  it("rejects a pane id when the session generation was replaced after opening", async () => {
    const openedGeneration = generation("daemon-a", 8);
    const replacement = generation("daemon-a", 9);
    const selectPane = vi.fn();
    const navigate = createApplicationAgentNavigator({
      startGeneration: async (sessionName) => result(sessionName, openedGeneration),
      sessionOwner: () => sessionOwner({ sessionName: "agents", snapshot: replacement }),
      selectPane,
    });

    await expect(navigate("agents", "pane.old")).resolves.toBe(false);
    expect(selectPane).not.toHaveBeenCalled();
  });
});
