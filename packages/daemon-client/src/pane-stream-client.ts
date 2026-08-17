import {
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_PROTOCOL_VERSION,
  PaneStreamClientFrameSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  PaneStreamRedeemFrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
  SessionRuntimeTerminalInputSchemaZ,
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
  type CausalCellCapability,
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
  addEventListener(type: SocketEventType, listener: SocketListener): void;
  removeEventListener?(type: SocketEventType, listener: SocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PaneStreamInputTransportStageEvent {
  readonly traceId: string;
  readonly operation:
    | "pane-stream-frame-enqueued"
    | "pane-stream-socket-send-return"
    | "pane-stream-next-event-loop-turn";
  readonly atMicros: number;
  readonly pane: string;
  readonly sequence: number;
}

export function classifyPaneStreamInputTransportDelay(
  stages: readonly PaneStreamInputTransportStageEvent[],
  stallThresholdMicros: number,
):
  | "incomplete"
  | "socket-send-return-stall"
  | "client-event-loop-stall"
  | "no-client-transport-stall" {
  if (!Number.isFinite(stallThresholdMicros) || stallThresholdMicros <= 0)
    throw new TypeError("Input transport stall threshold must be positive");
  if (
    stages.length !== 3 ||
    stages[0]?.operation !== "pane-stream-frame-enqueued" ||
    stages[1]?.operation !== "pane-stream-socket-send-return" ||
    stages[2]?.operation !== "pane-stream-next-event-loop-turn"
  )
    return "incomplete";
  const [enqueued, sent, nextTurn] = stages;
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
    sent.atMicros < enqueued.atMicros ||
    nextTurn.atMicros < sent.atMicros
  )
    return "incomplete";
  if (sent.atMicros - enqueued.atMicros >= stallThresholdMicros) return "socket-send-return-stall";
  if (nextTurn.atMicros - sent.atMicros >= stallThresholdMicros) return "client-event-loop-stall";
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
  readonly diagnosticCapabilities?: readonly CausalCellCapability[];
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
  }) => void;
  /** Diagnostic-only outbound edges for one trace-correlated input frame. */
  readonly onInputTransportStage?: (event: PaneStreamInputTransportStageEvent) => void;
  /** Test seams are consulted only when `onInputTransportStage` is installed. */
  readonly diagnosticNowMicros?: () => number;
  readonly diagnosticNextTurn?: (callback: () => void) => () => void;
  readonly onLayout?: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
  readonly onInputAck?: (pane: string, sequence: number) => void;
  readonly onCausalCellProof?: (proof: CausalCellProofV1) => void;
  readonly onCausalCellFailure?: (failure: CausalCellFailureV1) => void;
  readonly onAuthoritySnapshot?: (snapshot: SessionRuntimeAuthoritySnapshot) => void;
  readonly onFault?: (error: Error) => void;
  readonly onConnectionDiagnostic?: (
    phase: "issue-start" | "issue-response" | "socket-created" | "socket-open" | "ready-frame",
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export type ConnectIssuedPaneStreamRuntimeClientOptions = Pick<
  OpenPaneStreamClientOptions,
  | "createSocket"
  | "requestInitialInputAuthority"
  | "origin"
  | "hostClientId"
  | "onNegotiated"
  | "onTerminalDelivery"
  | "onTerminalFrameArrival"
  | "onInputTransportStage"
  | "diagnosticNowMicros"
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
  releaseAuthority(authority: SessionRuntimeAuthorityKind): Promise<void>;
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
  let socketCloseRequested = false;
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
    detachSocketListeners();
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
    closeSocketOnce(1008, "protocol-error");
  };
  const send = (frame: unknown): void => {
    if (closed || socket.readyState !== 1) throw new Error("Pane-stream runtime client is closed");
    socket.send(JSON.stringify(PaneStreamClientFrameSchemaZ.parse(frame)));
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
      resolve(lease: SessionRuntimeAuthorityLease | null): void;
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
      pendingAuthorities.set(requestId, { authority, resolve, reject, timer });
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
  const releaseAuthority = (authority: SessionRuntimeAuthorityKind): Promise<void> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = createRuntimeTimer(() => {
        pendingAuthorities.delete(requestId);
        reject(new PaneStreamOperationError("operation-timeout", `${authority} release timed out`));
      }, 2_000);
      pendingAuthorities.set(requestId, {
        authority,
        resolve: () => resolve(),
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
      pendingInputs.set(pendingKey, { pane, sequence, resolve, reject, timer });
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
        send({
          type: "input",
          ...input,
          pane,
          seq: sequence,
          ...(performanceTraceId ? { performanceTraceId } : {}),
          ...(causalProbe ? { causalProbe } : {}),
        });
        // Socket admission is authoritative. Commit FIFO identity before any
        // diagnostic callback can re-enter `sendTerminalInput`.
        inputSequences.set(pane, sequence);
        let sentAtMicros: number | null = null;
        if (diagnosticNowMicros) {
          try {
            sentAtMicros = diagnosticNowMicros();
          } catch {
            // Diagnostics cannot alter input transport truth.
          }
        }
        if (
          transportStage &&
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
                    pane,
                    sequence,
                  });
                } catch {
                  // Diagnostics cannot alter input transport truth.
                }
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
        resolveReady(client);
      } else {
        void client
          .requestAuthority("input")
          .then((lease) => {
            if (lease === null || authoritySnapshot?.owners.input !== options.hostClientId) {
              fail("Pane-stream input authority was denied during readiness");
              return;
            }
            resolveReady(client);
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error : new Error(String(error))),
          );
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
      pending.resolve(frame.status === "granted" ? frame.lease : null);
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
      options.onInputAck?.(frame.pane, frame.seq);
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
    detachSocketListeners();
    releaseSocketResource();
    const error = new Error("Pane-stream runtime connection closed");
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);
  listenersAttached = true;

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
