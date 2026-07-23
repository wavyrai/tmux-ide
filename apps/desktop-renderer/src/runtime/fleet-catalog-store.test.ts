import { describe, expect, it, vi } from "vitest";
import type {
  DaemonInstanceIdentity,
  DesktopDaemonEvent,
  DesktopDaemonFetchFleetCatalogResult,
  DesktopDaemonHostSubscriptionResult,
  HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createDesktopFleetCatalogStore,
  type DesktopFleetCatalogState,
} from "./fleet-catalog-store.ts";
import {
  FLEET_FIXTURE_DAEMON,
  emptyFleetCatalog,
  mixedFleetCatalog,
} from "./fleet-catalog-fixture.ts";

const DAEMON = FLEET_FIXTURE_DAEMON;
const OTHER_DAEMON: DaemonInstanceIdentity = {
  ...DAEMON,
  instanceId: "ffffffff-0a1b-4c3d-8e5f-60718293a4b5",
  startedAt: "2026-07-22T00:00:00.000Z",
};

const CONNECTED = { status: "connected" as const, identity: DAEMON };

interface FakeDaemonHost {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly fetchFleetCatalog: ReturnType<
    typeof vi.fn<() => Promise<DesktopDaemonFetchFleetCatalogResult>>
  >;
  readonly subscribe: ReturnType<
    typeof vi.fn<
      (
        request: { readonly workspaceNames: string[] },
        listener: (event: DesktopDaemonEvent) => void,
      ) => Promise<DesktopDaemonHostSubscriptionResult>
    >
  >;
  publish(event: DesktopDaemonEvent): void;
  readonly unsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

function fakeDaemonHost(
  fetchFleetCatalog: () => Promise<DesktopDaemonFetchFleetCatalogResult>,
  subscribeResult?: () => Promise<DesktopDaemonHostSubscriptionResult>,
): FakeDaemonHost {
  let listener: ((event: DesktopDaemonEvent) => void) | null = null;
  const unsubscribe = vi.fn<() => void>();
  const fetch = vi.fn(fetchFleetCatalog);
  const subscribe = vi.fn(async (_request, nextListener) => {
    listener = nextListener;
    return subscribeResult ? subscribeResult() : ({ status: "subscribed", unsubscribe } as const);
  });
  const preview = { code: "preview-only" as const, reason: "fixture only" };
  const daemon: HostCapabilities["daemon"] = {
    capabilities: async () => ({ status: "error", error: preview }),
    mutateAppWindow: async () => ({ status: "error", error: preview }),
    createWorkspacePane: async () => ({ status: "error", error: preview }),
    issueTerminalAttachment: async () => ({
      status: "error",
      error: { ...preview, retryable: false },
    }),
    refreshConnection: async () => ({
      outcome: "unchanged",
      daemon: { status: "connected", identity: DAEMON },
    }),
    listWorkspaces: async () => ({ status: "error", error: preview }),
    fetchFleetCatalog: fetch as HostCapabilities["daemon"]["fetchFleetCatalog"],
    promoteWorkspace: async () => ({ status: "error", error: preview }),
    fetchApplicationShell: async () => ({ status: "error", error: preview }),
    fetchWorkspaceFiles: async () => ({ status: "error", error: preview }),
    fetchWorkspaceFilePreview: async () => ({ status: "error", error: preview }),
    fetchWorkspaceChanges: async () => ({ status: "error", error: preview }),
    fetchWorkspaceChangeDiff: async () => ({ status: "error", error: preview }),
    subscribe,
  };
  return {
    host: { daemon },
    fetchFleetCatalog: fetch,
    subscribe,
    publish: (event) => listener?.(event),
    unsubscribe,
  };
}

async function publishLive(fake: FakeDaemonHost): Promise<void> {
  await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
  fake.publish({ type: "connection.changed", state: "live", error: null });
}

function collect(
  store: ReturnType<typeof createDesktopFleetCatalogStore>,
): DesktopFleetCatalogState[] {
  const states: DesktopFleetCatalogState[] = [];
  store.subscribe((state) => states.push(state));
  return states;
}

describe("createDesktopFleetCatalogStore", () => {
  it("loads a mixed fleet and goes live once the event socket verifies", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });

    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));

    const state = store.getState();
    expect(state.status === "live" && state.snapshot.catalog.sessions).toHaveLength(3);
    expect(state.snapshot?.catalog.sessions[0]?.agents[0]?.name).toBe("Claude");
    store.dispose();
  });

  it("reports a live but empty fleet", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: emptyFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });

    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    const state = store.getState();
    expect(state.snapshot?.catalog.sessions).toHaveLength(0);
    store.dispose();
  });

  it("is degraded when the daemon is unavailable, never fetching", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({
      host: fake.host,
      daemon: { status: "unavailable", code: "record-missing", reason: "owner not installed" },
    });
    const state = store.getState();
    expect(state.status).toBe("degraded");
    expect(state.status === "degraded" && state.code).toBe("daemon-unavailable");
    expect(fake.fetchFleetCatalog).not.toHaveBeenCalled();
    store.dispose();
  });

  it("surfaces a host error result as a request error before any snapshot", async () => {
    const fake = fakeDaemonHost(async () => ({
      status: "error",
      error: { code: "request-failed", reason: "boom" },
    }));
    const store = createDesktopFleetCatalogStore({
      host: fake.host,
      daemon: CONNECTED,
      retry: { maximumAttempts: 0 },
    });
    await vi.waitFor(() => expect(store.getState().status).toBe("error"));
    const state = store.getState();
    expect(state.status === "error" && state.code).toBe("retry-exhausted");
    store.dispose();
  });

  it("drops a response stamped by a superseded daemon generation", async () => {
    const fake = fakeDaemonHost(async () => ({
      // Envelope carries the OTHER daemon; the store is pinned to DAEMON.
      status: "ok",
      envelope: mixedFleetCatalog(OTHER_DAEMON),
    }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("degraded"));
    const state = store.getState();
    expect(state.status === "degraded" && state.code).toBe("daemon-identity-mismatch");
    expect(state.snapshot).toBeNull();
    store.dispose();
  });

  it("re-fetches on a fleet.changed invalidation", async () => {
    let call = 0;
    const fake = fakeDaemonHost(async () => {
      call += 1;
      const catalog = mixedFleetCatalog();
      return {
        status: "ok",
        envelope: call === 1 ? catalog : { ...catalog, sessions: catalog.sessions.slice(0, 1) },
      };
    });
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    expect(store.getState().snapshot?.catalog.sessions).toHaveLength(3);

    fake.publish({ type: "fleet.changed" });
    await vi.waitFor(() => expect(store.getState().snapshot?.catalog.sessions).toHaveLength(1));
    expect(fake.fetchFleetCatalog).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("re-fetches on a workspaces.changed invalidation (a promotion appeared)", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));

    fake.publish({ type: "workspaces.changed" });
    await vi.waitFor(() => expect(fake.fetchFleetCatalog).toHaveBeenCalledTimes(2));
    store.dispose();
  });

  it("holds the last snapshot as stale when events drop, then recovers live", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));

    fake.publish({
      type: "connection.changed",
      state: "degraded",
      error: { code: "event-unavailable", reason: "socket dropped" },
    });
    await vi.waitFor(() => expect(store.getState().status).toBe("stale"));
    expect(store.getState().snapshot?.catalog.sessions).toHaveLength(3);

    await vi.waitFor(() => expect(fake.subscribe.mock.calls.length).toBeGreaterThan(1));
    fake.publish({ type: "connection.changed", state: "live", error: null });
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    store.dispose();
  });

  it("re-pins to a new daemon generation and drops the old subscription", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));

    store.setDaemon({ status: "connected", identity: OTHER_DAEMON });
    expect(store.getState().status).toBe("loading");
    expect(fake.unsubscribe).toHaveBeenCalled();
    store.dispose();
    expect(store.getState().status).toBe("disposed");
  });

  it("notifies every subscriber and stops after dispose", async () => {
    const fake = fakeDaemonHost(async () => ({ status: "ok", envelope: mixedFleetCatalog() }));
    const store = createDesktopFleetCatalogStore({ host: fake.host, daemon: CONNECTED });
    const states = collect(store);
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    store.dispose();
    expect(states.at(-1)?.status).toBe("disposed");
  });
});
