import { afterEach, expect, it, vi } from "vitest";
const stores = vi.hoisted(() => new Map<object, { publish(): void; disposed: boolean }>());
vi.mock("../../desktop-renderer/src/runtime/fleet-catalog-store", () => ({
  createDesktopFleetCatalogStore: ({
    host,
  }: {
    host: { testCatalog?: unknown; daemon: { testCatalog: unknown } };
  }) => {
    let callback = () => {};
    const value = { publish: () => callback(), disposed: false };
    stores.set(host.daemon ?? host, value);
    return {
      getState: () => ({
        status: "live",
        snapshot: {
          catalog: host.testCatalog ?? (host.daemon as { testCatalog: unknown }).testCatalog,
        },
      }),
      subscribe: (next: () => void) => {
        callback = next;
        return () => {
          callback = () => {};
        };
      },
      dispose: () => {
        value.disposed = true;
      },
    };
  },
}));
const identity = {
  instanceId: "daemon.same",
  environmentId: "env.same",
  protocolVersion: 1,
  productVersion: "test",
  startedAt: "2026-09-10T00:00:00Z",
};
const catalog = {
  version: 1,
  daemon: identity,
  sessions: [
    {
      sessionId: "same",
      label: "same",
      projectLabel: "same",
      appCreated: false,
      paneCount: 1,
      agents: [
        {
          agentId: "same",
          name: "Codex",
          harness: "codex",
          activity: "running",
          attention: false,
          statusSource: "authority",
        },
      ],
    },
  ],
};
function host() {
  const daemon = {
    testCatalog: catalog,
    fetchWorkspaceCatalog: vi.fn(async () => ({
      status: "ok",
      envelope: { daemon: identity, liveSessions: [], intents: [] },
    })),
  };
  return {
    daemon,
    bootstrap: vi.fn(async () => ({
      daemon: { status: "connected", identity },
      platform: "darwin",
    })),
    dispose: vi.fn(),
  };
}
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
  stores.clear();
  vi.resetModules();
});
async function setup(remote = host(), wait = true) {
  const local = host();
  let changed = () => {};
  let phase = "ready";
  const root = {
    ...local,
    environments: {
      list: vi.fn(async () => [
        {
          connectionId: "remote",
          label: "Remote",
          kind: "ssh",
          phase,
          daemon: { status: "connected", identity },
          failure: null,
        },
      ]),
      open: vi.fn(async () => remote),
      onChanged: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  };
  vi.stubGlobal("window", { tmuxIdeHost: root });
  vi.stubGlobal("navigator", { platform: "Mac" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const client = await import("./client");
  let latest: import("./client").LiveSnapshot | undefined;
  stops.push(
    client.subscribeWorkspace((value) => {
      latest = value;
    }),
  );
  if (wait) await vi.waitFor(() => expect(latest?.state.tabs).toHaveLength(2));
  return {
    client,
    root,
    remote,
    changed: () => changed(),
    snapshot: () => latest!,
    offline: async () => {
      phase = "disconnected";
      changed();
      await vi.waitFor(() =>
        expect(latest?.machines?.find((entry) => entry.connectionId === "remote")?.status).toBe(
          "offline",
        ),
      );
    },
  };
}
it("routes identical daemon/session IDs independently and keeps local healthy after remote outage", async () => {
  const test = await setup();
  const before = test.snapshot().state;
  expect(new Set(before.tabs.map((tab) => tab.id)).size).toBe(2);
  expect(test.client.getHost("remote").daemon).not.toBe(test.client.getHost("local").daemon);
  expect(() => test.client.getHost("unknown")).toThrow();
  const localTab = before.tabs.find((tab) => tab.connectionId === "local")!.id;
  await test.offline();
  expect(test.snapshot().connection).toBe("paired");
  expect(test.snapshot().state.tabs.find((tab) => tab.connectionId === "local")!.id).toBe(localTab);
  expect(test.snapshot().state.tabs).toHaveLength(2);
  expect(() => test.client.getHost("remote")).toThrow();
  expect(test.remote.dispose).toHaveBeenCalledOnce();
});
it("drops a retired store completion and requires explicit retry without a ready-state change", async () => {
  const test = await setup();
  const old = stores.get(test.client.getHost("remote").daemon)!;
  await test.offline();
  const revision = test.snapshot().state.revision;
  old.publish();
  expect(test.snapshot().state.revision).toBe(revision);
  test.client.retryConnection("remote");
  await vi.waitFor(() => expect(test.root.environments.open).toHaveBeenCalledTimes(2));
});

it("drops bootstrap completions after the last subscriber disposes", async () => {
  const remote = host();
  let resolve!: (value: Awaited<ReturnType<typeof remote.bootstrap>>) => void;
  const gate = {
    promise: new Promise<Awaited<ReturnType<typeof remote.bootstrap>>>((done) => {
      resolve = done;
    }),
    resolve: (value: Awaited<ReturnType<typeof remote.bootstrap>>) => resolve(value),
  };
  remote.bootstrap.mockReturnValue(gate.promise);
  const test = await setup(remote, false);
  await vi.waitFor(() => expect(remote.bootstrap).toHaveBeenCalled());
  stops.pop()?.();
  const revision = test.snapshot().state.revision;
  gate.resolve({ daemon: { status: "connected", identity }, platform: "darwin" });
  await new Promise((done) => setTimeout(done, 0));
  expect(test.snapshot().state.revision).toBe(revision);
  expect(remote.dispose).toHaveBeenCalledOnce();
});

it("reuses the verified bootstrap per connection and blocks local project actions on remote", async () => {
  const test = await setup();
  const local = test.client.getHost("local");
  const remote = test.client.getHost("remote");
  await Promise.all([local.bootstrap(), local.bootstrap(), remote.bootstrap(), remote.bootstrap()]);
  expect(test.root.bootstrap).toHaveBeenCalledOnce();
  expect(test.remote.bootstrap).toHaveBeenCalledOnce();
  await expect(remote.workspace.openProjectDirectory()).rejects.toThrow("unavailable for remote");
  await expect(remote.workspace.prepareProjectDirectory?.()).rejects.toThrow(
    "unavailable for remote",
  );
  await expect(remote.workspace.commitPreparedOpen?.({} as never)).rejects.toThrow(
    "unavailable for remote",
  );
  await expect(remote.workspace.cancelPreparedOpen?.({} as never)).rejects.toThrow(
    "unavailable for remote",
  );
  await test.offline();
  await expect(remote.bootstrap()).rejects.toThrow("retired");
  test.client.retryConnection("remote");
  await vi.waitFor(() => expect(test.remote.bootstrap).toHaveBeenCalledTimes(2));
});

it.each(["instanceId", "environmentId"] as const)(
  "replaces only local when its verified %s changes",
  async (field) => {
    const test = await setup();
    const remoteHost = test.client.getHost("remote");
    const remoteStore = stores.get(test.client.getHost("remote").daemon)!;
    const next = { ...identity, [field]: "replacement" };
    test.root.bootstrap.mockResolvedValue({
      daemon: { status: "connected", identity: next },
      platform: "darwin",
    });
    test.root.daemon.testCatalog = { ...catalog, daemon: next };
    test.root.daemon.fetchWorkspaceCatalog.mockResolvedValue({
      status: "ok",
      envelope: { daemon: next, liveSessions: [], intents: [] },
    });
    test.root.environments.list.mockResolvedValue([
      {
        connectionId: "catalog-local",
        label: "Local",
        kind: "local-canonical",
        phase: "ready",
        daemon: { status: "connected", identity: next },
        failure: null,
      },
      {
        connectionId: "remote",
        label: "Remote",
        kind: "ssh",
        phase: "ready",
        daemon: { status: "connected", identity },
        failure: null,
      },
    ]);
    test.changed();
    await vi.waitFor(() => expect(test.root.bootstrap).toHaveBeenCalledTimes(2));
    expect(test.client.getHost("remote")).toBe(remoteHost);
    expect(remoteStore.disposed).toBe(false);
    expect(test.remote.bootstrap).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(
        test.snapshot().machines?.find((machine) => machine.connectionId === "local")?.status,
      ).toBe("paired"),
    );
  },
);

it("marks only local offline on host notification and preserves its catalog", async () => {
  const test = await setup();
  const localTabs = test.snapshot().state.tabs.filter((tab) => tab.connectionId === "local");
  test.root.environments.list.mockResolvedValue([
    {
      connectionId: "catalog-local",
      label: "Local",
      kind: "local-canonical",
      phase: "disconnected",
      daemon: { status: "connected", identity },
      failure: null,
    },
    {
      connectionId: "remote",
      label: "Remote",
      kind: "ssh",
      phase: "ready",
      daemon: { status: "connected", identity },
      failure: null,
    },
  ]);
  test.changed();
  await vi.waitFor(() =>
    expect(
      test.snapshot().machines?.find((machine) => machine.connectionId === "local")?.status,
    ).toBe("offline"),
  );
  expect(
    test
      .snapshot()
      .state.tabs.filter((tab) => tab.connectionId === "local")
      .map((tab) => tab.id),
  ).toEqual(localTabs.map((tab) => tab.id));
  expect(test.snapshot().connection).toBe("paired");
  expect(test.remote.dispose).not.toHaveBeenCalled();
});

it("bridges cancellation with own function properties instead of AbortSignal prototypes", async () => {
  const test = await setup();
  const controller = new AbortController();
  const adapted = test.client.bridgeAbortSignal(controller.signal);
  const copied = { ...adapted };
  const cancelled = vi.fn();
  const stop = copied.subscribeAbort(cancelled);
  controller.abort();
  expect(cancelled).toHaveBeenCalledOnce();
  stop();
});
