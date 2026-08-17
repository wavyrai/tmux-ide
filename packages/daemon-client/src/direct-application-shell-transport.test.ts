import { describe, expect, it } from "bun:test";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  DAEMON_WIRE_PROTOCOL_VERSION,
  ApplicationShellProjectionInputV2SchemaZ,
  COHESION_FIXTURE_V1,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
} from "@tmux-ide/contracts";

import {
  createDirectLoopbackDaemonTransport,
  type TerminalFirstDaemonTransport,
} from "./direct-application-shell-transport.ts";
import type {
  WorkspaceEventSocket,
  WorkspaceEventSocketEvent,
  WorkspaceEventSocketEventType,
  WorkspaceEventSocketListener,
  WorkspaceEventSocketOptions,
} from "./workspace-event-supervisor.ts";

const daemon = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-09T12:00:00.000Z",
};

const descriptor: DesktopDaemonHostDescriptor = {
  ...daemon,
  apiBaseUrl: "http://127.0.0.1:6060/",
};

const target: DesktopApplicationShellTarget = {
  daemon,
  workspaceName: "workspace.alpha",
};

const terminalFirstResource = ApplicationShellProjectionInputV2SchemaZ.parse({
  project: COHESION_FIXTURE_V1.project,
  workspace: {
    ...COHESION_FIXTURE_V1.workspace,
    sidebar: {
      ...COHESION_FIXTURE_V1.workspace.sidebar,
      agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
        ...agent,
        paneId: null,
      })),
    },
  },
  dock: COHESION_FIXTURE_V1.dock,
  focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
  connection: COHESION_FIXTURE_V1.connection,
  terminalInventory: {
    activeResourceId: "pane.worker",
    resources: [
      {
        id: "pane.worker",
        title: "Worker",
        kind: "terminal",
        active: true,
        attachability: { status: "available", semanticPaneId: "pane.worker" },
      },
    ],
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeSocket implements WorkspaceEventSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<WorkspaceEventSocketEventType, Set<WorkspaceEventSocketListener>>();
  addEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
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

class FakeReconnectClock {
  #next = 1;
  readonly callbacks = new Map<number, () => void>();
  setTimeout = (callback: () => void): number => {
    const handle = this.#next++;
    this.callbacks.set(handle, callback);
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };
  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No reconnect timer is pending");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("direct application-shell transport version selection", () => {
  it("uses owner-authenticated terminal and application-shell barriers on one socket", async () => {
    const socket = new FakeSocket();
    const socketUrls: string[] = [];
    const socketOptions: Array<WorkspaceEventSocketOptions | undefined> = [];
    const requests: URL[] = [];
    const diagnostics: string[] = [];
    const diagnosticActionStates: string[] = [];
    let fallbackListenerCount: number | null = null;
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken: "owner-secret",
      resolveSessionName: () => "alpha",
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      terminalRuntimeAuthority: true,
      terminalRuntimeDiagnostic: (phase) => {
        diagnostics.push(phase);
        diagnosticActionStates.push(
          `${phase}:${socketOptions.length}:${socket.sent.length}:${requests.length}`,
        );
        if (phase === "terminal-fallback-selected") {
          fallbackListenerCount = socket.listeners.get("message")?.size ?? 0;
        }
        throw new Error("diagnostic sink failed");
      },
      createWebSocket: (url, options) => {
        socketUrls.push(url);
        socketOptions.push(options);
        return socket;
      },
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.pathname.endsWith("/terminal-runtime-inventory")) {
          return json({
            version: 1,
            daemon,
            resource: {
              workspaceName: "workspace.alpha",
              workspaceId: "workspace.0123456789abcdefabcd",
              sessionId: "session.0123456789abcdefabcd",
              resourceRevision: 0,
              semanticPaneIds: ["pane.worker"],
            },
          });
        }
        return json({
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource: terminalFirstResource,
        });
      },
    }) as TerminalFirstDaemonTransport;
    const preparation = transport.prepareTerminalRuntimeInventory(
      target,
      new AbortController().signal,
    );
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparation;
    transport.adoptTerminalRuntimeInventory(prepared, () => undefined);
    expect(diagnostics).toEqual([
      "terminal-event-socket-create",
      "terminal-event-socket-open",
      "terminal-event-hello",
      "terminal-interest-send",
      "terminal-interest-ack",
      "terminal-http-start",
      "terminal-http-response",
      "terminal-capability-adopted",
    ]);
    expect(socketOptions).toEqual([{ headers: { Authorization: "Bearer owner-secret" } }]);
    expect(socketUrls).toEqual(["ws://127.0.0.1:6060/ws/events?mode=semantic"]);
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      "/api/project/alpha/terminal-runtime-inventory",
    ]);
    expect(diagnosticActionStates).toContain("terminal-event-socket-create:1:0:0");
    expect(diagnosticActionStates).toContain("terminal-interest-send:1:1:0");
    expect(diagnosticActionStates).toContain("terminal-http-start:1:1:1");

    let verified = 0;
    transport.connectEvents(target, {
      onVerifiedOpen: () => (verified += 1),
      onInvalidate: () => undefined,
      onMalformedFrame: () => undefined,
      onPeerMismatch: () => undefined,
      onProtocolError: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    const shellRead = transport.fetchApplicationShell(target, new AbortController().signal);
    await tick();
    expect(verified).toBe(0);
    expect(requests).toHaveLength(1);
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await shellRead;
    expect(verified).toBe(1);
    expect(requests.at(-1)!.pathname).toBe("/api/project/alpha/application-shell");
    expect(socketOptions).toHaveLength(1);
    transport.selectApplicationShellFallback("unknown");
    expect(diagnostics.at(-1)).toBe("terminal-fallback-selected");
    expect(fallbackListenerCount).toBe(0);
  });

  it("keeps the fallback event connection on the legacy endpoint", () => {
    const socketUrls: string[] = [];
    const socketOptions: Array<WorkspaceEventSocketOptions | undefined> = [];
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken: "owner-secret",
      resolveSessionName: () => "alpha",
      terminalRuntimeAuthority: true,
      createWebSocket: (url, options) => {
        socketUrls.push(url);
        socketOptions.push(options);
        return new FakeSocket();
      },
      fetch: async () => json({}),
    }) as TerminalFirstDaemonTransport;

    void transport
      .prepareTerminalRuntimeInventory(target, new AbortController().signal)
      .catch(() => undefined);
    transport.selectApplicationShellFallback("deadline");
    transport.connectEvents(target, {
      onVerifiedOpen: () => undefined,
      onInvalidate: () => undefined,
      onMalformedFrame: () => undefined,
      onPeerMismatch: () => undefined,
      onProtocolError: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });

    expect(socketUrls).toEqual([
      "ws://127.0.0.1:6060/ws/events?mode=semantic",
      "ws://127.0.0.1:6060/ws/events",
    ]);
    expect(socketOptions).toEqual([
      { headers: { Authorization: "Bearer owner-secret" } },
      undefined,
    ]);
  });

  it("replaces a retired supervisor and publishes its clean terminal authority", async () => {
    const sockets: FakeSocket[] = [];
    let revision = 1;
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken: "owner-secret",
      resolveSessionName: () => "alpha",
      terminalRuntimeAuthority: true,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async () =>
        json({
          version: 1,
          daemon,
          resource: {
            workspaceName: "workspace.alpha",
            workspaceId: "workspace.0123456789abcdefabcd",
            sessionId: "session.0123456789abcdefabcd",
            resourceRevision: revision,
            semanticPaneIds: [`pane.${revision}`],
          },
        }),
    }) as TerminalFirstDaemonTransport;
    const preparation = transport.prepareTerminalRuntimeInventory(
      target,
      new AbortController().signal,
    );
    sockets[0]!.emit("open");
    sockets[0]!.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    sockets[0]!.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparation;
    const published: string[][] = [];
    let verified = 0;
    expect(
      transport.adoptTerminalRuntimeInventory(prepared, (resource) =>
        published.push([...resource.semanticPaneIds]),
      ),
    ).not.toBeNull();
    transport.connectEvents(target, {
      onVerifiedOpen: () => (verified += 1),
      onInvalidate: () => undefined,
      onMalformedFrame: () => undefined,
      onPeerMismatch: () => undefined,
      onProtocolError: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    await tick();
    sockets[0]!.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(verified).toBe(1);

    revision = 2;
    sockets[0]!.emit("close");
    await tick();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.listeners.get("message")?.size ?? 0).toBe(0);
    sockets[1]!.emit("open");
    sockets[1]!.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    sockets[1]!.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(published).toEqual([["pane.2"]]);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent).toHaveLength(2);
    expect(sockets[1]!.sent[1]).toMatchObject({
      type: "subscribe",
      interestRevision: 2,
      interests: [{ resource: "terminal-runtime-inventory" }, { resource: "application-shell" }],
    });
    expect(verified).toBe(1);
    sockets[1]!.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(verified).toBe(2);
    transport.disposeEventSupervisor();
  });

  it("retires each failed replacement and reconnects terminal then application-shell on a fresh socket", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeReconnectClock();
    let terminalReads = 0;
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken: "owner-secret",
      resolveSessionName: () => "alpha",
      terminalRuntimeAuthority: true,
      terminalReconnectClock: clock,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async () => {
        terminalReads += 1;
        if (terminalReads >= 2 && terminalReads <= 5) throw new Error("read failed");
        return json({
          version: 1,
          daemon,
          resource: {
            workspaceName: "workspace.alpha",
            workspaceId: "workspace.0123456789abcdefabcd",
            sessionId: "session.0123456789abcdefabcd",
            resourceRevision: terminalReads,
            semanticPaneIds: [`pane.${terminalReads}`],
          },
        });
      },
    }) as TerminalFirstDaemonTransport;
    const preparation = transport.prepareTerminalRuntimeInventory(
      target,
      new AbortController().signal,
    );
    sockets[0]!.emit("open");
    sockets[0]!.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    sockets[0]!.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparation;
    const published: string[][] = [];
    transport.adoptTerminalRuntimeInventory(prepared, (resource) =>
      published.push([...resource.semanticPaneIds]),
    );
    let verified = 0;
    transport.connectEvents(target, {
      onVerifiedOpen: () => (verified += 1),
      onInvalidate: () => undefined,
      onMalformedFrame: () => undefined,
      onPeerMismatch: () => undefined,
      onProtocolError: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });

    sockets[0]!.emit("close");
    await tick();
    for (const expectedSocketCount of [2, 3]) {
      expect(sockets).toHaveLength(expectedSocketCount);
      const failed = sockets.at(-1)!;
      failed.emit("open");
      failed.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
      await tick();
      failed.frame({
        type: "resource.interests-ack",
        interestRevision: 1,
        sequence: 0,
        unavailableInterests: [],
      });
      await tick();
      await tick();
      expect(failed.listeners.get("message")?.size ?? 0).toBe(0);
      expect(clock.callbacks.size).toBe(1);
      clock.runNext();
    }
    expect(sockets).toHaveLength(4);
    const recovered = sockets[3]!;
    recovered.emit("open");
    recovered.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    recovered.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(published).toEqual([["pane.6"]]);
    expect(recovered.sent[1]).toMatchObject({
      type: "subscribe",
      interestRevision: 2,
      interests: [{ resource: "terminal-runtime-inventory" }, { resource: "application-shell" }],
    });
    recovered.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(verified).toBe(1);
    expect(clock.callbacks.size).toBe(0);
    transport.disposeEventSupervisor();
  });

  it("cancels a failed replacement retry without creating a late socket after disposal", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeReconnectClock();
    let reads = 0;
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      terminalRuntimeAuthority: true,
      terminalReconnectClock: clock,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async () => {
        reads += 1;
        if (reads > 1) throw new Error("read failed");
        return json({
          version: 1,
          daemon,
          resource: {
            workspaceName: "workspace.alpha",
            workspaceId: "workspace.0123456789abcdefabcd",
            sessionId: "session.0123456789abcdefabcd",
            resourceRevision: 1,
            semanticPaneIds: ["pane.1"],
          },
        });
      },
    }) as TerminalFirstDaemonTransport;
    const preparation = transport.prepareTerminalRuntimeInventory(
      target,
      new AbortController().signal,
    );
    sockets[0]!.emit("open");
    sockets[0]!.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    sockets[0]!.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparation;
    transport.adoptTerminalRuntimeInventory(prepared, () => undefined);
    sockets[0]!.emit("close");
    await tick();
    sockets[1]!.emit("open");
    sockets[1]!.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    sockets[1]!.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    const lateCallback = clock.callbacks.values().next().value as () => void;
    expect(clock.callbacks.size).toBe(1);
    transport.disposeEventSupervisor();
    expect(clock.callbacks.size).toBe(0);
    lateCallback();
    await tick();
    expect(sockets).toHaveLength(2);
  });

  it("requests and validates terminal-first V2 without app-window enrichment", async () => {
    const requests: URL[] = [];
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return json({
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource: terminalFirstResource,
        });
      },
    });

    const resource = await transport.fetchApplicationShell(target, new AbortController().signal);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/api/project/alpha/application-shell");
    expect(requests[0]!.searchParams.get("version")).toBe("2");
    expect(resource.terminalInventory).toEqual(terminalFirstResource.terminalInventory);
    expect("appWindows" in resource).toBe(false);
  });

  it("rejects a V2 response that omits the required terminal inventory", async () => {
    const incomplete = Object.fromEntries(
      Object.entries(terminalFirstResource).filter(([key]) => key !== "terminalInventory"),
    );
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      fetch: async () =>
        json({
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource: incomplete,
        }),
    });

    await expect(
      transport.fetchApplicationShell(target, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "schema-invalid" });
  });

  it("retains V3 as the default for canvas hosts", async () => {
    const requests: URL[] = [];
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return json({ error: "fixture stops after request capture" }, 500);
      },
    });

    await expect(
      transport.fetchApplicationShell(target, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "http-error", statusCode: 500 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("version")).toBe("3");
  });
});
