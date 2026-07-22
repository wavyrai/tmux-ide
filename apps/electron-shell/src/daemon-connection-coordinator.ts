import {
  DesktopDaemonHostStateSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityState,
  type DesktopDaemonEvent,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonHostState,
  type DesktopDaemonListWorkspacesResult,
  type DesktopDaemonRefreshConnectionResult,
  type TerminalAttachmentIssueMutationRequest,
  type TerminalAttachmentIssueResult,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
} from "@tmux-ide/contracts";

import {
  DaemonResourceBroker,
  daemonCapabilityError,
  rendererDaemonState,
  terminalAttachmentIssueError,
  type BrokerSubscriptionResult,
} from "./daemon-resource-broker.ts";
import { runDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";
import { inspectCanonicalDaemonInfo } from "../../../packages/daemon/src/canonical.ts";

type ConnectedDaemonState = Extract<DesktopDaemonHostState, { status: "connected" }>;

export interface DaemonResourceAuthority {
  createWorkspacePane(
    request: WorkspacePaneCreateMutationRequest,
  ): Promise<WorkspacePaneCreateMutationResult>;
  issueTerminalAttachment(
    request: TerminalAttachmentIssueMutationRequest,
    rendererOrigin: string,
  ): Promise<TerminalAttachmentIssueResult>;
  listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult>;
  fetchApplicationShell(workspaceName: string): Promise<DesktopDaemonFetchApplicationShellResult>;
  subscribe(
    workspaceNames: readonly string[],
    listener: (event: DesktopDaemonEvent) => void,
  ): Promise<BrokerSubscriptionResult>;
  releaseRenderer(): void;
  dispose(): void;
}

export interface DaemonConnectionAuthority extends DaemonResourceAuthority {
  state(): DesktopDaemonCapabilityState;
  refreshConnection(): Promise<DesktopDaemonRefreshConnectionResult>;
}

export interface DaemonConnectionCoordinatorDependencies {
  readonly initialDaemon: DesktopDaemonHostState;
  readonly preflight: DaemonPreflight;
  readonly preflightTimeoutMs?: number;
  readonly createBroker?: (daemon: ConnectedDaemonState) => DaemonResourceAuthority;
}

interface RefreshFlight {
  readonly rendererGeneration: number;
  readonly promise: Promise<DesktopDaemonRefreshConnectionResult>;
}

interface CoordinatorSubscription {
  readonly broker: DaemonResourceAuthority;
  readonly rendererGeneration: number;
  readonly listener: (event: DesktopDaemonEvent) => void;
  readonly unsubscribeBroker: () => void;
}

const BROKER_FAILED_STATE: DesktopDaemonHostState = Object.freeze({
  status: "degraded",
  code: "resource-broker-failed",
  reason: "The verified daemon resource authority could not be established.",
});

function identityOf(
  daemon: Extract<DesktopDaemonHostState, { status: "connected" }>,
): DaemonInstanceIdentity {
  const { protocolVersion, productVersion, instanceId, startedAt } = daemon.descriptor;
  return { protocolVersion, productVersion, instanceId, startedAt };
}

function sameIdentity(left: DaemonInstanceIdentity, right: DaemonInstanceIdentity): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function sameDisconnectedState(
  left: DesktopDaemonHostState,
  right: DesktopDaemonHostState,
): boolean {
  return (
    left.status !== "connected" &&
    right.status !== "connected" &&
    left.status === right.status &&
    left.code === right.code
  );
}

function defaultBrokerFactory(daemon: ConnectedDaemonState): DaemonResourceAuthority {
  const canonical = inspectCanonicalDaemonInfo();
  if (
    canonical.status !== "valid" ||
    canonical.info.instanceId !== daemon.descriptor.instanceId ||
    canonical.info.protocolVersion !== daemon.descriptor.protocolVersion ||
    canonical.info.startedAt !== daemon.descriptor.startedAt ||
    !canonical.info.authToken
  ) {
    throw new Error("canonical daemon owner capability is unavailable or changed");
  }
  return new DaemonResourceBroker({ daemon, ownerToken: canonical.info.authToken });
}

/**
 * Owns the verified daemon authority for the Electron main process. Refreshes
 * are generation-bound, serialized, and never expose the daemon endpoint.
 */
export class DaemonConnectionCoordinator implements DaemonConnectionAuthority {
  readonly #preflight: DaemonPreflight;
  readonly #preflightTimeoutMs: number | undefined;
  readonly #createBroker: (daemon: ConnectedDaemonState) => DaemonResourceAuthority;
  readonly #subscriptions = new Map<number, CoordinatorSubscription>();

  #daemon: DesktopDaemonHostState;
  #broker: DaemonResourceAuthority | null = null;
  #disposed = false;
  #rendererGeneration = 0;
  #nextSubscription = 0;
  #refreshFlight: RefreshFlight | null = null;
  #refreshTail: Promise<void> = Promise.resolve();

  constructor(dependencies: DaemonConnectionCoordinatorDependencies) {
    this.#daemon = DesktopDaemonHostStateSchemaZ.parse(dependencies.initialDaemon);
    this.#preflight = dependencies.preflight;
    this.#preflightTimeoutMs = dependencies.preflightTimeoutMs;
    this.#createBroker = dependencies.createBroker ?? defaultBrokerFactory;
    if (this.#daemon.status === "connected") {
      try {
        this.#broker = this.#createBroker(this.#daemon);
      } catch {
        this.#daemon = BROKER_FAILED_STATE;
      }
    }
  }

  state(): DesktopDaemonCapabilityState {
    return rendererDaemonState(this.#daemon);
  }

  refreshConnection(): Promise<DesktopDaemonRefreshConnectionResult> {
    const rendererGeneration = this.#rendererGeneration;
    if (this.#disposed) return Promise.resolve(this.#superseded());
    if (this.#refreshFlight?.rendererGeneration === rendererGeneration) {
      return this.#refreshFlight.promise;
    }

    const priorTail = this.#refreshTail;
    const operation = priorTail
      .catch(() => undefined)
      .then(() => this.#performRefresh(rendererGeneration));
    const flight: RefreshFlight = { rendererGeneration, promise: operation };
    this.#refreshFlight = flight;
    this.#refreshTail = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      () => {
        if (this.#refreshFlight === flight) this.#refreshFlight = null;
      },
      () => {
        if (this.#refreshFlight === flight) this.#refreshFlight = null;
      },
    );
    return operation;
  }

  async createWorkspacePane(
    request: WorkspacePaneCreateMutationRequest,
  ): Promise<WorkspacePaneCreateMutationResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) throw new Error("daemon mutation authority is unavailable");
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.createWorkspacePane(request);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      throw new Error("daemon mutation authority changed during the request");
    }
    return result;
  }

  async issueTerminalAttachment(
    request: TerminalAttachmentIssueMutationRequest,
    rendererOrigin: string,
  ): Promise<TerminalAttachmentIssueResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) {
      return {
        status: "error",
        error: terminalAttachmentIssueError("daemon-unavailable"),
      };
    }
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.issueTerminalAttachment(request, rendererOrigin);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      return {
        status: "error",
        error: terminalAttachmentIssueError(
          this.#broker !== broker ? "daemon-identity-mismatch" : "disposed",
        ),
      };
    }
    return result;
  }

  async listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.listWorkspaces();
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      return {
        status: "error",
        error: daemonCapabilityError(
          this.#broker !== broker ? "daemon-identity-mismatch" : "disposed",
        ),
      };
    }
    return result;
  }

  async fetchApplicationShell(
    workspaceName: string,
  ): Promise<DesktopDaemonFetchApplicationShellResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchApplicationShell(workspaceName);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      return {
        status: "error",
        error: daemonCapabilityError(
          this.#broker !== broker ? "daemon-identity-mismatch" : "disposed",
        ),
      };
    }
    return result;
  }

  async subscribe(
    workspaceNames: readonly string[],
    listener: (event: DesktopDaemonEvent) => void,
  ): Promise<BrokerSubscriptionResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const id = ++this.#nextSubscription;
    const earlyEvents: DesktopDaemonEvent[] = [];
    const result = await broker.subscribe(workspaceNames, (event) => {
      const subscription = this.#subscriptions.get(id);
      if (
        broker !== this.#broker ||
        rendererGeneration !== this.#rendererGeneration ||
        this.#disposed
      ) {
        return;
      }
      if (!subscription) {
        // A verified socket can emit its live handoff before subscribe()
        // resolves. Preserve only this tiny, bounded local race window.
        if (earlyEvents.length < 8) earlyEvents.push(event);
        return;
      }
      try {
        subscription.listener(event);
      } catch {
        // One renderer listener cannot destabilize connection ownership.
      }
    });
    if (result.status === "error") return result;
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      try {
        result.unsubscribe();
      } catch {
        // It never became a logical coordinator subscription.
      }
      return { status: "error", error: daemonCapabilityError("disposed") };
    }
    let active = true;
    this.#subscriptions.set(id, {
      broker,
      rendererGeneration,
      listener,
      unsubscribeBroker: result.unsubscribe,
    });
    for (const event of earlyEvents) {
      const subscription = this.#subscriptions.get(id);
      if (!subscription || subscription.broker !== this.#broker || this.#disposed) break;
      try {
        subscription.listener(event);
      } catch {
        // One renderer listener cannot break the subscription handoff.
      }
    }
    return {
      status: "subscribed",
      unsubscribe: () => {
        if (!active) return;
        active = false;
        const subscription = this.#subscriptions.get(id);
        if (!subscription) return;
        this.#subscriptions.delete(id);
        try {
          subscription.unsubscribeBroker();
        } catch {
          // Logical unsubscription happened before transport teardown.
        }
      },
    };
  }

  releaseRenderer(): void {
    this.#rendererGeneration += 1;
    this.#retireSubscriptions();
    try {
      this.#broker?.releaseRenderer();
    } catch {
      // Generation checks already revoked every callback and in-flight result.
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rendererGeneration += 1;
    this.#retireSubscriptions();
    try {
      this.#broker?.dispose();
    } catch {
      // Disposal is best-effort after logical authority is revoked.
    }
    this.#broker = null;
  }

  async #performRefresh(
    expectedRendererGeneration: number,
  ): Promise<DesktopDaemonRefreshConnectionResult> {
    if (this.#disposed || expectedRendererGeneration !== this.#rendererGeneration) {
      return this.#superseded();
    }

    let candidate: DesktopDaemonHostState;
    try {
      candidate = await runDaemonPreflight(this.#preflight, this.#preflightTimeoutMs);
      candidate = DesktopDaemonHostStateSchemaZ.parse(candidate);
    } catch {
      candidate = {
        status: "degraded",
        code: "probe-failed",
        reason: "Canonical daemon verification returned an invalid result.",
      };
    }
    if (this.#disposed || expectedRendererGeneration !== this.#rendererGeneration) {
      return this.#superseded();
    }

    const previousDaemon = this.#daemon;
    const previousIdentity =
      previousDaemon.status === "connected" ? identityOf(previousDaemon) : null;

    if (candidate.status === "connected") {
      const nextIdentity = identityOf(candidate);
      if (previousIdentity && sameIdentity(previousIdentity, nextIdentity)) {
        return this.#parseResult({ outcome: "unchanged", daemon: this.state() });
      }

      let nextBroker: DaemonResourceAuthority;
      try {
        nextBroker = this.#createBroker(candidate);
      } catch {
        return this.#transitionToDisconnected(BROKER_FAILED_STATE, previousIdentity);
      }
      if (this.#disposed || expectedRendererGeneration !== this.#rendererGeneration) {
        try {
          nextBroker.dispose();
        } catch {
          // It was never installed as an authority.
        }
        return this.#superseded();
      }

      const previousBroker = this.#broker;
      this.#daemon = candidate;
      this.#broker = nextBroker;
      const daemon = this.state();
      this.#retireSubscriptions({
        type: "daemon-generation.changed",
        previousIdentity,
        daemon,
      });
      try {
        previousBroker?.dispose();
      } catch {
        // Old callbacks are already generation-guarded and logically retired.
      }
      return this.#parseResult({
        outcome: "generation-replaced",
        previousIdentity,
        daemon,
      });
    }

    if (sameDisconnectedState(previousDaemon, candidate)) {
      this.#daemon = candidate;
      return this.#parseResult({ outcome: "unchanged", daemon: this.state() });
    }
    return this.#transitionToDisconnected(candidate, previousIdentity);
  }

  #transitionToDisconnected(
    candidate: DesktopDaemonHostState,
    previousIdentity: DaemonInstanceIdentity | null,
  ): DesktopDaemonRefreshConnectionResult {
    if (candidate.status === "connected") {
      throw new Error("connected daemon cannot retire connection authority");
    }
    const previousBroker = this.#broker;
    this.#daemon = candidate;
    this.#broker = null;
    const daemon = this.state();
    if (previousIdentity) {
      this.#retireSubscriptions({
        type: "daemon-generation.changed",
        previousIdentity,
        daemon,
      });
    } else {
      this.#retireSubscriptions();
    }
    try {
      previousBroker?.dispose();
    } catch {
      // Old callbacks are already generation-guarded and logically retired.
    }
    return previousIdentity
      ? this.#parseResult({ outcome: "authority-retired", previousIdentity, daemon })
      : this.#parseResult({ outcome: "state-changed", daemon });
  }

  #retireSubscriptions(event?: DesktopDaemonEvent): void {
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    if (event) {
      for (const subscription of subscriptions) {
        try {
          subscription.listener(event);
        } catch {
          // Every retired subscription still receives an independent attempt.
        }
      }
    }
    for (const subscription of subscriptions) {
      try {
        subscription.unsubscribeBroker();
      } catch {
        // Logical retirement happened before transport teardown.
      }
    }
  }

  #disconnectedResult(): {
    readonly status: "error";
    readonly error: ReturnType<typeof daemonCapabilityError>;
  } {
    return {
      status: "error",
      error: daemonCapabilityError(
        this.#disposed
          ? "disposed"
          : this.#daemon.status === "degraded"
            ? "daemon-degraded"
            : "daemon-unavailable",
      ),
    };
  }

  #superseded(): DesktopDaemonRefreshConnectionResult {
    return this.#parseResult({ outcome: "superseded", daemon: this.state() });
  }

  #parseResult(value: unknown): DesktopDaemonRefreshConnectionResult {
    return DesktopDaemonRefreshConnectionResultSchemaZ.parse(value);
  }
}
