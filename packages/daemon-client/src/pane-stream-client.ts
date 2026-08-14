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

type SocketEventType = "open" | "message" | "close" | "error";
type SocketListener = (event: { readonly data?: unknown }) => void;
const MAX_PENDING_TERMINAL_INPUTS = 256;

export interface PaneStreamClientSocket {
  readonly readyState: number;
  addEventListener(type: SocketEventType, listener: SocketListener): void;
  removeEventListener?(type: SocketEventType, listener: SocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
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
  readonly fetch?: typeof fetch;
  readonly onNegotiated: (pane: string, negotiation: TerminalDeliveryNegotiationResult) => void;
  readonly onTerminalDelivery: (pane: string, message: TerminalDeliveryServerMessage) => void;
  readonly onLayout?: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
  readonly onInputAck?: (pane: string, sequence: number) => void;
  readonly onAuthoritySnapshot?: (snapshot: SessionRuntimeAuthoritySnapshot) => void;
  readonly onFault?: (error: Error) => void;
}

export type ConnectIssuedPaneStreamRuntimeClientOptions = Pick<
  OpenPaneStreamClientOptions,
  | "createSocket"
  | "origin"
  | "hostClientId"
  | "onNegotiated"
  | "onTerminalDelivery"
  | "onLayout"
  | "onInputAck"
  | "onAuthoritySnapshot"
  | "onFault"
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
  });
  const issued = PaneStreamIssueResultSchemaZ.parse(await response.json());
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
  });
  let closed = false;
  let verified = false;
  let resolveReady!: (client: PaneStreamRuntimeClient) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<PaneStreamRuntimeClient>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => fail("Pane-stream runtime handshake timed out"), 2_000);
  readyTimer.unref?.();

  const fail = (message: string): void => {
    if (closed) return;
    closed = true;
    const error = new Error(message);
    clearTimeout(readyTimer);
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
    socket.close(1008, "protocol-error");
  };
  const send = (frame: unknown): void => {
    if (closed || socket.readyState !== 1) throw new Error("Pane-stream runtime client is closed");
    socket.send(JSON.stringify(PaneStreamClientFrameSchemaZ.parse(frame)));
  };
  const inputSequences = new Map<string, number>();
  const pendingInputs = new Map<
    string,
    {
      readonly pane: string;
      readonly sequence: number;
      resolve(result: SessionRuntimeTerminalInputResult): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  let authoritySnapshot: SessionRuntimeAuthoritySnapshot | null = null;
  const pendingAuthorities = new Map<
    string,
    {
      authority: SessionRuntimeAuthorityKind;
      resolve(lease: SessionRuntimeAuthorityLease | null): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
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
      timer: NodeJS.Timeout;
    }
  >();
  const pendingIntents = new Map<
    string,
    {
      resolve(result: WorkspaceMultiplexerMutationResult | null): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  const rejectPending = (error: Error): void => {
    for (const pending of pendingInputs.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingInputs.clear();
    for (const pending of pendingViewports.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingViewports.clear();
    for (const pending of pendingIntents.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingIntents.clear();
    for (const pending of pendingAuthorities.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingAuthorities.clear();
  };
  const retirePendingInputsForAuthorityLoss = (): void => {
    for (const pending of pendingInputs.values()) {
      clearTimeout(pending.timer);
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
      const timer = setTimeout(() => {
        pendingAuthorities.delete(requestId);
        reject(
          new PaneStreamOperationError("operation-timeout", `${authority} authority timed out`),
        );
      }, 2_000);
      timer.unref?.();
      pendingAuthorities.set(requestId, { authority, resolve, reject, timer });
      try {
        send({
          type: "authority-request",
          generation: descriptor.daemonInstanceId,
          requestId,
          authority,
        });
      } catch (error) {
        clearTimeout(timer);
        pendingAuthorities.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const releaseAuthority = (authority: SessionRuntimeAuthorityKind): Promise<void> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAuthorities.delete(requestId);
        reject(new PaneStreamOperationError("operation-timeout", `${authority} release timed out`));
      }, 2_000);
      timer.unref?.();
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
        clearTimeout(timer);
        pendingAuthorities.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const sendTerminalInput = (
    target: TerminalReplicaAddress,
    rawInput: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
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
    const pendingKey = `${pane}\0${sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingInputs.delete(pendingKey);
        reject(new PaneStreamOperationError("operation-timeout", "Terminal input ack timed out"));
      }, 2_000);
      timer.unref?.();
      pendingInputs.set(pendingKey, { pane, sequence, resolve, reject, timer });
      try {
        send({
          type: "input",
          ...input,
          pane,
          seq: sequence,
          ...(performanceTraceId ? { performanceTraceId } : {}),
        });
        inputSequences.set(pane, sequence);
      } catch (error) {
        clearTimeout(timer);
        pendingInputs.delete(pendingKey);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const onOpen: SocketListener = () => {
    if (closed) return;
    socket.send(
      JSON.stringify(
        PaneStreamRedeemFrameSchemaZ.parse({
          type: "redeem",
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          ticket: descriptor.redemptionTicket,
          requestId: descriptor.requestId,
          daemonInstanceId: descriptor.daemonInstanceId,
        }),
      ),
    );
  };
  const onMessage: SocketListener = (event) => {
    if (closed || typeof event.data !== "string") return fail("Pane-stream frame was not text");
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return fail("Pane-stream frame was not JSON");
    }
    const parsed = PaneStreamServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) return fail("Pane-stream frame failed validation");
    const frame = parsed.data;
    if (!verified) {
      if (
        frame.type !== "ready" ||
        frame.daemonInstanceId !== descriptor.daemonInstanceId ||
        frame.requestId !== descriptor.requestId ||
        JSON.stringify(frame.panes) !== JSON.stringify(descriptor.panes) ||
        frame.effectiveViewerMode !== descriptor.effectiveViewerMode
      ) {
        return fail("Pane-stream peer identity did not match the issued capability");
      }
      verified = true;
      if (frame.authority) applyAuthoritySnapshot(frame.authority);
      clearTimeout(readyTimer);
      send({
        type: "presence",
        generation: descriptor.daemonInstanceId,
        state: "foreground",
      });
      if (descriptor.effectiveViewerMode === "interactive") {
        void requestAuthority("input")
          .then((lease) => {
            if (!lease) {
              throw new PaneStreamOperationError(
                "authority-rejected",
                "The pane-stream daemon rejected initial input authority",
              );
            }
            resolveReady(client);
          })
          .catch((error: unknown) => {
            if (closed) return;
            closed = true;
            const cause =
              error instanceof Error
                ? error
                : new PaneStreamOperationError("authority-rejected", String(error));
            rejectPending(cause);
            rejectReady(cause);
            options.onFault?.(cause);
            socket.close(1008, "authority-rejected");
          });
        return;
      }
      resolveReady(client);
      return;
    }
    if (frame.type === "authority-snapshot") {
      applyAuthoritySnapshot(frame.snapshot);
      return;
    }
    if (frame.type === "authority-receipt") {
      const pending = pendingAuthorities.get(frame.requestId);
      if (!pending || pending.authority !== frame.authority)
        return fail("Pane-stream authority receipt did not match a request");
      clearTimeout(pending.timer);
      pendingAuthorities.delete(frame.requestId);
      applyAuthoritySnapshot(frame.snapshot);
      pending.resolve(frame.status === "granted" ? frame.lease : null);
      return;
    }
    if (frame.type === "viewport-ack") {
      const pending = pendingViewports.get(frame.seq);
      if (!pending || pending.cols !== frame.cols || pending.rows !== frame.rows)
        return fail("Pane-stream viewport acknowledgement did not match a request");
      clearTimeout(pending.timer);
      pendingViewports.delete(frame.seq);
      pending.resolve();
      return;
    }
    if (frame.type === "semantic-intent-ack") {
      const pending = pendingIntents.get(frame.operationId);
      if (!pending) return fail("Pane-stream intent acknowledgement was not pending");
      clearTimeout(pending.timer);
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
      clearTimeout(pending.timer);
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
    clearTimeout(readyTimer);
    const error = new Error("Pane-stream runtime connection closed");
    rejectPending(error);
    rejectReady(error);
    options.onFault?.(error);
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);

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
      const geometry = await requestAuthority("geometry");
      if (!geometry) {
        throw new PaneStreamOperationError(
          "authority-rejected",
          "Viewport fit requires foreground geometry authority",
        );
      }
      viewportSequence += 1;
      const seq = viewportSequence;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingViewports.delete(seq);
          reject(new PaneStreamOperationError("operation-timeout", "Viewport fit timed out"));
        }, 2_000);
        timer.unref?.();
        pendingViewports.set(seq, { cols, rows, resolve, reject, timer });
        try {
          send({ type: "viewport", seq, cols, rows });
        } catch (error) {
          clearTimeout(timer);
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
        const timer = setTimeout(() => {
          pendingIntents.delete(operationId);
          reject(new PaneStreamOperationError("operation-timeout", "Semantic intent timed out"));
        }, 12_000);
        timer.unref?.();
        pendingIntents.set(operationId, { resolve, reject, timer });
        try {
          send({ type: "semantic-intent", operationId, intent });
        } catch (error) {
          clearTimeout(timer);
          pendingIntents.delete(operationId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    close: () => {
      if (closed) return;
      closed = true;
      rejectPending(new Error("Pane-stream runtime client closed"));
      socket.close(1000, "client-closed");
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
