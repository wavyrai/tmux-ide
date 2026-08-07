import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellProjectionInputV2SchemaZ,
  ApplicationShellProjectionInputV3SchemaZ,
  COHESION_FIXTURE_V1,
  type DesktopDaemonHostDescriptor,
} from "@tmux-ide/contracts";

import {
  createDirectLoopbackDaemonTransport,
  DaemonTransportError,
  type DaemonEventSocket,
  type DaemonFetch,
} from "./daemon-transport.ts";

const descriptor: DesktopDaemonHostDescriptor = {
  apiBaseUrl: "http://127.0.0.1:6060",
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};
const daemonIdentity = {
  protocolVersion: descriptor.protocolVersion,
  productVersion: descriptor.productVersion,
  instanceId: descriptor.instanceId,
  startedAt: descriptor.startedAt,
};
const resolveSessionName = (workspaceName: string): string =>
  workspaceName === "project / one" ? "session / one" : workspaceName;

const resource = ApplicationShellProjectionInputV2SchemaZ.parse({
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
  terminalInventory: { activeResourceId: null, resources: [] },
});

const resourceV3 = ApplicationShellProjectionInputV3SchemaZ.parse({
  ...resource,
  appWindows: {
    version: 1,
    revision: 0,
    updatedAt: "2026-07-22T10:00:00.000Z",
    windows: {},
    dockRoot: null,
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: [],
    focusedWindowId: null,
    activeLayoutId: null,
    layouts: {},
  },
});

function resourceEnvelope(value: unknown = resourceV3, daemon: unknown = daemonIdentity): unknown {
  return { version: APPLICATION_SHELL_RESOURCE_V3_VERSION, daemon, resource: value };
}

function resourceV2Envelope(value: unknown = resource, daemon: unknown = daemonIdentity): unknown {
  return { version: APPLICATION_SHELL_RESOURCE_V2_VERSION, daemon, resource: value };
}

class FakeSocket implements DaemonEventSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  emit(type: "open" | "message" | "close" | "error", data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("browser-safe daemon transport", () => {
  it("fetches and validates the typed application-shell resource without credentials", async () => {
    const fetch = vi.fn<DaemonFetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(resourceEnvelope()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      fetch,
    });
    const result = await transport.fetchApplicationShell(
      { daemon: daemonIdentity, workspaceName: "project / one" },
      new AbortController().signal,
    );

    expect(result).toEqual(resourceV3);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://127.0.0.1:6060/api/project/session%20%2F%20one/application-shell?version=3",
    );
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    });
    expect(JSON.stringify(init)).not.toContain("token");
  });

  it("falls back to V2 only when the same daemon rejects V3 as unsupported", async () => {
    const fetch = vi.fn<DaemonFetch>(async (input) =>
      String(input).endsWith("version=3")
        ? new Response(JSON.stringify({ error: "Unsupported resource version" }), { status: 400 })
        : new Response(JSON.stringify(resourceV2Envelope()), { status: 200 }),
    );
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      fetch,
    });

    await expect(
      transport.fetchApplicationShell(
        { daemon: daemonIdentity, workspaceName: "project / one" },
        new AbortController().signal,
      ),
    ).resolves.toEqual(resource);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:6060/api/project/session%20%2F%20one/application-shell?version=3",
      "http://127.0.0.1:6060/api/project/session%20%2F%20one/application-shell?version=2",
    ]);
  });

  it("classifies missing and invalid resources without returning unvalidated data", async () => {
    const missing = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      fetch: async () => new Response("not found", { status: 404 }),
    });
    await expect(
      missing.fetchApplicationShell(
        { daemon: daemonIdentity, workspaceName: "missing" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "not-found", statusCode: 404 });

    const invalid = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      fetch: async () => new Response(JSON.stringify({ fixture: "must-not-pass" })),
    });
    await expect(
      invalid.fetchApplicationShell(
        { daemon: daemonIdentity, workspaceName: "project" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "schema-invalid" });
  });

  it("rejects every REST daemon-generation mismatch before returning resource data", async () => {
    const mismatches = [
      { ...daemonIdentity, protocolVersion: 2 },
      { ...daemonIdentity, productVersion: "9.9.9" },
      { ...daemonIdentity, instanceId: "3adfc6e2-f1ae-4e63-b9df-7e8eb0ea94d4" },
      { ...daemonIdentity, startedAt: "2026-07-21T00:00:01.000Z" },
    ];
    for (const daemon of mismatches) {
      const transport = createDirectLoopbackDaemonTransport({
        descriptor,
        resolveSessionName,
        fetch: async () => new Response(JSON.stringify(resourceEnvelope(resourceV3, daemon))),
      });
      await expect(
        transport.fetchApplicationShell(
          { daemon: daemonIdentity, workspaceName: "project" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: "daemon-identity-mismatch" });
    }
  });

  it("rejects remote, credentialed, and protocol-incompatible descriptors again", () => {
    for (const daemon of [
      { ...descriptor, apiBaseUrl: "http://192.0.2.1:6060" },
      { ...descriptor, apiBaseUrl: "http://secret@127.0.0.1:6060" },
      { ...descriptor, protocolVersion: 99 },
    ]) {
      expect(() =>
        createDirectLoopbackDaemonTransport({ descriptor: daemon, resolveSessionName }),
      ).toThrowError(DaemonTransportError);
    }
  });

  it("uses one strict event socket and sends a narrow validated subscription", () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const onVerifiedOpen = vi.fn();
    const onInvalidate = vi.fn();
    const onMalformedFrame = vi.fn();
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      createWebSocket,
    });
    const connection = transport.connectEvents(
      { daemon: daemonIdentity, workspaceName: "project" },
      {
        onVerifiedOpen,
        onInvalidate,
        onProtocolError: vi.fn(),
        onPeerMismatch: vi.fn(),
        onMalformedFrame,
        onClose: vi.fn(),
        onError: vi.fn(),
      },
    );

    expect(createWebSocket).toHaveBeenCalledWith("ws://127.0.0.1:6060/ws/events");
    socket.emit("open");
    expect(onVerifiedOpen).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    socket.emit("message", JSON.stringify({ type: "hello", daemon: daemonIdentity, sessions: [] }));
    expect(onVerifiedOpen).toHaveBeenCalledOnce();
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "subscribe", sessions: ["project"], afterSequence: 0 },
    ]);

    socket.emit("message", JSON.stringify({ type: "sessions.changed" }));
    expect(onInvalidate).toHaveBeenCalledOnce();
    // A session-scoped agent-status change re-fetches only for the bound
    // session; another session's frame is ignored.
    socket.emit(
      "message",
      JSON.stringify({ type: "agent-status.changed", sessionName: "project" }),
    );
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    socket.emit(
      "message",
      JSON.stringify({ type: "agent-status.changed", sessionName: "other-session" }),
    );
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    socket.emit("message", "not-json");
    socket.emit("message", JSON.stringify({ type: "sessions.changed", unexpected: true }));
    socket.emit("message", new Uint8Array([1, 2, 3]));
    expect(onMalformedFrame).toHaveBeenCalledTimes(3);

    connection.close();
    expect(socket.closes).toEqual([{ code: 1000, reason: "Desktop resource store disposed" }]);
  });

  it("resumes from the last applied event sequence and recovers an explicit journal gap", () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const onInvalidate = vi.fn();
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      createWebSocket: () => sockets.shift()!,
    });
    const handlers = {
      onVerifiedOpen: vi.fn(),
      onInvalidate,
      onProtocolError: vi.fn(),
      onPeerMismatch: vi.fn(),
      onMalformedFrame: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    };

    const first = transport.connectEvents(
      { daemon: daemonIdentity, workspaceName: "project" },
      handlers,
    );
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      JSON.stringify({ type: "hello", daemon: daemonIdentity, sessions: [], eventSequence: 1 }),
    );
    firstSocket.emit(
      "message",
      JSON.stringify({
        type: "action.complete",
        name: "workspace.app-window.mutate",
        result: { outcome: "applied" },
      }),
    );
    expect(onInvalidate).not.toHaveBeenCalled();
    firstSocket.emit(
      "message",
      JSON.stringify({
        type: "resource.changed",
        sequence: 1,
        workspaceName: "project",
        resource: "application-shell",
        revision: 5,
        causeOperationId: null,
      }),
    );
    expect(onInvalidate).toHaveBeenCalledOnce();
    first.close();

    transport.connectEvents({ daemon: daemonIdentity, workspaceName: "project" }, handlers);
    secondSocket.emit("open");
    secondSocket.emit(
      "message",
      JSON.stringify({ type: "hello", daemon: daemonIdentity, sessions: [], eventSequence: 2 }),
    );
    expect(secondSocket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "subscribe", sessions: ["project"], afterSequence: 1 },
    ]);
    secondSocket.emit(
      "message",
      JSON.stringify({
        type: "snapshot-required",
        afterSequence: 1,
        oldestAvailableSequence: 3,
        currentSequence: 4,
        reason: "journal-gap",
      }),
    );
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it("does not authenticate a socket before one matching, secret-free hello", () => {
    const socket = new FakeSocket();
    const onVerifiedOpen = vi.fn();
    const onPeerMismatch = vi.fn();
    const onMalformedFrame = vi.fn();
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName,
      createWebSocket: () => socket,
    });
    transport.connectEvents(
      { daemon: daemonIdentity, workspaceName: "project" },
      {
        onVerifiedOpen,
        onInvalidate: vi.fn(),
        onProtocolError: vi.fn(),
        onPeerMismatch,
        onMalformedFrame,
        onClose: vi.fn(),
        onError: vi.fn(),
      },
    );

    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "sessions.changed" }));
    expect(onMalformedFrame).toHaveBeenCalledOnce();
    expect(onVerifiedOpen).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);

    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        daemon: { ...daemonIdentity, authToken: "must-not-cross-wire" },
        sessions: [],
      }),
    );
    expect(onMalformedFrame).toHaveBeenCalledTimes(2);
    expect(onVerifiedOpen).not.toHaveBeenCalled();

    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        daemon: { ...daemonIdentity, instanceId: "3adfc6e2-f1ae-4e63-b9df-7e8eb0ea94d4" },
        sessions: [],
      }),
    );
    expect(onPeerMismatch).toHaveBeenCalledOnce();
    expect(onVerifiedOpen).not.toHaveBeenCalled();
    expect(socket.closes).toEqual([{ code: 4008, reason: "Daemon identity mismatch" }]);
  });
});
