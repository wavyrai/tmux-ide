import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _resetResourceEventJournalForTests,
  _resourceObserverStateForTests,
  _setResourceObservationOverrideForTests,
  _stopSessionsPollerForTests,
  broadcastInteractionReceipt,
  broadcastResourceChanged,
  handleWsEventsConnection,
} from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";

// This suite exercises only the client-frame protocol, never live session
// discovery. `handleWsEventsConnection` eagerly calls `discoverSessions()`
// (hello + sessions poller), which by default spawns `tmux` against the
// caller's real default socket. Under parallel test load those synchronous
// subprocess spawns block the worker long enough to trip the test timeout,
// and they reach into the user's real tmux server — both forbidden. Pin a
// runner that returns no sessions so discovery is instant and hermetic.
let restoreTmuxRunner: (() => void) | null = null;

beforeAll(() => {
  restoreTmuxRunner = _setTmuxRunner(() => "");
});

afterAll(() => {
  restoreTmuxRunner?.();
  restoreTmuxRunner = null;
});

const daemonIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;

class ProtocolWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string): void {
    this.emit("message", data, false);
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function frames(socket: ProtocolWebSocket): DaemonEventServerFrame[] {
  return socket.sent.map((value) => DaemonEventServerFrameSchemaZ.parse(JSON.parse(value)));
}

async function flushProtocol(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  _setResourceObservationOverrideForTests(null);
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
  _resetResourceEventJournalForTests();
});

describe("/ws/events client frame protocol", () => {
  it("waits for observer installation and acknowledges the post-install sequence", async () => {
    let install!: (value: { status: "installed" }) => void;
    _setResourceObservationOverrideForTests(() => ({
      release: vi.fn(),
      ready: new Promise((resolve) => {
        install = resolve;
      }),
    }));
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.sent.length = 0;
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interestRevision: 1,
        interests: [{ resource: "workspace-files", workspaceName: "alpha" }],
        afterSequence: 0,
      }),
    );
    broadcastResourceChanged(
      { workspaceName: "alpha", resource: "workspace-files" },
      daemonIdentity.instanceId,
    );
    expect(frames(socket).map(({ type }) => type)).toEqual(["resource.changed"]);
    install({ status: "installed" });
    await flushProtocol();
    expect(frames(socket).at(-1)).toEqual({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 1,
      unavailableInterests: [],
    });
    socket.disconnect();
  });

  it("serializes add then remove while installation is pending", async () => {
    let install!: (value: { status: "installed" }) => void;
    const release = vi.fn();
    _setResourceObservationOverrideForTests(() => ({
      release,
      ready: new Promise((resolve) => {
        install = resolve;
      }),
    }));
    const interest = { resource: "workspace-files", workspaceName: "alpha" } as const;
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.sent.length = 0;
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [interest],
        interestRevision: 1,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "unsubscribe",
        sessions: [],
        interests: [interest],
        interestRevision: 2,
      }),
    );
    expect(frames(socket)).toEqual([]);
    install({ status: "installed" });
    await flushProtocol();
    expect(frames(socket).filter(({ type }) => type === "resource.interests-ack")).toEqual([
      {
        type: "resource.interests-ack",
        interestRevision: 1,
        sequence: 0,
        unavailableInterests: [],
      },
      {
        type: "resource.interests-ack",
        interestRevision: 2,
        sequence: 0,
        unavailableInterests: [],
      },
    ]);
    expect(release).toHaveBeenCalledOnce();
    socket.disconnect();
  });

  it("reports an unavailable observer in the ack and retries the same key", async () => {
    const release = vi.fn();
    let attempt = 0;
    _setResourceObservationOverrideForTests(() => ({
      release,
      ready: Promise.resolve({ status: ++attempt === 1 ? "unavailable" : "installed" }),
    }));
    const interest = { resource: "workspace-files", workspaceName: "alpha" } as const;
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.sent.length = 0;
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [interest],
        interestRevision: 1,
      }),
    );
    await flushProtocol();
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [interest],
        interestRevision: 2,
      }),
    );
    await flushProtocol();
    expect(frames(socket).filter(({ type }) => type === "resource.interests-ack")).toEqual([
      {
        type: "resource.interests-ack",
        interestRevision: 1,
        sequence: 0,
        unavailableInterests: [interest],
      },
      {
        type: "resource.interests-ack",
        interestRevision: 2,
        sequence: 0,
        unavailableInterests: [],
      },
    ]);
    expect(release).toHaveBeenCalledOnce();
    socket.disconnect();
  });

  it("keeps semantic hello and delivery free of raw path-bearing frames", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    expect(frames(socket)[0]).toMatchObject({ type: "hello", sessions: [] });
    socket.receive(JSON.stringify({ type: "subscribe", sessions: ["secret"], legacyEvents: true }));
    expect(JSON.stringify(frames(socket))).not.toContain("projectDir");
    expect(frames(socket).some(({ type }) => type === "snapshot")).toBe(false);
    socket.disconnect();
  });

  it("binds the initial hello to the supplied daemon generation", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);

    expect(frames(socket)[0]).toMatchObject({ type: "hello", daemon: daemonIdentity });
    socket.disconnect();
  });

  it("does no observation work before demand and never starts legacy observers for explicit demand", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    expect(_resourceObserverStateForTests()).toMatchObject({
      sessions: 0,
      projects: 0,
      agents: 0,
      fleet: 0,
    });
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [{ resource: "workspace-files", workspaceName: "alpha" }],
      }),
    );
    expect(_resourceObserverStateForTests()).toMatchObject({
      sessions: 0,
      projects: 0,
      agents: 0,
      fleet: 0,
    });
    socket.disconnect();

    const legacy = new ProtocolWebSocket();
    handleWsEventsConnection(legacy, daemonIdentity);
    legacy.receive(JSON.stringify({ type: "subscribe", sessions: [] }));
    expect(_resourceObserverStateForTests()).toMatchObject({
      sessions: 1,
      projects: 1,
      agents: 1,
      fleet: 1,
    });
    legacy.disconnect();
  });

  it("keeps broad legacy observation and explicit workspace demand on one socket", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: true,
        interests: [{ resource: "workspace-files", workspaceName: "mixed" }],
      }),
    );
    expect(_resourceObserverStateForTests()).toMatchObject({
      sessions: 1,
      projects: 1,
      agents: 1,
      fleet: 1,
      workspaces: [{ workspaceName: "mixed", references: 1 }],
    });
    socket.sent.length = 0;
    broadcastResourceChanged(
      { workspaceName: "other", resource: "workspace-files" },
      daemonIdentity.instanceId,
    );
    expect(frames(socket)[0]).toMatchObject({ type: "resource.changed", workspaceName: "other" });
    socket.disconnect();
  });

  it("hides unmatched interaction receipt identity behind an observed cursor", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.sent.length = 0;
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [{ resource: "application-shell", workspaceName: "beta" }],
      }),
    );
    socket.sent.length = 0;
    broadcastInteractionReceipt(
      {
        operationId: "10000000-0000-4000-8000-000000000001",
        origin: "external",
        workspaceName: "alpha",
        target: { kind: "pane", semanticPaneId: "pane.editor" },
        operationKind: "workspace.pane.read",
        phase: "observed",
        summary: { operationKind: "workspace.pane.read", observedOnly: true },
        proof: {
          operationKind: "workspace.pane.read",
          observed: true,
          semanticPaneId: "pane.editor",
        },
      },
      daemonIdentity.instanceId,
    );
    expect(frames(socket)).toEqual([{ type: "resource.observed", sequence: 1 }]);
    expect(JSON.stringify(frames(socket))).not.toContain("alpha");
    socket.disconnect();
  });

  it("reports malformed JSON deterministically and keeps the socket usable", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    socket.receive("not-json");
    socket.receive(JSON.stringify({ type: "ping" }));

    expect(frames(socket)).toEqual([
      {
        type: "protocol.error",
        code: "invalid-json",
        message: "Client frame must be valid JSON.",
      },
      { type: "pong" },
    ]);
    socket.disconnect();
  });

  it("rejects malformed subscribe frames without throwing or changing subscription state", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    expect(() => socket.receive(JSON.stringify({ type: "subscribe" }))).not.toThrow();
    expect(() =>
      socket.receive(JSON.stringify({ type: "subscribe", sessions: "tmux-ide", unexpected: true })),
    ).not.toThrow();
    socket.receive(JSON.stringify({ type: "ping" }));

    expect(frames(socket)).toEqual([
      {
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      },
      {
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      },
      { type: "pong" },
    ]);
    socket.disconnect();
  });

  it("rejects unknown and extra client fields rather than accepting structural lookalikes", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    socket.receive(JSON.stringify({ type: "ping", extra: true }));
    socket.receive(JSON.stringify({ type: "future.event" }));

    expect(frames(socket).map(({ type }) => type)).toEqual(["protocol.error", "protocol.error"]);
    socket.disconnect();
  });

  it("replays retained scoped invalidations after a reconnect cursor", () => {
    broadcastResourceChanged(
      {
        workspaceName: "tmux-ide",
        resource: "application-shell",
        revision: 7,
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      daemonIdentity.instanceId,
    );
    broadcastResourceChanged(
      { workspaceName: "tmux-ide", resource: "application-shell", revision: 8 },
      daemonIdentity.instanceId,
    );
    // A lower domain-local revision cannot move the shared resource clock
    // backwards after another mutation kind already advanced it.
    broadcastResourceChanged(
      { workspaceName: "tmux-ide", resource: "application-shell", revision: 4 },
      daemonIdentity.instanceId,
    );

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    expect(frames(socket)[0]).toMatchObject({ type: "hello", eventSequence: 3 });
    socket.sent.length = 0;
    socket.receive(JSON.stringify({ type: "subscribe", sessions: [], afterSequence: 0 }));

    expect(frames(socket)).toEqual([
      expect.objectContaining({ type: "resource.changed", sequence: 1, revision: 7 }),
      expect.objectContaining({ type: "resource.changed", sequence: 2, revision: 8 }),
      expect.objectContaining({ type: "resource.changed", sequence: 3, revision: 9 }),
    ]);
    socket.disconnect();
  });

  it("delivers scoped invalidations only to explicit interests while preserving cursors", () => {
    const shell = new ProtocolWebSocket();
    const files = new ProtocolWebSocket();
    handleWsEventsConnection(shell, daemonIdentity);
    handleWsEventsConnection(files, daemonIdentity);
    shell.sent.length = 0;
    files.sent.length = 0;
    shell.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        afterSequence: 0,
        interests: [{ resource: "application-shell", workspaceName: "alpha" }],
      }),
    );
    files.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        afterSequence: 0,
        interests: [{ resource: "workspace-files", workspaceName: "beta" }],
      }),
    );
    shell.sent.length = 0;
    files.sent.length = 0;

    broadcastResourceChanged(
      { workspaceName: "alpha", resource: "application-shell" },
      daemonIdentity.instanceId,
    );
    broadcastResourceChanged(
      { workspaceName: "beta", resource: "workspace-files" },
      daemonIdentity.instanceId,
    );

    expect(frames(shell)).toEqual([
      expect.objectContaining({ type: "resource.changed", sequence: 1 }),
      { type: "resource.observed", sequence: 2 },
    ]);
    expect(frames(files)).toEqual([
      { type: "resource.observed", sequence: 1 },
      expect.objectContaining({ type: "resource.changed", sequence: 2 }),
    ]);
    shell.disconnect();
    files.disconnect();
  });

  it("refcounts shared observation demand and releases it after the last client", () => {
    const one = new ProtocolWebSocket();
    const two = new ProtocolWebSocket();
    handleWsEventsConnection(one, daemonIdentity);
    handleWsEventsConnection(two, daemonIdentity);
    one.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [{ resource: "workspace-files", workspaceName: "late-workspace" }],
      }),
    );
    two.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: false,
        interests: [{ resource: "workspace-files", workspaceName: "late-workspace" }],
      }),
    );
    expect(_resourceObserverStateForTests()).toMatchObject({
      sessions: 0,
      projects: 0,
      agents: 0,
      fleet: 0,
      workspaces: [{ workspaceName: "late-workspace", references: 2 }],
    });
    one.disconnect();
    expect(_resourceObserverStateForTests().workspaces[0]?.references).toBe(1);
    two.disconnect();
    expect(_resourceObserverStateForTests().workspaces).toEqual([]);
  });

  it("orders privacy-safe interaction receipts with resources for every client and replay", () => {
    const left = new ProtocolWebSocket();
    const right = new ProtocolWebSocket();
    handleWsEventsConnection(left, daemonIdentity);
    handleWsEventsConnection(right, daemonIdentity);
    left.sent.length = 0;
    right.sent.length = 0;
    left.receive(JSON.stringify({ type: "subscribe", sessions: [], afterSequence: 0 }));
    right.receive(JSON.stringify({ type: "subscribe", sessions: [], afterSequence: 0 }));
    left.sent.length = 0;
    right.sent.length = 0;

    broadcastResourceChanged(
      { workspaceName: "tmux-ide", resource: "application-shell" },
      daemonIdentity.instanceId,
    );
    broadcastInteractionReceipt(
      {
        operationId: "10000000-0000-4000-8000-000000000001",
        origin: "cli",
        workspaceName: "tmux-ide",
        target: { kind: "pane", semanticPaneId: "pane.editor" },
        operationKind: "workspace.pane.send",
        phase: "observed",
        summary: {
          operationKind: "workspace.pane.send",
          characterCount: 17,
          byteCount: 17,
          submitted: true,
        },
        proof: {
          operationKind: "workspace.pane.send",
          observed: true,
          semanticPaneId: "pane.editor",
        },
        at: "2026-08-10T10:00:00.000Z",
      },
      daemonIdentity.instanceId,
    );

    expect(frames(left)).toEqual(frames(right));
    expect(
      frames(left).map((frame) => [frame.type, "sequence" in frame ? frame.sequence : null]),
    ).toEqual([
      ["resource.changed", 1],
      ["interaction.receipt", 2],
    ]);
    expect(JSON.stringify(frames(left))).not.toContain("prompt");

    const replay = new ProtocolWebSocket();
    handleWsEventsConnection(replay, daemonIdentity);
    replay.sent.length = 0;
    replay.receive(JSON.stringify({ type: "subscribe", sessions: [], afterSequence: 1 }));
    expect(frames(replay)).toEqual([
      expect.objectContaining({ type: "interaction.receipt", sequence: 2 }),
    ]);

    left.disconnect();
    right.disconnect();
    replay.disconnect();
  });

  it("requires a snapshot when a reconnect cursor fell behind the bounded journal", () => {
    for (let index = 0; index < 257; index += 1) {
      broadcastResourceChanged(
        { workspaceName: "tmux-ide", resource: "application-shell" },
        daemonIdentity.instanceId,
      );
    }
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;
    socket.receive(JSON.stringify({ type: "subscribe", sessions: [], afterSequence: 0 }));

    expect(frames(socket)).toEqual([
      {
        type: "snapshot-required",
        afterSequence: 0,
        oldestAvailableSequence: 2,
        currentSequence: 257,
        reason: "journal-gap",
      },
    ]);
    socket.disconnect();
  });
});
