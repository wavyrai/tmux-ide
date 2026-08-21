import {
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  type DaemonEventResourceInterest,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type TerminalRuntimeInventoryProjectionV1,
} from "@tmux-ide/contracts";

import type {
  ApplicationShellEventConnection,
  ApplicationShellEventHandlers,
} from "./application-shell-session.ts";

export type WorkspaceEventSocketEventType = "open" | "message" | "close" | "error";
export type WorkspaceEventSocketEvent = { readonly data?: unknown };
export type WorkspaceEventSocketListener = (event: WorkspaceEventSocketEvent) => void;

export interface WorkspaceEventSocket {
  readonly readyState: number;
  addEventListener(
    type: WorkspaceEventSocketEventType,
    listener: WorkspaceEventSocketListener,
  ): void;
  removeEventListener?(
    type: WorkspaceEventSocketEventType,
    listener: WorkspaceEventSocketListener,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WorkspaceEventSocketOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export type WorkspaceEventSocketFactory = (
  url: string,
  options?: WorkspaceEventSocketOptions,
) => WorkspaceEventSocket;

export interface PreparedTerminalRuntimeInventory {
  readonly resource: TerminalRuntimeInventoryProjectionV1;
  /** One-shot clean adoption. An invalidation after preparation rejects consumption. */
  consume(): TerminalRuntimeInventoryProjectionV1 | null;
  dispose(): void;
}

export interface WorkspaceEventSupervisorOptions {
  readonly socket: WorkspaceEventSocket;
  readonly daemon: DaemonInstanceIdentity;
  readonly workspaceName: string;
  readonly sessionName: string;
  readonly fetchTerminalRuntimeInventory: (
    signal: AbortSignal,
  ) => Promise<TerminalRuntimeInventoryProjectionV1>;
  readonly maxInitialReadAttempts?: number;
  readonly terminalRefreshClock?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly onRetired?: () => void;
  readonly onDiagnostic?: (
    phase:
      | "terminal-event-socket-open"
      | "terminal-event-hello"
      | "terminal-interest-send"
      | "terminal-interest-ack"
      | "terminal-refresh",
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface WorkspaceEventSupervisor {
  prepareTerminalRuntimeInventory(signal: AbortSignal): Promise<PreparedTerminalRuntimeInventory>;
  /** Installs the ongoing terminal authority sink after the WorkspaceClient exists. */
  adoptTerminalRuntimeInventory(
    prepared: PreparedTerminalRuntimeInventory,
    onResource: (resource: TerminalRuntimeInventoryProjectionV1) => void,
  ): TerminalRuntimeInventoryProjectionV1 | null;
  /** Barrier awaited by application-shell fetches; verified-open is app-shell specific. */
  awaitApplicationShellBarrier(signal: AbortSignal): Promise<void>;
  connectApplicationShell(handlers: ApplicationShellEventHandlers): ApplicationShellEventConnection;
  connectWorkspaceCatalog(
    invalidate: () => void,
    options?: { readonly terminalFirst?: boolean },
  ): {
    readonly ready: Promise<void>;
    close(): void;
  };
  /** Releases terminal/app-shell authority while preserving a catalog-only subscription. */
  selectWorkspaceCatalogOnly(): Promise<void>;
  refreshTerminalRuntimeInventory(): void;
  dispose(): void;
}

interface AckWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly requested: readonly DaemonEventResourceInterest[];
}

function sameDaemon(expected: DaemonInstanceIdentity, actual: DaemonInstanceIdentity): boolean {
  return (
    expected.protocolVersion === actual.protocolVersion &&
    expected.productVersion === actual.productVersion &&
    expected.instanceId === actual.instanceId &&
    expected.startedAt === actual.startedAt
  );
}

function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * One permanent parser and physical event socket for a WorkspaceClient generation.
 * Logical resource barriers are independent; a socket hello never makes a resource live.
 */
export function createWorkspaceEventSupervisor(
  options: WorkspaceEventSupervisorOptions,
): WorkspaceEventSupervisor {
  const diagnose = options.onDiagnostic
    ? (
        phase: Parameters<NonNullable<WorkspaceEventSupervisorOptions["onDiagnostic"]>>[0],
        details: Readonly<Record<string, unknown>>,
      ): void => {
        try {
          options.onDiagnostic?.(phase, details);
        } catch {
          // Diagnostics never own the event authority lifecycle.
        }
      }
    : null;
  const socket = options.socket;
  const refreshClock =
    options.terminalRefreshClock ??
    Object.freeze({
      setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown): void =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  const terminalInterest = {
    resource: "terminal-runtime-inventory",
    workspaceName: options.workspaceName,
  } as const;
  const applicationShellInterest = {
    resource: "application-shell",
    workspaceName: options.workspaceName,
  } as const;
  const workspaceCatalogInterest = {
    resource: "workspace-catalog",
    workspaceName: null,
  } as const;
  const maximumInitialAttempts = options.maxInitialReadAttempts ?? 2;
  const hello = deferred();
  let disposed = false;
  let opened = false;
  let verified = false;
  let sequence = 0;
  let interestRevision = 0;
  let terminalEpoch = 0;
  let terminalRevision = 0;
  let snapshotRequired = false;
  let terminalDesired = true;
  let terminalInstalled = false;
  let applicationShellInstalled = false;
  let applicationShellDesired = false;
  let workspaceCatalogDesired = false;
  let terminalInstallFlight: Promise<void> | null = null;
  let applicationShellInstallFlight: Promise<void> | null = null;
  let interestMutationTail = Promise.resolve();
  let installedInterestSignature = "";
  let terminalSink: ((resource: TerminalRuntimeInventoryProjectionV1) => void) | null = null;
  let terminalRefreshQueued = false;
  let terminalRefreshRunning = false;
  let terminalRefreshTimer: unknown | null = null;
  let terminalRefreshController: AbortController | null = null;
  let terminalRefreshReason: "event" | "gap" | "snapshot" | "consumer" = "consumer";
  let terminalRefreshCoalesced = 0;
  let terminalRefreshDelayed = false;
  let terminalRefreshRetryAttempt = 0;
  let applicationShellHandlers: ApplicationShellEventHandlers | null = null;
  let workspaceCatalogInvalidate: (() => void) | null = null;
  let retirementNotified = false;
  let failureReported = false;
  const ackWaiters = new Map<number, AckWaiter>();

  const fail = (error: Error): void => {
    if (disposed || failureReported) return;
    failureReported = true;
    hello.reject(error);
    for (const waiter of ackWaiters.values()) waiter.reject(error);
    ackWaiters.clear();
    applicationShellHandlers?.onError(error.message);
  };
  const failProtocol = (error: Error): void => {
    fail(error);
    socket.close(1008, "Invalid daemon event protocol");
  };
  const notifyRetired = (): void => {
    if (retirementNotified || disposed) return;
    retirementNotified = true;
    try {
      options.onRetired?.();
    } catch {
      // The generation fence remains authoritative if a host observer fails.
    }
  };

  const mutateInterests = async (
    requested: readonly DaemonEventResourceInterest[],
  ): Promise<void> => {
    await hello.promise;
    if (disposed) throw new Error("workspace event supervisor disposed");
    const revision = ++interestRevision;
    const terminalOnly =
      requested.length === 1 && requested[0]?.resource === "terminal-runtime-inventory";
    const settled = new Promise<void>((resolve, reject) => {
      ackWaiters.set(revision, { resolve, reject, requested });
    });
    socket.send(
      JSON.stringify(
        DaemonEventClientFrameSchemaZ.parse({
          type: "subscribe",
          sessions: [options.sessionName],
          interests: requested,
          legacyEvents: false,
          interestRevision: revision,
          afterSequence: sequence,
        }),
      ),
    );
    if (terminalOnly) diagnose?.("terminal-interest-send", { interestRevision: revision });
    await settled;
  };

  const installTerminal = (): Promise<void> => {
    if (terminalInstalled) return Promise.resolve();
    if (terminalInstallFlight) return terminalInstallFlight;
    terminalInstallFlight = mutateInterests([terminalInterest])
      .then(() => {
        terminalInstalled = true;
      })
      .finally(() => {
        terminalInstallFlight = null;
      });
    return terminalInstallFlight;
  };

  const installApplicationShell = (): Promise<void> => {
    if (applicationShellInstalled) return Promise.resolve();
    if (applicationShellInstallFlight) return applicationShellInstallFlight;
    applicationShellDesired = true;
    applicationShellInstallFlight = installTerminal()
      .then(() => reconcileDesiredInterests())
      .then(() => {
        applicationShellInstalled = true;
      })
      .finally(() => {
        applicationShellInstallFlight = null;
      });
    return applicationShellInstallFlight;
  };

  const desiredInterests = (): readonly DaemonEventResourceInterest[] => [
    ...(terminalDesired ? [terminalInterest] : []),
    ...(applicationShellDesired ? [applicationShellInterest] : []),
    ...(workspaceCatalogDesired ? [workspaceCatalogInterest] : []),
  ];
  const reconcileDesiredInterests = (): Promise<void> => {
    const reconcile = interestMutationTail.then(async () => {
      const requested = desiredInterests();
      const signature = JSON.stringify(requested);
      if (signature === installedInterestSignature) return;
      await mutateInterests(requested);
      installedInterestSignature = signature;
    });
    interestMutationTail = reconcile.catch(() => undefined);
    return reconcile;
  };

  const isApplicationShellChange = (frame: DaemonEventServerFrame): boolean =>
    frame.type === "resource.changed" &&
    frame.resource === "application-shell" &&
    (frame.workspaceName === null || frame.workspaceName === options.workspaceName);

  const readTerminal = async (
    signal: AbortSignal,
    strict: boolean,
  ): Promise<TerminalRuntimeInventoryProjectionV1> => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < (strict ? maximumInitialAttempts : 1); attempt += 1) {
      const expectedEpoch = terminalEpoch;
      const expectedSnapshotRequired = snapshotRequired;
      try {
        const resource = await options.fetchTerminalRuntimeInventory(signal);
        if (
          strict &&
          (terminalEpoch !== expectedEpoch ||
            snapshotRequired !== expectedSnapshotRequired ||
            resource.resourceRevision < terminalRevision)
        ) {
          lastError = new Error("terminal runtime inventory changed during synchronization");
          continue;
        }
        return resource;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error instanceof Error ? error : new Error("terminal runtime inventory failed");
      }
    }
    throw lastError ?? new Error("terminal runtime inventory did not reach a clean snapshot");
  };

  const refreshTerminalAuthority = (
    reason: "event" | "gap" | "snapshot" | "consumer" = "consumer",
    continuation = false,
  ): void => {
    if (!continuation && !terminalRefreshQueued && !terminalRefreshRunning)
      terminalRefreshRetryAttempt = 0;
    if (!continuation && reason !== "consumer") {
      terminalRefreshReason = reason;
      terminalRefreshRetryAttempt = 0;
    }
    if (terminalRefreshQueued)
      terminalRefreshCoalesced = Math.min(terminalRefreshCoalesced + 1, 65_536);
    else terminalRefreshReason = reason;
    terminalRefreshQueued = true;
    if (
      terminalRefreshRunning ||
      terminalRefreshTimer !== null ||
      terminalSink === null ||
      disposed
    )
      return;
    terminalRefreshRunning = true;
    queueMicrotask(() => {
      const run = async (): Promise<void> => {
        if (!terminalRefreshQueued || terminalSink === null || disposed) return;
        terminalRefreshQueued = false;
        const refreshReason = terminalRefreshReason;
        const coalescedRequests = terminalRefreshCoalesced;
        const delayed = terminalRefreshDelayed;
        const attempt = terminalRefreshRetryAttempt + 1;
        terminalRefreshCoalesced = 0;
        terminalRefreshDelayed = false;
        const controller = new AbortController();
        terminalRefreshController = controller;
        let outcome: "success" | "retry" | "exhausted" | "aborted" = "success";
        let failure: "read-failed" | "stale-revision" | null = null;
        try {
          const resource = await readTerminal(controller.signal, false);
          if (resource.resourceRevision < terminalRevision) {
            failure = "stale-revision";
            throw new Error("terminal runtime inventory response was stale");
          }
          if (!disposed && terminalSink !== null) {
            terminalSink(resource);
          }
          terminalRefreshRetryAttempt = 0;
        } catch {
          if (failure === null && !controller.signal.aborted) failure = "read-failed";
          const recoverable = !controller.signal.aborted && !disposed && terminalSink !== null;
          const authoritativeReplacement =
            recoverable && terminalRefreshQueued && terminalRefreshReason !== "consumer";
          if (authoritativeReplacement) outcome = "retry";
          else if (recoverable && terminalRefreshRetryAttempt < 2) {
            terminalRefreshRetryAttempt += 1;
            terminalRefreshQueued = true;
            outcome = "retry";
          } else {
            terminalRefreshQueued = false;
            outcome = controller.signal.aborted ? "aborted" : "exhausted";
          }
        } finally {
          const discardedCoalesced =
            outcome === "exhausted" || outcome === "aborted" ? terminalRefreshCoalesced : 0;
          if (discardedCoalesced > 0) terminalRefreshCoalesced = 0;
          diagnose?.("terminal-refresh", {
            reason: refreshReason,
            coalescedRequests: Math.min(coalescedRequests + discardedCoalesced, 65_536),
            delayed,
            attempt,
            outcome,
            failure,
          });
          if (terminalRefreshController === controller) terminalRefreshController = null;
        }
      };
      void run().finally(() => {
        terminalRefreshRunning = false;
        if (!terminalRefreshQueued || terminalSink === null || disposed) return;
        // A sink may synchronously request another read while adopting the
        // just-read snapshot. Keep that recovery live, but never let it form a
        // microtask spin loop against a stale same-revision authority.
        terminalRefreshDelayed = true;
        terminalRefreshTimer = refreshClock.setTimeout(() => {
          terminalRefreshTimer = null;
          terminalRefreshQueued = false;
          refreshTerminalAuthority(terminalRefreshReason, true);
        }, 25);
      });
    });
  };

  const observeSequence = (next: number): boolean => {
    if (next <= sequence) return false;
    const gap = next !== sequence + 1;
    if (gap) snapshotRequired = true;
    sequence = next;
    return gap;
  };

  const onOpen: WorkspaceEventSocketListener = () => {
    if (disposed) return;
    opened = true;
    diagnose?.("terminal-event-socket-open", {});
  };
  const onMessage: WorkspaceEventSocketListener = (event) => {
    if (disposed) return;
    if (!opened || typeof event.data !== "string") {
      failProtocol(new Error("daemon event frame was not ordered text"));
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(event.data);
    } catch {
      failProtocol(new Error("daemon event frame was not valid JSON"));
      return;
    }
    const parsed = DaemonEventServerFrameSchemaZ.safeParse(input);
    if (!parsed.success) {
      failProtocol(new Error("daemon event frame failed validation"));
      return;
    }
    const frame = parsed.data;
    if (!verified) {
      if (frame.type !== "hello" || !sameDaemon(options.daemon, frame.daemon)) {
        failProtocol(new Error("daemon event hello did not match the route generation"));
        return;
      }
      verified = true;
      sequence = frame.eventSequence ?? 0;
      hello.resolve();
      diagnose?.("terminal-event-hello", { sequence });
      return;
    }
    if (frame.type === "hello") {
      failProtocol(new Error("daemon event socket sent duplicate hello"));
      return;
    }
    if (frame.type === "resource.interests-ack") {
      const gap = observeSequence(frame.sequence);
      if (gap) {
        terminalEpoch += 1;
        applicationShellHandlers?.onInvalidate();
        refreshTerminalAuthority("gap");
        workspaceCatalogInvalidate?.();
      }
      const waiter = ackWaiters.get(frame.interestRevision);
      if (!waiter) return;
      ackWaiters.delete(frame.interestRevision);
      const unavailable = frame.unavailableInterests.some((candidate) =>
        waiter.requested.some(
          (requested) =>
            requested.resource === candidate.resource &&
            requested.workspaceName === candidate.workspaceName,
        ),
      );
      if (unavailable) waiter.reject(new Error("daemon event resource interest unavailable"));
      else {
        waiter.resolve();
        if (
          waiter.requested.length === 1 &&
          waiter.requested[0]?.resource === "terminal-runtime-inventory"
        )
          diagnose?.("terminal-interest-ack", {
            interestRevision: frame.interestRevision,
            sequence: frame.sequence,
          });
      }
      return;
    }
    if (frame.type === "snapshot-required") {
      sequence = frame.currentSequence;
      snapshotRequired = true;
      terminalEpoch += 1;
      applicationShellHandlers?.onInvalidate();
      refreshTerminalAuthority("snapshot");
      workspaceCatalogInvalidate?.();
      return;
    }
    let applicationShellChangeAccepted = false;
    let acceptedApplicationShellHandlers: ApplicationShellEventHandlers | null = null;
    if (frame.type === "resource.changed" || frame.type === "resource.observed") {
      const priorSequence = sequence;
      const gap = observeSequence(frame.sequence);
      applicationShellChangeAccepted =
        isApplicationShellChange(frame) && frame.sequence === priorSequence + 1 && !gap;
      if (applicationShellChangeAccepted)
        acceptedApplicationShellHandlers = applicationShellHandlers;
      if (
        applicationShellChangeAccepted &&
        frame.type === "resource.changed" &&
        frame.causeOperationId !== null
      ) {
        try {
          acceptedApplicationShellHandlers?.onOperationAcknowledged?.({
            daemonInstanceId: options.daemon.instanceId,
            operationId: frame.causeOperationId,
            sequence: frame.sequence,
            revision: frame.revision,
          });
        } catch {
          // A consumer acknowledgement observer cannot suppress the resource
          // invalidation that makes the same operation visible.
        }
      }
      if (gap) {
        terminalEpoch += 1;
        applicationShellHandlers?.onInvalidate();
        refreshTerminalAuthority("gap");
        workspaceCatalogInvalidate?.();
      }
    }
    if (
      frame.type === "resource.changed" &&
      frame.resource === "terminal-runtime-inventory" &&
      (frame.workspaceName === null || frame.workspaceName === options.workspaceName)
    ) {
      if (frame.revision > terminalRevision) {
        terminalEpoch += 1;
        terminalRevision = frame.revision;
        refreshTerminalAuthority("event");
      }
    }
    if (
      applicationShellChangeAccepted &&
      acceptedApplicationShellHandlers !== null &&
      applicationShellHandlers === acceptedApplicationShellHandlers
    )
      acceptedApplicationShellHandlers.onInvalidate();
    if (
      frame.type === "resource.changed" &&
      frame.resource === "workspace-catalog" &&
      frame.workspaceName === null
    )
      workspaceCatalogInvalidate?.();
    if (frame.type === "interaction.receipt" && frame.workspaceName === options.workspaceName) {
      observeSequence(frame.sequence);
      applicationShellHandlers?.onInteractionReceipt?.(frame);
    }
    if (frame.type === "protocol.error") applicationShellHandlers?.onProtocolError(frame.message);
  };
  const onClose: WorkspaceEventSocketListener = () => {
    if (disposed) return;
    fail(new Error("daemon event socket disconnected"));
    applicationShellHandlers?.onClose();
    notifyRetired();
  };
  const onError: WorkspaceEventSocketListener = () => {
    if (disposed) return;
    fail(new Error("daemon event socket reported an error"));
    socket.close(1011, "Daemon event socket error");
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);

  return {
    async prepareTerminalRuntimeInventory(signal) {
      await abortable(installTerminal(), signal);
      snapshotRequired = false;
      const resource = await readTerminal(signal, true);
      const cleanEpoch = terminalEpoch;
      let consumed = false;
      let retired = false;
      return {
        resource,
        consume() {
          if (consumed || retired || disposed || terminalEpoch !== cleanEpoch) return null;
          consumed = true;
          return resource;
        },
        dispose() {
          retired = true;
        },
      };
    },
    adoptTerminalRuntimeInventory(prepared, onResource) {
      const resource = prepared.consume();
      if (resource === null || disposed) return null;
      terminalSink = onResource;
      return resource;
    },
    awaitApplicationShellBarrier(signal) {
      return abortable(installApplicationShell(), signal);
    },
    connectApplicationShell(handlers) {
      if (disposed) throw new Error("workspace event supervisor disposed");
      applicationShellHandlers = handlers;
      handlers.onTransportStateChanged?.({ phase: "connecting" });
      void installApplicationShell().then(
        () => {
          if (applicationShellHandlers !== handlers) return;
          handlers.onVerifiedOpen();
          handlers.onTransportStateChanged?.({ phase: "connected" });
        },
        (error: unknown) =>
          handlers.onError(
            error instanceof Error ? error.message : "application-shell interest failed",
          ),
      );
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          if (applicationShellHandlers === handlers) applicationShellHandlers = null;
        },
      };
    },
    connectWorkspaceCatalog(invalidate, connectionOptions = {}) {
      if (disposed) throw new Error("workspace event supervisor disposed");
      workspaceCatalogInvalidate = invalidate;
      workspaceCatalogDesired = true;
      if (connectionOptions.terminalFirst === false) terminalDesired = false;
      const ready =
        connectionOptions.terminalFirst === false
          ? reconcileDesiredInterests()
          : installTerminal().then(() => reconcileDesiredInterests());
      let closed = false;
      return {
        ready,
        close() {
          if (closed) return;
          closed = true;
          if (workspaceCatalogInvalidate === invalidate) workspaceCatalogInvalidate = null;
        },
      };
    },
    selectWorkspaceCatalogOnly() {
      if (disposed) return Promise.reject(new Error("workspace event supervisor disposed"));
      if (!workspaceCatalogDesired)
        return Promise.reject(new Error("workspace event supervisor has no catalog subscriber"));
      terminalDesired = false;
      terminalInstalled = false;
      applicationShellDesired = false;
      applicationShellInstalled = false;
      terminalSink = null;
      terminalRefreshQueued = false;
      if (terminalRefreshTimer !== null) refreshClock.clearTimeout(terminalRefreshTimer);
      terminalRefreshTimer = null;
      terminalRefreshDelayed = false;
      terminalRefreshController?.abort();
      terminalRefreshController = null;
      applicationShellHandlers = null;
      const terminalBarrier = terminalInstallFlight ?? Promise.resolve();
      return terminalBarrier.catch(() => undefined).then(() => reconcileDesiredInterests());
    },
    refreshTerminalRuntimeInventory() {
      refreshTerminalAuthority("consumer");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (terminalRefreshTimer !== null) refreshClock.clearTimeout(terminalRefreshTimer);
      terminalRefreshTimer = null;
      terminalRefreshQueued = false;
      terminalRefreshDelayed = false;
      terminalRefreshController?.abort();
      terminalRefreshController = null;
      terminalSink = null;
      applicationShellHandlers = null;
      workspaceCatalogInvalidate = null;
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("message", onMessage);
      socket.removeEventListener?.("close", onClose);
      socket.removeEventListener?.("error", onError);
      for (const waiter of ackWaiters.values()) {
        waiter.reject(new Error("workspace event supervisor disposed"));
      }
      ackWaiters.clear();
      socket.close(1000, "Workspace event supervisor disposed");
    },
  };
}
