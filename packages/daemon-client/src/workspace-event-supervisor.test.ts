import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import {
  createWorkspaceEventSupervisor,
  type WorkspaceEventSocket,
  type WorkspaceEventSocketEvent,
  type WorkspaceEventSocketEventType,
  type WorkspaceEventSocketListener,
} from "./workspace-event-supervisor.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeSocket implements WorkspaceEventSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<WorkspaceEventSocketEventType, Set<WorkspaceEventSocketListener>>();
  readonly close = vi.fn();

  addEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  emit(type: WorkspaceEventSocketEventType, event: WorkspaceEventSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  frame(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

const daemon = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "1.0.0",
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  startedAt: "2026-08-17T10:00:00.000Z",
};

const resource = (revision: number) => ({
  workspaceName: "alpha",
  workspaceId: "workspace.0123456789abcdefabcd",
  sessionId: "session.0123456789abcdefabcd",
  resourceRevision: revision,
  semanticPaneIds: ["pane.alpha"],
});

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function fakeRefreshClock() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    clock: {
      setTimeout(callback: () => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      clearTimeout(handle: unknown) {
        callbacks.delete(handle as number);
      },
    },
    get pending() {
      return callbacks.size;
    },
    runNext() {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined;
      if (!entry) return false;
      callbacks.delete(entry[0]);
      entry[1]();
      return true;
    },
  };
}

describe("WorkspaceEventSupervisor", () => {
  it("bounds a sink-triggered refresh and cancels its delayed successor on dispose", async () => {
    const socket = new FakeSocket();
    const fetch = vi.fn(async () => resource(0));
    const refreshDiagnostics: Readonly<Record<string, unknown>>[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: fetch,
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") refreshDiagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    expect(
      supervisor.adoptTerminalRuntimeInventory(prepared, () => {
        supervisor.refreshTerminalRuntimeInventory();
      }),
    ).toEqual(resource(0));

    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refreshDiagnostics).toEqual([
      {
        reason: "consumer",
        coalescedRequests: 0,
        delayed: false,
        attempt: 1,
        outcome: "success",
        failure: null,
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetch).toHaveBeenCalledTimes(2);
    supervisor.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("delays a sink-requeued refresh and still publishes a later authority revision", async () => {
    const socket = new FakeSocket();
    const reads = [resource(0), resource(1), resource(2)];
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const fetch = vi.fn(async () => reads.shift() ?? resource(2));
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: fetch,
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") diagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    const published: number[] = [];
    supervisor.adoptTerminalRuntimeInventory(prepared, (next) => {
      published.push(next.resourceRevision);
      if (next.resourceRevision === 1) supervisor.refreshTerminalRuntimeInventory();
    });

    supervisor.refreshTerminalRuntimeInventory();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(published).toEqual([1, 2]);
    expect(diagnostics).toEqual([
      {
        reason: "consumer",
        coalescedRequests: 0,
        delayed: false,
        attempt: 1,
        outcome: "success",
        failure: null,
      },
      {
        reason: "consumer",
        coalescedRequests: 0,
        delayed: true,
        attempt: 1,
        outcome: "success",
        failure: null,
      },
    ]);
    supervisor.dispose();
  });

  it("retries one transient refresh failure on the bounded clock", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    let reads = 0;
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async () => {
        reads += 1;
        if (reads === 2) throw new Error("transient");
        return resource(reads === 1 ? 0 : 1);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    const published: number[] = [];
    supervisor.adoptTerminalRuntimeInventory(prepared, (next) =>
      published.push(next.resourceRevision),
    );

    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    expect(timer.pending).toBe(1);
    timer.runNext();
    await tick();
    expect(reads).toBe(3);
    expect(published).toEqual([1]);
    expect(timer.pending).toBe(0);
    supervisor.dispose();
  });

  it("bounds permanent refresh failure and lets an event replace a pending retry", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    let reads = 0;
    let fail = true;
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async () => {
        reads += 1;
        if (reads > 1 && fail) throw new Error("persistent");
        return resource(reads > 1 ? 1 : 0);
      },
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") diagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    const published: number[] = [];
    supervisor.adoptTerminalRuntimeInventory(prepared, (next) =>
      published.push(next.resourceRevision),
    );

    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    expect(timer.pending).toBe(1);
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 1,
      causeOperationId: null,
    });
    fail = false;
    timer.runNext();
    await tick();
    expect(published).toEqual([1]);
    expect(timer.pending).toBe(0);
    expect(diagnostics.at(-1)).toMatchObject({ reason: "event", coalescedRequests: 1 });

    fail = true;
    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    expect(timer.pending).toBe(1);
    timer.runNext();
    await tick();
    expect(timer.pending).toBe(1);
    timer.runNext();
    await tick();
    expect(timer.pending).toBe(0);
    expect(diagnostics.slice(-3).map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(diagnostics.at(-1)).toMatchObject({ outcome: "exhausted" });
    supervisor.dispose();
  });

  it("aborts an in-flight refresh without scheduling a retry on dispose", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    let reads = 0;
    let refreshAborted = false;
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async (signal) => {
        reads += 1;
        if (reads === 1) return resource(0);
        return await new Promise<ReturnType<typeof resource>>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              refreshAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    supervisor.adoptTerminalRuntimeInventory(prepared, vi.fn());
    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    supervisor.dispose();
    await tick();
    expect(refreshAborted).toBe(true);
    expect(timer.pending).toBe(0);
  });

  it("retries a stale response until the event revision becomes readable", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    const reads = [resource(0), resource(1), resource(2)];
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async () => reads.shift() ?? resource(2),
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") diagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    const published: number[] = [];
    supervisor.adoptTerminalRuntimeInventory(prepared, (next) =>
      published.push(next.resourceRevision),
    );
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 2,
      causeOperationId: null,
    });
    await tick();
    expect(published).toEqual([]);
    expect(timer.pending).toBe(1);
    expect(diagnostics.at(-1)).toMatchObject({
      attempt: 1,
      outcome: "retry",
      failure: "stale-revision",
    });
    timer.runNext();
    await tick();
    expect(published).toEqual([2]);
    expect(timer.pending).toBe(0);
    supervisor.dispose();
  });

  it("exhausts three stale responses without publishing older authority", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    let initial = true;
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async () => {
        if (initial) {
          initial = false;
          return resource(0);
        }
        return resource(1);
      },
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") diagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    const sink = vi.fn();
    supervisor.adoptTerminalRuntimeInventory(prepared, sink);
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 3,
      causeOperationId: null,
    });
    await tick();
    timer.runNext();
    await tick();
    timer.runNext();
    await tick();
    expect(timer.pending).toBe(0);
    expect(sink).not.toHaveBeenCalled();
    expect(diagnostics.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "exhausted",
      failure: "stale-revision",
    });
    supervisor.dispose();
  });

  it("charges an in-flight failed attempt despite repeated consumer coalescing", async () => {
    const socket = new FakeSocket();
    const timer = fakeRefreshClock();
    const firstRefresh = deferred<ReturnType<typeof resource>>();
    const finalRefresh = deferred<ReturnType<typeof resource>>();
    let reads = 0;
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      terminalRefreshClock: timer.clock,
      fetchTerminalRuntimeInventory: async () => {
        reads += 1;
        if (reads === 1) return resource(0);
        if (reads === 2) return firstRefresh.promise;
        if (reads === 4) return finalRefresh.promise;
        throw new Error("persistent");
      },
      onDiagnostic: (phase, details) => {
        if (phase === "terminal-refresh") diagnostics.push(details);
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    supervisor.adoptTerminalRuntimeInventory(prepared, vi.fn());
    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    for (let index = 0; index < 1_000; index += 1) supervisor.refreshTerminalRuntimeInventory();
    for (let index = 1; index <= 1_000; index += 1)
      socket.frame({
        type: "resource.changed",
        sequence: index,
        workspaceName: "alpha",
        resource: "terminal-runtime-inventory",
        revision: 0,
        causeOperationId: null,
      });
    firstRefresh.reject(new Error("first failed"));
    await tick();
    expect(timer.pending).toBe(1);
    timer.runNext();
    await tick();
    expect(timer.pending).toBe(1);
    timer.runNext();
    await tick();
    for (let index = 0; index < 1_000; index += 1) supervisor.refreshTerminalRuntimeInventory();
    finalRefresh.reject(new Error("final failed"));
    await tick();
    expect(timer.pending).toBe(0);
    expect(reads).toBe(4);
    expect(diagnostics.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "exhausted",
      failure: "read-failed",
    });
    expect(diagnostics.at(-1)?.coalescedRequests).toBe(999);
    supervisor.refreshTerminalRuntimeInventory();
    await tick();
    expect(diagnostics.at(-1)).toMatchObject({ attempt: 1, coalescedRequests: 0 });
    supervisor.dispose();
  });

  it("installs terminal authority first and never publishes a dirty initial read", async () => {
    const socket = new FakeSocket();
    const first = deferred<ReturnType<typeof resource>>();
    const second = deferred<ReturnType<typeof resource>>();
    const reads = [first, second];
    const fetch = vi.fn(() => reads.shift()!.promise);
    const diagnostics: string[] = [];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: fetch,
      onDiagnostic: (phase) => {
        diagnostics.push(`${phase}:${socket.sent.length}`);
        throw new Error("diagnostic sink failed");
      },
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    expect(socket.sent[0]).toMatchObject({
      type: "subscribe",
      interests: [{ resource: "terminal-runtime-inventory", workspaceName: "alpha" }],
      interestRevision: 1,
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(diagnostics).toEqual([
      "terminal-event-socket-open:0",
      "terminal-event-hello:0",
      "terminal-interest-send:1",
      "terminal-interest-ack:1",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 1,
      causeOperationId: null,
    });
    first.resolve(resource(1));
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve(resource(1));
    const prepared = await preparing;
    const observed = vi.fn();
    expect(supervisor.adoptTerminalRuntimeInventory(prepared, observed)).toEqual(resource(1));
    expect(observed).not.toHaveBeenCalled();
    supervisor.dispose();
  });

  it("uses an independent application-shell ACK on the same parser/socket", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    expect(supervisor.adoptTerminalRuntimeInventory(prepared, vi.fn())).not.toBeNull();
    const verified = vi.fn();
    supervisor.connectApplicationShell({
      onVerifiedOpen: verified,
      onInvalidate: vi.fn(),
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    await tick();
    expect(verified).not.toHaveBeenCalled();
    expect(socket.sent[1]).toMatchObject({
      type: "subscribe",
      interests: [{ resource: "terminal-runtime-inventory" }, { resource: "application-shell" }],
      interestRevision: 2,
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(verified).toHaveBeenCalledTimes(1);
    supervisor.dispose();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("acknowledges one exact application-shell mutation before invalidation", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    supervisor.adoptTerminalRuntimeInventory(prepared, vi.fn());
    const ordered: string[] = [];
    const acknowledgements: unknown[] = [];
    const retiredAcknowledgement = vi.fn((acknowledgement: unknown) => {
      acknowledgements.push(acknowledgement);
      ordered.push("ack");
    });
    const retiredInvalidation = vi.fn(() => ordered.push("invalidate"));
    const connection = supervisor.connectApplicationShell({
      onVerifiedOpen: vi.fn(),
      onInvalidate: retiredInvalidation,
      onOperationAcknowledged: retiredAcknowledgement,
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    const operationId = "17000000-0000-4000-8000-000000000017";
    const changed = {
      type: "resource.changed" as const,
      sequence: 1,
      workspaceName: "alpha",
      resource: "application-shell" as const,
      revision: 8,
      causeOperationId: operationId,
    };
    socket.frame(changed);
    expect(ordered).toEqual(["ack", "invalidate"]);
    expect(acknowledgements).toEqual([
      {
        daemonInstanceId: daemon.instanceId,
        operationId,
        sequence: 1,
        revision: 8,
      },
    ]);

    socket.frame(changed);
    socket.frame({ ...changed, sequence: 0 });
    expect(ordered).toEqual(["ack", "invalidate"]);
    socket.frame({ ...changed, sequence: 3, revision: 9 });
    expect(ordered).toEqual(["ack", "invalidate", "invalidate"]);
    expect(retiredAcknowledgement).toHaveBeenCalledTimes(1);
    socket.frame({ ...changed, sequence: 4, workspaceName: "beta", revision: 10 });
    expect(retiredAcknowledgement).toHaveBeenCalledTimes(1);

    connection.close();
    const replacementAcknowledgement = vi.fn();
    const replacementInvalidation = vi.fn();
    const replacementConnection = supervisor.connectApplicationShell({
      onVerifiedOpen: vi.fn(),
      onInvalidate: replacementInvalidation,
      onOperationAcknowledged: replacementAcknowledgement,
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    await tick();
    socket.frame({ ...changed, sequence: 5, revision: 11 });
    expect(retiredAcknowledgement).toHaveBeenCalledTimes(1);
    expect(retiredInvalidation).toHaveBeenCalledTimes(2);
    expect(replacementAcknowledgement).toHaveBeenCalledTimes(1);
    expect(replacementInvalidation).toHaveBeenCalledTimes(1);

    replacementConnection.close();
    const reentrantAcknowledgement = vi.fn();
    const reentrantInvalidation = vi.fn();
    const successorAcknowledgement = vi.fn();
    const successorInvalidation = vi.fn();
    let reentrantConnection!: ReturnType<typeof supervisor.connectApplicationShell>;
    reentrantConnection = supervisor.connectApplicationShell({
      onVerifiedOpen: vi.fn(),
      onInvalidate: reentrantInvalidation,
      onOperationAcknowledged: (acknowledgement) => {
        reentrantAcknowledgement(acknowledgement);
        reentrantConnection.close();
        supervisor.connectApplicationShell({
          onVerifiedOpen: vi.fn(),
          onInvalidate: successorInvalidation,
          onOperationAcknowledged: successorAcknowledgement,
          onMalformedFrame: vi.fn(),
          onPeerMismatch: vi.fn(),
          onProtocolError: vi.fn(),
          onClose: vi.fn(),
          onError: vi.fn(),
        });
      },
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    await tick();
    socket.frame({ ...changed, sequence: 6, revision: 12 });
    expect(reentrantAcknowledgement).toHaveBeenCalledTimes(1);
    expect(reentrantInvalidation).not.toHaveBeenCalled();
    expect(successorInvalidation).not.toHaveBeenCalled();
    socket.frame({ ...changed, sequence: 7, revision: 13 });
    expect(successorAcknowledgement).toHaveBeenCalledTimes(1);
    expect(successorInvalidation).toHaveBeenCalledTimes(1);
    supervisor.dispose();
  });

  it("serializes the full terminal, shell, and catalog interest union on one socket", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const catalogInvalidated = vi.fn();
    const catalog = supervisor.connectWorkspaceCatalog(catalogInvalidated);
    const shellVerified = vi.fn();
    supervisor.connectApplicationShell({
      onVerifiedOpen: shellVerified,
      onInvalidate: vi.fn(),
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      interests: [{ resource: "terminal-runtime-inventory", workspaceName: "alpha" }],
      interestRevision: 1,
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({
      interests: [
        { resource: "terminal-runtime-inventory", workspaceName: "alpha" },
        { resource: "application-shell", workspaceName: "alpha" },
        { resource: "workspace-catalog", workspaceName: null },
      ],
      interestRevision: 2,
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await catalog.ready;
    await tick();
    expect(shellVerified).toHaveBeenCalledTimes(1);

    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: null,
      resource: "workspace-catalog",
      revision: 1,
      causeOperationId: null,
    });
    expect(catalogInvalidated).toHaveBeenCalledTimes(1);
    socket.frame({
      type: "snapshot-required",
      afterSequence: 1,
      oldestAvailableSequence: 2,
      currentSequence: 2,
      reason: "journal-gap",
    });
    expect(catalogInvalidated).toHaveBeenCalledTimes(2);
    socket.frame({
      type: "resource.changed",
      sequence: 4,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 4,
      causeOperationId: null,
    });
    expect(catalogInvalidated).toHaveBeenCalledTimes(3);
    catalog.close();
    socket.frame({
      type: "resource.changed",
      sequence: 5,
      workspaceName: null,
      resource: "workspace-catalog",
      revision: 5,
      causeOperationId: null,
    });
    expect(catalogInvalidated).toHaveBeenCalledTimes(3);
    supervisor.dispose();
  });

  it("reduces an active semantic supervisor to catalog-only authority", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const invalidated = vi.fn();
    const catalog = supervisor.connectWorkspaceCatalog(invalidated);
    supervisor.connectApplicationShell({
      onVerifiedOpen: vi.fn(),
      onInvalidate: vi.fn(),
      onMalformedFrame: vi.fn(),
      onPeerMismatch: vi.fn(),
      onProtocolError: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await catalog.ready;

    const selected = supervisor.selectWorkspaceCatalogOnly();
    await tick();
    expect(socket.sent[2]).toMatchObject({
      type: "subscribe",
      interestRevision: 3,
      interests: [{ resource: "workspace-catalog", workspaceName: null }],
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 3,
      sequence: 0,
      unavailableInterests: [],
    });
    await selected;
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: null,
      resource: "workspace-catalog",
      revision: 1,
      causeOperationId: null,
    });
    expect(invalidated).toHaveBeenCalledOnce();
    supervisor.dispose();
  });

  it("fences a pending terminal install before settling catalog-only fallback", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const catalog = supervisor.connectWorkspaceCatalog(vi.fn());
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      interestRevision: 1,
      interests: [{ resource: "terminal-runtime-inventory" }],
    });
    const selected = supervisor.selectWorkspaceCatalogOnly();
    await tick();
    expect(socket.sent).toHaveLength(1);
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({
      interestRevision: 2,
      interests: [{ resource: "workspace-catalog", workspaceName: null }],
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await Promise.all([catalog.ready, selected]);
    expect(socket.sent).toHaveLength(2);
    supervisor.dispose();
  });

  it("rejects adoption when topology changes after clean completion", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparing;
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 1,
      causeOperationId: null,
    });
    expect(supervisor.adoptTerminalRuntimeInventory(prepared, vi.fn())).toBeNull();
    supervisor.dispose();
  });

  it("publishes nothing when both bounded initial attempts become dirty", async () => {
    const socket = new FakeSocket();
    const first = deferred<ReturnType<typeof resource>>();
    const second = deferred<ReturnType<typeof resource>>();
    const reads = [first, second];
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: () => reads.shift()!.promise,
    });
    const preparing = supervisor.prepareTerminalRuntimeInventory(new AbortController().signal);
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    await tick();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    await tick();
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 1,
      causeOperationId: null,
    });
    first.resolve(resource(1));
    await tick();
    socket.frame({
      type: "resource.changed",
      sequence: 2,
      workspaceName: "alpha",
      resource: "terminal-runtime-inventory",
      revision: 2,
      causeOperationId: null,
    });
    second.resolve(resource(2));
    await expect(preparing).rejects.toThrow("changed during synchronization");
    supervisor.dispose();
  });

  it("closes fail-closed on a malformed frame instead of retaining stale authority", async () => {
    const socket = new FakeSocket();
    const supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon,
      workspaceName: "alpha",
      sessionName: "tmux-alpha",
      fetchTerminalRuntimeInventory: async () => resource(0),
    });
    socket.emit("open");
    socket.frame({ type: "hello", daemon, sessions: [], eventSequence: 0 });
    socket.emit("message", { data: "not-json" });
    expect(socket.close).toHaveBeenCalledWith(1008, "Invalid daemon event protocol");
    supervisor.dispose();
  });
});
