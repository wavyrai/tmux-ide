import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_RESOURCE_VERSION,
  ApplicationShellProjectionInputV1SchemaZ,
  COHESION_FIXTURE_V1,
  DesktopApplicationShellTargetSchemaZ,
  type ApplicationShellProjectionInputV1,
  type DesktopDaemonHostDescriptor,
} from "@tmux-ide/contracts";

import type { DesktopApplicationShellTarget } from "./connection-state.ts";
import {
  createDesktopApplicationShellResourceStore,
  createSolidDesktopApplicationShellResourceStore,
  type DesktopResourceClock,
} from "./desktop-resource-store.ts";
import {
  createDirectLoopbackDaemonTransport,
  type DaemonEventHandlers,
  type DaemonEventSocket,
  type DaemonFetch,
  type DesktopDaemonTransport,
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

function resource(name: string): ApplicationShellProjectionInputV1 {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    project: { ...COHESION_FIXTURE_V1.project, name },
    workspace: COHESION_FIXTURE_V1.workspace,
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
  });
}

function target(workspaceName = "project", daemon = daemonIdentity): DesktopApplicationShellTarget {
  return { daemon, workspaceName };
}

function jsonResponse(value: unknown, status = 200, daemon: unknown = daemonIdentity): Response {
  const body =
    status >= 200 && status < 300
      ? { version: APPLICATION_SHELL_RESOURCE_VERSION, daemon, resource: value }
      : value;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authenticateSocket(socket: FakeSocket, daemon: unknown = daemonIdentity): void {
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "hello", daemon, sessions: [] }));
}

async function settle(): Promise<void> {
  // Response.json() may finish on a later event-loop turn rather than in the
  // current microtask queue. CI runs the renderer beside the daemon and
  // Electron suites, so microtask-only draining can observe the store while it
  // is still legitimately loading. Keep this bounded, but yield real turns.
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

class FakeClock implements DesktopResourceClock {
  nowValue = 1_000;
  readonly scheduledDelays: number[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    this.scheduledDelays.push(delayMs);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  runNext(): boolean {
    const next = this.timers.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    if (!next) return false;
    const [id, timer] = next;
    this.timers.delete(id);
    this.nowValue += timer.delayMs;
    timer.callback();
    return true;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

function harness(fetch: DaemonFetch): {
  readonly sockets: FakeSocket[];
  readonly transport: ReturnType<typeof createDirectLoopbackDaemonTransport>;
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    transport: createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: (workspaceName) => workspaceName,
      fetch,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }),
  };
}

interface BrokerConnection {
  readonly target: DesktopApplicationShellTarget;
  readonly handlers: DaemonEventHandlers;
  closed: boolean;
}

function brokerHarness(): {
  readonly transport: DesktopDaemonTransport;
  readonly requests: Array<ReturnType<typeof deferred<ApplicationShellProjectionInputV1>>>;
  readonly signals: AbortSignal[];
  readonly connections: BrokerConnection[];
} {
  const requests: Array<ReturnType<typeof deferred<ApplicationShellProjectionInputV1>>> = [];
  const signals: AbortSignal[] = [];
  const connections: BrokerConnection[] = [];
  return {
    requests,
    signals,
    connections,
    transport: {
      validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
      fetchApplicationShell: (_target, signal) => {
        const request = deferred<ApplicationShellProjectionInputV1>();
        requests.push(request);
        signals.push(signal);
        return request.promise;
      },
      connectEvents: (connectionTarget, handlers) => {
        const record: BrokerConnection = {
          target: connectionTarget,
          handlers,
          closed: false,
        };
        connections.push(record);
        return { close: () => (record.closed = true) };
      },
    },
  };
}

describe("desktop application-shell resource store", () => {
  it("loads the first validated resource and owns one narrowly subscribed socket", async () => {
    const fetch = vi.fn(async () => jsonResponse(resource("live-project")));
    const runtime = harness(fetch);
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
    });

    expect(store.getState()).toMatchObject({ status: "loading", data: null });
    expect(runtime.sockets).toHaveLength(1);
    await settle();
    expect(store.getState()).toMatchObject({
      status: "stale",
      data: { project: { name: "live-project" } },
    });

    runtime.sockets[0]!.emit("open");
    expect(store.getState()).toMatchObject({ status: "stale" });
    expect(runtime.sockets[0]!.sent).toEqual([]);
    runtime.sockets[0]!.emit(
      "message",
      JSON.stringify({ type: "hello", daemon: daemonIdentity, sessions: [] }),
    );

    expect(store.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "live-project" } },
    });
    expect(runtime.sockets[0]!.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "subscribe", sessions: ["project"] },
    ]);
    store.dispose();
  });

  it("keeps schema failures degraded and never substitutes preview fixture data", async () => {
    const runtime = harness(async () => jsonResponse({ preview: "not-a-resource" }));
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
    });
    await settle();

    expect(store.getState()).toMatchObject({
      status: "degraded",
      code: "schema-invalid",
      data: null,
    });
    expect(JSON.stringify(store.getState())).not.toContain(COHESION_FIXTURE_V1.project.name);
    store.dispose();
  });

  it("distinguishes a missing project and a network failure", async () => {
    const missingRuntime = harness(async () => jsonResponse({ error: "missing" }, 404));
    const missing = createDesktopApplicationShellResourceStore({
      target: target("missing"),
      transport: missingRuntime.transport,
    });
    await settle();
    expect(missing.getState()).toMatchObject({
      status: "unavailable",
      code: "not-found",
      data: null,
    });
    missing.dispose();

    const errorRuntime = harness(async () => {
      throw new TypeError("connection refused");
    });
    const failed = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: errorRuntime.transport,
    });
    await settle();
    expect(failed.getState()).toMatchObject({
      status: "error",
      code: "network-error",
      data: null,
      reason: "connection refused",
    });
    failed.dispose();
  });

  it("preserves the last validated resource as stale across HTTP and network refresh failures", async () => {
    let call = 0;
    const runtime = harness(async () => {
      call += 1;
      if (call === 1) return jsonResponse(resource("validated"));
      if (call === 2) return jsonResponse({ error: "busy" }, 503);
      throw new TypeError("connection reset");
    });
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();
    expect(store.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "validated" } },
    });

    store.refresh();
    await settle();
    expect(store.getState()).toMatchObject({
      status: "stale",
      data: { project: { name: "validated" } },
      reason: "Daemon application-shell request returned HTTP 503.",
    });

    store.refresh();
    await settle();
    expect(store.getState()).toMatchObject({
      status: "stale",
      data: { project: { name: "validated" } },
      reason: "connection reset",
    });
    store.dispose();
  });

  it("never becomes live when REST or WebSocket peer identity mismatches", async () => {
    const wrongDaemon = {
      ...daemonIdentity,
      instanceId: "3adfc6e2-f1ae-4e63-b9df-7e8eb0ea94d4",
    };
    const restRuntime = harness(async () =>
      jsonResponse(resource("wrong-rest-peer"), 200, wrongDaemon),
    );
    const restStore = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: restRuntime.transport,
    });
    await settle();
    expect(restStore.getState()).toMatchObject({
      status: "degraded",
      code: "daemon-identity-mismatch",
      data: null,
    });
    expect(restRuntime.sockets[0]!.closes).toHaveLength(1);
    restStore.dispose();

    const pending = deferred<Response>();
    const wsRuntime = harness(() => pending.promise);
    const wsStore = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: wsRuntime.transport,
    });
    authenticateSocket(wsRuntime.sockets[0]!, wrongDaemon);
    expect(wsStore.getState()).toMatchObject({
      status: "degraded",
      code: "daemon-identity-mismatch",
      data: null,
    });
    pending.resolve(jsonResponse(resource("too-late")));
    await settle();
    expect(wsStore.getState()).toMatchObject({
      status: "degraded",
      code: "daemon-identity-mismatch",
      data: null,
    });
    wsStore.dispose();
  });

  it("never stores or emits null, malformed, or extra-secret targets", () => {
    for (const untrusted of [
      null,
      { daemon: daemonIdentity },
      { daemon: daemonIdentity, workspaceName: "project", authToken: "must-not-cross-state" },
    ]) {
      const fetch = vi.fn(async () => jsonResponse(resource("must-not-load")));
      const runtime = harness(fetch);
      const observed: unknown[] = [];
      const store = createDesktopApplicationShellResourceStore({
        target: untrusted,
        transport: runtime.transport,
      });
      store.subscribe((state) => observed.push(state));

      expect(store.getState()).toMatchObject({
        status: "degraded",
        target: null,
        code: "descriptor-invalid",
        data: null,
      });
      expect(JSON.stringify(observed)).not.toContain("must-not-cross-state");
      expect(fetch).not.toHaveBeenCalled();
      expect(runtime.sockets).toHaveLength(0);
      store.dispose();
    }
  });

  it("marks live data stale on disconnect and refetches after bounded reconnect", async () => {
    const clock = new FakeClock();
    const responses = [resource("first"), resource("second")];
    const fetch = vi.fn(async () => jsonResponse(responses.shift()));
    const runtime = harness(fetch);
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
      clock,
      random: () => 0.5,
      reconnect: { initialDelayMs: 100, maximumDelayMs: 400, maximumAttempts: 3 },
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();

    runtime.sockets[0]!.emit("close");
    expect(store.getState()).toMatchObject({
      status: "stale",
      data: { project: { name: "first" } },
    });
    expect(clock.scheduledDelays).toEqual([100]);
    expect(clock.pendingCount).toBe(1);

    clock.runNext();
    expect(runtime.sockets).toHaveLength(2);
    authenticateSocket(runtime.sockets[1]!);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "second" } },
    });
    expect(runtime.sockets[0]!.closes).toHaveLength(1);
    store.dispose();
  });

  it("rejects malformed event frames, degrades safely, and reconnects", async () => {
    const clock = new FakeClock();
    const fetch = vi.fn(async () => jsonResponse(resource("live")));
    const runtime = harness(fetch);
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
      clock,
      random: () => 0.5,
      reconnect: { initialDelayMs: 50 },
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();

    runtime.sockets[0]!.emit("message", JSON.stringify({ type: "future.event" }));
    expect(store.getState()).toMatchObject({
      status: "degraded",
      code: "event-frame-invalid",
      data: { project: { name: "live" } },
    });
    expect(runtime.sockets[0]!.closes).toHaveLength(1);
    expect(clock.pendingCount).toBe(1);

    clock.runNext();
    expect(runtime.sockets).toHaveLength(2);
    store.dispose();
  });

  it("only invalidates for relevant validated session and project events", async () => {
    const fetch = vi.fn(async () => jsonResponse(resource(`load-${fetch.mock.calls.length}`)));
    const runtime = harness(fetch);
    const store = createDesktopApplicationShellResourceStore({
      target: target("project"),
      transport: runtime.transport,
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);

    runtime.sockets[0]!.emit(
      "message",
      JSON.stringify({ type: "config.changed", sessionName: "other" }),
    );
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);

    runtime.sockets[0]!.emit(
      "message",
      JSON.stringify({ type: "terminals.changed", sessionName: "project" }),
    );
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);

    runtime.sockets[0]!.emit("message", JSON.stringify({ type: "projects.changed" }));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    store.dispose();
  });

  it("guards rapid project switches from stale requests and sockets", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const request = deferred<Response>();
      requests.push(request);
      signals.push(init!.signal as AbortSignal);
      return request.promise;
    });
    const runtime = harness(fetch);
    const store = createDesktopApplicationShellResourceStore({
      target: target("first"),
      transport: runtime.transport,
    });
    const firstGeneration = store.getState().generation;

    store.setTarget(target("second"));
    expect(signals[0]!.aborted).toBe(true);
    expect(runtime.sockets[0]!.closes).toHaveLength(1);
    expect(runtime.sockets).toHaveLength(2);
    authenticateSocket(runtime.sockets[1]!);
    requests[1]!.resolve(jsonResponse(resource("second-live")));
    await settle();
    expect(store.getState()).toMatchObject({
      status: "live",
      target: { workspaceName: "second" },
      data: { project: { name: "second-live" } },
    });

    requests[0]!.resolve(jsonResponse(resource("stale-first")));
    runtime.sockets[0]!.emit("message", JSON.stringify({ type: "projects.changed" }));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ data: { project: { name: "second-live" } } });

    store.refresh();
    expect(requests).toHaveLength(3);
    expect(store.getState().generation).toBe(firstGeneration + 1);
    store.dispose();
    expect(signals[2]!.aborted).toBe(true);
  });

  it("guards daemon-generation switches when using a host-broker transport", async () => {
    const runtime = brokerHarness();
    const store = createDesktopApplicationShellResourceStore({
      target: target("project"),
      transport: runtime.transport,
    });
    const firstGeneration = store.getState().generation;
    const nextDaemon = {
      ...daemonIdentity,
      instanceId: "3adfc6e2-f1ae-4e63-b9df-7e8eb0ea94d4",
      startedAt: "2026-07-21T00:00:01.000Z",
    };

    store.setTarget(target("project", nextDaemon));
    expect(runtime.signals[0]!.aborted).toBe(true);
    expect(runtime.connections[0]!.closed).toBe(true);
    expect(store.getState()).toMatchObject({
      status: "loading",
      generation: firstGeneration + 1,
      target: { daemon: { instanceId: nextDaemon.instanceId } },
      data: null,
    });

    runtime.connections[0]!.handlers.onVerifiedOpen();
    runtime.connections[0]!.handlers.onInvalidate();
    runtime.requests[0]!.resolve(resource("stale-generation"));
    await settle();
    expect(store.getState()).toMatchObject({ status: "loading", data: null });

    runtime.connections[1]!.handlers.onVerifiedOpen();
    runtime.requests[1]!.resolve(resource("current-generation"));
    await settle();
    expect(store.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "current-generation" } },
    });
    store.dispose();
  });

  it("exhausts reconnect budget under verified open-close and malformed-frame flapping", async () => {
    const clock = new FakeClock();
    const runtime = harness(async () => jsonResponse(resource("retained")));
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
      clock,
      random: () => 0.5,
      reconnect: {
        initialDelayMs: 10,
        maximumDelayMs: 20,
        maximumAttempts: 2,
        stabilityWindowMs: 1_000,
      },
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();

    runtime.sockets[0]!.emit("close");
    clock.runNext();
    authenticateSocket(runtime.sockets[1]!);
    runtime.sockets[1]!.emit("message", JSON.stringify({ type: "future.event" }));
    clock.runNext();
    authenticateSocket(runtime.sockets[2]!);
    runtime.sockets[2]!.emit(
      "message",
      JSON.stringify({
        type: "protocol.error",
        code: "invalid-frame",
        message: "subscription rejected",
      }),
    );
    await settle();

    expect(runtime.sockets).toHaveLength(3);
    expect(clock.scheduledDelays).toEqual([10, 1_000, 20, 1_000]);
    expect(clock.pendingCount).toBe(0);
    expect(store.getState()).toMatchObject({
      status: "stale",
      data: { project: { name: "retained" } },
      reason: "Daemon event reconnection attempts were exhausted.",
    });
    store.dispose();
  });

  it("resets retry budget only after a verified connection survives the stability epoch", async () => {
    const clock = new FakeClock();
    const runtime = harness(async () => jsonResponse(resource("stable")));
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport: runtime.transport,
      clock,
      random: () => 0.5,
      reconnect: {
        initialDelayMs: 10,
        maximumDelayMs: 10,
        maximumAttempts: 1,
        stabilityWindowMs: 100,
      },
    });
    authenticateSocket(runtime.sockets[0]!);
    await settle();
    runtime.sockets[0]!.emit("close");
    clock.runNext();
    authenticateSocket(runtime.sockets[1]!);
    expect(clock.pendingCount).toBe(1);
    clock.runNext();

    runtime.sockets[1]!.emit("close");
    expect(clock.pendingCount).toBe(1);
    expect(clock.scheduledDelays).toEqual([10, 100, 10]);
    store.dispose();
  });

  it("normalizes hostile reconnect overrides into finite bounded work", () => {
    const clock = new FakeClock();
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: (workspaceName) => workspaceName,
      fetch: () => new Promise<Response>(() => undefined),
      createWebSocket: () => {
        throw new Error("socket refused");
      },
    });
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport,
      clock,
      random: () => {
        throw new Error("host entropy unavailable");
      },
      reconnect: {
        initialDelayMs: -1_000,
        maximumDelayMs: Number.POSITIVE_INFINITY,
        maximumAttempts: 1_000_000,
        jitterRatio: 99,
        stabilityWindowMs: Number.NaN,
      },
    });

    let callbacks = 0;
    while (clock.runNext()) {
      callbacks += 1;
      if (callbacks > 25) throw new Error("Reconnect work was not bounded.");
    }
    expect(callbacks).toBe(20);
    expect(clock.scheduledDelays).toHaveLength(20);
    expect(clock.scheduledDelays.every((delay) => Number.isFinite(delay))).toBe(true);
    expect(Math.min(...clock.scheduledDelays)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...clock.scheduledDelays)).toBeLessThanOrEqual(300_000);
    expect(store.getState()).toMatchObject({
      status: "unavailable",
      code: "reconnect-exhausted",
    });
    store.dispose();
  });

  it("bounds reconnect attempts and disposes requests, sockets, timers, and listeners", async () => {
    const clock = new FakeClock();
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetch: DaemonFetch = (_input, init) => {
      signal = init?.signal ?? undefined;
      return pending.promise;
    };
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: (workspaceName) => workspaceName,
      fetch,
      createWebSocket: () => {
        throw new Error("socket refused");
      },
    });
    const store = createDesktopApplicationShellResourceStore({
      target: target(),
      transport,
      clock,
      random: () => 0.5,
      reconnect: {
        initialDelayMs: 10,
        maximumDelayMs: 20,
        maximumAttempts: 2,
      },
    });
    expect(clock.scheduledDelays).toEqual([10]);
    clock.runNext();
    expect(clock.scheduledDelays).toEqual([10, 20]);
    clock.runNext();
    expect(store.getState()).toMatchObject({
      status: "unavailable",
      code: "reconnect-exhausted",
    });
    expect(clock.pendingCount).toBe(0);

    const observed = vi.fn();
    store.subscribe(observed);
    const callsBeforeDispose = observed.mock.calls.length;
    store.dispose();
    expect(signal?.aborted).toBe(true);
    expect(clock.pendingCount).toBe(0);
    pending.resolve(jsonResponse(resource("too-late")));
    await settle();
    expect(observed).toHaveBeenCalledTimes(callsBeforeDispose);
  });

  it("exposes the store as a Solid signal and follows owner cleanup", async () => {
    const runtime = harness(async () => jsonResponse(resource("solid-live")));
    let solidStore!: ReturnType<typeof createSolidDesktopApplicationShellResourceStore>;
    let disposeRoot!: () => void;
    createRoot((dispose) => {
      disposeRoot = dispose;
      solidStore = createSolidDesktopApplicationShellResourceStore({
        target: target(),
        transport: runtime.transport,
      });
    });

    expect(solidStore.state().status).toBe("loading");
    authenticateSocket(runtime.sockets[0]!);
    await settle();
    expect(solidStore.state()).toMatchObject({
      status: "live",
      data: { project: { name: "solid-live" } },
    });
    disposeRoot();
    expect(runtime.sockets[0]!.closes).toHaveLength(1);
  });
});
