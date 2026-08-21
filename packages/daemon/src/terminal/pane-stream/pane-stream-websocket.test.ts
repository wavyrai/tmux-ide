import { describe, expect, it, vi } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamServerFrameSchemaZ,
} from "@tmux-ide/contracts";
import type { MirrorPaneEvent, MirrorSessionDescription } from "../mirror/events.ts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import type { DirectTerminalSocket } from "../attachments/direct-websocket.ts";
import {
  createSessionRuntimeObservability,
  type SessionRuntimeObservability,
} from "../session-runtime/runtime-observability.ts";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamClientSocket,
  type PaneStreamInputTransportStageEvent,
} from "@tmux-ide/daemon-client/pane-stream-client";
import {
  crossProcessOneWayBounds,
  daemonToClientOneWayBounds,
  type PaneStreamClockCalibration,
} from "@tmux-ide/daemon-client/pane-stream-clock-calibration";
import { WorkspaceMultiplexerError } from "../../lib/workspace-multiplexer-verbs.ts";
import { SessionRuntimeIntentError } from "../session-runtime/semantic-mutation-executor.ts";
import { PaneStreamLeaseManager } from "./lease-manager.ts";
import {
  PaneStreamAdmissionCoordinator,
  type PaneStreamMirror,
  type SessionRuntimePaneStreamTransportBinding,
} from "./pane-stream-websocket.ts";

const INSTANCE = "00000000-0000-4000-8000-000000000099";
const ORIGIN = "tmux-ide://app";
const WS_URL = `ws://127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}`;
const SESSION = "alpha";

let requestCounter = 0;
function freshRequestId(): string {
  requestCounter += 1;
  return `00000000-0000-4000-8000-${String(requestCounter).padStart(12, "0")}`;
}

class FakeSocket implements DirectTerminalSocket {
  readyState = 1;
  sentBytes = 0;
  drainedBytes = 0;
  readonly frames: unknown[] = [];
  onTransmit: ((text: string) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>();

  get bufferedAmount(): number {
    return this.sentBytes - this.drainedBytes;
  }

  send(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    this.sentBytes += Buffer.byteLength(text, "utf8");
    this.frames.push(JSON.parse(text));
    this.onTransmit?.(text);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      (listener as (...inner: unknown[]) => void)(...args);
    }
  }

  message(frame: unknown, isBinary = false): void {
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.emit("message", Buffer.from(payload, "utf8"), isBinary);
  }

  drainAll(): void {
    this.drainedBytes = this.sentBytes;
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter(
      (frame): frame is Record<string, unknown> =>
        typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === type,
    );
  }
}

class LoopbackClientSocket implements PaneStreamClientSocket {
  readyState = 0;
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  readonly #server: FakeSocket;
  readonly #forward: (frame: Record<string, unknown>) => void;

  constructor(server: FakeSocket, forward: (frame: Record<string, unknown>) => void) {
    this.#server = server;
    this.#forward = forward;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    queueMicrotask(() => {
      this.#forward(frame);
      this.#server.emit("message", Buffer.from(data, "utf8"), false);
    });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#server.close();
    this.#emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open");
  }

  message(data: string): void {
    this.#emit("message", data);
  }

  #emit(type: string, data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

class FakeSub implements MirrorSubscription {
  readonly session: string;
  readonly semanticPaneId: string;
  readonly onEvent: (event: MirrorPaneEvent) => void;
  freezes = 0;
  thaws = 0;
  texts: string[] = [];
  keys: string[] = [];
  closedCount = 0;

  constructor(request: MirrorSubscribeRequest) {
    this.session = request.session;
    this.semanticPaneId = request.semanticPaneId;
    this.onEvent = request.onEvent;
  }

  freeze(): void {
    this.freezes += 1;
  }

  thaw(): void {
    this.thaws += 1;
  }

  sendText(text: string): void {
    this.texts.push(text);
  }

  sendKey(key: string): void {
    this.keys.push(key);
  }

  async close(): Promise<void> {
    this.closedCount += 1;
  }
}

class FakeMirror implements PaneStreamMirror {
  panes: string[];
  readonly subs: FakeSub[] = [];
  layoutHandlers: Array<(event: never) => void> = [];
  describeGate: Promise<void> | null = null;
  describeFailure = false;

  constructor(panes: string[]) {
    this.panes = panes;
  }

  async describeSession(session: string): Promise<MirrorSessionDescription> {
    await this.describeGate;
    if (this.describeFailure) throw new Error("describe failed");
    return {
      session,
      panes: this.panes.map((semanticPaneId) => ({
        semanticPaneId,
        semanticWindowId: "window.mirror.w1",
        role: null,
        paneType: null,
        currentCommand: "sh",
        cwd: null,
        title: semanticPaneId,
        windowName: "main",
        active: false,
      })),
      diagnostics: [],
      degraded: false,
    };
  }

  async subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription> {
    if (!this.panes.includes(request.semanticPaneId)) {
      throw new Error(`unknown semantic pane ${request.semanticPaneId}`);
    }
    const sub = new FakeSub(request);
    this.subs.push(sub);
    if (request.onLayout) this.layoutHandlers.push(request.onLayout as (event: never) => void);
    return sub;
  }

  async subscribeLayout(_session: string, onLayout: (event: never) => void) {
    this.layoutHandlers.push(onLayout);
    return { session: SESSION, close: async () => undefined };
  }

  subFor(pane: string, index = 0): FakeSub {
    const matches = this.subs.filter((sub) => sub.semanticPaneId === pane);
    const sub = matches[index];
    if (!sub) throw new Error(`no subscription ${index} for ${pane}`);
    return sub;
  }
}

interface Timer {
  callback: () => void;
  delay: number;
  cancelled: boolean;
}

function testScheduler() {
  const timers: Timer[] = [];
  const schedule = (callback: () => void, delay: number): (() => void) => {
    const timer: Timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const runDue = (): void => {
    const due = timers.splice(0);
    for (const timer of due) {
      if (!timer.cancelled) timer.callback();
    }
  };
  return { schedule, runDue, timers };
}

function harness(
  options: {
    panes?: string[];
    budgets?: ConstructorParameters<typeof PaneStreamAdmissionCoordinator>[0]["flowBudgets"];
    ticketTtlMs?: number;
    now?: () => number;
    maxInputFramesPerWindow?: number;
    maxInputBytesPerWindow?: number;
    inputRateWindowMs?: number;
    maxSocketBufferedBytes?: number;
    bindSessionRuntime?: ConstructorParameters<
      typeof PaneStreamAdmissionCoordinator
    >[0]["bindSessionRuntime"];
    openTerminalDelivery?: SessionRuntimePaneStreamTransportBinding["openTerminalDelivery"];
    observability?: SessionRuntimeObservability;
    diagnosticSharedNowMicros?: () => number;
    diagnosticAfterFrameParse?: () => void;
  } = {},
) {
  const mirror = new FakeMirror(options.panes ?? ["pane.editor", "pane.shell"]);
  const now = options.now ?? Date.now;
  const leaseManager = new PaneStreamLeaseManager({
    daemonInstanceId: INSTANCE,
    now,
    ticketTtlMs: options.ticketTtlMs ?? 15_000,
  });
  const scheduler = testScheduler();
  const deliveryListeners = new Map<string, (message: never) => void>();
  const deliveryAcks = vi.fn();
  const deliveryNacks = vi.fn();
  const deliveryVisibility = vi.fn();
  const submitIntent = vi.fn(async () => undefined);
  const sendInput = vi.fn();
  const fitViewport = vi.fn();
  let authorityRevision = 1;
  const authorityOwners = { input: "test:interactive", focus: null, geometry: null } as {
    input: string | null;
    focus: string | null;
    geometry: string | null;
  };
  const authoritySnapshot = () => ({
    generation: INSTANCE,
    session: SESSION,
    revision: authorityRevision,
    owners: { ...authorityOwners },
    nativeGeometryYieldUntilMs: 0,
    clients: [
      {
        clientId: "test:interactive",
        surface: "unknown" as const,
        state: "foreground" as const,
        connectedRevision: 1,
        activityRevision: authorityRevision,
      },
    ],
  });
  const activateLegacyAuthority = vi.fn((geometry: boolean) => {
    authorityOwners.input = "test:interactive";
    if (geometry) authorityOwners.geometry = "test:interactive";
    authorityRevision += 1;
    return authoritySnapshot();
  });
  const coordinator = new PaneStreamAdmissionCoordinator({
    daemonInstanceId: INSTANCE,
    webSocketUrl: WS_URL,
    leaseManager,
    mirror,
    observability: options.observability,
    diagnosticSharedNowMicros: options.diagnosticSharedNowMicros,
    diagnosticAfterFrameParse: options.diagnosticAfterFrameParse,
    bindSessionRuntime:
      options.bindSessionRuntime ??
      (() => ({
        generation: INSTANCE,
        session: SESSION,
        clientId: "test:interactive",
        authoritySnapshot,
        activateLegacyAuthority,
        updatePresence: () => {
          authorityRevision += 1;
          return authoritySnapshot();
        },
        noteActivity: () => {
          authorityRevision += 1;
          return authoritySnapshot();
        },
        requestAuthority: (authority) => {
          authorityOwners[authority] = "test:interactive";
          authorityRevision += 1;
          return {
            generation: INSTANCE,
            session: SESSION,
            clientId: "test:interactive",
            authority,
            token: "00000000-0000-4000-8000-000000000095",
            revision: authorityRevision,
          };
        },
        releaseAuthority: (authority) => {
          authorityOwners[authority] = null;
          authorityRevision += 1;
          return authoritySnapshot();
        },
        assertController: () => undefined,
        openTerminalDelivery:
          options.openTerminalDelivery ??
          (async (pane, _offer, onMessage) => {
            deliveryListeners.set(pane, onMessage as (message: never) => void);
            return {
              negotiation: {
                accepted: true as const,
                negotiated: {
                  protocolVersion: 1 as const,
                  encoding: "semantic-v1" as const,
                  richPlacements: false,
                  generation: INSTANCE,
                  deliveryNonce: "00000000-0000-4000-8000-000000000098",
                },
              },
              ack: deliveryAcks,
              nack: deliveryNacks,
              setVisibility: deliveryVisibility,
              close: async () => undefined,
            };
          }),
        submitIntent,
        sendInput,
        fitViewport,
        close: async () => undefined,
      })),
    flowBudgets: options.budgets,
    maxInputFramesPerWindow: options.maxInputFramesPerWindow,
    maxInputBytesPerWindow: options.maxInputBytesPerWindow,
    inputRateWindowMs: options.inputRateWindowMs,
    maxSocketBufferedBytes: options.maxSocketBufferedBytes,
    now,
    schedule: scheduler.schedule,
  });
  return {
    mirror,
    leaseManager,
    coordinator,
    scheduler,
    deliveryListeners,
    deliveryAcks,
    deliveryNacks,
    deliveryVisibility,
    submitIntent,
    sendInput,
    fitViewport,
    activateLegacyAuthority,
  };
}

async function connect(
  h: ReturnType<typeof harness>,
  options: {
    panes?: string[];
    viewerMode?: "interactive" | "read-only";
    deliveryAcks?: boolean;
    hostClientId?: string;
    semanticDelivery?: boolean;
    diagnosticCapabilities?: readonly ("causal-cell-v1" | "clock-bounds-v1")[];
  } = {},
): Promise<{ socket: FakeSocket; requestId: string }> {
  const requestId = freshRequestId();
  const descriptor = await h.coordinator.issue(
    {
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      workspaceName: "workspace.alpha",
      panes: options.panes ?? ["pane.editor", "pane.shell"],
      viewerMode: options.viewerMode ?? "read-only",
      ...(options.semanticDelivery
        ? {
            terminalDelivery: {
              protocolVersions: [1],
              encodings: ["semantic-v1"] as const,
              richPlacements: false,
            },
          }
        : {}),
    },
    {
      requestId,
      projectIdentity: "workspace.alpha",
      sessionName: SESSION,
      rendererOrigin: ORIGIN,
      hostClientId: options.hostClientId ?? `test-host:${requestId}`,
    },
  );
  const decision = h.coordinator.reserveUpgrade({
    path: PANE_STREAM_REDEEM_PATH,
    protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
    origin: ORIGIN,
  });
  if (!decision.accepted) throw new Error(`upgrade rejected: ${decision.code}`);
  const socket = new FakeSocket();
  decision.admission.bind(socket);
  socket.message({
    type: "redeem",
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    ticket: descriptor.redemptionTicket,
    requestId,
    daemonInstanceId: INSTANCE,
    ...(options.deliveryAcks ? { deliveryAcks: true } : {}),
    ...(options.diagnosticCapabilities
      ? { diagnosticCapabilities: options.diagnosticCapabilities }
      : {}),
  });
  await vi.waitFor(() => {
    expect({ ready: socket.framesOfType("ready").length, closed: socket.closed }).toEqual({
      ready: 1,
      closed: null,
    });
  });
  return { socket, requestId };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PaneStreamAdmissionCoordinator", () => {
  it("answers normalized clock probes only on the negotiated authenticated connection", async () => {
    let raw = 7_000_000_000_000;
    const shared = vi.fn(() => (raw += 10));
    const h = harness({ diagnosticSharedNowMicros: shared });
    const { socket, requestId } = await connect(h, {
      diagnosticCapabilities: ["clock-bounds-v1"],
    });
    for (let probe = 1; probe <= 5; probe += 1)
      socket.message({ type: "clock-probe", requestId, probe, clientSendMicros: probe - 1 });
    expect(socket.framesOfType("clock-probe-ack")).toHaveLength(5);
    expect(socket.framesOfType("clock-probe-ack")[0]).toEqual({
      type: "clock-probe-ack",
      requestId,
      daemonInstanceId: INSTANCE,
      probe: 1,
      clientSendMicros: 0,
      daemonReceiveMicros: 0,
      daemonSendMicros: 10,
    });
    expect(JSON.stringify(socket.frames)).not.toContain("7000000000000");
    const calls = shared.mock.calls.length;
    socket.message({ type: "clock-probe", requestId, probe: 5, clientSendMicros: 5 });
    expect(shared).toHaveBeenCalledTimes(calls);
    expect(socket.framesOfType("clock-probe-ack")).toHaveLength(5);
    expect(socket.closed?.reason).toBe("protocol-error");
  });

  it("handles escaped clock-probe spellings in the parsed bounded handler without a clock read", async () => {
    let raw = 7_000_000_000_000;
    const shared = vi.fn(() => (raw += 10));
    const h = harness({ diagnosticSharedNowMicros: shared });
    const { socket, requestId } = await connect(h, {
      diagnosticCapabilities: ["clock-bounds-v1"],
    });
    const calls = shared.mock.calls.length;
    socket.message(
      `{"ty\\u0070e":"clock\\u002dprobe","requestId":"${requestId}","probe":2,"clientSendMicros":0}`,
    );
    expect(shared).toHaveBeenCalledTimes(calls);
    expect(socket.framesOfType("clock-probe-ack")).toEqual([]);
    expect(socket.closed?.reason).toBe("protocol-error");
  });

  it("does no shared-clock work without negotiated clock bounds", async () => {
    const shared = vi.fn(() => {
      throw new Error("must not run");
    });
    const h = harness({ diagnosticSharedNowMicros: shared });
    const { socket, requestId } = await connect(h);
    socket.message({ type: "clock-probe", requestId, probe: 1, clientSendMicros: 0 });
    expect(shared).not.toHaveBeenCalled();
    expect(socket.framesOfType("clock-probe-ack")).toEqual([]);
    expect(socket.closed?.reason).toBe("protocol-error");
  });

  it("samples shared callback entry before induced frame parsing work", async () => {
    let sharedRawMicros = 9_000_000_000_000;
    const observability = createSessionRuntimeObservability({ nowMicros: () => 1_000 });
    const h = harness({
      observability,
      diagnosticSharedNowMicros: () => sharedRawMicros,
      diagnosticAfterFrameParse: () => {
        sharedRawMicros += 40_000;
      },
    });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      panes: ["pane.editor"],
      diagnosticCapabilities: ["clock-bounds-v1"],
    });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(1));
    const traceId = "00000000-0000-4000-8000-000000000091";
    socket.message({
      type: "input",
      kind: "key",
      pane: "pane.editor",
      seq: 1,
      data: "x",
      performanceTraceId: traceId,
    });

    expect(h.mirror.subFor("pane.editor").keys).toEqual(["x"]);
    const spans = observability
      .snapshot()
      .spans.filter((span) => span.traceId === traceId && span.sharedStartedAtMicros !== undefined);
    expect(
      spans.find((span) => span.operation === "pane-stream-socket-message-callback-entry"),
    ).toMatchObject({ sharedStartedAtMicros: 0, sharedEndedAtMicros: 0 });
    expect(
      spans.find((span) => span.operation === "pane-stream-input-frame-ingress"),
    ).toMatchObject({ sharedStartedAtMicros: 40_000, sharedEndedAtMicros: 40_000 });
  });

  it("keeps shared parse diagnostics fail-open for product input", async () => {
    const h = harness({
      diagnosticSharedNowMicros: () => 1,
      diagnosticAfterFrameParse: () => {
        throw new Error("diagnostic parse observer failed");
      },
    });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      panes: ["pane.editor"],
      diagnosticCapabilities: ["clock-bounds-v1"],
    });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(1));
    socket.message({ type: "input", kind: "key", pane: "pane.editor", seq: 1, data: "x" });
    expect(h.mirror.subFor("pane.editor").keys).toEqual(["x"]);
    expect(socket.framesOfType("input-ack")).toHaveLength(1);
    expect(socket.closed).toBeNull();
  });

  it("bounds induced outbound and inbound delay through the production client/server seams", async () => {
    let worldMicros = 0;
    const observability = createSessionRuntimeObservability({ nowMicros: () => worldMicros });
    const h = harness({
      observability,
      diagnosticSharedNowMicros: () => 9_000_000_000_000 + worldMicros,
    });
    const requestId = freshRequestId();
    const stream = {
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      workspaceName: "workspace.alpha",
      panes: ["pane.editor"],
      viewerMode: "interactive" as const,
      terminalDelivery: {
        protocolVersions: [1],
        encodings: ["semantic-v1" as const],
        richPlacements: false,
      },
    };
    const issued = await h.coordinator.issue(stream, {
      requestId,
      projectIdentity: "workspace.alpha",
      sessionName: SESSION,
      rendererOrigin: ORIGIN,
      hostClientId: "test:interactive",
    });
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error(`upgrade rejected: ${decision.code}`);
    const serverSocket = new FakeSocket();
    decision.admission.bind(serverSocket);
    const clientSocket = new LoopbackClientSocket(serverSocket, (frame) => {
      worldMicros += frame.type === "input" ? 40_000 : 10;
    });
    serverSocket.onTransmit = (text) => {
      const frame = JSON.parse(text) as { type?: string };
      queueMicrotask(() => {
        worldMicros += frame.type === "input-ack" ? 70_000 : 10;
        clientSocket.message(text);
      });
    };
    const calibrations: Array<PaneStreamClockCalibration | null> = [];
    const stages: PaneStreamInputTransportStageEvent[] = [];
    const acknowledgements: Array<{ sharedMicros?: number }> = [];
    const opening = connectIssuedPaneStreamRuntimeClient(
      {
        createSocket: () => {
          queueMicrotask(() => clientSocket.open());
          return clientSocket;
        },
        origin: ORIGIN,
        hostClientId: "test:interactive",
        stream,
        onNegotiated: () => undefined,
        onTerminalDelivery: () => undefined,
        onInputTransportStage: (event) => stages.push(event),
        diagnosticNowMicros: () => worldMicros,
        diagnosticSharedNowMicros: () => 8_000_000_000_000 + worldMicros,
        diagnosticNextTurn: (callback) => {
          queueMicrotask(callback);
          return () => undefined;
        },
        diagnosticCapabilities: ["clock-bounds-v1"],
        onClockCalibration: (calibration) => calibrations.push(calibration),
        onInputAck: (event) => acknowledgements.push(event),
        onFault: (error) => {
          throw error;
        },
      },
      issued,
    );
    const client = await opening;
    const traceId = "00000000-0000-4000-8000-000000000091";
    await expect(
      client.sendTerminalInput(
        { workspaceName: "workspace.alpha", semanticPaneId: "pane.editor" },
        { kind: "key", data: "x" },
        traceId,
      ),
    ).resolves.toBe("ok");
    await vi.waitFor(() =>
      expect(stages.some((stage) => stage.operation === "pane-stream-socket-send-return")).toBe(
        true,
      ),
    );

    const calibration = calibrations[0];
    expect(calibration).not.toBeNull();
    const clientSend = stages.find(
      (stage) => stage.operation === "pane-stream-socket-send-return",
    )!;
    const daemonSpans = observability.snapshot().spans.filter((span) => span.traceId === traceId);
    const callback = daemonSpans.find(
      (span) => span.operation === "pane-stream-socket-message-callback-entry",
    )!;
    const daemonAck = daemonSpans.find(
      (span) => span.operation === "pane-stream-input-ack-socket-send",
    )!;
    const clientAck = acknowledgements[0]!;
    const outbound = crossProcessOneWayBounds(
      calibration!,
      clientSend.sharedMicros!,
      callback.sharedStartedAtMicros!,
    )!;
    const inbound = daemonToClientOneWayBounds(
      calibration!,
      daemonAck.sharedEndedAtMicros!,
      clientAck.sharedMicros!,
    )!;
    expect(
      outbound,
      JSON.stringify({ calibration, clientSend, callback, daemonAck, clientAck }),
    ).not.toBeNull();
    expect(outbound.lowerMicros).toBeLessThanOrEqual(40_000);
    expect(outbound.upperMicros).toBeGreaterThanOrEqual(40_000);
    expect(inbound.lowerMicros).toBeLessThanOrEqual(70_000);
    expect(inbound.upperMicros).toBeGreaterThanOrEqual(70_000);
    expect(
      JSON.stringify({ server: serverSocket.frames, stages, daemonSpans, calibrations }),
    ).not.toContain("8000000000000");
    expect(
      JSON.stringify({ server: serverSocket.frames, stages, daemonSpans, calibrations }),
    ).not.toContain("9000000000000");
    client.close();
  });

  it("binds redeemed transport identity to SessionRuntime and closes it with the socket", async () => {
    const close = vi.fn(async () => undefined);
    const bindSessionRuntime = vi.fn((descriptor: { sessionName: string; leaseId: string }) => ({
      generation: "11111111-1111-4111-8111-111111111111",
      session: descriptor.sessionName,
      clientId: `pane-stream:${descriptor.leaseId}`,
      assertController: () => undefined,
      openTerminalDelivery: async () => {
        throw new Error("not used");
      },
      submitIntent: async () => undefined,
      close,
    }));
    const h = harness({ bindSessionRuntime });
    const { socket } = await connect(h);
    expect(bindSessionRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: SESSION, status: "active" }),
    );
    socket.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("redeems a ticket and streams atomic seed batches plus live output for two panes", async () => {
    const h = harness();
    const { socket } = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));

    const editor = h.mirror.subFor("pane.editor");
    const shell = h.mirror.subFor("pane.shell");
    // The atomic recipe: reset -> seed -> held delta -> cursor in one burst.
    editor.onEvent({ type: "reset", cols: 120, rows: 40 });
    editor.onEvent({ type: "seed", data: Buffer.from("EDITOR_SEED") });
    editor.onEvent({ type: "delta", data: Buffer.from("HELD") });
    editor.onEvent({ type: "cursor", x: 3, y: 1 });
    shell.onEvent({ type: "reset", cols: 80, rows: 24 });
    shell.onEvent({ type: "seed", data: Buffer.from("SHELL_SEED") });
    shell.onEvent({ type: "cursor", x: 0, y: 0 });

    const batches = socket.framesOfType("seed-batch");
    expect(batches).toHaveLength(2);
    const editorBatch = batches.find((frame) => frame.pane === "pane.editor")!;
    expect(editorBatch.reset).toEqual({ cols: 120, rows: 40 });
    expect(Buffer.from(editorBatch.seed as string, "base64").toString()).toBe("EDITOR_SEED");
    expect(
      (editorBatch.held as string[]).map((held) => Buffer.from(held, "base64").toString()),
    ).toEqual(["HELD"]);
    expect(editorBatch.cursor).toEqual({ x: 3, y: 1 });

    // Live deltas route to their own pane only.
    editor.onEvent({ type: "delta", data: Buffer.from("EDITOR_LIVE") });
    shell.onEvent({ type: "delta", data: Buffer.from("SHELL_LIVE") });
    const outputs = socket.framesOfType("output");
    expect(outputs).toHaveLength(2);
    expect(outputs.map((frame) => frame.pane)).toEqual(["pane.editor", "pane.shell"]);
    expect(Buffer.from(outputs[0]!.data as string, "base64").toString()).toBe("EDITOR_LIVE");

    // Every frame on the wire parses under the contract and carries no
    // runtime tmux address in structural fields.
    for (const frame of socket.frames) {
      const parsed = PaneStreamServerFrameSchemaZ.parse(frame);
      const structural = { ...(parsed as Record<string, unknown>) };
      delete structural.seed;
      delete structural.held;
      delete structural.data;
      expect(JSON.stringify(structural)).not.toMatch(/[%@$][0-9]/u);
    }
  });

  it("enumerates the pane set at issue and rejects unknown panes", async () => {
    const h = harness({ panes: ["pane.editor"] });
    await expect(
      h.coordinator.issue(
        {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "workspace.alpha",
          panes: ["pane.editor", "pane.ghost"],
          viewerMode: "read-only",
        },
        {
          requestId: freshRequestId(),
          projectIdentity: "workspace.alpha",
          sessionName: SESSION,
          rendererOrigin: ORIGIN,
        },
      ),
    ).rejects.toMatchObject({ code: "pane-not-found" });
  });

  it("stalls only the exhausted client's pane and thaws it after drain", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 300, resumeAt: 0 },
        "renderer-backlog": { maxOutstanding: 512, resumeAt: 128 },
      },
    });
    const one = await connect(h);
    const two = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(4));
    const editorOne = h.mirror.subFor("pane.editor", 0);
    const shellOne = h.mirror.subFor("pane.shell", 0);
    const editorTwo = h.mirror.subFor("pane.editor", 1);

    // Client one's socket never drains; flood its editor pane past budget.
    // Stall is judged on the drain tick, not synchronously at send.
    const flood = Buffer.alloc(200, 65);
    editorOne.onEvent({ type: "delta", data: flood });
    editorOne.onEvent({ type: "delta", data: flood });
    h.scheduler.runDue();
    expect(editorOne.freezes).toBe(1);
    // Its own quiet pane and the OTHER client's same pane are untouched.
    expect(shellOne.freezes).toBe(0);
    expect(editorTwo.freezes).toBe(0);

    // The healthy client keeps receiving that same pane's frames.
    editorTwo.onEvent({ type: "delta", data: Buffer.from("STILL_FLOWING") });
    expect(
      two.socket
        .framesOfType("output")
        .some(
          (frame) => Buffer.from(frame.data as string, "base64").toString() === "STILL_FLOWING",
        ),
    ).toBe(true);

    // Drain both sockets; the tick returns tickets and thaws the pane.
    one.socket.drainAll();
    two.socket.drainAll();
    h.scheduler.runDue();
    expect(editorOne.thaws).toBe(1);
    expect(h.coordinator.flowSnapshot()).toEqual({});
  });

  it("force-returns tickets and closes subscriptions on WS close within one tick", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 10_000, resumeAt: 1_000 },
        "renderer-backlog": { maxOutstanding: 512, resumeAt: 128 },
      },
    });
    const { socket } = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));
    h.mirror.subFor("pane.editor").onEvent({ type: "delta", data: Buffer.from("X") });
    expect(Object.keys(h.coordinator.flowSnapshot())).toHaveLength(1);

    socket.emit("close");
    // Synchronously after the close event: ledger empty, subs closed.
    expect(h.coordinator.flowSnapshot()).toEqual({});
    expect(h.mirror.subFor("pane.editor").closedCount).toBe(1);
    expect(h.mirror.subFor("pane.shell").closedCount).toBe(1);
    await settled();
    expect(h.leaseManager.snapshot().leases).toHaveLength(0);
  });

  it("enforces interactive controller ownership at trusted redemption", async () => {
    let controllerHost: string | null = null;
    const h = harness({
      bindSessionRuntime: (descriptor) => {
        if (!descriptor.hostClientId) throw new Error("trusted host identity required");
        if (descriptor.viewerMode === "interactive") {
          if (controllerHost && controllerHost !== descriptor.hostClientId) {
            throw Object.assign(new Error("controller conflict"), {
              code: "controller-conflict",
            });
          }
          controllerHost = descriptor.hostClientId;
        }
        return {
          generation: INSTANCE,
          session: descriptor.sessionName,
          clientId: descriptor.hostClientId,
          assertController: () => undefined,
          openTerminalDelivery: async () => {
            throw new Error("not used");
          },
          submitIntent: async () => undefined,
          close: async () => undefined,
        };
      },
    });
    const first = await connect(h, {
      viewerMode: "interactive",
      panes: ["pane.editor"],
      hostClientId: "test-host:first",
    });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor", "pane.shell"],
        viewerMode: "interactive",
      },
      {
        requestId,
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
        hostClientId: "test-host:second",
      },
    );
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error(decision.code);
    const second = new FakeSocket();
    decision.admission.bind(second);
    second.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await vi.waitFor(() => {
      expect(second.framesOfType("ready")).toHaveLength(0);
      expect(second.closed).toEqual({ code: 1008, reason: "redemption-rejected" });
    });
    // Passive viewers remain independent of controller ownership.
    await expect(
      connect(h, { viewerMode: "read-only", panes: ["pane.editor"] }),
    ).resolves.toBeTruthy();
    first.socket.close();
  });

  it("honors the delivery TTL for a redeem queued behind slow admission work", async () => {
    let now = 1_000;
    const h = harness({ ticketTtlMs: 1_000, now: () => now });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId,
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    // Occupy the serialized admission queue with a gated issue.
    let releaseGate!: () => void;
    h.mirror.describeGate = new Promise((resolve) => {
      releaseGate = () => resolve();
    });
    const queued = h.coordinator
      .issue(
        {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "workspace.alpha",
          panes: ["pane.editor"],
          viewerMode: "read-only",
        },
        {
          requestId: freshRequestId(),
          projectIdentity: "workspace.alpha",
          sessionName: SESSION,
          rendererOrigin: ORIGIN,
        },
      )
      .catch(() => undefined);

    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    // The frame is DELIVERED in time (now=1500 < 2000)...
    now = 1_500;
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await settled();
    // ...but only EXECUTES after the queue clears, past the ticket TTL.
    now = 5_000;
    h.mirror.describeGate = null;
    releaseGate();
    await queued;
    await vi.waitFor(() => {
      expect(socket.framesOfType("ready")).toHaveLength(1);
    });
  });

  it("rejects a redemption frame delivered after the ticket TTL", async () => {
    let now = 1_000;
    const h = harness({ ticketTtlMs: 1_000, now: () => now });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId,
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    now = 2_500;
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await vi.waitFor(() => {
      expect(socket.framesOfType("error")).toHaveLength(1);
    });
    expect(socket.framesOfType("error")[0]!.code).toBe("ticket-expired");
    expect(socket.closed).not.toBeNull();
  });

  it("accepts interactive input, acks it, and rejects it on read-only leases", async () => {
    const h = harness();
    const interactive = await connect(h, { viewerMode: "interactive" });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));
    interactive.socket.message({
      type: "input",
      kind: "text",
      pane: "pane.editor",
      seq: 1,
      data: "echo hi",
    });
    interactive.socket.message({
      type: "input",
      kind: "key",
      pane: "pane.editor",
      seq: 2,
      data: "Enter",
    });
    expect(h.mirror.subFor("pane.editor").texts).toEqual(["echo hi"]);
    expect(h.mirror.subFor("pane.editor").keys).toEqual(["Enter"]);
    const acks = interactive.socket.framesOfType("input-ack");
    expect(acks.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(h.activateLegacyAuthority).toHaveBeenCalledTimes(1);
    expect(h.activateLegacyAuthority).toHaveBeenCalledWith(false);

    // Out-of-order input closes the connection.
    interactive.socket.message({
      type: "input",
      kind: "text",
      pane: "pane.editor",
      seq: 9,
      data: "x",
    });
    expect(interactive.socket.framesOfType("error")[0]!.code).toBe("input-rejected");
    expect(interactive.socket.closed).not.toBeNull();

    const readOnly = await connect(h, { viewerMode: "read-only", panes: ["pane.shell"] });
    readOnly.socket.message({ type: "input", kind: "text", pane: "pane.shell", seq: 1, data: "x" });
    expect(readOnly.socket.framesOfType("error")[0]!.code).toBe("input-rejected");
    expect(readOnly.socket.closed).not.toBeNull();
  });

  it("does not sample the observability clock for input when diagnostics are disabled", async () => {
    const nowMicros = vi.fn(() => {
      throw new Error("disabled observability clock was sampled");
    });
    const observability: SessionRuntimeObservability = {
      enabled: false,
      nowMicros,
      beginTrace: vi.fn(() => null),
      recordSpan: vi.fn(),
      snapshot: () => ({ spans: [], droppedSpans: 0 }),
    };
    const h = harness({ observability });
    const { socket } = await connect(h, { viewerMode: "interactive" });
    const beginTraceCallsBeforeInput = vi.mocked(observability.beginTrace).mock.calls.length;
    const recordSpanCallsBeforeInput = vi.mocked(observability.recordSpan).mock.calls.length;
    socket.message({
      type: "input",
      kind: "key",
      pane: "pane.editor",
      seq: 1,
      data: "Enter",
      performanceTraceId: "00000000-0000-4000-8000-000000000093",
    });
    expect(socket.framesOfType("input-ack").map((frame) => frame.seq)).toEqual([1]);
    expect(nowMicros).not.toHaveBeenCalled();
    expect(vi.mocked(observability.beginTrace).mock.calls).toHaveLength(beginTraceCallsBeforeInput);
    expect(vi.mocked(observability.recordSpan).mock.calls).toHaveLength(recordSpanCallsBeforeInput);
  });

  it("keeps daemon input and ACK fail-open when ingress or ACK observation throws", async () => {
    for (const failure of ["clock", "ingress-span", "ack-span"] as const) {
      let now = 0;
      let records = 0;
      let armed = false;
      const observability = createSessionRuntimeObservability({
        nowMicros: () => {
          if (armed && failure === "clock") throw new Error("clock failed");
          return (now += 5);
        },
        onSpan: () => {
          if (!armed) return;
          records += 1;
          if (failure === "ingress-span" && records === 1) throw new Error("ingress failed");
          if (failure === "ack-span" && records === 2) throw new Error("ack failed");
        },
      });
      const h = harness({ observability });
      const { socket } = await connect(h, { viewerMode: "interactive" });
      armed = true;
      socket.message({
        type: "input",
        kind: "key",
        pane: "pane.editor",
        seq: 1,
        data: "Enter",
        performanceTraceId: `00000000-0000-4000-8000-00000000009${failure === "clock" ? 4 : failure === "ingress-span" ? 5 : 6}`,
      });
      expect(h.mirror.subFor("pane.editor").keys).toEqual(["Enter"]);
      expect(socket.framesOfType("input-ack").map((frame) => frame.seq)).toEqual([1]);
      expect(socket.closed).toBeNull();
    }
  });

  it("keeps healthy long-lived input live across rate windows while bounding a flood", async () => {
    let now = 1_000;
    const healthy = harness({
      now: () => now,
      maxInputFramesPerWindow: 2,
      maxInputBytesPerWindow: 1_024,
      inputRateWindowMs: 100,
    });
    const healthyConnection = await connect(healthy, {
      viewerMode: "interactive",
      panes: ["pane.editor"],
    });

    for (let seq = 1; seq <= 6; seq += 1) {
      healthyConnection.socket.message({
        type: "input",
        kind: "text",
        pane: "pane.editor",
        seq,
        data: "x",
      });
      if (seq % 2 === 0) now += 100;
    }
    expect(healthyConnection.socket.framesOfType("input-ack").map((frame) => frame.seq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(healthyConnection.socket.closed).toBeNull();

    const flooded = harness({
      now: () => now,
      maxInputFramesPerWindow: 2,
      maxInputBytesPerWindow: 1_024,
      inputRateWindowMs: 100,
    });
    const floodedConnection = await connect(flooded, {
      viewerMode: "interactive",
      panes: ["pane.editor"],
    });
    for (let seq = 1; seq <= 3; seq += 1) {
      floodedConnection.socket.message({
        type: "input",
        kind: "text",
        pane: "pane.editor",
        seq,
        data: "x",
      });
    }
    expect(floodedConnection.socket.framesOfType("input-ack").map((frame) => frame.seq)).toEqual([
      1, 2,
    ]);
    expect(floodedConnection.socket.framesOfType("error")[0]!.code).toBe("input-rejected");
    expect(floodedConnection.socket.closed).not.toBeNull();
  });

  it("uses one session socket and one runtime binding for semantic delivery, layout and intents", async () => {
    let nowMicros = 10_000;
    const observability = createSessionRuntimeObservability({
      nowMicros: () => (nowMicros += 5),
    });
    const h = harness({ observability });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    await vi.waitFor(() => expect(socket.framesOfType("terminal-delivery-ready")).toHaveLength(2));

    // No raw pane subscription remains. Layout is session-scoped and both
    // terminal bodies are sourced by the shared SessionRuntime delivery hub.
    expect(h.mirror.subs).toHaveLength(0);
    expect(h.mirror.layoutHandlers).toHaveLength(1);
    expect(h.deliveryListeners.size).toBe(2);
    const transactionId = "00000000-0000-4000-8000-000000000095";
    await h.deliveryListeners.get("pane.shell")?.({
      type: "terminal.delivery",
      workspaceName: SESSION,
      semanticPaneId: "pane.shell",
      generation: INSTANCE,
      incarnation: `${INSTANCE}:0`,
      deliveryNonce: "00000000-0000-4000-8000-000000000098",
      transactionId,
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 0,
      canonicalStateHash: "1111111111111111",
      representationHash: "2222222222222222",
      representationBytes: 1,
      chunkCount: 1,
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
      performanceTraceId: "00000000-0000-4000-8000-000000000096",
    } as never);
    expect(socket.framesOfType("terminal-delivery-envelope")[0]).toMatchObject({
      envelope: { workspaceName: "workspace.alpha" },
    });
    expect(observability.snapshot().spans).toContainEqual(
      expect.objectContaining({
        traceId: "00000000-0000-4000-8000-000000000096",
        stage: "transport",
        operation: "pane-stream-socket-send",
      }),
    );
    socket.message({
      type: "terminal-delivery-ack",
      ack: {
        type: "terminal.delivery.ack",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.shell",
        generation: INSTANCE,
        incarnation: `${INSTANCE}:0`,
        deliveryNonce: "00000000-0000-4000-8000-000000000098",
        transactionId,
        canonicalRevision: 0,
        canonicalStateHash: "1111111111111111",
        representationHash: "2222222222222222",
      },
    });
    expect(h.deliveryAcks).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceName: SESSION, transactionId }),
    );

    // The server may publish a replacement incarnation before the client has
    // applied and ACKed the preceding seed. The address cache contains only
    // the latest incarnation; the delivery owner must remain the authority for
    // ordered transaction validation instead of tearing down the whole stream.
    await h.deliveryListeners.get("pane.shell")?.({
      type: "terminal.delivery",
      workspaceName: SESSION,
      semanticPaneId: "pane.shell",
      generation: INSTANCE,
      incarnation: `${INSTANCE}:1`,
      deliveryNonce: "00000000-0000-4000-8000-000000000098",
      transactionId: "00000000-0000-4000-8000-000000000094",
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 0,
      canonicalStateHash: "3333333333333333",
      representationHash: "4444444444444444",
      representationBytes: 1,
      chunkCount: 1,
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
    } as never);
    socket.message({
      type: "terminal-delivery-ack",
      ack: {
        type: "terminal.delivery.ack",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.shell",
        generation: INSTANCE,
        incarnation: `${INSTANCE}:0`,
        deliveryNonce: "00000000-0000-4000-8000-000000000098",
        transactionId,
        canonicalRevision: 0,
        canonicalStateHash: "1111111111111111",
        representationHash: "2222222222222222",
      },
    });
    expect(socket.closed).toBeNull();
    h.deliveryListeners.get("pane.editor")?.({
      type: "terminal.delivery.fault",
      reason: "source-closed",
      message: "closed",
      deliveryNonce: "00000000-0000-4000-8000-000000000098",
    } as never);
    expect(socket.framesOfType("terminal-delivery-fault")).toHaveLength(1);

    const operationId = "00000000-0000-4000-8000-000000000097";
    socket.message({
      type: "semantic-intent",
      operationId,
      intent: {
        verb: "workspace.pane.send",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
        text: "x",
        submit: false,
        origin: "tui",
      },
    });
    await vi.waitFor(() => expect(socket.framesOfType("semantic-intent-ack")).toHaveLength(1));
    expect(socket.framesOfType("semantic-intent-ack")[0]).toMatchObject({
      operationId,
      outcome: { status: "applied" },
    });
    expect(h.submitIntent).toHaveBeenCalledWith(
      operationId,
      expect.objectContaining({ verb: "workspace.pane.send", semanticPaneId: "pane.editor" }),
    );

    const rejectedOperationId = "00000000-0000-4000-8000-000000000096";
    h.submitIntent.mockRejectedValueOnce(
      Object.assign(new Error("another client owns the controller"), {
        code: "controller-conflict",
      }),
    );
    socket.message({
      type: "semantic-intent",
      operationId: rejectedOperationId,
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
      },
    });
    await vi.waitFor(() => expect(socket.framesOfType("semantic-intent-ack")).toHaveLength(2));
    expect(socket.framesOfType("semantic-intent-ack")[1]).toEqual({
      type: "semantic-intent-ack",
      operationId: rejectedOperationId,
      outcome: {
        status: "rejected",
        code: "controller-conflict",
        message: "another client owns the controller",
      },
    });
    expect(socket.closed).toBeNull();

    const inventoryRefusalOperationId = "00000000-0000-4000-8000-000000000095";
    h.submitIntent.mockRejectedValueOnce(
      new SessionRuntimeIntentError("rejected", "generic semantic refusal", {
        cause: new WorkspaceMultiplexerError("workspace_unavailable", {
          reason: "pane_inventory_not_ready",
          pane: "%99",
        }),
      }),
    );
    socket.message({
      type: "semantic-intent",
      operationId: inventoryRefusalOperationId,
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
      },
    });
    await vi.waitFor(() => expect(socket.framesOfType("semantic-intent-ack")).toHaveLength(3));
    expect(socket.framesOfType("semantic-intent-ack")[2]).toEqual({
      type: "semantic-intent-ack",
      operationId: inventoryRefusalOperationId,
      outcome: {
        status: "rejected",
        code: "pane_inventory_not_ready",
        message: "generic semantic refusal",
      },
    });
    expect(JSON.stringify(socket.framesOfType("semantic-intent-ack")[2])).not.toContain("%99");

    // Terminal input stays FIFO and byte-exact across named keys and bracketed
    // paste while both daemon transport edges retain the originating trace.
    const keyTrace = "00000000-0000-4000-8000-000000000091";
    const pasteTrace = "00000000-0000-4000-8000-000000000092";
    const bracketedPaste = "\u001b[200~alpha\nbeta\u001b[201~";
    socket.message({
      type: "input",
      kind: "key",
      pane: "pane.editor",
      seq: 1,
      data: "Enter",
      performanceTraceId: keyTrace,
    });
    socket.message({
      type: "input",
      kind: "text",
      pane: "pane.editor",
      seq: 2,
      data: bracketedPaste,
      performanceTraceId: pasteTrace,
    });
    expect(h.sendInput.mock.calls).toEqual([
      ["pane.editor", { kind: "key", data: "Enter" }, keyTrace, undefined, undefined],
      ["pane.editor", { kind: "text", data: bracketedPaste }, pasteTrace, undefined, undefined],
    ]);
    expect(socket.framesOfType("input-ack").map((frame) => frame.seq)).toEqual([1, 2]);
    for (const traceId of [keyTrace, pasteTrace]) {
      const transportSpans = observability
        .snapshot()
        .spans.filter(
          (span) =>
            span.traceId === traceId &&
            [
              "pane-stream-socket-message-callback-entry",
              "pane-stream-input-frame-ingress",
              "pane-stream-input-ack-socket-send",
            ].includes(span.operation),
        );
      expect(transportSpans.map(({ operation }) => operation)).toEqual([
        "pane-stream-socket-message-callback-entry",
        "pane-stream-input-frame-ingress",
        "pane-stream-input-ack-socket-send",
      ]);
      expect(transportSpans[0]!.startedAtMicros).toBeLessThanOrEqual(
        transportSpans[1]!.startedAtMicros,
      );
    }
    socket.message({ type: "viewport", seq: 1, cols: 132, rows: 44 });
    expect(h.fitViewport).toHaveBeenCalledWith(132, 44);
    expect(socket.framesOfType("viewport-ack")).toEqual([
      { type: "viewport-ack", seq: 1, cols: 132, rows: 44 },
    ]);
  });

  it("opens pane deliveries concurrently but publishes readiness in descriptor order", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const opened: string[] = [];
    const closed: string[] = [];
    const h = harness({
      openTerminalDelivery: async (pane) => {
        opened.push(pane);
        if (pane === "pane.editor") await slow;
        return {
          negotiation: {
            accepted: true,
            negotiated: {
              protocolVersion: 1,
              encoding: "semantic-v1",
              richPlacements: false,
              generation: INSTANCE,
              deliveryNonce: "00000000-0000-4000-8000-000000000098",
            },
          },
          ack: () => undefined,
          nack: () => undefined,
          setVisibility: () => undefined,
          close: async () => {
            closed.push(pane);
          },
        };
      },
    });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    await vi.waitFor(() => expect(opened).toEqual(["pane.editor", "pane.shell"]));
    // shell opened without waiting for editor, but the document cannot claim
    // coherent readiness until every requested pane has an accepted delivery.
    expect(socket.framesOfType("terminal-delivery-ready")).toHaveLength(0);
    releaseSlow();
    await vi.waitFor(() =>
      expect(socket.framesOfType("terminal-delivery-ready").map(({ pane }) => pane)).toEqual([
        "pane.editor",
        "pane.shell",
      ]),
    );
    socket.close();
    await vi.waitFor(() => expect(closed.sort()).toEqual(["pane.editor", "pane.shell"]));
  });

  it("closes every partial delivery when one concurrent pane open fails", async () => {
    const closeEditor = vi.fn(async () => undefined);
    let rejectShell!: (error: Error) => void;
    const shell = new Promise<never>((_resolve, reject) => {
      rejectShell = reject;
    });
    const h = harness({
      openTerminalDelivery: async (pane) => {
        if (pane === "pane.shell") return await shell;
        return {
          negotiation: {
            accepted: true,
            negotiated: {
              protocolVersion: 1,
              encoding: "semantic-v1",
              richPlacements: false,
              generation: INSTANCE,
              deliveryNonce: "00000000-0000-4000-8000-000000000098",
            },
          },
          ack: () => undefined,
          nack: () => undefined,
          setVisibility: () => undefined,
          close: closeEditor,
        };
      },
    });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    rejectShell(new Error("shell unavailable"));
    await vi.waitFor(() => expect(closeEditor).toHaveBeenCalledOnce());
    expect(socket.framesOfType("terminal-delivery-ready")).toHaveLength(0);
    expect(socket.closed).toEqual({ code: 1011, reason: "stream-unavailable" });
  });

  it("does not park a sibling source-close behind aggregate semantic output pressure", async () => {
    const h = harness({ maxSocketBufferedBytes: 2_000 });
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    await vi.waitFor(() => expect(socket.framesOfType("terminal-delivery-ready")).toHaveLength(2));

    // Raise aggregate buffered bytes without exhausting shell's pane-local
    // ledger. The sibling close callback must settle immediately.
    socket.send(JSON.stringify({ padding: "x".repeat(600) }));
    const close = h.deliveryListeners.get("pane.shell")!({
      type: "terminal.delivery.fault",
      reason: "source-closed",
      message: "closed",
      deliveryNonce: "00000000-0000-4000-8000-000000000098",
    } as never) as unknown;
    await expect(Promise.resolve(close)).resolves.toBeUndefined();
    expect(socket.framesOfType("terminal-delivery-fault")).toHaveLength(1);
  });

  it("generation-fences explicit authority and requires geometry before viewport fit", async () => {
    const h = harness();
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    socket.message({ type: "presence", generation: INSTANCE, state: "foreground" });
    expect(socket.framesOfType("authority-snapshot")).toHaveLength(1);
    const requestId = "00000000-0000-4000-8000-000000000094";
    socket.message({
      type: "authority-request",
      generation: INSTANCE,
      requestId,
      authority: "geometry",
    });
    expect(socket.framesOfType("authority-receipt")).toEqual([
      expect.objectContaining({ requestId, authority: "geometry", status: "granted" }),
    ]);
    socket.message({ type: "viewport", seq: 1, cols: 111, rows: 33 });
    expect(h.fitViewport).toHaveBeenCalledWith(111, 33);

    const stale = harness();
    const staleConnection = await connect(stale, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    staleConnection.socket.message({
      type: "authority-request",
      generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestId: "00000000-0000-4000-8000-000000000093",
      authority: "geometry",
    });
    expect(staleConnection.socket.framesOfType("error")[0]?.code).toBe("protocol-error");
  });

  it("permanently disables legacy escalation after the first explicit authority frame", async () => {
    const h = harness();
    const { socket } = await connect(h, {
      viewerMode: "interactive",
      semanticDelivery: true,
    });
    socket.message({ type: "presence", generation: INSTANCE, state: "foreground" });
    socket.message({ type: "input", kind: "text", pane: "pane.editor", seq: 1, data: "x" });
    expect(socket.framesOfType("error")[0]?.code).toBe("input-rejected");
    expect(h.activateLegacyAuthority).not.toHaveBeenCalled();
    expect(h.sendInput).not.toHaveBeenCalled();
  });

  it("meters renderer backlog for acking clients and thaws on consumed frames", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 1 << 20, resumeAt: 256 << 10 },
        "renderer-backlog": { maxOutstanding: 2, resumeAt: 1 },
      },
    });
    const { socket } = await connect(h, { deliveryAcks: true, panes: ["pane.editor"] });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(1));
    const editor = h.mirror.subFor("pane.editor");
    editor.onEvent({ type: "delta", data: Buffer.from("1") });
    editor.onEvent({ type: "delta", data: Buffer.from("2") });
    socket.drainAll();
    h.scheduler.runDue();
    expect(editor.freezes).toBe(0);
    editor.onEvent({ type: "delta", data: Buffer.from("3") });
    socket.drainAll();
    h.scheduler.runDue();
    expect(editor.freezes).toBe(1);

    socket.message({ type: "consumed", pane: "pane.editor", seq: 3 });
    expect(editor.thaws).toBe(1);

    // A non-acking client sending consumed frames is a protocol error.
    const plain = await connect(h, { panes: ["pane.shell"] });
    plain.socket.message({ type: "consumed", pane: "pane.shell", seq: 1 });
    expect(plain.socket.framesOfType("error")[0]!.code).toBe("protocol-error");
  });

  it("sends closed for a pane that vanished between issue and redeem, and closes when all panes are gone", async () => {
    const h = harness({ panes: ["pane.editor", "pane.shell"] });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor", "pane.shell"],
        viewerMode: "read-only",
      },
      {
        requestId,
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    // Both panes vanish before redemption (a successful describe omitting
    // them IS absence — unlike a describe failure).
    h.mirror.panes = [];
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await vi.waitFor(() => {
      expect(socket.framesOfType("closed")).toHaveLength(2);
    });
    expect(socket.closed?.reason).toBe("panes-closed");
  });

  it("gates the upgrade on path, subprotocol, and a pending origin", async () => {
    const h = harness();
    await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId: freshRequestId(),
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    expect(
      h.coordinator.reserveUpgrade({
        path: "/v1/terminal/attachments/redeem",
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
      }),
    ).toMatchObject({ accepted: false, code: "invalid-path" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: ["tmux-ide-terminal.v1"],
        origin: ORIGIN,
      }),
    ).toMatchObject({ accepted: false, code: "invalid-subprotocol" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: "http://evil.example",
      }),
    ).toMatchObject({ accepted: false, code: "origin-rejected" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
      }).accepted,
    ).toBe(true);
  });

  it("binds upgrade admission to the issuing browser-document host", async () => {
    const h = harness();
    await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId: freshRequestId(),
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
        hostClientId: "web:document-a",
      },
    );
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
        hostClientId: "web:document-b",
      }),
    ).toMatchObject({ accepted: false, code: "origin-rejected" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
        hostClientId: "web:document-a",
      }).accepted,
    ).toBe(true);
    await h.coordinator.shutdown();
  });

  it("shuts down cleanly, retiring pendings and closing live connections", async () => {
    const h = harness();
    const { socket } = await connect(h);
    await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId: freshRequestId(),
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    await h.coordinator.shutdown();
    expect(socket.closed).not.toBeNull();
    expect(h.coordinator.snapshot()).toMatchObject({
      pendingTickets: 0,
      liveConnections: 0,
      shuttingDown: true,
    });
    expect(h.leaseManager.snapshot().leases).toHaveLength(0);
  });
});
