import { createRoot } from "solid-js";
import {
  DESKTOP_HOST_API_VERSION,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityState,
  type DesktopDaemonEvent,
  type DesktopDaemonHostSubscriptionResult,
  type DesktopDaemonListWorkspacesResult,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDesktopWorkspaceCatalogStore,
  createSolidDesktopWorkspaceCatalogStore,
  type DesktopWorkspaceCatalogState,
} from "./workspace-catalog-store.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};

const NEXT_DAEMON: DaemonInstanceIdentity = {
  ...DAEMON,
  instanceId: "66ab67ed-18fe-431b-913b-70972b78c96f",
  startedAt: "2026-07-22T00:00:00.000Z",
};

const CONNECTED = {
  status: "connected",
  identity: DAEMON,
} satisfies DesktopDaemonCapabilityState;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

function catalog(
  names: readonly string[],
  daemon: DaemonInstanceIdentity = DAEMON,
): DesktopDaemonListWorkspacesResult {
  return {
    status: "ok",
    daemon,
    workspaces: names.map((workspaceName) => ({ workspaceName })),
  };
}

interface FakeDaemonHost {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly listWorkspaces: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
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
  listWorkspaces: () => Promise<unknown>,
  subscribeResult?: () => Promise<DesktopDaemonHostSubscriptionResult>,
): FakeDaemonHost {
  let listener: ((event: DesktopDaemonEvent) => void) | null = null;
  const unsubscribe = vi.fn<() => void>();
  const list = vi.fn(listWorkspaces);
  const subscribe = vi.fn(async (request, nextListener) => {
    listener = nextListener;
    return subscribeResult ? subscribeResult() : ({ status: "subscribed", unsubscribe } as const);
  });
  const daemon: HostCapabilities["daemon"] = {
    createWorkspacePane: async () => ({
      status: "error",
      error: { code: "preview-only", reason: "fixture only" },
    }),
    issueTerminalAttachment: async () => ({
      status: "error",
      error: { code: "preview-only", reason: "fixture only", retryable: false },
    }),
    refreshConnection: async () => ({
      outcome: "unchanged",
      daemon: { status: "connected", identity: DAEMON },
    }),
    listWorkspaces: list as HostCapabilities["daemon"]["listWorkspaces"],
    fetchApplicationShell: async () => ({
      status: "error",
      error: { code: "preview-only", reason: "not used by catalog tests" },
    }),
    subscribe,
  };
  return {
    host: { daemon },
    listWorkspaces: list,
    subscribe,
    publish: (event) => listener?.(event),
    unsubscribe,
  };
}

async function publishLive(fake: FakeDaemonHost): Promise<void> {
  await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
  fake.publish({ type: "connection.changed", state: "live", error: null });
}

function liveSnapshot(state: DesktopWorkspaceCatalogState) {
  expect(state.status).toBe("live");
  if (state.status !== "live") throw new Error("catalog was not live");
  return state.snapshot;
}

describe("desktop live workspace catalog and selection store", () => {
  it.each([
    {
      label: "zero",
      names: [] as string[],
      view: "onboarding",
      workspaceName: null,
      reason: "no-live-workspaces",
    },
    {
      label: "one",
      names: ["only"],
      view: "workspace",
      workspaceName: "only",
      reason: "only-live-workspace",
    },
    {
      label: "many",
      names: ["zeta", "alpha"],
      view: "chooser",
      workspaceName: null,
      reason: "multiple-live-workspaces",
    },
  ])("projects $label catalogs without choosing an arbitrary first workspace", async (example) => {
    const fake = fakeDaemonHost(async () => catalog(example.names));
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));

    const snapshot = liveSnapshot(store.getState());
    expect(snapshot.workspaces.map(({ workspaceName }) => workspaceName)).toEqual(
      [...example.names].sort(),
    );
    expect(snapshot.selection).toEqual({
      view: example.view,
      workspaceName: example.workspaceName,
      reason: example.reason,
    });
    expect(fake.subscribe).toHaveBeenCalledWith({ workspaceNames: [] }, expect.any(Function));
    store.dispose();
  });

  it.each(["startup", "persisted"] as const)(
    "validates a trusted %s selection against the stamped catalog before selecting it",
    async (source) => {
      const pending = deferred<DesktopDaemonListWorkspacesResult>();
      const fake = fakeDaemonHost(() => pending.promise);
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        initialSelection: { source, workspaceName: "docs" },
      });
      expect(store.getState()).toMatchObject({ status: "loading", snapshot: null });
      pending.resolve(catalog(["app", "docs"]));
      await publishLive(fake);
      await vi.waitFor(() => expect(store.getState().status).toBe("live"));
      expect(liveSnapshot(store.getState()).selection).toEqual({
        view: "workspace",
        workspaceName: "docs",
        reason: source,
      });
      store.dispose();
    },
  );

  it.each([
    { source: "startup" as const, workspaceName: " docs ", reason: "startup-selection-invalid" },
    {
      source: "persisted" as const,
      workspaceName: "missing",
      reason: "persisted-selection-not-found",
    },
  ])("does not alias or silently replace an invalid $source selection", async (seed) => {
    const fake = fakeDaemonHost(async () => catalog(["docs", "app"]));
    const store = createDesktopWorkspaceCatalogStore({
      host: fake.host,
      daemon: CONNECTED,
      initialSelection: seed,
    });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    expect(liveSnapshot(store.getState()).selection).toEqual({
      view: "chooser",
      workspaceName: null,
      reason: seed.reason,
    });
    store.dispose();
  });

  it("preserves an exact explicit selection, then clears it on removal without switching", async () => {
    const responses = [catalog(["app", "docs"]), catalog(["app", "docs"]), catalog(["app"])];
    const fake = fakeDaemonHost(async () => responses.shift()!);
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    expect(store.select("docs")).toBe(true);
    expect(liveSnapshot(store.getState()).selection).toMatchObject({
      workspaceName: "docs",
      reason: "explicit",
    });

    fake.publish({ type: "workspaces.changed" });
    await vi.waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(liveSnapshot(store.getState()).selection.workspaceName).toBe("docs"),
    );
    fake.publish({ type: "workspaces.changed" });
    await vi.waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(liveSnapshot(store.getState()).selection).toEqual({
        view: "chooser",
        workspaceName: null,
        reason: "selected-workspace-removed",
      }),
    );
    expect(store.select(" missing ")).toBe(false);
    expect(liveSnapshot(store.getState()).selection.workspaceName).toBeNull();
    store.dispose();
  });

  it("ignores a late old-generation response and revalidates the prior exact selection", async () => {
    const oldResponse = deferred<DesktopDaemonListWorkspacesResult>();
    let currentDaemon = DAEMON;
    const fake = fakeDaemonHost(async () =>
      currentDaemon === DAEMON ? oldResponse.promise : catalog(["docs", "other"], NEXT_DAEMON),
    );
    const store = createDesktopWorkspaceCatalogStore({
      host: fake.host,
      daemon: CONNECTED,
      initialSelection: { source: "startup", workspaceName: "docs" },
    });
    currentDaemon = NEXT_DAEMON;
    store.setDaemon({ status: "connected", identity: NEXT_DAEMON });
    oldResponse.resolve(catalog(["wrong"]));
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(2));
    fake.publish({ type: "connection.changed", state: "live", error: null });
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    const snapshot = liveSnapshot(store.getState());
    expect(snapshot.daemon).toEqual(NEXT_DAEMON);
    expect(snapshot.workspaces.map(({ workspaceName }) => workspaceName)).toEqual([
      "docs",
      "other",
    ]);
    expect(snapshot.selection).toEqual({
      view: "workspace",
      workspaceName: "docs",
      reason: "startup",
    });
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it.each([
    { name: "padded", raw: catalog([" docs "]) },
    { name: "duplicate", raw: catalog(["docs", "docs"]) },
    {
      name: "secret-bearing",
      raw: { ...catalog(["docs"]), token: "top-secret", projectDir: "/private/secret" },
    },
  ])("rejects a $name catalog without reflecting untrusted details", async ({ raw }) => {
    const fake = fakeDaemonHost(async () => raw);
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    await vi.waitFor(() => expect(store.getState().status).toBe("degraded"));
    expect(store.getState()).toMatchObject({
      status: "degraded",
      code: "invalid-response",
      reason: "Desktop host returned an invalid workspace catalog.",
    });
    expect(JSON.stringify(store.getState())).not.toMatch(/top-secret|private|token/iu);
    store.dispose();
  });

  it("rejects a catalog stamped by another daemon generation", async () => {
    const fake = fakeDaemonHost(async () => catalog(["docs"], NEXT_DAEMON));
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    await vi.waitFor(() => expect(store.getState().status).toBe("degraded"));
    expect(store.getState()).toMatchObject({
      code: "daemon-identity-mismatch",
      reason: "Workspace catalog came from another daemon generation.",
    });
    store.dispose();
  });

  it.each([
    {
      label: "daemon-generation mismatch",
      terminalCatalog: catalog(["docs"], NEXT_DAEMON),
      code: "daemon-identity-mismatch" as const,
      recovery: "refresh" as const,
    },
    {
      label: "daemon-generation mismatch",
      terminalCatalog: catalog(["docs"], NEXT_DAEMON),
      code: "daemon-identity-mismatch" as const,
      recovery: "setDaemon" as const,
    },
    {
      label: "malformed response",
      terminalCatalog: catalog([" docs "]),
      code: "invalid-response" as const,
      recovery: "refresh" as const,
    },
    {
      label: "malformed response",
      terminalCatalog: catalog([" docs "]),
      code: "invalid-response" as const,
      recovery: "setDaemon" as const,
    },
  ])(
    "does not let a late pending subscription recover after a terminal $label until $recovery",
    async ({ terminalCatalog, code, recovery }) => {
      vi.useFakeTimers();
      try {
        const terminalResponse = deferred<DesktopDaemonListWorkspacesResult>();
        const pendingSubscription = deferred<DesktopDaemonHostSubscriptionResult>();
        const retiredUnsubscribe = vi.fn<() => void>();
        let catalogRequests = 0;
        let subscriptionAttempts = 0;
        const fake = fakeDaemonHost(
          () => {
            catalogRequests += 1;
            if (catalogRequests === 1) return Promise.resolve(catalog(["docs"]));
            if (catalogRequests === 2) return terminalResponse.promise;
            return Promise.resolve(catalog(["docs"]));
          },
          () => {
            subscriptionAttempts += 1;
            return subscriptionAttempts === 1
              ? pendingSubscription.promise
              : Promise.resolve({
                  status: "subscribed",
                  unsubscribe: () => fake.unsubscribe(),
                });
          },
        );
        const store = createDesktopWorkspaceCatalogStore({
          host: fake.host,
          daemon: CONNECTED,
          retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.getState()).toMatchObject({ status: "stale", snapshot: {} });
        const retiredListener = fake.subscribe.mock.calls[0]![1];

        // Explicit recovery while subscribe() is pending requests a restart,
        // then the catalog proves that this generation cannot be trusted.
        store.refresh();
        terminalResponse.resolve(terminalCatalog);
        await vi.advanceTimersByTimeAsync(0);
        expect(store.getState()).toMatchObject({ status: "degraded", code });

        pendingSubscription.resolve({
          status: "subscribed",
          unsubscribe: () => retiredUnsubscribe(),
        });
        await vi.advanceTimersByTimeAsync(0);
        retiredListener({ type: "connection.changed", state: "live", error: null });
        await vi.advanceTimersByTimeAsync(100);
        expect(retiredUnsubscribe).toHaveBeenCalledOnce();
        expect(fake.subscribe).toHaveBeenCalledOnce();
        expect(store.getState()).toMatchObject({ status: "degraded", code });

        // Only an explicit same-generation recovery may reopen after this
        // terminal catalog boundary.
        if (recovery === "refresh") store.refresh();
        else store.setDaemon(CONNECTED);
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.subscribe).toHaveBeenCalledTimes(2);
        fake.publish({ type: "connection.changed", state: "live", error: null });
        expect(store.getState().status).toBe("live");
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("queues explicit terminal recovery behind the unresolved retired subscription", async () => {
    vi.useFakeTimers();
    try {
      const pendingSubscription = deferred<DesktopDaemonHostSubscriptionResult>();
      const retiredUnsubscribe = vi.fn<() => void>();
      let catalogRequests = 0;
      let subscriptionAttempts = 0;
      const fake = fakeDaemonHost(
        () => {
          catalogRequests += 1;
          return Promise.resolve(
            catalogRequests === 1 ? catalog(["docs"], NEXT_DAEMON) : catalog(["docs"]),
          );
        },
        () => {
          subscriptionAttempts += 1;
          return subscriptionAttempts === 1
            ? pendingSubscription.promise
            : Promise.resolve({
                status: "subscribed",
                unsubscribe: () => fake.unsubscribe(),
              });
        },
      );
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({
        status: "degraded",
        code: "daemon-identity-mismatch",
      });
      const retiredListener = fake.subscribe.mock.calls[0]![1];

      store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.subscribe).toHaveBeenCalledOnce();
      retiredListener({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).not.toBe("live");

      pendingSubscription.resolve({
        status: "subscribed",
        unsubscribe: () => retiredUnsubscribe(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(retiredUnsubscribe).toHaveBeenCalledOnce();
      expect(fake.subscribe).toHaveBeenCalledOnce();
      retiredListener({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).not.toBe("live");

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.subscribe).toHaveBeenCalledTimes(2);
      fake.publish({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).toBe("live");
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns one catalog subscription, refetches on invalidation, and disposes late work", async () => {
    const pendingRefresh = deferred<DesktopDaemonListWorkspacesResult>();
    const lateSubscription = deferred<DesktopDaemonHostSubscriptionResult>();
    const unsubscribe = vi.fn();
    let calls = 0;
    const fake = fakeDaemonHost(
      async () => (++calls === 1 ? catalog(["docs", "app"]) : pendingRefresh.promise),
      () => lateSubscription.promise,
    );
    const observed: DesktopWorkspaceCatalogState[] = [];
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    store.subscribe((next) => observed.push(next));
    await vi.waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
    fake.publish({ type: "workspaces.changed" });
    await vi.waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledTimes(2));
    store.dispose();
    lateSubscription.resolve({ status: "subscribed", unsubscribe });
    pendingRefresh.resolve(catalog(["late"]));
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect(store.getState().status).toBe("disposed");
    expect(observed.at(-1)?.status).toBe("disposed");
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.getState())).not.toMatch(/late|sessionName|apiBaseUrl|token/iu);
  });

  it("keeps browser-preview/unavailable hosts no-network and reports the boundary", () => {
    const fake = fakeDaemonHost(async () => catalog(["must-not-load"]));
    const store = createDesktopWorkspaceCatalogStore({
      host: fake.host,
      daemon: {
        status: "unavailable",
        code: "preview-only",
        reason: "Browser preview does not attach to the desktop daemon.",
      },
    });
    expect(store.getState()).toMatchObject({
      status: "degraded",
      code: "daemon-unavailable",
      reason: "Browser preview does not attach to the desktop daemon.",
    });
    expect(fake.listWorkspaces).not.toHaveBeenCalled();
    expect(fake.subscribe).not.toHaveBeenCalled();
    store.dispose();
  });

  it("bounds transient request retries without reconnecting the host event subscription", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDaemonHost(async () => ({
        status: "error",
        error: { code: "request-failed", reason: "Catalog request unavailable." },
      }));
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(fake.listWorkspaces).toHaveBeenCalledTimes(3);
      expect(fake.subscribe).toHaveBeenCalledOnce();
      expect(store.getState()).toMatchObject({ status: "error", code: "retry-exhausted" });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["result error", "promise rejection"] as const)(
    "recovers a failed initial event subscription after a %s on the same daemon generation",
    async (failure) => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        const fake = fakeDaemonHost(
          async () => catalog(["docs"]),
          async () => {
            attempts += 1;
            if (attempts > 1) {
              return { status: "subscribed", unsubscribe: () => fake.unsubscribe() };
            }
            if (failure === "promise rejection") throw new Error("private host rejection");
            return {
              status: "error",
              error: { code: "event-unavailable", reason: "Catalog events unavailable." },
            };
          },
        );
        const store = createDesktopWorkspaceCatalogStore({
          host: fake.host,
          daemon: CONNECTED,
          retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.subscribe).toHaveBeenCalledOnce();
        expect(store.getState().status).not.toBe("live");

        await vi.advanceTimersByTimeAsync(10);
        expect(fake.subscribe).toHaveBeenCalledTimes(2);
        fake.publish({ type: "connection.changed", state: "live", error: null });
        expect(store.getState().status).toBe("live");
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { label: "physical close/error", code: "event-unavailable" as const },
    { label: "protocol failure", code: "protocol-error" as const },
    { label: "malformed frame", code: "invalid-response" as const },
    { label: "peer mismatch", code: "daemon-identity-mismatch" as const },
  ])("retires and recovers its logical subscription after a $label", async ({ code }) => {
    vi.useFakeTimers();
    try {
      const fake = fakeDaemonHost(async () => catalog(["docs"]));
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const retiredListener = fake.subscribe.mock.calls[0]![1];
      fake.publish({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).toBe("live");

      fake.publish({
        type: "connection.changed",
        state: "degraded",
        error: { code, reason: "Bounded event failure." },
      });
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
      expect(store.getState().status).not.toBe("live");
      await vi.advanceTimersByTimeAsync(10);
      expect(fake.subscribe).toHaveBeenCalledTimes(2);
      fake.publish({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).toBe("live");

      const catalogCalls = fake.listWorkspaces.mock.calls.length;
      retiredListener({ type: "workspaces.changed" });
      retiredListener({
        type: "connection.changed",
        state: "degraded",
        error: { code: "event-unavailable", reason: "late callback" },
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(fake.listWorkspaces).toHaveBeenCalledTimes(catalogCalls);
      expect(fake.subscribe).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["setDaemon", "refresh"] as const)(
    "uses %s as an explicit same-generation event recovery boundary",
    async (action) => {
      let attempts = 0;
      const fake = fakeDaemonHost(
        async () => catalog(["docs"]),
        async () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: "error",
                error: { code: "event-unavailable", reason: "Initial subscription unavailable." },
              }
            : { status: "subscribed", unsubscribe: () => fake.unsubscribe() };
        },
      );
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { maximumAttempts: 0 },
      });
      await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(store.getState()).toMatchObject({
          reason: "Daemon catalog event recovery attempts were exhausted.",
        }),
      );

      if (action === "setDaemon") store.setDaemon(CONNECTED);
      else store.refresh();
      await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(2));
      fake.publish({ type: "connection.changed", state: "live", error: null });
      await vi.waitFor(() => expect(store.getState().status).toBe("live"));
      expect(store.getState().generation).toBe(1);
      store.dispose();
    },
  );

  it("does not overlap a pending logical subscription during explicit same-generation recovery", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<DesktopDaemonHostSubscriptionResult>();
      const lateUnsubscribe = vi.fn();
      let attempts = 0;
      const fake = fakeDaemonHost(
        async () => catalog(["docs"]),
        () => {
          attempts += 1;
          return attempts === 1
            ? pending.promise
            : Promise.resolve({ status: "subscribed", unsubscribe: () => fake.unsubscribe() });
        },
      );
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);
      store.refresh();
      store.setDaemon(CONNECTED);
      expect(fake.subscribe).toHaveBeenCalledOnce();

      pending.resolve({ status: "subscribed", unsubscribe: () => lateUnsubscribe() });
      await vi.advanceTimersByTimeAsync(0);
      expect(lateUnsubscribe).toHaveBeenCalledOnce();
      expect(fake.subscribe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(fake.subscribe).toHaveBeenCalledTimes(2);
      fake.publish({ type: "connection.changed", state: "live", error: null });
      expect(store.getState().status).toBe("live");
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds same-generation event recovery and can be disposed with a retry pending", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDaemonHost(
        async () => catalog(["docs"]),
        async () => ({
          status: "error",
          error: { code: "protocol-error", reason: "Subscription rejected." },
        }),
      );
      const store = createDesktopWorkspaceCatalogStore({
        host: fake.host,
        daemon: CONNECTED,
        retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.subscribe).toHaveBeenCalledTimes(3);
      expect(store.getState()).toMatchObject({
        reason: "Daemon catalog event recovery attempts were exhausted.",
      });
      store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.subscribe).toHaveBeenCalledTimes(4);
      store.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.subscribe).toHaveBeenCalledTimes(4);
      expect(store.getState().status).toBe("disposed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates observer and host teardown exceptions after making disposal irrevocable", async () => {
    const unsubscribe = vi.fn(() => {
      throw new Error("private host teardown failure");
    });
    const fake = fakeDaemonHost(
      async () => catalog(["docs"]),
      async () => ({
        status: "subscribed",
        unsubscribe,
      }),
    );
    const store = createDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    const observed: string[] = [];
    expect(() =>
      store.subscribe(() => {
        throw new Error("private observer failure");
      }),
    ).not.toThrow();
    store.subscribe((next) => {
      observed.push(next.status);
      if (next.status === "disposed") {
        store.refresh();
        store.setDaemon(CONNECTED);
        throw new Error("observer attempted re-entry");
      }
    });
    await publishLive(fake);
    await vi.waitFor(() => expect(store.getState().status).toBe("live"));
    const requestCalls = fake.listWorkspaces.mock.calls.length;
    expect(() => store.dispose()).not.toThrow();
    expect(store.getState().status).toBe("disposed");
    expect(observed.at(-1)).toBe("disposed");
    expect(fake.listWorkspaces).toHaveBeenCalledTimes(requestCalls);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("adapts the pure store to Solid and disposes with its owner", async () => {
    const fake = fakeDaemonHost(async () => catalog(["docs"]));
    let disposeOwner!: () => void;
    let solidStore!: ReturnType<typeof createSolidDesktopWorkspaceCatalogStore>;
    createRoot((dispose) => {
      disposeOwner = dispose;
      solidStore = createSolidDesktopWorkspaceCatalogStore({ host: fake.host, daemon: CONNECTED });
    });
    await publishLive(fake);
    await vi.waitFor(() => expect(solidStore.state().status).toBe("live"));
    expect(liveSnapshot(solidStore.state()).selection.reason).toBe("only-live-workspace");
    disposeOwner();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("workspace catalog host contract seam", () => {
  it("uses the current versioned facade without exposing a generic transport", () => {
    expect(DESKTOP_HOST_API_VERSION).toBe(5);
  });
});
