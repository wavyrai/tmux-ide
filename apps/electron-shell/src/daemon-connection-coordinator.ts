import {
  DesktopDaemonHostStateSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  type DaemonInstanceIdentity,
  type DaemonChildOutputTail,
  type StartupReadinessLadder,
  type DesktopDaemonCapabilityState,
  type DesktopDaemonCapabilitiesResult,
  type DesktopDaemonEvent,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonFetchApplicationShellRequest,
  type DesktopDaemonFetchWorkspaceChangeDiffRequest,
  type DesktopDaemonFetchWorkspaceChangeDiffResult,
  type DesktopDaemonFetchWorkspaceChangesRequest,
  type DesktopDaemonFetchWorkspaceChangesResult,
  type DesktopDaemonFetchWorkspaceFilePreviewRequest,
  type DesktopDaemonFetchWorkspaceFilePreviewResult,
  type DesktopDaemonFetchWorkspaceFilesRequest,
  type DesktopDaemonFetchWorkspaceFilesResult,
  type DesktopDaemonHostState,
  type DesktopDaemonListWorkspacesResult,
  type DesktopDaemonFetchFleetCatalogResult,
  type DesktopDaemonRefreshConnectionResult,
  type TerminalAttachmentIssueMutationRequest,
  type TerminalAttachmentIssueResult,
  type PaneStreamIssueMutationRequest,
  type PaneStreamIssueResult,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
  type WorkspaceOpenMutationRequest,
  type WorkspaceOpenMutationResult,
  type WorkspacePromoteMutationRequest,
  type WorkspacePromoteMutationResult,
  type AppWindowMutationRequest,
  type AppWindowMutationResult,
} from "@tmux-ide/contracts";

import {
  DaemonResourceBroker,
  daemonCapabilityError,
  paneStreamIssueError,
  rendererDaemonState,
  terminalAttachmentIssueError,
  type BrokerSubscriptionResult,
} from "./daemon-resource-broker.ts";
import { runDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";
import type { KnownEnvironmentReconciler } from "./environment-catalog.ts";
import { inspectCanonicalDaemonInfo } from "../../../packages/daemon/src/canonical.ts";

type ConnectedDaemonState = Extract<DesktopDaemonHostState, { status: "connected" }>;

export interface DaemonResourceAuthority {
  capabilities(): Promise<DesktopDaemonCapabilitiesResult>;
  mutateAppWindow(request: AppWindowMutationRequest): Promise<AppWindowMutationResult>;
  openWorkspace(request: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult>;
  promoteWorkspace(
    request: WorkspacePromoteMutationRequest,
  ): Promise<WorkspacePromoteMutationResult>;
  createWorkspacePane(
    request: WorkspacePaneCreateMutationRequest,
  ): Promise<WorkspacePaneCreateMutationResult>;
  issueTerminalAttachment(
    request: TerminalAttachmentIssueMutationRequest,
    rendererOrigin: string,
  ): Promise<TerminalAttachmentIssueResult>;
  issuePaneStream(
    request: PaneStreamIssueMutationRequest,
    rendererOrigin: string,
  ): Promise<PaneStreamIssueResult>;
  listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult>;
  fetchFleetCatalog(): Promise<DesktopDaemonFetchFleetCatalogResult>;
  fetchApplicationShell(
    workspaceName: string,
    resourceVersion?: DesktopDaemonFetchApplicationShellRequest["resourceVersion"],
  ): Promise<DesktopDaemonFetchApplicationShellResult>;
  fetchWorkspaceFiles(
    request: DesktopDaemonFetchWorkspaceFilesRequest,
  ): Promise<DesktopDaemonFetchWorkspaceFilesResult>;
  fetchWorkspaceFilePreview(
    request: DesktopDaemonFetchWorkspaceFilePreviewRequest,
  ): Promise<DesktopDaemonFetchWorkspaceFilePreviewResult>;
  fetchWorkspaceChanges(
    request: DesktopDaemonFetchWorkspaceChangesRequest,
  ): Promise<DesktopDaemonFetchWorkspaceChangesResult>;
  fetchWorkspaceChangeDiff(
    request: DesktopDaemonFetchWorkspaceChangeDiffRequest,
  ): Promise<DesktopDaemonFetchWorkspaceChangeDiffResult>;
  subscribe(
    workspaceNames: readonly string[],
    listener: (event: DesktopDaemonEvent) => void,
  ): Promise<BrokerSubscriptionResult>;
  /**
   * Explicit transport wakeup: interrupts a scheduled event-socket backoff and
   * restarts a transport stopped at its fatal ceiling. Optional so bespoke
   * test authorities without an event supervisor remain valid.
   */
  retryTransport?(): void;
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
  /** Main-process-only observer; renderer-safe state remains behind state(). */
  readonly onHostStateChanged?: (daemon: DesktopDaemonHostState) => void;
  /**
   * Client-side environment catalog: learns the daemon-minted environmentId
   * from each verified connect. Observational only — reconcile failures never
   * disturb connection authority, and no trust decision reads it.
   */
  readonly environmentReconciler?: KnownEnvironmentReconciler;
  /**
   * The daemon child's captured stderr tail, read at state() time. Supplied by
   * the supervisor that owns the child; absent for coordinators with no child
   * of their own (an attached foreign daemon, tests).
   */
  readonly childOutputTail?: () => DaemonChildOutputTail | null;
  /**
   * Reads the daemon's own startup readiness ladder. Called only while a
   * DISCONNECTED state is being composed — the daemon may still be answering,
   * and then its ladder names the rung the host cannot see. Must be bounded and
   * must resolve to null rather than reject; a diagnostic read never delays or
   * changes a connection verdict.
   */
  readonly readStartupReadiness?: () => Promise<StartupReadinessLadder | null>;
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
  const { protocolVersion, productVersion, instanceId, startedAt, environmentId } =
    daemon.descriptor;
  return {
    protocolVersion,
    productVersion,
    instanceId,
    startedAt,
    ...(environmentId !== undefined ? { environmentId } : {}),
  };
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
  readonly #onHostStateChanged: ((daemon: DesktopDaemonHostState) => void) | undefined;
  readonly #environmentReconciler: KnownEnvironmentReconciler | undefined;
  readonly #childOutputTail: (() => DaemonChildOutputTail | null) | undefined;
  readonly #readStartupReadiness: (() => Promise<StartupReadinessLadder | null>) | undefined;
  readonly #subscriptions = new Map<number, CoordinatorSubscription>();
  /** The last ladder read while disconnected; cleared the moment we connect. */
  #startupReadiness: StartupReadinessLadder | null = null;

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
    this.#onHostStateChanged = dependencies.onHostStateChanged;
    this.#environmentReconciler = dependencies.environmentReconciler;
    this.#childOutputTail = dependencies.childOutputTail;
    this.#readStartupReadiness = dependencies.readStartupReadiness;
    if (this.#daemon.status === "connected") {
      try {
        this.#broker = this.#createBroker(this.#daemon);
        this.#reconcileEnvironment(this.#daemon);
      } catch {
        this.#daemon = BROKER_FAILED_STATE;
      }
    }
    if (this.#daemon.status !== "connected") {
      // The first bootstrap can arrive before any refresh runs, and a desktop
      // that starts disconnected is exactly when the user needs the diagnosis.
      // Nothing waits on this: it resolves into the cache or it does not.
      void this.#refreshStartupReadiness();
    }
    this.#publishHostState();
  }

  /**
   * Read the daemon's ladder into the cache. Never throws, never rejects, and
   * is only meaningful while disconnected — a connected state is served by the
   * broker, which already sees everything the ladder would report.
   */
  async #refreshStartupReadiness(): Promise<void> {
    if (!this.#readStartupReadiness) return;
    try {
      const ladder = await this.#readStartupReadiness();
      this.#startupReadiness = ladder ?? null;
    } catch {
      this.#startupReadiness = null;
    }
  }

  /** Learn the stable environment id behind a verified connect; best-effort. */
  #reconcileEnvironment(daemon: ConnectedDaemonState): void {
    const environmentId = daemon.descriptor.environmentId;
    if (environmentId === undefined) return;
    try {
      this.#environmentReconciler?.reconcileLocalCanonical(environmentId);
    } catch {
      // The catalog is bookkeeping; it can never affect connection authority.
    }
  }

  state(): DesktopDaemonCapabilityState {
    if (this.#daemon.status === "connected") return rendererDaemonState(this.#daemon);
    let childOutput: DaemonChildOutputTail | null = null;
    try {
      childOutput = this.#childOutputTail?.() ?? null;
    } catch {
      // Diagnostics are never allowed to break connection reporting.
    }
    return rendererDaemonState(this.#daemon, childOutput, this.#startupReadiness);
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

  async mutateAppWindow(request: AppWindowMutationRequest): Promise<AppWindowMutationResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) throw new Error("daemon mutation authority is unavailable");
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.mutateAppWindow(request);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      throw new Error("daemon mutation authority changed during the request");
    }
    return result;
  }

  async openWorkspace(request: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) throw new Error("daemon mutation authority is unavailable");
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.openWorkspace(request);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      throw new Error("daemon mutation authority changed during the request");
    }
    return result;
  }

  async promoteWorkspace(
    request: WorkspacePromoteMutationRequest,
  ): Promise<WorkspacePromoteMutationResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) throw new Error("daemon mutation authority is unavailable");
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.promoteWorkspace(request);
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

  async issuePaneStream(
    request: PaneStreamIssueMutationRequest,
    rendererOrigin: string,
  ): Promise<PaneStreamIssueResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) {
      return { status: "error", error: paneStreamIssueError("daemon-unavailable") };
    }
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.issuePaneStream(request, rendererOrigin);
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      return {
        status: "error",
        error: paneStreamIssueError(
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

  async fetchFleetCatalog(): Promise<DesktopDaemonFetchFleetCatalogResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchFleetCatalog();
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
    resourceVersion?: DesktopDaemonFetchApplicationShellRequest["resourceVersion"],
  ): Promise<DesktopDaemonFetchApplicationShellResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchApplicationShell(workspaceName, resourceVersion);
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

  async fetchWorkspaceFiles(
    request: DesktopDaemonFetchWorkspaceFilesRequest,
  ): Promise<DesktopDaemonFetchWorkspaceFilesResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchWorkspaceFiles(request);
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

  async fetchWorkspaceFilePreview(
    request: DesktopDaemonFetchWorkspaceFilePreviewRequest,
  ): Promise<DesktopDaemonFetchWorkspaceFilePreviewResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchWorkspaceFilePreview(request);
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

  async fetchWorkspaceChanges(
    request: DesktopDaemonFetchWorkspaceChangesRequest,
  ): Promise<DesktopDaemonFetchWorkspaceChangesResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchWorkspaceChanges(request);
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

  async fetchWorkspaceChangeDiff(
    request: DesktopDaemonFetchWorkspaceChangeDiffRequest,
  ): Promise<DesktopDaemonFetchWorkspaceChangeDiffResult> {
    const broker = this.#broker;
    if (!broker) return this.#disconnectedResult();
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.fetchWorkspaceChangeDiff(request);
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

    if (candidate.status === "connected") {
      // A usable daemon needs no ladder: the broker reads everything directly.
      this.#startupReadiness = null;
    } else {
      // Bounded, failure-tolerant, and read BEFORE the disconnected state is
      // composed so the state the renderer receives already carries the
      // daemon's own account of the stuck rung.
      await this.#refreshStartupReadiness();
      if (this.#disposed || expectedRendererGeneration !== this.#rendererGeneration) {
        return this.#superseded();
      }
    }

    const previousDaemon = this.#daemon;
    const previousIdentity =
      previousDaemon.status === "connected" ? identityOf(previousDaemon) : null;

    if (candidate.status === "connected") {
      const nextIdentity = identityOf(candidate);
      if (
        previousDaemon.status === "connected" &&
        previousIdentity &&
        sameIdentity(previousIdentity, nextIdentity) &&
        previousDaemon.descriptor.apiBaseUrl === candidate.descriptor.apiBaseUrl
      ) {
        // An explicit revalidation against an unchanged generation is a
        // transport wakeup: it interrupts a scheduled event-socket backoff and
        // restarts a transport stopped at its fatal ceiling.
        try {
          this.#broker?.retryTransport?.();
        } catch {
          // The wakeup is advisory; connection authority is unchanged.
        }
        return this.#parseResult({ outcome: "unchanged", daemon: this.state() });
      }

      let nextBroker: DaemonResourceAuthority;
      try {
        nextBroker = this.#createBroker(candidate);
      } catch {
        // The daemon answered, but no authority can be built over it. This is
        // the one disconnected outcome reached from a CONNECTED probe, and so
        // the case where the daemon's own ladder is most likely readable.
        await this.#refreshStartupReadiness();
        if (this.#disposed || expectedRendererGeneration !== this.#rendererGeneration) {
          return this.#superseded();
        }
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
      this.#reconcileEnvironment(candidate);
      this.#publishHostState();
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
      this.#publishHostState();
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
    this.#publishHostState();
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

  #publishHostState(): void {
    try {
      this.#onHostStateChanged?.(this.#daemon);
    } catch {
      // Presentation policy observation cannot change daemon authority state.
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

  async capabilities(): Promise<DesktopDaemonCapabilitiesResult> {
    const broker = this.#broker;
    if (!broker || this.#disposed) {
      return { status: "error", error: daemonCapabilityError("daemon-unavailable") };
    }
    const rendererGeneration = this.#rendererGeneration;
    const result = await broker.capabilities();
    if (
      this.#broker !== broker ||
      rendererGeneration !== this.#rendererGeneration ||
      this.#disposed
    ) {
      return { status: "error", error: daemonCapabilityError("disposed") };
    }
    return result;
  }
}
