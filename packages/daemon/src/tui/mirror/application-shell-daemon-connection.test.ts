import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  DAEMON_WIRE_PROTOCOL_VERSION,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV2,
} from "@tmux-ide/contracts";
import {
  createDirectLoopbackDaemonTransport,
  type TerminalFirstDaemonTransport,
} from "@tmux-ide/daemon-client/direct-application-shell-transport";
import { createWorkspaceClient } from "@tmux-ide/daemon-client/workspace-client";
import type {
  WorkspaceEventSocket,
  WorkspaceEventSocketEvent,
  WorkspaceEventSocketEventType,
  WorkspaceEventSocketListener,
} from "@tmux-ide/daemon-client/workspace-event-supervisor";

import {
  openTuiDaemonDescriptor,
  prepareOpenTuiApplicationShellConnection,
  resolveOpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnectionDependencies,
} from "./application-shell-daemon-connection.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-09T12:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-secret",
};

const catalog = {
  version: 2,
  daemon: {
    protocolVersion: daemon.protocolVersion,
    productVersion: daemon.productVersion,
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
  },
  intents: [
    {
      workspaceName: "workspace.alpha",
      sessionName: "alpha",
      source: "workspace",
      availability: "live",
    },
  ],
  liveSessions: [
    {
      sessionName: "alpha",
      fleetSessionId: "session.aaaaaaaaaaaaaaaaaaaa",
      paneCount: 1,
    },
  ],
} as WorkspaceCatalogResourceV2;

class FakeSemanticSocket implements WorkspaceEventSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<WorkspaceEventSocketEventType, Set<WorkspaceEventSocketListener>>();
  addEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {}
  emit(type: WorkspaceEventSocketEventType, event: WorkspaceEventSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  frame(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

class FakeRetryClock {
  #next = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  setTimeout = (callback: () => void, delayMs: number): number => {
    const handle = this.#next++;
    this.delays.push(delayMs);
    this.callbacks.set(handle, callback);
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };
  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No catalog retry is pending");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function transport(
  prepareTerminalRuntimeInventory = vi.fn(async () => ({
    resource: {
      workspaceName: "workspace.alpha",
      workspaceId: "workspace.0123456789abcdefabcd",
      sessionId: "session.0123456789abcdefabcd",
      resourceRevision: 0,
      semanticPaneIds: ["pane.alpha"],
    },
    consume: vi.fn(() => null),
    dispose: vi.fn(),
  })),
): TerminalFirstDaemonTransport {
  return {
    validateTarget: (value) => value as never,
    fetchApplicationShell: vi.fn(async () => ({ terminalInventory: { resources: [] } })) as never,
    connectEvents: () => ({ close: vi.fn() }),
    prepareTerminalRuntimeInventory,
    adoptTerminalRuntimeInventory: vi.fn(() => null),
    disposeEventSupervisor: vi.fn(),
    selectApplicationShellFallback: vi.fn(),
    refreshTerminalRuntimeInventory: vi.fn(),
    connectWorkspaceCatalog: vi.fn(() => ({ ready: Promise.resolve(), close: vi.fn() })),
  } as unknown as TerminalFirstDaemonTransport;
}

describe("OpenTUI canonical daemon connection", () => {
  it("derives an uncredentialed host descriptor", () => {
    expect(openTuiDaemonDescriptor(daemon)).toEqual({
      apiBaseUrl: "http://127.0.0.1:6060/",
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    });
  });

  it("resolves transport capabilities without constructing a client session", async () => {
    const baseTransport = transport();
    const createTransport = vi.fn(() => baseTransport);
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toMatchObject({
      workspaceName: "workspace.alpha",
      target: { workspaceName: "workspace.alpha" },
    });
    expect(connection?.transport.prepareTerminalRuntimeInventory).toBeTypeOf("function");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: openTuiDaemonDescriptor(daemon),
        ownerToken: "owner-secret",
        sessionName: "alpha",
        workspaceName: "workspace.alpha",
        applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      }),
    );
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty("terminalRuntimeDiagnostic");

    connection?.dispose();
    expect(() =>
      connection?.routing?.assertCurrent({
        daemonInstanceId: daemon.instanceId,
        workspaceName: "workspace.alpha",
        sessionName: "alpha",
      }),
    ).toThrow("has been retired");
  });

  it("waits for the catalog interest barrier before committing a fresh post-promotion catalog", async () => {
    let acknowledge!: () => void;
    const ready = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const close = vi.fn();
    const baseTransport = transport();
    baseTransport.connectWorkspaceCatalog = vi.fn(() => ({ ready, close }));
    const fetchCanonicalWorkspaceRouting = vi.fn(async () => catalog);
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting,
      createTransport: () => baseTransport,
    });
    const invalidate = vi.fn();
    const subscription = connection!.catalog.subscribe(connection!.target, invalidate);
    const reading = connection!.catalog.read(connection!.target, new AbortController().signal);
    await Promise.resolve();
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledTimes(1);
    acknowledge();
    await expect(reading).resolves.toBe(catalog);
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledTimes(2);
    expect(baseTransport.connectWorkspaceCatalog).toHaveBeenCalledWith(
      connection!.target,
      invalidate,
    );
    subscription.close();
    expect(close).toHaveBeenCalledOnce();
    connection!.dispose();
  });

  it("keeps WorkspaceClient catalog commits live on the semantic socket after shell fallback", async () => {
    const compatibleDaemon = { ...daemon, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION };
    const compatibleCatalog: WorkspaceCatalogResourceV2 = {
      ...catalog,
      daemon: {
        ...catalog.daemon,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      },
    };
    const sockets: FakeSemanticSocket[] = [];
    const socketUrls: string[] = [];
    const retryClock = new FakeRetryClock();
    const baseTransport = createDirectLoopbackDaemonTransport({
      descriptor: openTuiDaemonDescriptor(compatibleDaemon),
      ownerToken: compatibleDaemon.authToken,
      terminalRuntimeAuthority: true,
      resolveSessionName: () => "alpha",
      createWebSocket: (url) => {
        const socket = new FakeSemanticSocket();
        sockets.push(socket);
        socketUrls.push(url);
        return socket;
      },
      terminalReconnectClock: retryClock,
      fetch: async () => new Response("{}", { status: 503 }),
    }) as TerminalFirstDaemonTransport;
    const changedCatalog: WorkspaceCatalogResourceV2 = {
      ...compatibleCatalog,
      liveSessions: [{ ...compatibleCatalog.liveSessions[0]!, paneCount: 2 }],
    };
    let catalogReads = 0;
    const readCatalog = vi.fn(async () =>
      ++catalogReads >= 3 ? changedCatalog : compatibleCatalog,
    );
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => compatibleDaemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: readCatalog,
      createTransport: () => baseTransport,
    });
    const client = createWorkspaceClient({
      target: connection!.target,
      ports: {
        shell: connection!.transport,
        catalog: connection!.catalog,
        connectRuntime: async () => {
          throw new Error("terminal runtime is outside this catalog fallback proof");
        },
        actions: { dispatch: vi.fn() } as never,
      },
    });
    connection!.transport.connectEvents(connection!.target, {
      onVerifiedOpen: vi.fn(),
      onInvalidate: vi.fn(),
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    const socket = sockets[socketUrls.findIndex((url) => url.includes("mode=semantic"))]!;
    socket.emit("open");
    socket.frame({
      type: "hello",
      daemon: {
        protocolVersion: compatibleDaemon.protocolVersion,
        productVersion: compatibleDaemon.productVersion,
        instanceId: compatibleDaemon.instanceId,
        startedAt: compatibleDaemon.startedAt,
      },
      sessions: [],
      eventSequence: 0,
    });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    for (let attempt = 0; attempt < 3 && socket.sent.length < 2; attempt += 1) await tick();
    expect(socket.sent[1]).toMatchObject({
      interests: [
        { resource: "terminal-runtime-inventory" },
        { resource: "application-shell" },
        { resource: "workspace-catalog", workspaceName: null },
      ],
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(client.getSnapshot().catalog.liveSessions[0]?.paneCount).toBe(1);

    connection!.transport.selectApplicationShellFallback("deadline");
    await tick();
    expect(socket.sent[2]).toMatchObject({
      interests: [{ resource: "workspace-catalog", workspaceName: null }],
      interestRevision: 3,
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 3,
      sequence: 0,
      unavailableInterests: [],
    });
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: null,
      resource: "workspace-catalog",
      revision: 1,
      causeOperationId: null,
    });
    await tick();
    expect(client.getSnapshot().catalog.liveSessions[0]?.paneCount).toBe(2);
    const readsBeforeReconnect = catalogReads;
    socket.emit("close");
    expect(retryClock.callbacks.size).toBe(1);
    for (let failure = 0; failure < 2; failure += 1) {
      retryClock.runNext();
      await tick();
      const failed = sockets.at(-1)!;
      failed.emit("open");
      failed.frame({
        type: "hello",
        daemon: {
          protocolVersion: compatibleDaemon.protocolVersion,
          productVersion: compatibleDaemon.productVersion,
          instanceId: compatibleDaemon.instanceId,
          startedAt: compatibleDaemon.startedAt,
        },
        sessions: [],
        eventSequence: 0,
      });
      await tick();
      expect(failed.sent[0]).toMatchObject({
        interests: [{ resource: "workspace-catalog", workspaceName: null }],
      });
      failed.frame({
        type: "resource.interests-ack",
        interestRevision: 1,
        sequence: 0,
        unavailableInterests: [{ resource: "workspace-catalog", workspaceName: null }],
      });
      await tick();
      expect(retryClock.callbacks.size).toBe(1);
    }
    expect(retryClock.delays).toEqual([1_000, 2_000, 4_000]);
    retryClock.runNext();
    await tick();
    const replacement = sockets.at(-1)!;
    replacement.emit("open");
    replacement.frame({
      type: "hello",
      daemon: {
        protocolVersion: compatibleDaemon.protocolVersion,
        productVersion: compatibleDaemon.productVersion,
        instanceId: compatibleDaemon.instanceId,
        startedAt: compatibleDaemon.startedAt,
      },
      sessions: [],
      eventSequence: 0,
    });
    await tick();
    expect(replacement.sent[0]).toMatchObject({
      interests: [{ resource: "workspace-catalog", workspaceName: null }],
      interestRevision: 1,
    });
    replacement.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(catalogReads).toBeGreaterThan(readsBeforeReconnect);
    const readsBeforeDispose = catalogReads;
    await client.dispose();
    connection!.dispose();
    replacement.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: null,
      resource: "workspace-catalog",
      revision: 2,
      causeOperationId: null,
    });
    await tick();
    expect(catalogReads).toBe(readsBeforeDispose);
  });

  it("commits a fresh WorkspaceClient catalog after pre-ACK terminal retirement falls back", async () => {
    const compatibleDaemon = { ...daemon, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION };
    const compatibleCatalog: WorkspaceCatalogResourceV2 = {
      ...catalog,
      daemon: { ...catalog.daemon, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION },
    };
    const sockets: FakeSemanticSocket[] = [];
    const retryClock = new FakeRetryClock();
    const baseTransport = createDirectLoopbackDaemonTransport({
      descriptor: openTuiDaemonDescriptor(compatibleDaemon),
      ownerToken: compatibleDaemon.authToken,
      terminalRuntimeAuthority: true,
      terminalReconnectClock: retryClock,
      resolveSessionName: () => "alpha",
      createWebSocket: () => {
        const socket = new FakeSemanticSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async () => new Response("{}", { status: 503 }),
    }) as TerminalFirstDaemonTransport;
    let catalogReads = 0;
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => compatibleDaemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => {
        catalogReads += 1;
        return compatibleCatalog;
      },
      createTransport: () => baseTransport,
    });
    const client = createWorkspaceClient({
      target: connection!.target,
      ports: {
        shell: connection!.transport,
        catalog: connection!.catalog,
        connectRuntime: async () => {
          throw new Error("terminal runtime cannot commit in the fallback proof");
        },
        actions: { dispatch: vi.fn() } as never,
      },
    });
    const preparing = connection!.prepareTerminalRuntimeInventory();
    const first = sockets[0]!;
    first.emit("open");
    first.frame({
      type: "hello",
      daemon: {
        protocolVersion: compatibleDaemon.protocolVersion,
        productVersion: compatibleDaemon.productVersion,
        instanceId: compatibleDaemon.instanceId,
        startedAt: compatibleDaemon.startedAt,
      },
      sessions: [],
      eventSequence: 0,
    });
    await tick();
    expect(first.sent[0]).toMatchObject({
      interests: [{ resource: "terminal-runtime-inventory" }],
    });
    first.emit("close");
    await expect(preparing).resolves.toBeNull();
    expect(retryClock.callbacks.size).toBe(1);
    retryClock.runNext();
    await tick();
    const replacement = sockets[1]!;
    replacement.emit("open");
    replacement.frame({
      type: "hello",
      daemon: {
        protocolVersion: compatibleDaemon.protocolVersion,
        productVersion: compatibleDaemon.productVersion,
        instanceId: compatibleDaemon.instanceId,
        startedAt: compatibleDaemon.startedAt,
      },
      sessions: [],
      eventSequence: 0,
    });
    await tick();
    expect(replacement.sent[0]).toMatchObject({
      interests: [{ resource: "workspace-catalog", workspaceName: null }],
    });
    replacement.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(catalogReads).toBe(2);
    expect(client.getSnapshot().catalog).toMatchObject({
      daemonInstanceId: compatibleDaemon.instanceId,
      intents: [{ workspaceName: "workspace.alpha", availability: "live" }],
    });
    await client.dispose();
    connection!.dispose();
  });

  it("returns null before allocating a transport when the session is not live", async () => {
    const createTransport = vi.fn();
    const connection = await resolveOpenTuiApplicationShellConnection("missing", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("reconciles an already-routed warm session before preparing its connection", async () => {
    const isCanonicalDaemonAlive = vi.fn(async () => true);
    const fetchCanonicalWorkspaceRouting = vi.fn(async () => catalog);
    const ensureSessionWorkspace = vi.fn(async () => true);
    const createTransport = vi.fn(() => transport());

    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive,
      fetchCanonicalWorkspaceRouting,
      ensureSessionWorkspace,
      createTransport,
    });

    expect(prepared?.workspaceName).toBe("workspace.alpha");
    expect(isCanonicalDaemonAlive).toHaveBeenCalledOnce();
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledOnce();
    expect(ensureSessionWorkspace).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledOnce();
  });

  it("promotes an ordinary live session before resolving its new route", async () => {
    const fetchCanonicalWorkspaceRouting = vi.fn(async () => catalog);
    const ensureSessionWorkspace = vi.fn(async () => true);
    const createTransport = vi.fn(() => transport());

    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting,
      ensureSessionWorkspace,
      createTransport,
    });

    expect(prepared?.workspaceName).toBe("workspace.alpha");
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledOnce();
    expect(ensureSessionWorkspace).toHaveBeenCalledOnce();
    expect(ensureSessionWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      fetchCanonicalWorkspaceRouting.mock.invocationCallOrder[0]!,
    );
    expect(createTransport).toHaveBeenCalledOnce();
  });

  it("fails closed before route or transport allocation when reconciliation fails", async () => {
    const fetchCanonicalWorkspaceRouting = vi.fn(async () => catalog);
    const createTransport = vi.fn(() => transport());

    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting,
      ensureSessionWorkspace: async () => false,
      createTransport,
    });

    expect(prepared).toBeNull();
    expect(fetchCanonicalWorkspaceRouting).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("fails closed on stale routing without allocating a transport", async () => {
    const createTransport = vi.fn();
    const staleCatalog = {
      ...catalog,
      daemon: { ...catalog.daemon, instanceId: "22222222-2222-4222-8222-222222222222" },
    } satisfies WorkspaceCatalogResourceV2;

    await expect(
      resolveOpenTuiApplicationShellConnection("alpha", {
        readCanonicalDaemonInfo: () => daemon,
        isCanonicalDaemonAlive: async () => true,
        fetchCanonicalWorkspaceRouting: async () => staleCatalog,
        createTransport,
      }),
    ).resolves.toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("retains one terminal preparation and never starts V2 before the host decision", async () => {
    let preparationSignal!: AbortSignal;
    const prepare = vi.fn((_target, signal: AbortSignal) => {
      preparationSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const baseTransport = transport(prepare);
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(baseTransport.fetchApplicationShell).not.toHaveBeenCalled();
    expect(prepared!.prepareTerminalRuntimeInventory()).toBe(
      prepared!.prepareTerminalRuntimeInventory(),
    );
    prepared!.dispose();
    expect(preparationSignal.aborted).toBe(true);
    expect(baseTransport.disposeEventSupervisor).toHaveBeenCalledOnce();
  });

  it("fully selects V2 fallback after terminal preparation rejection", async () => {
    const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const lifecycleOrder: string[] = [];
    const baseTransport = transport(
      vi.fn(async () => {
        lifecycleOrder.push("preparation-started");
        throw new Error("unsupported");
      }),
    );
    baseTransport.selectApplicationShellFallback.mockImplementation(() => {
      lifecycleOrder.push("fallback-selected");
    });
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
      onDiagnostic: (phase, details) => {
        diagnostics.push({ phase, details });
        if (phase === "application-shell-prewarm-start") lifecycleOrder.push("start-marked");
        if (phase === "application-shell-prewarm-settled") lifecycleOrder.push("settled-marked");
        throw new Error("diagnostic sink failed");
      },
    });
    await expect(prepared!.prepareTerminalRuntimeInventory()).resolves.toBeNull();
    expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith(
      "preparation-rejected",
    );
    expect(diagnostics.at(-1)).toMatchObject({
      phase: "application-shell-prewarm-settled",
      details: { outcome: "rejected", fallbackReason: "preparation-rejected" },
    });
    expect(lifecycleOrder).toEqual([
      "preparation-started",
      "start-marked",
      "fallback-selected",
      "settled-marked",
    ]);
    prepared!.dispose();
  });

  it("reports the bounded deadline fallback reason without changing the one-second policy", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
      const baseTransport = transport(
        vi.fn(
          (_target, signal: AbortSignal) =>
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            ),
        ),
      );
      const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
        readCanonicalDaemonInfo: () => daemon,
        isCanonicalDaemonAlive: async () => true,
        fetchCanonicalWorkspaceRouting: async () => catalog,
        ensureSessionWorkspace: async () => true,
        createTransport: () => baseTransport,
        onDiagnostic: (phase, details) => diagnostics.push({ phase, details }),
      });
      const terminal = prepared!.prepareTerminalRuntimeInventory();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(terminal).resolves.toBeNull();
      expect(diagnostics.at(-1)).toMatchObject({
        phase: "application-shell-prewarm-settled",
        details: { outcome: "aborted", fallbackReason: "deadline" },
      });
      expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith("deadline");
      prepared!.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fully selects V2 fallback when terminal preparation is aborted", async () => {
    const prepare = vi.fn(
      (_target, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const baseTransport = transport(prepare);
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
    });
    prepared!.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith("retired");
  });

  it("emits bounded opt-in terminal preparation evidence without credentials", async () => {
    const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const createTransport: OpenTuiApplicationShellConnectionDependencies["createTransport"] = vi.fn(
      (options) => {
        options.terminalRuntimeDiagnostic?.("terminal-event-socket-create", {});
        return transport();
      },
    );
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport,
      onDiagnostic: (phase, details) => diagnostics.push({ phase, details }),
    });
    await prepared!.prepareTerminalRuntimeInventory();
    expect(diagnostics).toContainEqual({
      phase: "application-shell-prewarm-settled",
      details: {
        ordinal: 0,
        outcome: "fulfilled",
        resource: "terminal-runtime-inventory",
        daemonGeneration: daemon.instanceId,
      },
    });
    expect(diagnostics[0]).toEqual({ phase: "terminal-event-socket-create", details: {} });
    expect(JSON.stringify(diagnostics)).not.toContain(daemon.authToken);
    prepared!.dispose();
  });
});
