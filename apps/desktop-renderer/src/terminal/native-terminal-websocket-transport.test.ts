import { describe, expect, it, vi } from "vitest";
import type {
  NativeTerminalEvent,
  NativeTerminalTransportError,
} from "./native-terminal-transport.ts";
import {
  NATIVE_TERMINAL_MAX_CONNECTION_LIFETIME_MS,
  NATIVE_TERMINAL_MAX_CONTROL_BYTES,
  NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW,
  NATIVE_TERMINAL_MAX_INBOUND_FRAMES_PER_WINDOW,
  NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES,
  NATIVE_TERMINAL_MAX_QUEUED_EVENTS,
  NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES,
  NATIVE_TERMINAL_RATE_WINDOW_MS,
  NATIVE_TERMINAL_RESIZE_ACK_TIMEOUT_MS,
  NATIVE_TERMINAL_WEBSOCKET_PROTOCOL,
  createNativeTerminalWebSocketTransport,
  type NativeTerminalSocketEvent,
  type NativeTerminalSocketListener,
  type NativeTerminalWebSocket,
  type NativeTerminalWebSocketTransportDependencies,
} from "./native-terminal-websocket-transport.ts";

const NOW = 1_000;
const URL = "ws://127.0.0.1:6070/v1/terminal/attachments/redeem";
const REQUEST_ID = "2a215cf2-547e-42a2-91c7-454df8e56121";
const DAEMON_ID = "daemon-instance-1";
const TICKET = `ta1_${"a".repeat(43)}`;
const TARGET = { workspaceName: "workspace.alpha", semanticPaneId: "pane.codex" };
const REQUEST = {
  protocolVersion: 1 as const,
  target: TARGET,
  viewerMode: "interactive" as const,
  viewport: { cols: 120, rows: 40 },
};

function issueDescriptor(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: 1,
    webSocketUrl: URL,
    webSocketProtocol: NATIVE_TERMINAL_WEBSOCKET_PROTOCOL,
    redemptionTicket: TICKET,
    daemonInstanceId: DAEMON_ID,
    requestId: REQUEST_ID,
    expiresAt: NOW + 15_000,
    effectiveViewerMode: "interactive",
    ...overrides,
  };
}

function ready(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    daemonInstanceId: DAEMON_ID,
    requestId: REQUEST_ID,
    generation: 0,
    effectiveViewerMode: "interactive",
    inputCapability: "unavailable",
    sourceGrid: { cols: 120, rows: 40 },
    clientViewport: { cols: 118, rows: 38 },
    ...overrides,
  });
}

function geometry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "geometry",
    protocolVersion: 1,
    generation: 0,
    sourceGrid: { cols: 100, rows: 30 },
    clientViewport: { cols: 98, rows: 28 },
    ...overrides,
  });
}

class FakeWebSocket implements NativeTerminalWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  protocol: string;
  binaryType: BinaryType = "blob";
  readonly url: string;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<NativeTerminalSocketListener>>();

  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
  }

  addEventListener(type: string, listener: NativeTerminalSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: NativeTerminalSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  peerClose(): void {
    this.readyState = 3;
    this.emit("close");
  }

  error(): void {
    this.emit("error");
  }

  private emit(type: string, event: NativeTerminalSocketEvent = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

interface RigOptions {
  readonly descriptors?: readonly unknown[];
  readonly schedule?: NativeTerminalWebSocketTransportDependencies["schedule"];
  readonly issueAttachment?: NativeTerminalWebSocketTransportDependencies["issueAttachment"];
  readonly now?: () => number;
}

function rig(options: RigOptions = {}) {
  const descriptors = [...(options.descriptors ?? [issueDescriptor()])];
  const sockets: FakeWebSocket[] = [];
  const issueAttachment = vi.fn(
    options.issueAttachment ?? (async () => descriptors.shift() ?? issueDescriptor()),
  );
  const createWebSocket = vi.fn((url: string, protocol: string) => {
    const socket = new FakeWebSocket(url, protocol);
    sockets.push(socket);
    return socket;
  });
  const transport = createNativeTerminalWebSocketTransport({
    issueAttachment,
    createWebSocket,
    now: options.now ?? (() => NOW),
    schedule: options.schedule,
  });
  return { transport, issueAttachment, createWebSocket, sockets };
}

async function waitForSocket(sockets: FakeWebSocket[], index = 0): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
  return sockets[index]!;
}

async function connectLive(
  harness: ReturnType<typeof rig>,
  listener: (event: NativeTerminalEvent) => void | Promise<void> = () => undefined,
  socketIndex = 0,
) {
  const connection = harness.transport.connect(REQUEST, listener);
  const socket = await waitForSocket(harness.sockets, socketIndex);
  socket.open();
  socket.message(ready());
  const result = await connection;
  if (result.status !== "connected") throw new Error(result.error.reason);
  await Promise.resolve();
  return { socket, attachment: result.attachment };
}

describe("NativeTerminalTransport direct WebSocket adapter", () => {
  it("validates semantic requests before issue and rejects unsafe issue descriptors", async () => {
    const invalidRequest = rig();
    await expect(
      invalidRequest.transport.connect(
        { ...REQUEST, target: { ...TARGET, workspaceName: "%7" } },
        () => undefined,
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(invalidRequest.issueAttachment).not.toHaveBeenCalled();

    for (const descriptor of [
      issueDescriptor({ webSocketUrl: "ws://192.0.2.1:6070/v1/terminal/attachments/redeem" }),
      issueDescriptor({
        webSocketUrl: `ws://secret@127.0.0.1:6070${URL.slice(URL.indexOf("/v1"))}`,
      }),
      issueDescriptor({ webSocketUrl: `${URL}?ticket=${TICKET}` }),
      issueDescriptor({ webSocketProtocol: "other-terminal.v1" }),
      issueDescriptor({ expiresAt: NOW }),
      issueDescriptor({ tmuxPaneId: "%7" }),
    ]) {
      const harness = rig({ descriptors: [descriptor] });
      await expect(harness.transport.connect(REQUEST, () => undefined)).resolves.toMatchObject({
        status: "error",
        error: { code: "invalid-descriptor" },
      });
      expect(harness.createWebSocket).not.toHaveBeenCalled();
    }
  });

  it("opens the exact subprotocol, redeems once first, streams binary, and never sends input", async () => {
    const events: NativeTerminalEvent[] = [];
    const harness = rig();
    const connection = harness.transport.connect(REQUEST, (event) => {
      events.push(event);
    });
    const socket = await waitForSocket(harness.sockets);

    expect(harness.issueAttachment).toHaveBeenCalledWith(REQUEST);
    expect(harness.createWebSocket).toHaveBeenCalledWith(URL, NATIVE_TERMINAL_WEBSOCKET_PROTOCOL);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.sent).toEqual([]);
    expect(socket.url).not.toContain(TICKET);

    socket.open();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: "redeem",
      protocolVersion: 1,
      ticket: TICKET,
      requestId: REQUEST_ID,
      daemonInstanceId: DAEMON_ID,
    });
    socket.message(ready());
    const result = await connection;
    expect(result.status).toBe("connected");
    if (result.status !== "connected") return;
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "state",
        state: "connected",
        error: null,
        sourceGrid: { cols: 120, rows: 40 },
        clientViewport: { cols: 118, rows: 38 },
      }),
    );

    socket.message(Uint8Array.of(0x00, 0x80, 0xff).buffer);
    await vi.waitFor(() => expect(events.some((event) => event.type === "output")).toBe(true));
    expect(events).toContainEqual({ type: "output", bytes: Uint8Array.of(0x00, 0x80, 0xff) });
    await expect(result.attachment.write(Uint8Array.of(3, 0, 255))).resolves.toEqual({
      status: "error",
      error: {
        code: "input-backpressure-unavailable",
        reason: "Terminal input is unavailable until the daemon enables bounded input recovery.",
        retryable: false,
      },
    });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.stringify(result.attachment)).not.toContain(TICKET);
  });

  it("rejects pre-ready frames, wrong ready identity, and close-versus-ready races", async () => {
    const preReady = rig();
    const first = preReady.transport.connect(REQUEST, () => undefined);
    const firstSocket = await waitForSocket(preReady.sockets);
    firstSocket.open();
    firstSocket.message(geometry());
    await expect(first).resolves.toMatchObject({
      status: "error",
      error: { code: "protocol-error" },
    });
    expect(firstSocket.closes.at(-1)).toEqual({ code: 1002, reason: "protocol-error" });

    const wrongIdentity = rig();
    const second = wrongIdentity.transport.connect(REQUEST, () => undefined);
    const secondSocket = await waitForSocket(wrongIdentity.sockets);
    secondSocket.open();
    secondSocket.message(ready({ requestId: "fa8e7197-2236-4a62-bc01-5b64dd18c267" }));
    await expect(second).resolves.toMatchObject({
      status: "error",
      error: { code: "protocol-error" },
    });

    const closed = rig();
    const third = closed.transport.connect(REQUEST, () => undefined);
    const thirdSocket = await waitForSocket(closed.sockets);
    thirdSocket.open();
    thirdSocket.peerClose();
    thirdSocket.message(ready());
    await expect(third).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-closed" },
    });
  });

  it("settles only the latest coalesced resize after matching authoritative geometry", async () => {
    const events: NativeTerminalEvent[] = [];
    const harness = rig();
    const { socket, attachment } = await connectLive(harness, (event) => {
      events.push(event);
    });
    const first = attachment.resize({ cols: 80, rows: 24 });
    const second = attachment.resize({ cols: 90, rows: 25 });
    const third = attachment.resize({ cols: 100, rows: 30 });
    await expect(first).resolves.toMatchObject({
      status: "error",
      error: { code: "resize-superseded" },
    });
    await expect(second).resolves.toMatchObject({
      status: "error",
      error: { code: "resize-superseded" },
    });
    let thirdSettled = false;
    void third.then(() => {
      thirdSettled = true;
    });
    await Promise.resolve();
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1] as string)).toMatchObject({
      type: "resize",
      generation: 0,
      viewport: { cols: 100, rows: 30 },
    });
    socket.message(geometry());
    await Promise.resolve();
    expect(thirdSettled).toBe(false);
    socket.message(
      geometry({
        sourceGrid: { cols: 102, rows: 32 },
        clientViewport: { cols: 100, rows: 30 },
      }),
    );
    await expect(third).resolves.toEqual({ status: "ok" });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "geometry",
        sourceGrid: { cols: 102, rows: 32 },
        clientViewport: { cols: 100, rows: 30 },
      }),
    );

    socket.bufferedAmount = NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES;
    await expect(attachment.resize({ cols: 110, rows: 35 })).resolves.toMatchObject({
      status: "error",
      error: { code: "socket-backpressure" },
    });
    expect(socket.closes.at(-1)).toEqual({ code: 1013, reason: "socket-backpressure" });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "state",
        state: "disconnected",
        error: expect.objectContaining({ code: "socket-backpressure" }),
      }),
    );
  });

  it("serializes sent resize correlation and supersedes older promises deterministically", async () => {
    const harness = rig();
    const { socket, attachment } = await connectLive(harness);
    const first = attachment.resize({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const latest = attachment.resize({ cols: 100, rows: 30 });
    await expect(first).resolves.toMatchObject({
      status: "error",
      error: { code: "resize-superseded" },
    });
    expect(socket.sent).toHaveLength(2);

    socket.message(geometry({ clientViewport: { cols: 80, rows: 24 } }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2] as string)).toMatchObject({
      type: "resize",
      viewport: { cols: 100, rows: 30 },
    });
    socket.message(geometry({ clientViewport: { cols: 100, rows: 30 } }));
    await expect(latest).resolves.toEqual({ status: "ok" });
  });

  it("bounds asynchronous output delivery and retires instead of growing an event queue", async () => {
    let releaseOutput!: () => void;
    const outputGate = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    const events: NativeTerminalEvent[] = [];
    const harness = rig();
    const { socket } = await connectLive(harness, async (event) => {
      events.push(event);
      if (
        event.type === "output" &&
        events.filter((entry) => entry.type === "output").length === 1
      ) {
        await outputGate;
      }
    });

    for (let index = 0; index <= NATIVE_TERMINAL_MAX_QUEUED_EVENTS; index += 1) {
      socket.message(Uint8Array.of(index & 0xff).buffer);
    }
    expect(socket.closes.at(-1)).toEqual({ code: 1013, reason: "renderer-backpressure" });
    releaseOutput();
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "state",
        state: "disconnected",
        error: expect.objectContaining({ code: "renderer-backpressure" }),
      }),
    );
    expect(events.filter((event) => event.type === "output")).toHaveLength(1);
  });

  it("rejects oversized text and binary frames before encoding or copying payloads", async () => {
    const textHarness = rig();
    const text = await connectLive(textHarness);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    text.socket.message("x".repeat(NATIVE_TERMINAL_MAX_CONTROL_BYTES + 1));
    expect(encode).not.toHaveBeenCalled();
    expect(text.socket.closes.at(-1)).toEqual({
      code: 1009,
      reason: "control-frame-too-large",
    });
    encode.mockRestore();

    const encodedHarness = rig();
    const encoded = await connectLive(encodedHarness);
    const encodedByteCheck = vi.spyOn(TextEncoder.prototype, "encode");
    encoded.socket.message("€".repeat(Math.floor(NATIVE_TERMINAL_MAX_CONTROL_BYTES / 3) + 1));
    expect(encodedByteCheck).toHaveBeenCalledOnce();
    expect(encoded.socket.closes.at(-1)).toEqual({
      code: 1009,
      reason: "control-frame-too-large",
    });
    encodedByteCheck.mockRestore();

    const bufferHarness = rig();
    const buffer = await connectLive(bufferHarness);
    const arrayBufferSlice = vi.spyOn(ArrayBuffer.prototype, "slice");
    buffer.socket.message(new ArrayBuffer(NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES + 1));
    expect(arrayBufferSlice).not.toHaveBeenCalled();
    expect(buffer.socket.closes.at(-1)).toEqual({
      code: 1009,
      reason: "output-frame-too-large",
    });
    arrayBufferSlice.mockRestore();

    const viewHarness = rig();
    const view = await connectLive(viewHarness);
    const typedArraySlice = vi.spyOn(Uint8Array.prototype, "slice");
    view.socket.message(new Uint8Array(NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES + 1));
    expect(typedArraySlice).not.toHaveBeenCalled();
    expect(view.socket.closes.at(-1)).toEqual({
      code: 1009,
      reason: "output-frame-too-large",
    });
    typedArraySlice.mockRestore();
  });

  it("retires typed on bounded control and total inbound frame-rate exhaustion", async () => {
    let clock = NOW;
    const controlHarness = rig({ now: () => clock });
    const control = await connectLive(controlHarness);
    for (
      let index = 1;
      index <= NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW;
      index += 1
    ) {
      control.socket.message(geometry());
      await Promise.resolve();
      await Promise.resolve();
      if (control.socket.readyState === 3) break;
    }
    expect(control.socket.closes.at(-1)).toEqual({
      code: 1008,
      reason: "control-frame-rate-limit",
    });

    clock = NOW;
    const frameHarness = rig({ now: () => clock });
    const frames = await connectLive(frameHarness);
    for (let index = 1; index <= NATIVE_TERMINAL_MAX_INBOUND_FRAMES_PER_WINDOW; index += 1) {
      frames.socket.message(new ArrayBuffer(0));
      if (frames.socket.readyState === 3) break;
    }
    expect(frames.socket.closes.at(-1)).toEqual({
      code: 1008,
      reason: "inbound-frame-rate-limit",
    });

    clock = NOW;
    const renewalHarness = rig({ now: () => clock });
    const renewal = await connectLive(renewalHarness);
    for (let index = 0; index < 4; index += 1) {
      clock += NATIVE_TERMINAL_RATE_WINDOW_MS;
      renewal.socket.message(geometry());
      await Promise.resolve();
    }
    expect(renewal.socket.closes).toEqual([]);
  });

  it("bounds connection lifetime and resize acknowledgement, settling outstanding callers", async () => {
    const scheduled: Array<{ callback: () => void; active: boolean; delay: number }> = [];
    const schedule = (callback: () => void, delay: number) => {
      const entry = { callback, active: true, delay };
      scheduled.push(entry);
      return () => {
        entry.active = false;
      };
    };

    const resizeHarness = rig({ schedule });
    const resize = await connectLive(resizeHarness);
    const pending = resize.attachment.resize({ cols: 100, rows: 30 });
    await vi.waitFor(() => expect(resize.socket.sent).toHaveLength(2));
    const resizeTimeout = scheduled.find(
      (entry) => entry.active && entry.delay === NATIVE_TERMINAL_RESIZE_ACK_TIMEOUT_MS,
    );
    expect(resizeTimeout).toBeDefined();
    resizeTimeout!.callback();
    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: { code: "resize-ack-timeout" },
    });
    expect(resize.socket.closes.at(-1)).toEqual({ code: 1008, reason: "resize-ack-timeout" });

    const lifetimeHarness = rig({ schedule });
    const lifetimeEvents: NativeTerminalEvent[] = [];
    const lifetime = await connectLive(lifetimeHarness, (event) => {
      lifetimeEvents.push(event);
    });
    const lifetimeLimit = [...scheduled]
      .reverse()
      .find((entry) => entry.active && entry.delay === NATIVE_TERMINAL_MAX_CONNECTION_LIFETIME_MS);
    expect(lifetimeLimit).toBeDefined();
    lifetimeLimit!.callback();
    expect(lifetime.socket.closes.at(-1)).toEqual({
      code: 1008,
      reason: "connection-lifetime-limit",
    });
    await vi.waitFor(() =>
      expect(lifetimeEvents).toContainEqual({
        type: "state",
        state: "disconnected",
        error: expect.objectContaining({ code: "connection-lifetime-limit" }),
      }),
    );
  });

  it("settles an outstanding resize with typed close and socket errors", async () => {
    const closeHarness = rig();
    const closed = await connectLive(closeHarness);
    const closedResize = closed.attachment.resize({ cols: 100, rows: 30 });
    await vi.waitFor(() => expect(closed.socket.sent).toHaveLength(2));
    closed.socket.peerClose();
    await expect(closedResize).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-closed" },
    });

    const errorHarness = rig();
    const errored = await connectLive(errorHarness);
    const erroredResize = errored.attachment.resize({ cols: 100, rows: 30 });
    await vi.waitFor(() => expect(errored.socket.sent).toHaveLength(2));
    errored.socket.error();
    await expect(erroredResize).resolves.toMatchObject({
      status: "error",
      error: { code: "socket-unavailable" },
    });
  });

  it("translates typed daemon failures and emits one disconnected state", async () => {
    const events: NativeTerminalEvent[] = [];
    const harness = rig();
    const { socket } = await connectLive(harness, (event) => {
      events.push(event);
    });
    socket.message(
      JSON.stringify({
        type: "error",
        protocolVersion: 1,
        code: "attachment-renewal-failed",
        retryable: true,
      }),
    );
    socket.peerClose();
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "state")).toHaveLength(2),
    );
    const disconnected = events.filter(
      (event): event is Extract<NativeTerminalEvent, { type: "state" }> =>
        event.type === "state" && event.state === "disconnected",
    );
    expect(disconnected).toEqual([
      {
        type: "state",
        state: "disconnected",
        error: {
          code: "attachment-renewal-failed",
          reason: "The terminal attachment could not renew its lease.",
          retryable: true,
        },
      },
    ]);
  });

  it("tears down idempotently and rejects late socket events and resize", async () => {
    const events: NativeTerminalEvent[] = [];
    const harness = rig();
    const { socket, attachment } = await connectLive(harness, (event) => {
      events.push(event);
    });
    attachment.dispose();
    attachment.dispose();
    socket.message(Uint8Array.of(9).buffer);
    socket.peerClose();

    expect(socket.closes).toEqual([{ code: 1000, reason: "renderer-disposed" }]);
    await expect(attachment.resize({ cols: 100, rows: 30 })).resolves.toMatchObject({
      status: "error",
      error: { code: "resize-unavailable" },
    });
    expect(events.filter((event) => event.type === "output")).toEqual([]);
    expect(
      events.filter((event) => event.type === "state" && event.state === "disconnected"),
    ).toEqual([]);
  });

  it("bounds issue/open lifetime and ignores late completion after expiry", async () => {
    const scheduled: Array<{ callback: () => void; active: boolean; delay: number }> = [];
    const schedule = (callback: () => void, delay: number) => {
      const entry = { callback, active: true, delay };
      scheduled.push(entry);
      return () => {
        entry.active = false;
      };
    };
    const never = new Promise<unknown>(() => undefined);
    const issueTimeout = rig({ issueAttachment: async () => never, schedule });
    const timed = issueTimeout.transport.connect(REQUEST, () => undefined);
    await vi.waitFor(() => expect(scheduled.some((entry) => entry.active)).toBe(true));
    scheduled.find((entry) => entry.active)!.callback();
    await expect(timed).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-issue-failed" },
    });
    expect(issueTimeout.sockets).toHaveLength(0);

    const openExpiry = rig({ schedule });
    const opening = openExpiry.transport.connect(REQUEST, () => undefined);
    const socket = await waitForSocket(openExpiry.sockets);
    const expiry = [...scheduled].reverse().find((entry) => entry.active);
    expect(expiry?.delay).toBe(15_000);
    expiry!.callback();
    socket.open();
    socket.message(ready());
    await expect(opening).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-expired" },
    });
    expect(socket.sent).toHaveLength(0);
  });

  it("requires a fresh issue/ticket on reconnect and rejects late retired output", async () => {
    const secondTicket = `ta1_${"b".repeat(43)}`;
    const secondRequest = "fa8e7197-2236-4a62-bc01-5b64dd18c267";
    const harness = rig({
      descriptors: [
        issueDescriptor(),
        issueDescriptor({ redemptionTicket: secondTicket, requestId: secondRequest }),
      ],
    });
    const firstEvents: NativeTerminalEvent[] = [];
    const first = await connectLive(harness, (event) => {
      firstEvents.push(event);
    });
    first.socket.message(Uint8Array.of(1).buffer);
    await vi.waitFor(() => expect(firstEvents.some((event) => event.type === "output")).toBe(true));
    first.socket.peerClose();
    first.socket.message(Uint8Array.of(9).buffer);

    const secondEvents: NativeTerminalEvent[] = [];
    const secondConnection = harness.transport.connect(REQUEST, (event) => {
      secondEvents.push(event);
    });
    const secondSocket = await waitForSocket(harness.sockets, 1);
    secondSocket.open();
    secondSocket.message(ready({ requestId: secondRequest }));
    const second = await secondConnection;
    expect(second.status).toBe("connected");
    secondSocket.message(Uint8Array.of(2).buffer);
    await vi.waitFor(() =>
      expect(secondEvents.some((event) => event.type === "output")).toBe(true),
    );

    expect(harness.issueAttachment).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first.socket.sent[0] as string).ticket).toBe(TICKET);
    expect(JSON.parse(secondSocket.sent[0] as string).ticket).toBe(secondTicket);
    expect(firstEvents.filter((event) => event.type === "output")).toEqual([
      { type: "output", bytes: Uint8Array.of(1) },
    ]);
    expect(secondEvents.filter((event) => event.type === "output")).toEqual([
      { type: "output", bytes: Uint8Array.of(2) },
    ]);
  });

  it("does not reflect bearer material through typed failures", async () => {
    const secret = `${TICKET}-must-not-reflect`;
    const harness = rig({ issueAttachment: async () => Promise.reject(new Error(secret)) });
    const result = await harness.transport.connect(REQUEST, () => undefined);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((result.error satisfies NativeTerminalTransportError).code).toBe(
      "attachment-issue-failed",
    );
  });
});
