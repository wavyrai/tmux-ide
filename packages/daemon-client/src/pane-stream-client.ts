import {
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_PROTOCOL_VERSION,
  PaneStreamClientFrameSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  PaneStreamRedeemFrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
  SessionRuntimeTerminalInputSchemaZ,
  sharedMonotonicMicros,
  type PaneStreamIssueDescriptor,
  type PaneStreamLeaseRequest,
  type PaneStreamServerFrame,
  type SessionRuntimeActivityKind,
  type SessionRuntimeAuthorityKind,
  type SessionRuntimeAuthorityLease,
  type SessionRuntimeAuthoritySnapshot,
  type SessionRuntimePresenceState,
  type SessionRuntimeSemanticIntent,
  type SessionRuntimeTerminalInput,
  type PaneStreamDiagnosticCapability,
  type CausalCellProbeV1,
  type CausalCellProbeRequestV1,
  type CausalCellProofV1,
  type CausalCellFailureV1,
  type SessionRuntimeTerminalInputResult,
  type TerminalReplicaAddress,
  type TerminalDeliveryAck,
  type TerminalDeliveryNack,
  type TerminalDeliveryNegotiationResult,
  type TerminalDeliveryOffer,
  type TerminalDeliveryServerMessage,
  type TerminalDeliveryVisibility,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import {
  calibratePaneStreamClocks,
  type PaneStreamClockCalibration,
  type PaneStreamClockCalibrationOutcome,
  type PaneStreamClockCalibrationReason,
  type PaneStreamClockProbeSample,
} from "./pane-stream-clock-calibration.ts";
import { acquireRuntimeResource } from "./runtime-resource-ledger.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketListener = (event: { readonly data?: unknown }) => void;
const MAX_PENDING_TERMINAL_INPUTS = 256;

function performanceNowMicros(): number {
  return Math.floor(performance.now() * 1_000);
}

function scheduleNextEventLoopTurn(callback: () => void): () => void {
  const releaseResource = acquireRuntimeResource("runtime-timer");
  let active = true;
  const handle = setImmediate(() => {
    if (!active) return;
    active = false;
    releaseResource();
    callback();
  });
  handle.unref?.();
  return () => {
    if (!active) return;
    active = false;
    clearImmediate(handle);
    releaseResource();
  };
}

interface RuntimeTimer {
  readonly handle: NodeJS.Timeout;
  release(): void;
}

function createRuntimeTimer(callback: () => void, delayMs: number): RuntimeTimer {
  const releaseResource = acquireRuntimeResource("runtime-timer");
  let active = true;
  const release = (): void => {
    if (!active) return;
    active = false;
    clearTimeout(handle);
    releaseResource();
  };
  const handle = setTimeout(() => {
    if (!active) return;
    active = false;
    releaseResource();
    callback();
  }, delayMs);
  handle.unref?.();
  return { handle, release };
}

export interface PaneStreamClientSocket {
  readonly readyState: number;
  /** Optional native/socket queue watermark in bytes. */
  readonly bufferedAmount?: number;
  addEventListener(type: SocketEventType, listener: SocketListener): void;
  removeEventListener?(type: SocketEventType, listener: SocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function readSocketBufferedAmount(socket: PaneStreamClientSocket): number | null {
  try {
    const value = socket.bufferedAmount;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export interface PaneStreamInputTransportStageEvent {
  readonly traceId: string;
  readonly operation:
    | "pane-stream-frame-enqueued"
    | "pane-stream-socket-send-return"
    | "pane-stream-next-event-loop-turn"
    | "pane-stream-buffer-before-send"
    | "pane-stream-buffer-after-send"
    | "pane-stream-buffer-next-turn"
    | "pane-stream-buffer-drain-watermark"
    | "pane-stream-observer-returned";
  readonly atMicros: number;
  readonly sharedMicros?: number;
  readonly pane: string;
  readonly sequence: number;
  readonly bufferedAmount?: number;
  readonly frameBytes?: number;
  readonly drained?: boolean;
}

export function classifyPaneStreamInputTransportDelay(
  stages: readonly PaneStreamInputTransportStageEvent[],
  stallThresholdMicros: number,
):
  | "incomplete"
  | "socket-send-return-stall"
  | "client-event-loop-stall"
  | "observer-callback-stall"
  | "no-client-transport-stall" {
  if (!Number.isFinite(stallThresholdMicros) || stallThresholdMicros <= 0)
    throw new TypeError("Input transport stall threshold must be positive");
  const causalStages = stages.filter(
    ({ operation }) =>
      operation === "pane-stream-frame-enqueued" ||
      operation === "pane-stream-socket-send-return" ||
      operation === "pane-stream-next-event-loop-turn" ||
      operation === "pane-stream-observer-returned",
  );
  if (
    (causalStages.length !== 3 && causalStages.length !== 4) ||
    causalStages[0]?.operation !== "pane-stream-frame-enqueued" ||
    causalStages[1]?.operation !== "pane-stream-socket-send-return" ||
    causalStages[2]?.operation !== "pane-stream-next-event-loop-turn"
  )
    return "incomplete";
  const [enqueued, sent, nextTurn] = causalStages;
  const observerReturned = causalStages[3];
  if (
    !enqueued ||
    !sent ||
    !nextTurn ||
    enqueued.traceId !== sent.traceId ||
    sent.traceId !== nextTurn.traceId ||
    enqueued.pane !== sent.pane ||
    sent.pane !== nextTurn.pane ||
    enqueued.sequence !== sent.sequence ||
    sent.sequence !== nextTurn.sequence ||
    (observerReturned !== undefined &&
      (observerReturned.operation !== "pane-stream-observer-returned" ||
        observerReturned.traceId !== nextTurn.traceId ||
        observerReturned.pane !== nextTurn.pane ||
        observerReturned.sequence !== nextTurn.sequence ||
        observerReturned.atMicros < nextTurn.atMicros)) ||
    sent.atMicros < enqueued.atMicros ||
    nextTurn.atMicros < sent.atMicros
  )
    return "incomplete";
  if (sent.atMicros - enqueued.atMicros >= stallThresholdMicros) return "socket-send-return-stall";
  if (nextTurn.atMicros - sent.atMicros >= stallThresholdMicros) return "client-event-loop-stall";
  if (observerReturned && observerReturned.atMicros - nextTurn.atMicros >= stallThresholdMicros)
    return "observer-callback-stall";
  return "no-client-transport-stall";
}

export type PaneStreamClientSocketFactory = (
  descriptor: PaneStreamIssueDescriptor,
  headers: Readonly<Record<string, string>>,
) => PaneStreamClientSocket;

export interface OpenPaneStreamClientOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly daemonInstanceId: string;
  readonly origin: string;
  readonly hostClientId: string;
  readonly requestId: string;
  readonly stream: PaneStreamLeaseRequest & { readonly terminalDelivery: TerminalDeliveryOffer };
  readonly createSocket: PaneStreamClientSocketFactory;
  /**
   * Acquire input authority before reporting the stream ready. Defaults to
   * true for direct/legacy consumers. Read-only shells may opt out and acquire
   * authority lazily on their first mutation.
   */
  readonly requestInitialInputAuthority?: boolean;
  readonly diagnosticCapabilities?: readonly PaneStreamDiagnosticCapability[];
  /** Cancels capability issuance before a physical socket exists. */
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly onNegotiated: (pane: string, negotiation: TerminalDeliveryNegotiationResult) => void;
  readonly onTerminalDelivery: (pane: string, message: TerminalDeliveryServerMessage) => void;
  /** Diagnostic-only arrival edge, sampled before JSON decode/validation work. */
  readonly onTerminalFrameArrival?: (event: {
    readonly pane: string;
    readonly traceId: string;
    readonly atMicros: number;
    readonly sharedMicros?: number;
  }) => void;
  /** Diagnostic-only outbound edges for one trace-correlated input frame. */
  readonly onInputTransportStage?: (event: PaneStreamInputTransportStageEvent) => void;
  /** Test seams are consulted only when `onInputTransportStage` is installed. */
  readonly diagnosticNowMicros?: () => number;
  /** Read only while clock-bounds-v1 is negotiated. */
  readonly diagnosticSharedNowMicros?: () => number;
  readonly diagnosticClockProbeCount?: number;
  readonly onClockCalibration?: (calibration: PaneStreamClockCalibration | null) => void;
  readonly onClockCalibrationOutcome?: (outcome: PaneStreamClockCalibrationOutcome) => void;
  readonly diagnosticNextTurn?: (callback: () => void) => () => void;
  readonly onLayout?: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
  readonly onInputAck?: (event: {
    readonly pane: string;
    readonly sequence: number;
    readonly traceId?: string;
    readonly sharedMicros?: number;
  }) => void;
  readonly onCausalCellProof?: (proof: CausalCellProofV1) => void;
  readonly onCausalCellFailure?: (failure: CausalCellFailureV1) => void;
  readonly onAuthoritySnapshot?: (snapshot: SessionRuntimeAuthoritySnapshot) => void;
  readonly onFault?: (error: Error) => void;
  readonly onConnectionDiagnostic?: (
    phase:
      | "issue-start"
      | "issue-response"
      | "socket-created"
      | "socket-open"
      | "ready-frame"
      | "clock-calibration",
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export type ConnectIssuedPaneStreamRuntimeClientOptions = Pick<
  OpenPaneStreamClientOptions,
  | "signal"
  | "createSocket"
  | "requestInitialInputAuthority"
  | "origin"
  | "hostClientId"
  | "onNegotiated"
  | "onTerminalDelivery"
  | "onTerminalFrameArrival"
  | "onInputTransportStage"
  | "diagnosticNowMicros"
  | "diagnosticSharedNowMicros"
  | "diagnosticClockProbeCount"
  | "onClockCalibration"
  | "onClockCalibrationOutcome"
  | "diagnosticNextTurn"
  | "onLayout"
  | "onInputAck"
  | "onCausalCellProof"
  | "onCausalCellFailure"
  | "diagnosticCapabilities"
  | "onAuthoritySnapshot"
  | "onFault"
  | "onConnectionDiagnostic"
  | "stream"
>;

export interface PaneStreamRuntimeClient {
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly effectiveViewerMode: PaneStreamIssueDescriptor["effectiveViewerMode"];
  readonly authoritySnapshot: SessionRuntimeAuthoritySnapshot | null;
  setPresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  requestAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot>;
  sendTerminalInput(
    target: TerminalReplicaAddress,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeRequestV1,
  ): Promise<SessionRuntimeTerminalInputResult>;
  sendText(pane: string, text: string, performanceTraceId?: string): void;
  sendKey(pane: string, key: string, performanceTraceId?: string): void;
  fitViewport(cols: number, rows: number): Promise<void>;
  ack(ack: TerminalDeliveryAck): void;
  nack(nack: TerminalDeliveryNack): void;
  setVisibility(
    address: {
      workspaceName: string;
      pane: string;
      generation: string;
      incarnation: string;
      deliveryNonce: string;
    },
    visibility: TerminalDeliveryVisibility,
  ): void;
  submitIntent(
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<WorkspaceMultiplexerMutationResult | null>;
  close(): void;
}

export class PaneStreamOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaneStreamOperationError";
  }
}

export async function openPaneStreamRuntimeClient(
  options: OpenPaneStreamClientOptions,
): Promise<PaneStreamRuntimeClient> {
  options.onConnectionDiagnostic?.("issue-start", { requestId: options.requestId });
  const request = options.fetch ?? fetch;
  const mutation = PaneStreamIssueMutationRequestSchemaZ.parse({
    requestId: options.requestId,
    expectedDaemonInstanceId: options.daemonInstanceId,
    stream: options.stream,
  });
  const response = await request(new URL(PANE_STREAM_ISSUE_PATH, options.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.ownerToken}`,
      "Content-Type": "application/json",
      Origin: options.origin,
      "X-Tmux-Ide-Request-Id": options.requestId,
      "X-Tmux-Ide-Expected-Daemon-Instance-Id": options.daemonInstanceId,
      "X-Tmux-Ide-Host-Client-Id": options.hostClientId,
    },
    body: JSON.stringify(mutation),
    redirect: "error",
    cache: "no-store",
    signal: options.signal,
  });
  const issued = PaneStreamIssueResultSchemaZ.parse(await response.json());
  options.onConnectionDiagnostic?.("issue-response", {
    requestId: options.requestId,
    status: issued.status,
  });
  if (issued.status === "error") throw new Error(issued.error.reason);
  if (
    issued.descriptor.daemonInstanceId !== options.daemonInstanceId ||
    issued.descriptor.requestId !== options.requestId
  ) {
    throw new Error("Pane-stream issue returned another daemon generation");
  }
  return await connectIssuedPaneStreamRuntimeClient(options, issued.descriptor);
}

export async function connectIssuedPaneStreamRuntimeClient(
  options: ConnectIssuedPaneStreamRuntimeClientOptions,
  descriptor: PaneStreamIssueDescriptor,
): Promise<PaneStreamRuntimeClient> {
  const socket = options.createSocket(descriptor, {
    Origin: options.origin,
    "X-Tmux-Ide-Host-Client-Id": options.hostClientId,
    "X-Tmux-Ide-Request-Id": descriptor.requestId,
  });
  options.onConnectionDiagnostic?.("socket-created", { requestId: descriptor.requestId });
  const releaseSocketResource = acquireRuntimeResource("pane-stream-socket");
  const releaseSocketListenerResources = acquireRuntimeResource("socket-listener", 4);
  let pendingDiagnosticTurns: Set<() => void> | null = null;
  const cancelDiagnosticTurns = (): void => {
    if (!pendingDiagnosticTurns) return;
    for (const cancel of pendingDiagnosticTurns) {
      try {
        cancel();
      } catch {
        // Diagnostics cannot alter connection teardown.
      }
    }
    pendingDiagnosticTurns.clear();
    pendingDiagnosticTurns = null;
  };
  let closed = false;
  let verified = false;
  let resolveReady!: (client: PaneStreamRuntimeClient) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<PaneStreamRuntimeClient>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = createRuntimeTimer(
    () => fail("Pane-stream runtime handshake timed out"),
    2_000,
  );
  const clearReadyTimer = (): void => readyTimer.release();

  let listenersAttached = false;
  let abortListenerAttached = false;
  let socketCloseRequested = false;
  const detachAbortListener = (): void => {
    if (!abortListenerAttached) return;
    abortListenerAttached = false;
    options.signal?.removeEventListener("abort", onAbort);
  };
  const detachSocketListeners = (): void => {
    if (!listenersAttached) return;
    listenersAttached = false;
    socket.removeEventListener?.("open", onOpen);
    socket.removeEventListener?.("message", onMessage);
    socket.removeEventListener?.("close", onClose);
    socket.removeEventListener?.("error", onClose);
    releaseSocketListenerResources();
  };
  const closeSocketOnce = (code: number, reason: string): void => {
    if (socketCloseRequested) return;
    socketCloseRequested = true;
    releaseSocketResource();
    socket.close(code, reason);
  };

  const fail = (failure: string | Error): void => {
    if (closed) return;
    closed = true;
    const error = failure instanceof Error ? failure : new Error(failure);
    clearReadyTimer();
    cancelDiagnosticTurns();
    detachAbortListener();
    detachSocketListeners();
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
    closeSocketOnce(1008, "protocol-error");
  };
  const send = (
    frame: unknown,
    measureBuffer = false,
  ): {
    readonly before: number | null;
    readonly after: number | null;
    readonly frameBytes: number;
  } | null => {
    if (closed || socket.readyState !== 1) throw new Error("Pane-stream runtime client is closed");
    const serialized = JSON.stringify(PaneStreamClientFrameSchemaZ.parse(frame));
    const before = measureBuffer ? readSocketBufferedAmount(socket) : null;
    socket.send(serialized);
    if (!measureBuffer) return null;
    return {
      before,
      after: readSocketBufferedAmount(socket),
      frameBytes: utf8ByteLength(serialized),
    };
  };
  const clockCalibrationEnabled =
    options.diagnosticCapabilities?.includes("clock-bounds-v1") === true &&
    options.onClockCalibration !== undefined;
  const diagnosticSharedRawMicros = clockCalibrationEnabled
    ? (options.diagnosticSharedNowMicros ?? sharedMonotonicMicros)
    : undefined;
  let diagnosticSharedOriginMicros: number | undefined;
  const diagnosticSharedNowMicros = diagnosticSharedRawMicros
    ? () => {
        const raw = diagnosticSharedRawMicros();
        diagnosticSharedOriginMicros ??= raw;
        const elapsed = raw - diagnosticSharedOriginMicros;
        if (!Number.isSafeInteger(elapsed) || elapsed < 0)
          throw new Error("Client shared monotonic clock regressed");
        return elapsed;
      }
    : undefined;
  const clockProbeCount = clockCalibrationEnabled ? (options.diagnosticClockProbeCount ?? 5) : 0;
  if (
    clockCalibrationEnabled &&
    (!Number.isInteger(clockProbeCount) || clockProbeCount < 1 || clockProbeCount > 5)
  )
    throw new TypeError("Pane-stream clock probe count must be in [1, 5]");
  const clockSamples: PaneStreamClockProbeSample[] = [];
  let pendingClockProbe:
    | {
        readonly probe: number;
        readonly clientSendMicros: number;
        readonly timer: RuntimeTimer;
      }
    | undefined;
  let finishClockCalibration: (() => void) | undefined;
  let clockCalibrationSettled = false;
  let attemptedClockProbes = 0;
  let receivedClockProbes = 0;
  let validClockProbes = 0;
  const publishClockCalibration = (calibration: PaneStreamClockCalibration | null): void => {
    try {
      options.onClockCalibration?.(calibration);
    } catch {
      // Diagnostics cannot alter authenticated stream readiness.
    }
  };
  const completeClockCalibration = (
    calibration: PaneStreamClockCalibration | null,
    reason: PaneStreamClockCalibrationReason,
    settleReadiness = true,
  ): void => {
    if (clockCalibrationSettled) return;
    clockCalibrationSettled = true;
    pendingClockProbe?.timer.release();
    pendingClockProbe = undefined;
    const outcome: PaneStreamClockCalibrationOutcome = Object.freeze({
      version: 1,
      requestId: descriptor.requestId,
      daemonInstanceId: descriptor.daemonInstanceId,
      reason,
      attemptedProbes: attemptedClockProbes,
      receivedProbes: receivedClockProbes,
      validProbes: validClockProbes,
      selectedProbes: calibration ? 1 : 0,
      selectedProbe: calibration?.probe ?? null,
    });
    publishClockCalibration(calibration);
    try {
      options.onClockCalibrationOutcome?.(outcome);
    } catch {
      // Diagnostics cannot alter authenticated stream readiness.
    }
    try {
      options.onConnectionDiagnostic?.("clock-calibration", {
        version: outcome.version,
        requestId: outcome.requestId,
        daemonInstanceId: outcome.daemonInstanceId,
        reason: outcome.reason,
        attemptedProbes: outcome.attemptedProbes,
        receivedProbes: outcome.receivedProbes,
        validProbes: outcome.validProbes,
        selectedProbes: outcome.selectedProbes,
        selectedProbe: outcome.selectedProbe,
      });
    } catch {
      // Diagnostics cannot alter authenticated stream readiness.
    }
    const finish = finishClockCalibration;
    finishClockCalibration = undefined;
    if (settleReadiness) finish?.();
  };
  const sendClockProbe = (probe: number): void => {
    attemptedClockProbes += 1;
    if (!diagnosticSharedNowMicros) return completeClockCalibration(null, "clock-unavailable");
    let clientSendMicros: number;
    try {
      clientSendMicros = diagnosticSharedNowMicros();
    } catch {
      completeClockCalibration(null, "clock-unavailable");
      return;
    }
    const timer = createRuntimeTimer(() => {
      const retained = calibratePaneStreamClocks(
        descriptor.requestId,
        descriptor.daemonInstanceId,
        clockSamples,
      );
      completeClockCalibration(
        retained,
        retained ? "timeout-retained-sample" : "timeout-no-sample",
      );
    }, 1_000);
    pendingClockProbe = { probe, clientSendMicros, timer };
    try {
      send({
        type: "clock-probe",
        requestId: descriptor.requestId,
        probe,
        clientSendMicros,
      });
    } catch {
      completeClockCalibration(null, "send-failed");
    }
  };
  const calibrateBeforeReady = (done: () => void): void => {
    if (!clockCalibrationEnabled) return done();
    finishClockCalibration = done;
    sendClockProbe(1);
  };
  const inputSequences = new Map<string, number>();
  const negotiatedDeliveries = new Map<
    string,
    { readonly generation: string; readonly deliveryNonce: string }
  >();
  const pendingInputs = new Map<
    string,
    {
      readonly pane: string;
      readonly sequence: number;
      readonly traceId?: string;
      resolve(result: SessionRuntimeTerminalInputResult): void;
      reject(error: Error): void;
      timer: RuntimeTimer;
    }
  >();
  let authoritySnapshot: SessionRuntimeAuthoritySnapshot | null = null;
  const pendingAuthorities = new Map<
    string,
    {
      authority: SessionRuntimeAuthorityKind;
      resolve(
        lease: SessionRuntimeAuthorityLease | null,
        snapshot: SessionRuntimeAuthoritySnapshot,
      ): void;
      reject(error: Error): void;
      timer: RuntimeTimer;
    }
  >();
  let viewportSequence = 0;
  const pendingViewports = new Map<
    number,
    {
      cols: number;
      rows: number;
      resolve(): void;
      reject(error: Error): void;
      timer: RuntimeTimer;
    }
  >();
  const pendingIntents = new Map<
    string,
    {
      resolve(result: WorkspaceMultiplexerMutationResult | null): void;
      reject(error: Error): void;
      timer: RuntimeTimer;
    }
  >();
  const rejectPending = (error: Error): void => {
    if (!clockCalibrationSettled && (pendingClockProbe || finishClockCalibration))
      completeClockCalibration(null, "connection-closed", false);
    for (const pending of pendingInputs.values()) {
      pending.timer.release();
      pending.reject(error);
    }
    pendingInputs.clear();
    for (const pending of pendingViewports.values()) {
      pending.timer.release();
      pending.reject(error);
    }
    pendingViewports.clear();
    for (const pending of pendingIntents.values()) {
      pending.timer.release();
      pending.reject(error);
    }
    pendingIntents.clear();
    for (const pending of pendingAuthorities.values()) {
      pending.timer.release();
      pending.reject(error);
    }
    pendingAuthorities.clear();
  };
  const retirePendingInputsForAuthorityLoss = (): void => {
    for (const pending of pendingInputs.values()) {
      pending.timer.release();
      pending.resolve("authority-lost");
    }
    pendingInputs.clear();
  };
  const applyAuthoritySnapshot = (snapshot: SessionRuntimeAuthoritySnapshot): void => {
    if (snapshot.generation !== descriptor.daemonInstanceId) {
      fail("Pane-stream authority snapshot belonged to another daemon generation");
      return;
    }
    const ownedInput = authoritySnapshot?.owners.input === options.hostClientId;
    authoritySnapshot = snapshot;
    if (ownedInput && snapshot.owners.input !== options.hostClientId) {
      retirePendingInputsForAuthorityLoss();
    }
    options.onAuthoritySnapshot?.(snapshot);
  };
  const requestAuthority = (
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = createRuntimeTimer(() => {
        pendingAuthorities.delete(requestId);
        reject(
          new PaneStreamOperationError("operation-timeout", `${authority} authority timed out`),
        );
      }, 2_000);
      pendingAuthorities.set(requestId, {
        authority,
        resolve: (lease) => resolve(lease),
        reject,
        timer,
      });
      try {
        send({
          type: "authority-request",
          generation: descriptor.daemonInstanceId,
          requestId,
          authority,
        });
      } catch (error) {
        timer.release();
        pendingAuthorities.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const releaseAuthority = (
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = createRuntimeTimer(() => {
        pendingAuthorities.delete(requestId);
        reject(new PaneStreamOperationError("operation-timeout", `${authority} release timed out`));
      }, 2_000);
      pendingAuthorities.set(requestId, {
        authority,
        resolve: (_lease, snapshot) => resolve(snapshot),
        reject,
        timer,
      });
      try {
        send({
          type: "authority-release",
          generation: descriptor.daemonInstanceId,
          requestId,
          authority,
        });
      } catch (error) {
        timer.release();
        pendingAuthorities.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const sendTerminalInput = (
    target: TerminalReplicaAddress,
    rawInput: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbeRequest?: CausalCellProbeRequestV1,
  ): Promise<SessionRuntimeTerminalInputResult> => {
    const input = SessionRuntimeTerminalInputSchemaZ.parse(rawInput);
    const pane = target.semanticPaneId;
    if (!descriptor.panes.includes(pane)) {
      return Promise.reject(
        new PaneStreamOperationError("invalid-pane", "Terminal input target is outside the lease"),
      );
    }
    if (target.workspaceName !== options.stream.workspaceName) {
      return Promise.reject(
        new PaneStreamOperationError(
          "invalid-workspace",
          "Terminal input target belongs to another workspace",
        ),
      );
    }
    if (
      descriptor.effectiveViewerMode !== "interactive" ||
      authoritySnapshot?.owners.input !== options.hostClientId
    ) {
      return Promise.resolve("authority-lost");
    }
    if (pendingInputs.size >= MAX_PENDING_TERMINAL_INPUTS) {
      return Promise.reject(
        new PaneStreamOperationError(
          "input-queue-full",
          "Terminal input acknowledgement queue is full",
        ),
      );
    }
    const sequence = (inputSequences.get(pane) ?? 0) + 1;
    let causalProbe: CausalCellProbeV1 | undefined;
    if (causalProbeRequest) {
      if (causalProbeRequest.semanticPaneId !== pane) {
        return Promise.reject(
          new PaneStreamOperationError("invalid-pane", "Causal-cell probe target did not match"),
        );
      }
      if (!options.diagnosticCapabilities?.includes("causal-cell-v1")) {
        return Promise.reject(
          new PaneStreamOperationError(
            "capability-unavailable",
            "Causal-cell input requires a negotiated diagnostic capability",
          ),
        );
      }
      const delivery = negotiatedDeliveries.get(pane);
      if (!delivery || delivery.generation !== causalProbeRequest.generation) {
        return Promise.reject(
          new PaneStreamOperationError(
            "delivery-unavailable",
            "Causal-cell input requires the current negotiated terminal delivery",
          ),
        );
      }
      causalProbe = {
        ...causalProbeRequest,
        clientId: options.hostClientId,
        transportNonce: descriptor.requestId,
        deliveryNonce: delivery.deliveryNonce,
        inputSequence: sequence,
      };
    }
    const pendingKey = `${pane}\0${sequence}`;
    return new Promise((resolve, reject) => {
      const timer = createRuntimeTimer(() => {
        pendingInputs.delete(pendingKey);
        reject(new PaneStreamOperationError("operation-timeout", "Terminal input ack timed out"));
      }, 2_000);
      pendingInputs.set(pendingKey, {
        pane,
        sequence,
        ...(performanceTraceId ? { traceId: performanceTraceId } : {}),
        resolve,
        reject,
        timer,
      });
      try {
        const transportStage = performanceTraceId ? options.onInputTransportStage : undefined;
        const diagnosticNowMicros = transportStage
          ? (options.diagnosticNowMicros ?? performanceNowMicros)
          : undefined;
        let enqueuedAtMicros: number | null = null;
        if (diagnosticNowMicros) {
          try {
            enqueuedAtMicros = diagnosticNowMicros();
          } catch {
            // Diagnostics cannot alter input transport truth.
          }
        }
        const bufferMeasurement = send(
          {
            type: "input",
            ...input,
            pane,
            seq: sequence,
            ...(performanceTraceId ? { performanceTraceId } : {}),
            ...(causalProbe ? { causalProbe } : {}),
          },
          Boolean(transportStage),
        );
        // Socket admission is authoritative. Commit FIFO identity before any
        // diagnostic callback can re-enter `sendTerminalInput`.
        inputSequences.set(pane, sequence);
        let sentAtMicros: number | null = null;
        let sentAtSharedMicros: number | undefined;
        if (diagnosticNowMicros) {
          try {
            sentAtMicros = diagnosticNowMicros();
          } catch {
            // Diagnostics cannot alter input transport truth.
          }
        }
        if (diagnosticSharedNowMicros) {
          try {
            sentAtSharedMicros = diagnosticSharedNowMicros();
          } catch {
            // Shared-clock diagnostics cannot alter input transport truth.
          }
        }
        if (
          transportStage &&
          bufferMeasurement &&
          diagnosticNowMicros &&
          enqueuedAtMicros !== null &&
          sentAtMicros !== null
        ) {
          const nextTurn = options.diagnosticNextTurn ?? scheduleNextEventLoopTurn;
          let completed = false;
          let cancel: () => void = () => undefined;
          try {
            cancel = nextTurn(() => {
              let atMicros: number | null = null;
              try {
                atMicros = diagnosticNowMicros();
              } catch {
                // Diagnostics cannot alter input transport truth.
              }
              completed = true;
              const turns = pendingDiagnosticTurns;
              turns?.delete(cancel);
              if (turns?.size === 0 && pendingDiagnosticTurns === turns)
                pendingDiagnosticTurns = null;
              if (closed || atMicros === null) return;
              for (const [operation, observedAtMicros] of [
                ["pane-stream-frame-enqueued", enqueuedAtMicros],
                ["pane-stream-socket-send-return", sentAtMicros],
                ["pane-stream-next-event-loop-turn", atMicros],
              ] as const) {
                try {
                  transportStage({
                    traceId: performanceTraceId!,
                    operation,
                    atMicros: observedAtMicros,
                    ...(operation === "pane-stream-socket-send-return" &&
                    sentAtSharedMicros !== undefined
                      ? { sharedMicros: sentAtSharedMicros }
                      : {}),
                    pane,
                    sequence,
                  });
                } catch {
                  // Diagnostics cannot alter input transport truth.
                }
              }
              const nextTurnBufferedAmount = readSocketBufferedAmount(socket);
              for (const [operation, bufferedAmount, sampledAtMicros] of [
                ["pane-stream-buffer-before-send", bufferMeasurement.before, enqueuedAtMicros],
                ["pane-stream-buffer-after-send", bufferMeasurement.after, sentAtMicros],
                ["pane-stream-buffer-next-turn", nextTurnBufferedAmount, atMicros],
              ] as const) {
                if (bufferedAmount === null) continue;
                try {
                  transportStage({
                    traceId: performanceTraceId!,
                    operation,
                    atMicros: sampledAtMicros,
                    pane,
                    sequence,
                    bufferedAmount,
                    frameBytes: bufferMeasurement.frameBytes,
                  });
                } catch {
                  // Diagnostics cannot alter input transport truth.
                }
              }
              if (bufferMeasurement.before !== null && nextTurnBufferedAmount !== null) {
                try {
                  transportStage({
                    traceId: performanceTraceId!,
                    operation: "pane-stream-buffer-drain-watermark",
                    atMicros,
                    pane,
                    sequence,
                    bufferedAmount: nextTurnBufferedAmount,
                    frameBytes: bufferMeasurement.frameBytes,
                    drained: nextTurnBufferedAmount <= bufferMeasurement.before,
                  });
                } catch {
                  // Diagnostics cannot alter input transport truth.
                }
              }
              try {
                transportStage({
                  traceId: performanceTraceId!,
                  operation: "pane-stream-observer-returned",
                  atMicros: diagnosticNowMicros(),
                  pane,
                  sequence,
                });
              } catch {
                // Diagnostics cannot alter input transport truth.
              }
            });
            if (!completed) (pendingDiagnosticTurns ??= new Set()).add(cancel);
          } catch {
            // Diagnostics cannot alter input transport truth.
          }
        }
      } catch (error) {
        timer.release();
        pendingInputs.delete(pendingKey);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const onOpen: SocketListener = () => {
    if (closed) return;
    options.onConnectionDiagnostic?.("socket-open", { requestId: descriptor.requestId });
    socket.send(
      JSON.stringify(
        PaneStreamRedeemFrameSchemaZ.parse({
          type: "redeem",
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          ticket: descriptor.redemptionTicket,
          requestId: descriptor.requestId,
          daemonInstanceId: descriptor.daemonInstanceId,
          ...(options.diagnosticCapabilities?.length
            ? { diagnosticCapabilities: [...options.diagnosticCapabilities] }
            : {}),
        }),
      ),
    );
  };
  const onMessage: SocketListener = (event) => {
    if (closed || typeof event.data !== "string") return fail("Pane-stream frame was not text");
    const arrivedAtMicros = options.onTerminalFrameArrival
      ? Math.floor(performance.now() * 1_000)
      : 0;
    let arrivedAtSharedMicros: number | undefined;
    if (diagnosticSharedNowMicros) {
      try {
        arrivedAtSharedMicros = diagnosticSharedNowMicros();
      } catch {
        // Shared-clock diagnostics are fail-open.
      }
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return fail("Pane-stream frame was not JSON");
    }
    const parsed = PaneStreamServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) return fail("Pane-stream frame failed validation");
    const frame = parsed.data;
    if (
      frame.type === "terminal-delivery-envelope" &&
      frame.envelope.performanceTraceId &&
      options.onTerminalFrameArrival
    ) {
      options.onTerminalFrameArrival({
        pane: frame.pane,
        traceId: frame.envelope.performanceTraceId,
        atMicros: arrivedAtMicros,
        ...(arrivedAtSharedMicros === undefined ? {} : { sharedMicros: arrivedAtSharedMicros }),
      });
    }
    if (!verified) {
      if (
        frame.type !== "ready" ||
        frame.daemonInstanceId !== descriptor.daemonInstanceId ||
        frame.requestId !== descriptor.requestId ||
        JSON.stringify(frame.panes) !== JSON.stringify(descriptor.panes) ||
        frame.effectiveViewerMode !== descriptor.effectiveViewerMode ||
        JSON.stringify(frame.diagnosticCapabilities ?? []) !==
          JSON.stringify(options.diagnosticCapabilities ?? [])
      ) {
        return fail("Pane-stream peer identity did not match the issued capability");
      }
      verified = true;
      options.onConnectionDiagnostic?.("ready-frame", {
        requestId: descriptor.requestId,
        panes: frame.panes.length,
        effectiveViewerMode: frame.effectiveViewerMode,
      });
      if (frame.authority) applyAuthoritySnapshot(frame.authority);
      clearReadyTimer();
      send({
        type: "presence",
        generation: descriptor.daemonInstanceId,
        state: "foreground",
      });
      if (options.requestInitialInputAuthority === false) {
        // Verified stream readiness is a read/display boundary. Input authority
        // is intentionally lazy and requested by TerminalFastLane on first
        // mutation, so a contended controller can never delay coherent paint.
        calibrateBeforeReady(() => {
          detachAbortListener();
          resolveReady(client);
        });
      } else {
        void client
          .requestAuthority("input")
          .then((lease) => {
            if (lease === null || authoritySnapshot?.owners.input !== options.hostClientId) {
              fail("Pane-stream input authority was denied during readiness");
              return;
            }
            calibrateBeforeReady(() => {
              detachAbortListener();
              resolveReady(client);
            });
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error : new Error(String(error))),
          );
      }
      return;
    }
    if (frame.type === "clock-probe-ack") {
      if (clockCalibrationSettled) return;
      receivedClockProbes += 1;
      const pending = pendingClockProbe;
      if (frame.requestId !== descriptor.requestId)
        return completeClockCalibration(null, "ack-request-mismatch");
      if (frame.daemonInstanceId !== descriptor.daemonInstanceId)
        return completeClockCalibration(null, "ack-generation-mismatch");
      if (!pending || frame.probe !== pending.probe)
        return completeClockCalibration(null, "ack-probe-mismatch");
      if (frame.clientSendMicros !== pending.clientSendMicros)
        return completeClockCalibration(null, "ack-client-send-mismatch");
      if (arrivedAtSharedMicros === undefined)
        return completeClockCalibration(null, "ack-clock-unavailable");
      pending.timer.release();
      pendingClockProbe = undefined;
      const sample = {
        probe: frame.probe,
        clientSendMicros: frame.clientSendMicros,
        daemonReceiveMicros: frame.daemonReceiveMicros,
        daemonSendMicros: frame.daemonSendMicros,
        clientReceiveMicros: arrivedAtSharedMicros,
      };
      clockSamples.push(sample);
      if (calibratePaneStreamClocks(descriptor.requestId, descriptor.daemonInstanceId, [sample]))
        validClockProbes += 1;
      if (frame.probe < clockProbeCount) sendClockProbe(frame.probe + 1);
      else {
        const calibration = calibratePaneStreamClocks(
          descriptor.requestId,
          descriptor.daemonInstanceId,
          clockSamples,
        );
        completeClockCalibration(calibration, calibration ? "calibrated" : "invalid-samples");
      }
      return;
    }
    if (frame.type === "causal-cell-proof") {
      options.onCausalCellProof?.(frame.proof);
      return;
    }
    if (frame.type === "causal-cell-failure") {
      options.onCausalCellFailure?.(frame.failure);
      return;
    }
    if (frame.type === "terminal-delivery-ready") {
      if (frame.negotiation.accepted) {
        negotiatedDeliveries.set(frame.pane, {
          generation: frame.negotiation.negotiated.generation,
          deliveryNonce: frame.negotiation.negotiated.deliveryNonce,
        });
      } else {
        negotiatedDeliveries.delete(frame.pane);
      }
    }
    if (frame.type === "authority-snapshot") {
      applyAuthoritySnapshot(frame.snapshot);
      return;
    }
    if (frame.type === "authority-receipt") {
      const pending = pendingAuthorities.get(frame.requestId);
      if (!pending || pending.authority !== frame.authority)
        return fail("Pane-stream authority receipt did not match a request");
      pending.timer.release();
      pendingAuthorities.delete(frame.requestId);
      applyAuthoritySnapshot(frame.snapshot);
      pending.resolve(frame.status === "granted" ? frame.lease : null, frame.snapshot);
      return;
    }
    if (frame.type === "viewport-ack") {
      const pending = pendingViewports.get(frame.seq);
      if (!pending || pending.cols !== frame.cols || pending.rows !== frame.rows)
        return fail("Pane-stream viewport acknowledgement did not match a request");
      pending.timer.release();
      pendingViewports.delete(frame.seq);
      pending.resolve();
      return;
    }
    if (frame.type === "semantic-intent-ack") {
      const pending = pendingIntents.get(frame.operationId);
      if (!pending) return fail("Pane-stream intent acknowledgement was not pending");
      pending.timer.release();
      pendingIntents.delete(frame.operationId);
      if (frame.outcome.status === "applied") pending.resolve(frame.outcome.result);
      else pending.reject(new PaneStreamOperationError(frame.outcome.code, frame.outcome.message));
      return;
    }
    if (frame.type === "input-ack") {
      const pendingKey = `${frame.pane}\0${frame.seq}`;
      const pending = pendingInputs.get(pendingKey);
      // ACKs can race a timeout/retirement or be duplicated by a replaying
      // transport. They carry no new authority and are safely idempotent.
      if (!pending) return;
      pending.timer.release();
      pendingInputs.delete(pendingKey);
      pending.resolve("ok");
      options.onInputAck?.({
        pane: frame.pane,
        sequence: frame.seq,
        ...(pending.traceId ? { traceId: pending.traceId } : {}),
        ...(arrivedAtSharedMicros === undefined ? {} : { sharedMicros: arrivedAtSharedMicros }),
      });
      return;
    }
    if (frame.type === "error" && frame.code === "input-rejected") {
      retirePendingInputsForAuthorityLoss();
    }
    routeFrame(options, frame, fail);
  };
  const onClose: SocketListener = () => {
    if (closed) return;
    closed = true;
    clearReadyTimer();
    cancelDiagnosticTurns();
    detachAbortListener();
    detachSocketListeners();
    releaseSocketResource();
    const error = new Error("Pane-stream runtime connection closed");
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
  };
  const onAbort = (): void => {
    const reason = options.signal?.reason;
    fail(reason instanceof Error ? reason : new Error("Pane-stream runtime connection aborted"));
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);
  listenersAttached = true;
  if (options.signal) {
    abortListenerAttached = true;
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }

  const client: PaneStreamRuntimeClient = {
    daemonInstanceId: descriptor.daemonInstanceId,
    requestId: descriptor.requestId,
    effectiveViewerMode: descriptor.effectiveViewerMode,
    get authoritySnapshot() {
      return authoritySnapshot;
    },
    setPresence: (state) =>
      send({ type: "presence", generation: descriptor.daemonInstanceId, state }),
    noteActivity: (activity) =>
      send({ type: "activity", generation: descriptor.daemonInstanceId, activity }),
    requestAuthority,
    releaseAuthority,
    sendTerminalInput,
    sendText: (pane, text, performanceTraceId) => {
      void sendTerminalInput(
        { workspaceName: options.stream.workspaceName, semanticPaneId: pane },
        { kind: "text", data: text },
        performanceTraceId,
      ).catch((error: unknown) =>
        options.onFault?.(error instanceof Error ? error : new Error(String(error))),
      );
    },
    sendKey: (pane, key, performanceTraceId) => {
      void sendTerminalInput(
        { workspaceName: options.stream.workspaceName, semanticPaneId: pane },
        SessionRuntimeTerminalInputSchemaZ.parse({ kind: "key", data: key }),
        performanceTraceId,
      ).catch((error: unknown) =>
        options.onFault?.(error instanceof Error ? error : new Error(String(error))),
      );
    },
    fitViewport: async (cols, rows) => {
      if (authoritySnapshot?.owners.geometry !== options.hostClientId) {
        const geometry = await requestAuthority("geometry");
        if (!geometry) {
          throw new PaneStreamOperationError(
            "authority-rejected",
            "Viewport fit requires foreground geometry authority",
          );
        }
      }
      viewportSequence += 1;
      const seq = viewportSequence;
      await new Promise<void>((resolve, reject) => {
        const timer = createRuntimeTimer(() => {
          pendingViewports.delete(seq);
          reject(new PaneStreamOperationError("operation-timeout", "Viewport fit timed out"));
        }, 2_000);
        pendingViewports.set(seq, { cols, rows, resolve, reject, timer });
        try {
          send({ type: "viewport", seq, cols, rows });
        } catch (error) {
          timer.release();
          pendingViewports.delete(seq);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    ack: (ack) => send({ type: "terminal-delivery-ack", ack }),
    nack: (nack) => send({ type: "terminal-delivery-nack", nack }),
    setVisibility: (address, visibility) =>
      send({ type: "terminal-delivery-visibility", ...address, visibility }),
    submitIntent: (operationId, intent) =>
      new Promise<WorkspaceMultiplexerMutationResult | null>((resolve, reject) => {
        const timer = createRuntimeTimer(() => {
          pendingIntents.delete(operationId);
          reject(new PaneStreamOperationError("operation-timeout", "Semantic intent timed out"));
        }, 12_000);
        pendingIntents.set(operationId, { resolve, reject, timer });
        try {
          send({ type: "semantic-intent", operationId, intent });
        } catch (error) {
          timer.release();
          pendingIntents.delete(operationId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    close: () => {
      if (closed) return;
      closed = true;
      clearReadyTimer();
      cancelDiagnosticTurns();
      detachAbortListener();
      detachSocketListeners();
      rejectPending(new Error("Pane-stream runtime client closed"));
      closeSocketOnce(1000, "client-closed");
    },
  };
  return await ready;
}

function routeFrame(
  options: ConnectIssuedPaneStreamRuntimeClientOptions,
  frame: PaneStreamServerFrame,
  fail: (message: string) => void,
): void {
  switch (frame.type) {
    case "terminal-delivery-ready":
      options.onNegotiated(frame.pane, frame.negotiation);
      return;
    case "terminal-delivery-envelope":
      if (frame.pane !== frame.envelope.semanticPaneId)
        return fail("Terminal delivery pane identity mismatch");
      options.onTerminalDelivery(frame.pane, frame.envelope);
      return;
    case "terminal-delivery-chunk":
      options.onTerminalDelivery(frame.pane, {
        type: "terminal.delivery.chunk",
        transactionId: frame.transactionId,
        index: frame.index,
        bytes: decodeBase64(frame.data),
      });
      return;
    case "terminal-delivery-fault":
      options.onTerminalDelivery(frame.pane, frame.fault);
      return;
    case "layout":
      options.onLayout?.(frame);
      return;
    case "semantic-intent-ack":
    case "viewport-ack":
    case "authority-snapshot":
    case "authority-receipt":
      fail(`Pane-stream received an unhandled ${frame.type}`);
      return;
    case "input-ack":
      fail("Pane-stream received an unhandled input acknowledgement");
      return;
    case "error":
      fail(`Pane-stream daemon rejected the connection: ${frame.code}`);
      return;
    case "ready":
      fail("Pane-stream sent a duplicate ready frame");
      return;
    default:
      // Explicit semantic-v2 clients reject raw-v1 body frames. Input ACKs are
      // also impossible because semantic intents own input in this mode.
      fail(`Pane-stream sent legacy ${frame.type} on the semantic delivery lane`);
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
