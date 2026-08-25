import { describe, expect, it, vi } from "vitest";
import {
  blankTerminalReplicaSnapshot,
  applyTerminalReplicaUpdate,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "@tmux-ide/core";

import {
  PANE_STREAM_MAX_DESCRIPTOR_LIFETIME_MS,
  PANE_STREAM_REDEEM_RESPONSE_TIMEOUT_MS,
  PANE_STREAM_TRANSPORT_PROTOCOL,
  PaneStreamIssueFailure,
  createPaneStreamTransport,
  type PaneMirrorEvent,
  type PaneStreamConnectResult,
  type PaneStreamDiagnosticLifecycleEvent,
  type PaneStreamSessionListeners,
  type PaneStreamSocketListener,
  type PaneStreamTransportError,
  type PaneStreamWebSocket,
} from "./pane-stream-transport.ts";

const DAEMON_INSTANCE_ID = "0b0e2a86-04ee-4f5f-9f0c-1d1b3c67f100";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const TICKET = `ps1_${"A".repeat(43)}`;
const WS_URL = "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem";
const PANE_A = "pane.workspace.a1";
const PANE_B = "pane.workspace.b2";

function authoritySnapshot(input: string | null, revision: number) {
  return {
    generation: DAEMON_INSTANCE_ID,
    session: "workspace-a",
    revision,
    owners: { input, focus: null, geometry: null },
    nativeGeometryYieldUntilMs: 0,
    clients: [],
  };
}

function inputLease(clientId: string, revision: number) {
  return {
    generation: DAEMON_INSTANCE_ID,
    session: "workspace-a",
    clientId,
    authority: "input" as const,
    token: globalThis.crypto.randomUUID(),
    revision,
  };
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function encodeBytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function sendSemanticReady(socket: FakeSocket, pane = PANE_A): void {
  const negotiation = negotiateTerminalDelivery(
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: true },
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
  );
  if (!negotiation.accepted) throw new Error("semantic negotiation failed");
  socket.serverSends({ type: "terminal-delivery-ready", pane, negotiation });
}

interface Scheduled {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class Clock {
  #now = 1_000_000;
  readonly #scheduled: Scheduled[] = [];

  now = (): number => this.#now;

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const entry: Scheduled = { at: this.#now + delayMs, callback, cancelled: false };
    this.#scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  async advance(byMs: number): Promise<void> {
    const target = this.#now + byMs;
    while (true) {
      const due = this.#scheduled
        .filter((entry) => !entry.cancelled && entry.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.#scheduled.splice(this.#scheduled.indexOf(due), 1);
      this.#now = due.at;
      due.callback();
      await flushMicrotasks();
    }
    this.#now = target;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

class FakeSocket implements PaneStreamWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  protocol = PANE_STREAM_TRANSPORT_PROTOCOL;
  binaryType: BinaryType = "blob";
  readonly sent: string[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  readonly #listeners = new Map<string, Set<PaneStreamSocketListener>>();

  addEventListener(type: string, listener: PaneStreamSocketListener): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: PaneStreamSocketListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  emit(type: "open" | "message" | "close" | "error", data?: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({ data });
  }

  peerCloses(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of [...(this.#listeners.get("close") ?? [])]) listener({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  serverSends(frame: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(frame));
  }
}

function descriptor(clock: Clock, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    webSocketUrl: WS_URL,
    subprotocol: PANE_STREAM_TRANSPORT_PROTOCOL,
    redemptionTicket: TICKET,
    daemonInstanceId: DAEMON_INSTANCE_ID,
    requestId: REQUEST_ID,
    expiresAt: clock.now() + 15_000,
    panes: [PANE_A, PANE_B],
    effectiveViewerMode: "read-only",
    ...overrides,
  };
}

interface Harness {
  readonly clock: Clock;
  readonly socket: FakeSocket;
  readonly events: { pane: string; event: PaneMirrorEvent }[];
  readonly ends: (PaneStreamTransportError | null)[];
  readonly connect: Promise<PaneStreamConnectResult>;
  settleApply(): void;
}

function harness(options: {
  descriptorOverrides?: Record<string, unknown>;
  panes?: readonly string[];
  deferApplies?: boolean;
  listeners?: Partial<PaneStreamSessionListeners>;
  terminalDelivery?: null;
  viewerMode?: "read-only" | "interactive";
}): Harness {
  const clock = new Clock();
  const socket = new FakeSocket();
  const events: { pane: string; event: PaneMirrorEvent }[] = [];
  const ends: (PaneStreamTransportError | null)[] = [];
  const pendingApplies: (() => void)[] = [];
  const transport = createPaneStreamTransport({
    issuePaneStream: async () => descriptor(clock, options.descriptorOverrides),
    createWebSocket: () => socket,
    now: clock.now,
    schedule: clock.schedule,
    ...(options.terminalDelivery === null ? { terminalDelivery: null } : {}),
  });
  const connect = transport.connect(
    {
      workspaceName: "workspace-a",
      panes: options.panes ?? [PANE_A, PANE_B],
      viewerMode: options.viewerMode,
    },
    {
      onPaneEvent: (pane, event) => {
        events.push({ pane, event });
        if (!options.deferApplies) return undefined;
        return new Promise<void>((resolve) => {
          pendingApplies.push(resolve);
        });
      },
      onEnd: (error) => {
        ends.push(error);
      },
      ...options.listeners,
    },
  );
  return {
    clock,
    socket,
    events,
    ends,
    connect,
    settleApply: () => pendingApplies.shift()?.(),
  };
}

async function liveHarness(
  options: Parameters<typeof harness>[0] = {},
): Promise<Harness & { result: Extract<PaneStreamConnectResult, { status: "connected" }> }> {
  const h = harness(options);
  await flushMicrotasks();
  h.socket.open();
  h.socket.serverSends({
    type: "ready",
    protocolVersion: 1,
    daemonInstanceId: DAEMON_INSTANCE_ID,
    requestId: REQUEST_ID,
    panes: [...(options.panes ?? [PANE_A, PANE_B])],
    effectiveViewerMode: options.viewerMode ?? "read-only",
  });
  const result = await h.connect;
  expect(result.status).toBe("connected");
  return { ...h, result: result as Extract<PaneStreamConnectResult, { status: "connected" }> };
}

describe("pane-stream transport admission", () => {
  it("reports bounded causal stages and exact typed peer/client/dispose terminals", async () => {
    const peerEvents: PaneStreamDiagnosticLifecycleEvent[] = [];
    const peer = await liveHarness({
      listeners: { onDiagnosticLifecycle: (event) => peerEvents.push(event) },
    });
    peer.socket.serverSends({
      type: "layout-snapshot",
      topologyEpoch: 1,
      layouts: [
        {
          type: "layout",
          semanticWindowId: "window.workspace.one",
          windowName: "work",
          currentWindow: true,
          cols: 200,
          rows: 50,
          zoomed: false,
          paneBorderStatus: "off",
          panes: [
            { pane: PANE_A, left: 0, top: 0, width: 100, height: 50, active: true },
            { pane: PANE_B, left: 100, top: 0, width: 100, height: 50, active: false },
          ],
        },
      ],
    });
    sendSemanticReady(peer.socket);
    peer.socket.peerCloses(1012, "topology-changed");
    expect(peerEvents.map(({ stage }) => stage)).toEqual([
      "issued",
      "socket-open",
      "server-ready",
      "layout-validated",
      "delivery-open",
      "terminal",
    ]);
    expect(peerEvents.at(-1)).toMatchObject({
      code: "stream-closed",
      origin: "peer",
      closeCode: 1012,
      closeReason: "topology-changed",
    });
    const peerCount = peerEvents.length;
    peer.socket.serverSends({
      type: "error",
      protocolVersion: 1,
      code: "stream-unavailable",
      retryable: true,
    });
    expect(peerEvents).toHaveLength(peerCount);

    const protocolEvents: PaneStreamDiagnosticLifecycleEvent[] = [];
    const protocol = await liveHarness({
      listeners: { onDiagnosticLifecycle: (event) => protocolEvents.push(event) },
    });
    protocol.socket.serverSends({ nope: true });
    expect(protocolEvents.at(-1)).toMatchObject({
      stage: "terminal",
      code: "protocol-error",
      origin: "peer",
      closeCode: 1002,
      closeReason: "protocol-error",
    });

    const typedEvents: PaneStreamDiagnosticLifecycleEvent[] = [];
    const typed = await liveHarness({
      listeners: { onDiagnosticLifecycle: (event) => typedEvents.push(event) },
    });
    typed.socket.serverSends({
      type: "error",
      protocolVersion: 1,
      code: "topology-changed",
      retryable: true,
    });
    expect(typedEvents.at(-1)).toMatchObject({
      stage: "terminal",
      code: "topology-changed",
      origin: "peer",
      closeCode: 1008,
      closeReason: "topology-changed",
    });

    const disposeEvents: PaneStreamDiagnosticLifecycleEvent[] = [];
    const disposed = await liveHarness({
      listeners: { onDiagnosticLifecycle: (event) => disposeEvents.push(event) },
    });
    disposed.result.session.dispose();
    expect(disposeEvents.at(-1)).toMatchObject({
      stage: "terminal",
      code: "disposed",
      origin: "dispose",
      closeCode: 1000,
      closeReason: "renderer-disposed",
    });
  });

  it("rejects an invalid semantic request without calling the issuer", async () => {
    const issue = vi.fn();
    const transport = createPaneStreamTransport({ issuePaneStream: issue });
    const result = await transport.connect(
      { workspaceName: "workspace-a", panes: [] },
      { onPaneEvent: () => undefined, onEnd: () => undefined },
    );
    expect(result).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(issue).not.toHaveBeenCalled();
  });

  it("surfaces the structured issue failure instead of a generic error", async () => {
    const clock = new Clock();
    const transport = createPaneStreamTransport({
      issuePaneStream: async () => {
        throw new PaneStreamIssueFailure(
          "pane-not-found",
          "A requested pane is unavailable.",
          false,
        );
      },
      now: clock.now,
      schedule: clock.schedule,
    });
    const result = await transport.connect(
      { workspaceName: "workspace-a", panes: [PANE_A] },
      { onPaneEvent: () => undefined, onEnd: () => undefined },
    );
    expect(result).toMatchObject({
      status: "error",
      error: { code: "pane-not-found", retryable: false },
    });
  });

  it("collapses an issue timeout to the generic retryable failure", async () => {
    const clock = new Clock();
    const transport = createPaneStreamTransport({
      issuePaneStream: () => new Promise(() => undefined),
      now: clock.now,
      schedule: clock.schedule,
    });
    const pending = transport.connect(
      { workspaceName: "workspace-a", panes: [PANE_A] },
      { onPaneEvent: () => undefined, onEnd: () => undefined },
    );
    await clock.advance(5_001);
    expect(await pending).toMatchObject({
      status: "error",
      error: { code: "pane-stream-issue-failed", retryable: true },
    });
  });

  it.each([
    ["expired descriptor", { expiresAt: 999_999 }],
    [
      "over-lifetime descriptor",
      { expiresAt: 1_000_000 + PANE_STREAM_MAX_DESCRIPTOR_LIFETIME_MS + 1 },
    ],
    ["viewer-mode drift", { effectiveViewerMode: "interactive" }],
    ["pane-set drift", { panes: [PANE_A] }],
    ["non-loopback url", { webSocketUrl: "ws://example.com:6060/v1/terminal/pane-streams/redeem" }],
  ])("rejects a descriptor with %s", async (_label, overrides) => {
    const h = harness({ descriptorOverrides: overrides });
    expect(await h.connect).toMatchObject({
      status: "error",
      error: { code: "invalid-descriptor" },
    });
  });

  it("sends exactly one redeem frame without claiming the legacy ACK lane", async () => {
    const h = await liveHarness();
    expect(h.socket.sent).toHaveLength(1);
    expect(JSON.parse(h.socket.sent[0]!)).toEqual({
      type: "redeem",
      protocolVersion: 1,
      ticket: TICKET,
      requestId: REQUEST_ID,
      daemonInstanceId: DAEMON_INSTANCE_ID,
    });
  });

  it("reports the exact validated physical descriptor before opening its socket", async () => {
    const issued = vi.fn();
    const h = await liveHarness({ listeners: { onDescriptorIssued: issued } });
    expect(issued).toHaveBeenCalledTimes(1);
    expect(issued).toHaveBeenCalledWith({
      daemonInstanceId: DAEMON_INSTANCE_ID,
      requestId: REQUEST_ID,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
      subprotocol: PANE_STREAM_TRANSPORT_PROTOCOL,
    });
    h.result.session.dispose();
  });

  it("retains cumulative delivery ACKs for the explicit legacy profile", async () => {
    const h = await liveHarness({ terminalDelivery: null });
    expect(JSON.parse(h.socket.sent[0]!)).toEqual({
      type: "redeem",
      protocolVersion: 1,
      ticket: TICKET,
      requestId: REQUEST_ID,
      daemonInstanceId: DAEMON_INSTANCE_ID,
      deliveryAcks: true,
    });
  });

  it("moves expiry authority to the daemon once the redeem frame is sent", async () => {
    const h = harness({});
    await flushMicrotasks();
    h.socket.open();
    // Well past the ticket TTL: delivery already happened, so no local expiry.
    await h.clock.advance(20_000);
    expect(h.ends).toHaveLength(0);
    // Only the bounded no-answer ceiling may fire.
    await h.clock.advance(PANE_STREAM_REDEEM_RESPONSE_TIMEOUT_MS);
    expect(await h.connect).toMatchObject({
      status: "error",
      error: { code: "redeem-timeout", retryable: true },
    });
  });

  it("expires locally when the socket never opens within the ticket TTL", async () => {
    const h = harness({});
    await flushMicrotasks();
    await h.clock.advance(15_001);
    expect(await h.connect).toMatchObject({
      status: "error",
      error: { code: "stream-expired", retryable: true },
    });
  });

  it("rejects a ready frame that mutates the pane set", async () => {
    const h = harness({});
    await flushMicrotasks();
    h.socket.open();
    h.socket.serverSends({
      type: "ready",
      protocolVersion: 1,
      daemonInstanceId: DAEMON_INSTANCE_ID,
      requestId: REQUEST_ID,
      panes: [PANE_B, PANE_A],
      effectiveViewerMode: "read-only",
    });
    expect(await h.connect).toMatchObject({
      status: "error",
      error: { code: "protocol-error", retryable: false },
    });
  });

  it("maps a pre-ready error frame to its typed stream error", async () => {
    const h = harness({});
    await flushMicrotasks();
    h.socket.open();
    h.socket.serverSends({
      type: "error",
      protocolVersion: 1,
      code: "ticket-expired",
      retryable: true,
    });
    expect(await h.connect).toMatchObject({
      status: "error",
      error: { code: "ticket-expired", retryable: true },
    });
  });
});

describe("pane-stream transport demultiplexing", () => {
  it("accepts semantic negotiation exactly once", async () => {
    const h = await liveHarness();
    sendSemanticReady(h.socket);
    sendSemanticReady(h.socket);
    await flushMicrotasks();
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error", retryable: false })]);
  });

  it("rejects legacy terminal bytes after semantic cutover", async () => {
    const h = await liveHarness();
    sendSemanticReady(h.socket);
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 1, data: encodeBase64("stale") });
    await flushMicrotasks();
    expect(h.events).toHaveLength(0);
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error", retryable: false })]);
  });

  it("never resurrects a semantic lane after a delivery fault", async () => {
    const h = await liveHarness();
    h.socket.serverSends({
      type: "terminal-delivery-fault",
      pane: PANE_A,
      fault: {
        type: "terminal.delivery.fault",
        reason: "source-closed",
        message: "source closed",
        deliveryNonce: "20000000-0000-4000-8000-000000000002",
      },
    });
    sendSemanticReady(h.socket);
    await flushMicrotasks();
    // The invalid resurrection retires the session before the queued fault
    // paint can run; importantly, no stale terminal state reaches the sink.
    expect(h.events).toEqual([]);
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error", retryable: false })]);
  });

  it.each([
    ["semantic-v1", "semantic-v1", true, false],
    ["semantic-compact-v1", "semantic-compact-v1", true, false],
    ["semantic-compact-v1", "semantic-v1", true, false],
    ["semantic-v1", "semantic-compact-v1", false, false],
    ["semantic-compact-v1", "semantic-v1", false, true],
  ] as const)(
    "applies a %s negotiation / %s envelope seed atomically and ACKs only after the renderer settles",
    async (negotiatedEncoding, encoding, accepted, malformed) => {
      const lifecycle: PaneStreamDiagnosticLifecycleEvent[] = [];
      const h = await liveHarness({
        deferApplies: true,
        listeners: { onDiagnosticLifecycle: (event) => lifecycle.push(event) },
      });
      const generation = "20000000-0000-4000-8000-000000000001";
      const deliveryNonce = "20000000-0000-4000-8000-000000000002";
      const transactionId = "20000000-0000-4000-8000-000000000003";
      const negotiation = negotiateTerminalDelivery(
        {
          protocolVersions: [1],
          encodings:
            negotiatedEncoding === "semantic-compact-v1"
              ? ["semantic-compact-v1", "semantic-v1"]
              : ["semantic-v1"],
          richPlacements: true,
        },
        generation,
        deliveryNonce,
      );
      if (!negotiation.accepted) throw new Error("semantic negotiation failed");
      const normal = blankTerminalReplicaSnapshot(12, 4);
      const snapshot = {
        ...normal,
        modes: {
          ...normal.modes,
          alternateScreen: true,
          applicationCursor: true,
          applicationKeypad: true,
          bracketedPaste: true,
          insert: true,
          origin: true,
          mouseTracking: true,
          mouseProtocol: "drag" as const,
          mouseEncoding: "sgr" as const,
          synchronizedOutput: true,
        },
      };
      const payload = { frame: "seed" as const, revision: 0, snapshot };
      const bytes = malformed
        ? new TextEncoder().encode("{")
        : encoding === "semantic-compact-v1"
          ? encodeCompactSemanticTerminalUpdate(payload)
          : encodeSemanticTerminalUpdate(payload);
      const incarnation = `${generation}:0`;
      h.socket.serverSends({
        type: "terminal-delivery-ready",
        pane: PANE_A,
        negotiation,
      });
      h.socket.serverSends({
        type: "terminal-delivery-envelope",
        pane: PANE_A,
        envelope: {
          type: "terminal.delivery",
          workspaceName: "workspace-a",
          semanticPaneId: PANE_A,
          generation,
          incarnation,
          deliveryNonce,
          transactionId,
          protocolVersion: 1,
          encoding,
          frame: "seed",
          baseRevision: null,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
          representationHash: hashTerminalDeliveryRepresentation(bytes),
          representationBytes: bytes.byteLength,
          chunkCount: splitTerminalDeliveryChunks(transactionId, bytes).length,
          canonicalEquivalent: true,
          history: "complete",
          richPlacements: true,
        },
      });
      for (const chunk of splitTerminalDeliveryChunks(transactionId, bytes)) {
        h.socket.serverSends({
          type: "terminal-delivery-chunk",
          pane: PANE_A,
          transactionId,
          index: chunk.index,
          data: encodeBytesBase64(chunk.bytes),
        });
      }
      if (accepted) expect(lifecycle.some(({ stage }) => stage === "first-seed")).toBe(true);
      await flushMicrotasks();
      if (!accepted) {
        expect(h.events).toEqual([]);
        expect(h.ends).toEqual([
          expect.objectContaining({ code: "protocol-error", retryable: false }),
        ]);
        return;
      }
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({ pane: PANE_A, event: { type: "seed-batch" } });
      const seeded = h.events[0]!.event;
      if (seeded.type !== "seed-batch") throw new Error("semantic seed event was unavailable");
      expect(seeded.canonical?.deliveryRequestId).toBe(REQUEST_ID);
      expect(seeded.canonicalUpdate).toMatchObject({
        type: "terminal.seed",
        workspaceName: "workspace-a",
        semanticPaneId: PANE_A,
        generation,
        incarnation,
        revision: 0,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
      });
      const adopted = applyTerminalReplicaUpdate(null, seeded.canonicalUpdate!);
      expect(adopted.status).toBe("applied");
      expect(adopted.state?.snapshot).toStrictEqual(snapshot);
      const presented = new TextDecoder().decode(seeded.batch.seed);
      expect(presented.startsWith("\u001b[?1049h")).toBe(true);
      for (const sequence of [
        "\u001b[?1h",
        "\u001b=",
        "\u001b[?2004h",
        "\u001b[4h",
        "\u001b[?6h",
        "\u001b[?1002h",
        "\u001b[?1006h",
        "\u001b[?2026h",
      ])
        expect(presented).toContain(sequence);
      expect(h.socket.sent).toHaveLength(1);
      h.settleApply();
      await flushMicrotasks();
      expect(JSON.parse(h.socket.sent[1]!)).toMatchObject({
        type: "terminal-delivery-ack",
        ack: {
          workspaceName: "workspace-a",
          semanticPaneId: PANE_A,
          canonicalRevision: 0,
          transactionId,
        },
      });
    },
  );

  it("delivers per-pane events in wire order with decoded bytes", async () => {
    const h = await liveHarness();
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 1, data: encodeBase64("alpha") });
    h.socket.serverSends({ type: "output", pane: PANE_B, seq: 1, data: encodeBase64("beta") });
    h.socket.serverSends({ type: "cursor", pane: PANE_A, seq: 2, x: 3, y: 4 });
    await flushMicrotasks();
    expect(h.events.map(({ pane, event }) => `${pane}:${event.type}`)).toEqual([
      `${PANE_A}:output`,
      `${PANE_B}:output`,
      `${PANE_A}:cursor`,
    ]);
    const first = h.events[0]!.event;
    expect(first.type === "output" && new TextDecoder().decode(first.bytes)).toBe("alpha");
  });

  it("decodes a seed-batch into ONE atomic paint event", async () => {
    const h = await liveHarness();
    h.socket.serverSends({
      type: "seed-batch",
      pane: PANE_A,
      seq: 1,
      reset: { cols: 120, rows: 32 },
      seed: encodeBase64("screen"),
      held: [encodeBase64("delta-1"), encodeBase64("delta-2")],
      cursor: { x: 5, y: 6 },
    });
    await flushMicrotasks();
    expect(h.events).toHaveLength(1);
    const event = h.events[0]!.event;
    expect(event.type).toBe("seed-batch");
    if (event.type !== "seed-batch") throw new Error("unreachable");
    expect(event.batch.reset).toEqual({ cols: 120, rows: 32 });
    expect(new TextDecoder().decode(event.batch.seed)).toBe("screen");
    expect(event.batch.held.map((held) => new TextDecoder().decode(held))).toEqual([
      "delta-1",
      "delta-2",
    ]);
    expect(event.batch.cursor).toEqual({ x: 5, y: 6 });
  });

  it("acks cumulatively per pane only after the apply settles", async () => {
    const h = await liveHarness({ deferApplies: true });
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 1, data: encodeBase64("one") });
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 2, data: encodeBase64("two") });
    await flushMicrotasks();
    // Nothing applied yet: the redeem frame is the only client frame on the wire.
    expect(h.socket.sent).toHaveLength(1);
    h.settleApply();
    await flushMicrotasks();
    expect(h.socket.sent).toHaveLength(2);
    expect(JSON.parse(h.socket.sent[1]!)).toEqual({ type: "consumed", pane: PANE_A, seq: 1 });
    h.settleApply();
    await flushMicrotasks();
    expect(JSON.parse(h.socket.sent[2]!)).toEqual({ type: "consumed", pane: PANE_A, seq: 2 });
  });

  it("fails the session on a per-pane sequence gap", async () => {
    const h = await liveHarness();
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 2, data: encodeBase64("gap") });
    await flushMicrotasks();
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error", retryable: false })]);
  });

  it("fails the session on an unleased pane", async () => {
    const h = await liveHarness();
    h.socket.serverSends({
      type: "output",
      pane: "pane.workspace.zz",
      seq: 1,
      data: encodeBase64("x"),
    });
    await flushMicrotasks();
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error" })]);
  });

  it("treats an input-ack as impossible for a read-only stream", async () => {
    const h = await liveHarness();
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: 1 });
    await flushMicrotasks();
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error" })]);
  });

  it("surfaces flow pause/resume as pane events", async () => {
    const h = await liveHarness();
    h.socket.serverSends({
      type: "flow",
      pane: PANE_A,
      seq: 1,
      state: "paused",
      reason: "backpressure",
    });
    await flushMicrotasks();
    expect(h.events[0]!.event).toEqual({
      type: "flow",
      state: "paused",
      reason: "backpressure",
    });
  });

  it("delivers closed per pane and ends cleanly when every pane closed", async () => {
    const h = await liveHarness();
    h.socket.serverSends({ type: "closed", pane: PANE_A, seq: 1 });
    h.socket.serverSends({ type: "closed", pane: PANE_B, seq: 1 });
    await flushMicrotasks();
    expect(h.events.map(({ event }) => event.type)).toEqual(["closed", "closed"]);
    h.socket.emit("close");
    expect(h.ends).toEqual([null]);
  });

  it("reports a live socket drop as a retryable stream end", async () => {
    const h = await liveHarness();
    h.socket.emit("close");
    expect(h.ends).toEqual([expect.objectContaining({ code: "stream-closed", retryable: true })]);
  });

  it("maps a live error frame to a typed session end", async () => {
    const h = await liveHarness();
    h.socket.serverSends({
      type: "error",
      protocolVersion: 1,
      code: "stream-unavailable",
      retryable: false,
    });
    await flushMicrotasks();
    expect(h.ends).toEqual([expect.objectContaining({ code: "stream-unavailable" })]);
  });

  it("retires the session when the consumer fails to apply", async () => {
    const h = await liveHarness({
      listeners: {
        onPaneEvent: () => Promise.reject(new Error("apply failed")),
      },
    });
    h.socket.serverSends({ type: "output", pane: PANE_A, seq: 1, data: encodeBase64("x") });
    await flushMicrotasks();
    expect(h.ends).toEqual([
      expect.objectContaining({ code: "renderer-consumer-failed", retryable: true }),
    ]);
  });

  it("routes layout frames to the layout listener without acks", async () => {
    const layouts: unknown[] = [];
    const h = await liveHarness({
      listeners: { onLayout: (layout) => layouts.push(layout) },
    });
    h.socket.serverSends({
      type: "layout",
      semanticWindowId: null,
      windowName: "work",
      currentWindow: true,
      cols: 200,
      rows: 50,
      zoomed: false,
      panes: [{ pane: PANE_A, left: 0, top: 0, width: 100, height: 50, active: true }],
    });
    await flushMicrotasks();
    expect(layouts).toHaveLength(1);
    expect(h.socket.sent).toHaveLength(1);
  });

  it("atomically routes only strictly advancing layout snapshots", async () => {
    const snapshots: unknown[] = [];
    const h = await liveHarness({
      listeners: { onLayoutSnapshot: (snapshot) => snapshots.push(snapshot) },
    });
    const frame = {
      type: "layout-snapshot",
      topologyEpoch: 3,
      layouts: [
        {
          type: "layout",
          semanticWindowId: "window.workspace.one",
          windowName: "work",
          currentWindow: true,
          cols: 200,
          rows: 50,
          zoomed: false,
          paneBorderStatus: "off",
          panes: [
            { pane: PANE_A, left: 0, top: 0, width: 100, height: 50, active: true },
            { pane: PANE_B, left: 100, top: 0, width: 100, height: 50, active: false },
          ],
        },
      ],
    };
    h.socket.serverSends(frame);
    expect(snapshots).toHaveLength(1);
    h.socket.serverSends(frame);
    await flushMicrotasks();
    expect(snapshots).toHaveLength(1);
    expect(h.ends).toEqual([expect.objectContaining({ code: "protocol-error", retryable: false })]);
  });

  it("publishes visibility/activity and consumes authority snapshots without polling", async () => {
    const snapshots: unknown[] = [];
    const h = await liveHarness({
      listeners: { onAuthoritySnapshot: (snapshot) => snapshots.push(snapshot) },
    });
    h.result.session.updatePresence?.("foreground");
    h.result.session.noteActivity?.("focus");
    expect(h.socket.sent.slice(-2).map((frame) => JSON.parse(frame))).toEqual([
      { type: "presence", generation: DAEMON_INSTANCE_ID, state: "foreground" },
      { type: "activity", generation: DAEMON_INSTANCE_ID, activity: "focus" },
    ]);
    h.socket.serverSends({
      type: "authority-snapshot",
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 1,
        owners: { input: null, focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    expect(snapshots).toHaveLength(1);
  });

  it("queues immediate input behind explicit authority and resolves on input ack", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.write?.(PANE_A, "hello");
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    expect(request).toMatchObject({ type: "authority-request", authority: "input" });
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "input",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        clientId: "client-a",
        authority: "input",
        token: "70000000-0000-4000-8000-000000000001",
        revision: 1,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 1,
        owners: { input: "client-a", focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    const input = JSON.parse(h.socket.sent.at(-2)!);
    expect(input).toMatchObject({ type: "input", pane: PANE_A, data: "hello" });
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: input.seq });
    await expect(pending).resolves.toBe(true);
  });

  it("exposes and releases only this connection's exact held authority once", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const requested = h.result.session.requestAuthority!("geometry");
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "runtime-a",
        clientId: "client-a",
        authority: "geometry",
        token: "70000000-0000-4000-8000-000000000001",
        revision: 1,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "runtime-a",
        revision: 1,
        owners: { input: null, focus: null, geometry: "client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(requested).resolves.toMatchObject({ clientId: "client-a" });
    expect(h.result.session.connectionAuthorityClientId!("geometry")).toBe("client-a");

    const released = h.result.session.releaseAuthority!("geometry");
    await flushMicrotasks();
    const release = JSON.parse(h.socket.sent.at(-1)!);
    expect(release).toMatchObject({ type: "authority-release", authority: "geometry" });
    expect(h.result.session.connectionAuthorityClientId!("geometry")).toBeNull();
    const sentCount = h.socket.sent.length;
    await expect(h.result.session.releaseAuthority!("geometry")).resolves.toBeNull();
    expect(h.socket.sent).toHaveLength(sentCount);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: release.requestId,
      authority: "geometry",
      status: "released",
      lease: null,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "runtime-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(released).resolves.toMatchObject({ revision: 2 });
    h.result.session.dispose();
    expect(h.result.session.connectionAuthorityClientId!("geometry")).toBeNull();
  });

  it("does not let an observing connection release another connection's global owner", async () => {
    const owner = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const observer = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const grant = owner.result.session.requestAuthority!("geometry");
    await flushMicrotasks();
    const request = JSON.parse(owner.socket.sent.at(-1)!);
    const ownedSnapshot = {
      generation: DAEMON_INSTANCE_ID,
      session: "runtime-a",
      revision: 1,
      owners: { input: null, focus: null, geometry: "client-a" },
      nativeGeometryYieldUntilMs: 0,
      clients: [],
    };
    owner.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "runtime-a",
        clientId: "client-a",
        authority: "geometry",
        token: "70000000-0000-4000-8000-000000000002",
        revision: 1,
      },
      snapshot: ownedSnapshot,
    });
    await grant;
    observer.socket.serverSends({ type: "authority-snapshot", snapshot: ownedSnapshot });
    expect(observer.result.session.connectionAuthorityClientId!("geometry")).toBeNull();
    const observerSent = observer.socket.sent.length;
    await expect(observer.result.session.releaseAuthority!("geometry")).resolves.toBeNull();
    expect(observer.socket.sent).toHaveLength(observerSent);

    const released = owner.result.session.releaseAuthority!("geometry");
    await flushMicrotasks();
    const release = JSON.parse(owner.socket.sent.at(-1)!);
    owner.socket.serverSends({
      type: "authority-receipt",
      requestId: release.requestId,
      authority: "geometry",
      status: "released",
      lease: null,
      snapshot: {
        ...ownedSnapshot,
        revision: 2,
        owners: { ...ownedSnapshot.owners, geometry: null },
      },
    });
    await expect(released).resolves.toMatchObject({ revision: 2 });
    expect(
      owner.socket.sent.filter((frame) => JSON.parse(frame).type === "authority-release"),
    ).toHaveLength(1);
  });

  it("binds authority to the authenticated runtime session without conflating workspace name", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.write?.(PANE_A, "hello");
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "input",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        clientId: "client-a",
        authority: "input",
        token: "70000000-0000-4000-8000-000000000001",
        revision: 1,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        revision: 1,
        owners: { input: "client-a", focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    const input = h.socket.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "input");
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: input.seq });
    await expect(pending).resolves.toBe(true);
    expect(h.ends).toEqual([]);

    h.socket.serverSends({
      type: "authority-snapshot",
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-b",
        revision: 2,
        owners: { input: null, focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
  });

  it("accepts a sticky lease older than its coherent authority snapshot and rejects the reverse", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const fitted = h.result.session.resize?.(140, 46);
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        clientId: "client-a",
        authority: "geometry",
        token: "70000000-0000-4000-8000-000000000002",
        revision: 2,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        revision: 3,
        owners: { input: null, focus: null, geometry: "client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    const viewport = h.socket.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "viewport");
    h.socket.serverSends({
      type: "viewport-ack",
      seq: viewport.seq,
      cols: viewport.cols,
      rows: viewport.rows,
      outcome: "ok",
      authorityLease: viewport.authorityLease,
    });
    await expect(fitted).resolves.toBe("ok");
    expect(h.ends).toEqual([]);

    const next = h.result.session.requestAuthority?.("focus");
    await flushMicrotasks();
    const nextRequest = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: nextRequest.requestId,
      authority: "focus",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        clientId: "client-a",
        authority: "focus",
        token: "70000000-0000-4000-8000-000000000003",
        revision: 5,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "tmux-runtime-a",
        revision: 4,
        owners: { input: null, focus: "client-a", geometry: "client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(next).resolves.toBeNull();
    expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
  });

  it("does not send input when another Web client owns authority", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.write?.(PANE_A, "blocked");
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "input",
      status: "rejected",
      lease: null,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: "other-web-client", focus: null, geometry: null },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(pending).resolves.toBe(false);
    expect(h.socket.sent.some((frame) => JSON.parse(frame).type === "input")).toBe(false);
  });

  it("distinguishes an explicit geometry authority rejection from transport failure", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.resize?.(140, 46);
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    expect(request).toMatchObject({ type: "authority-request", authority: "geometry" });
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "rejected",
      lease: null,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "other-web-client" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(pending).resolves.toBe("geometry-authority-conflict");
    expect(h.socket.sent.some((frame) => JSON.parse(frame).type === "viewport")).toBe(false);

    h.result.session.dispose();
    await expect(h.result.session.resize?.(140, 46)).resolves.toBe("lifecycle-retired");
  });

  it.each(["unknown-request", "cross-authority"] as const)(
    "rejects %s authority receipts before they can install a local lease",
    async (kind) => {
      const h = await liveHarness({
        viewerMode: "interactive",
        descriptorOverrides: { effectiveViewerMode: "interactive" },
      });
      const pending = h.result.session.resize?.(140, 46);
      await flushMicrotasks();
      const request = JSON.parse(h.socket.sent.at(-1)!);
      const authority = kind === "cross-authority" ? "input" : "geometry";
      const clientId = "web-client-a";
      h.socket.serverSends({
        type: "authority-receipt",
        requestId: kind === "unknown-request" ? globalThis.crypto.randomUUID() : request.requestId,
        authority,
        status: "granted",
        lease: {
          generation: DAEMON_INSTANCE_ID,
          session: "workspace-a",
          clientId,
          authority,
          token: globalThis.crypto.randomUUID(),
          revision: 2,
        },
        snapshot: {
          generation: DAEMON_INSTANCE_ID,
          session: "workspace-a",
          revision: 2,
          owners: {
            input: authority === "input" ? clientId : null,
            focus: null,
            geometry: authority === "geometry" ? clientId : null,
          },
          nativeGeometryYieldUntilMs: 0,
          clients: [],
        },
      });
      await expect(pending).resolves.toBe("stream-closed");
      expect(h.socket.sent.some((frame) => JSON.parse(frame).type === "viewport")).toBe(false);
      expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
    },
  );

  it.each(["granted-without-lease", "request-released", "rejected-with-lease"] as const)(
    "rejects malformed authority receipt shape %s before mutation",
    async (kind) => {
      const h = await liveHarness({
        viewerMode: "interactive",
        descriptorOverrides: { effectiveViewerMode: "interactive" },
      });
      const pending = h.result.session.resize?.(140, 46);
      await flushMicrotasks();
      const request = JSON.parse(h.socket.sent.at(-1)!);
      const malformedLease = {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        clientId: "web-client-a",
        authority: "geometry" as const,
        token: globalThis.crypto.randomUUID(),
        revision: 2,
      };
      h.socket.serverSends({
        type: "authority-receipt",
        requestId: request.requestId,
        authority: "geometry",
        status:
          kind === "request-released"
            ? "released"
            : kind === "rejected-with-lease"
              ? "rejected"
              : "granted",
        lease: kind === "rejected-with-lease" ? malformedLease : null,
        snapshot: {
          generation: DAEMON_INSTANCE_ID,
          session: "workspace-a",
          revision: 2,
          owners: { input: null, focus: null, geometry: null },
          nativeGeometryYieldUntilMs: 0,
          clients: [],
        },
      });
      await expect(pending).resolves.toBe("stream-closed");
      expect(h.socket.sent.some((frame) => JSON.parse(frame).type === "viewport")).toBe(false);
      expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
    },
  );

  it("rejects a granted receipt for an exact pending release", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const acquire = h.result.session.requestAuthority?.("geometry");
    await flushMicrotasks();
    const acquireRequest = JSON.parse(h.socket.sent.at(-1)!);
    const lease = {
      generation: DAEMON_INSTANCE_ID,
      session: "workspace-a",
      clientId: "web-client-a",
      authority: "geometry" as const,
      token: globalThis.crypto.randomUUID(),
      revision: 2,
    };
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: acquireRequest.requestId,
      authority: "geometry",
      status: "granted",
      lease,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "web-client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(acquire).resolves.toEqual(lease);
    const release = h.result.session.releaseAuthority?.("geometry");
    await flushMicrotasks();
    const releaseRequest = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: releaseRequest.requestId,
      authority: "geometry",
      status: "granted",
      lease,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "web-client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await expect(release).resolves.toBeNull();
    expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
  });

  it("keeps authority and viewport deadlines distinct and fatal", async () => {
    const authorityTimeout = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pendingAuthority = authorityTimeout.result.session.resize?.(140, 46);
    await authorityTimeout.clock.advance(2_001);
    await expect(pendingAuthority).resolves.toBe("authority-timeout");
    expect(
      authorityTimeout.socket.sent.some((frame) => JSON.parse(frame).type === "viewport"),
    ).toBe(false);

    const viewportTimeout = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pendingViewport = viewportTimeout.result.session.resize?.(140, 46);
    await flushMicrotasks();
    const request = JSON.parse(viewportTimeout.socket.sent.at(-1)!);
    viewportTimeout.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        clientId: "web-client-a",
        authority: "geometry",
        token: globalThis.crypto.randomUUID(),
        revision: 2,
      },
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "web-client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    expect(
      viewportTimeout.socket.sent
        .map((frame): Record<string, unknown> => JSON.parse(frame))
        .reverse()
        .find((frame) => frame.type === "viewport"),
    ).toMatchObject({ type: "viewport", cols: 140, rows: 46 });
    await viewportTimeout.clock.advance(2_001);
    await expect(pendingViewport).resolves.toBe("viewport-timeout");
  });

  it("binds the viewport acknowledgement to the exact granted lease and preserves conflict", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.resize?.(140, 46);
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    const lease = {
      generation: DAEMON_INSTANCE_ID,
      session: "workspace-a",
      clientId: "web-client-a",
      authority: "geometry",
      token: globalThis.crypto.randomUUID(),
      revision: 2,
    } as const;
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "web-client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    const viewport = h.socket.sent
      .map((frame): Record<string, unknown> => JSON.parse(frame))
      .reverse()
      .find((frame) => frame.type === "viewport")!;
    expect(viewport).toMatchObject({
      type: "viewport",
      authorityLease: lease,
      cols: 140,
      rows: 46,
    });
    h.socket.serverSends({
      type: "viewport-ack",
      seq: viewport.seq,
      cols: 140,
      rows: 46,
      outcome: "geometry-authority-conflict",
      authorityLease: lease,
    });
    await expect(pending).resolves.toBe("geometry-authority-conflict");
  });

  it("rejects a viewport acknowledgement whose echoed dimensions do not match", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.resize?.(140, 46);
    await flushMicrotasks();
    const request = JSON.parse(h.socket.sent.at(-1)!);
    const lease = {
      generation: DAEMON_INSTANCE_ID,
      session: "workspace-a",
      clientId: "web-client-a",
      authority: "geometry",
      token: globalThis.crypto.randomUUID(),
      revision: 2,
    } as const;
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: request.requestId,
      authority: "geometry",
      status: "granted",
      lease,
      snapshot: {
        generation: DAEMON_INSTANCE_ID,
        session: "workspace-a",
        revision: 2,
        owners: { input: null, focus: null, geometry: "web-client-a" },
        nativeGeometryYieldUntilMs: 0,
        clients: [],
      },
    });
    await flushMicrotasks();
    const viewport = h.socket.sent
      .map((frame): Record<string, unknown> => JSON.parse(frame))
      .reverse()
      .find((frame) => frame.type === "viewport")!;
    h.socket.serverSends({
      type: "viewport-ack",
      seq: viewport.seq,
      cols: 139,
      rows: 46,
      outcome: "ok",
      authorityLease: lease,
    });
    await expect(pending).resolves.toBe("stream-closed");
    expect(h.ends.at(-1)).toMatchObject({ code: "protocol-error" });
  });

  it("settles a pending geometry request as closed without emitting viewport evidence", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const pending = h.result.session.resize?.(140, 46);
    await flushMicrotasks();
    h.result.session.dispose();
    await expect(pending).resolves.toBe("stream-closed");
    expect(h.socket.sent.some((frame) => JSON.parse(frame).type === "viewport")).toBe(false);
  });

  it("revokes a stale local hold from an unsolicited snapshot before the next write", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const first = h.result.session.write?.(PANE_A, "first");
    await flushMicrotasks();
    const firstRequest = JSON.parse(h.socket.sent.at(-1)!);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: firstRequest.requestId,
      authority: "input",
      status: "granted",
      lease: inputLease("client-a", 1),
      snapshot: authoritySnapshot("client-a", 1),
    });
    await flushMicrotasks();
    const firstInput = h.socket.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "input" && frame.data === "first");
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: firstInput.seq });
    await expect(first).resolves.toBe(true);

    h.socket.serverSends({
      type: "authority-snapshot",
      snapshot: authoritySnapshot("client-b", 2),
    });
    const second = h.result.session.write?.(PANE_A, "second");
    await flushMicrotasks();
    const secondRequest = JSON.parse(h.socket.sent.at(-1)!);
    expect(secondRequest).toMatchObject({ type: "authority-request", authority: "input" });
    expect(
      h.socket.sent
        .map((frame) => JSON.parse(frame))
        .some((frame) => frame.type === "input" && frame.data === "second"),
    ).toBe(false);
    h.socket.serverSends({
      type: "authority-receipt",
      requestId: secondRequest.requestId,
      authority: "input",
      status: "rejected",
      lease: null,
      snapshot: authoritySnapshot("client-b", 3),
    });
    await expect(second).resolves.toBe(false);
    expect(
      h.socket.sent
        .map((frame) => JSON.parse(frame))
        .some((frame) => frame.type === "input" && frame.data === "second"),
    ).toBe(false);
  });

  it("serializes rapid first writes through one authority request and preserves byte order", async () => {
    const h = await liveHarness({
      viewerMode: "interactive",
      descriptorOverrides: { effectiveViewerMode: "interactive" },
    });
    const first = h.result.session.write?.(PANE_A, "a");
    const second = h.result.session.write?.(PANE_A, "b");
    await flushMicrotasks();
    const frames = h.socket.sent.map((frame) => JSON.parse(frame));
    const requests = frames.filter((frame) => frame.type === "authority-request");
    expect(requests).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === "input")).toHaveLength(0);

    h.socket.serverSends({
      type: "authority-receipt",
      requestId: requests[0].requestId,
      authority: "input",
      status: "granted",
      lease: inputLease("client-a", 1),
      snapshot: authoritySnapshot("client-a", 1),
    });
    await flushMicrotasks();
    const firstInput = h.socket.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "input");
    expect(firstInput.data).toBe("a");
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: firstInput.seq });
    await expect(first).resolves.toBe(true);
    await flushMicrotasks();
    const inputFrames = h.socket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "input");
    expect(inputFrames.map((frame) => frame.data)).toEqual(["a", "b"]);
    expect(
      h.socket.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "authority-request"),
    ).toHaveLength(1);
    h.socket.serverSends({ type: "input-ack", pane: PANE_A, seq: inputFrames[1].seq });
    await expect(second).resolves.toBe(true);
  });

  it("disposing the session closes the socket without an error end", async () => {
    const h = await liveHarness();
    h.result.session.dispose();
    expect(h.socket.closes.at(-1)).toMatchObject({ code: 1000 });
    expect(h.ends).toEqual([null]);
  });
});
