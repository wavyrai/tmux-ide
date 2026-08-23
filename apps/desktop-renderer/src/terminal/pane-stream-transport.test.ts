import { describe, expect, it, vi } from "vitest";
import {
  blankTerminalReplicaSnapshot,
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
      const h = await liveHarness({ deferApplies: true });
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
        modes: { ...normal.modes, alternateScreen: true },
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
      expect(new TextDecoder().decode(seeded.batch.seed).startsWith("\u001b[?1049h")).toBe(true);
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
