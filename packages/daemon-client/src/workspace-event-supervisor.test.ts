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

describe("WorkspaceEventSupervisor", () => {
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
