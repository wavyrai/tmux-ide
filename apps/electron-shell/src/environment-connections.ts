import { createFleetDialScheduler } from "@tmux-ide/daemon-client/fleet-dial-scheduler";
import type { FleetConnectionFailureCode } from "@tmux-ide/daemon-client/fleet-connection-status";
import type { DesktopDaemonCapabilityState, DesktopDaemonHostState } from "@tmux-ide/contracts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  SshConnectionError,
} from "../../../packages/daemon/src/lib/ssh-daemon-transport.ts";
import {
  DaemonConnectionCoordinator,
  type DaemonConnectionAuthority,
} from "./daemon-connection-coordinator.ts";
import { DaemonResourceBroker } from "./daemon-resource-broker.ts";
import type { KnownEnvironment, KnownEnvironmentCatalog } from "./environment-catalog.ts";

type SshTransport = Awaited<ReturnType<typeof openSshDaemonTransport>>;
type ConnectedDaemon = Extract<DesktopDaemonHostState, { status: "connected" }>;

export interface EnvironmentConnectionSnapshot {
  readonly connectionId: string;
  readonly label: string;
  readonly kind: KnownEnvironment["endpoint"]["kind"];
  readonly phase: "connecting" | "ready" | "disconnected" | "needs-attention";
  readonly daemon: DesktopDaemonCapabilityState | null;
  readonly failure: FleetConnectionFailureCode | null;
}

/** A main-process capture, never serialized into a renderer capability. */
export interface EnvironmentAuthorityCapture {
  readonly connectionId: string;
  readonly authority: DaemonConnectionAuthority;
  /** Private verified SSH forwarding origin; never serialized to the renderer. */
  readonly streamOrigin?: string;
  /** Recheck after every asynchronous request and before delivering events. */
  isCurrent(): boolean;
}

interface RemoteConnection {
  readonly entry: KnownEnvironment;
  readonly controller: AbortController;
  phase: EnvironmentConnectionSnapshot["phase"];
  failure: FleetConnectionFailureCode | null;
  authority: DaemonConnectionAuthority | null;
  transport: SshTransport | null;
  flight: Promise<EnvironmentAuthorityCapture | null> | null;
}

export interface EnvironmentConnectionDependencies {
  readonly catalog: KnownEnvironmentCatalog;
  /** Borrowed: the existing app supervisor remains its lifecycle owner. */
  readonly localAuthority: DaemonConnectionAuthority;
  readonly openTransport?: typeof openSshDaemonTransport;
  readonly createRemoteAuthority?: (transport: SshTransport) => DaemonConnectionAuthority;
  readonly dialLimit?: number;
  readonly timeoutMs?: number;
}

const unavailable: DesktopDaemonHostState = {
  status: "unavailable",
  code: "identity-unreachable",
  reason: "Remote daemon identity could not be verified.",
};

function identityGuard(authority: DaemonConnectionAuthority): () => boolean {
  const captured = authority.state();
  return () => {
    const current = authority.state();
    if (captured.status !== "connected" || current.status !== "connected") return false;
    const a = captured.identity;
    const b = current.identity;
    return (
      a.instanceId === b.instanceId &&
      a.environmentId === b.environmentId &&
      a.protocolVersion === b.protocolVersion &&
      a.productVersion === b.productVersion &&
      a.startedAt === b.startedAt
    );
  };
}

/** Uses only the authenticated SSH handshake; never reads local daemon.json. */
export function createSshEnvironmentAuthority(transport: SshTransport): DaemonConnectionAuthority {
  const { daemon, baseUrl } = transport;
  const state: ConnectedDaemon = {
    status: "connected",
    descriptor: {
      apiBaseUrl: baseUrl,
      protocolVersion: daemon.protocolVersion,
      productVersion: daemon.productVersion,
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
      ...(daemon.environmentId === undefined ? {} : { environmentId: daemon.environmentId }),
    },
  };
  let closed = false;
  void transport.closed.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    },
  );
  return new DaemonConnectionCoordinator({
    initialDaemon: state,
    preflight: {
      probe: async (signal) => {
        if (closed || signal.aborted) return unavailable;
        const verified = await probeSshDaemonIdentity(baseUrl, daemon, signal);
        return verified && !closed && !signal.aborted ? state : unavailable;
      },
    },
    createBroker: (verified) => {
      const a = verified.descriptor;
      const b = state.descriptor;
      if (
        closed ||
        a.apiBaseUrl !== b.apiBaseUrl ||
        a.instanceId !== b.instanceId ||
        a.environmentId !== b.environmentId ||
        a.protocolVersion !== b.protocolVersion ||
        a.productVersion !== b.productVersion ||
        a.startedAt !== b.startedAt
      )
        throw new Error("Remote daemon authority changed.");
      return new DaemonResourceBroker({ daemon: verified, ownerToken: daemon.authToken });
    },
  });
}

/**
 * Independent, bounded connection lifetimes. Catalog IDs route requests; daemon
 * IDs describe what was verified. Neither display labels nor matching daemon IDs
 * can redirect a capture to another transport. IPC adapters must use captures.
 */
export class EnvironmentConnections {
  readonly #deps: EnvironmentConnectionDependencies;
  readonly #scheduler: ReturnType<typeof createFleetDialScheduler>;
  readonly #remotes = new Map<string, RemoteConnection>();
  readonly #listeners = new Set<() => void>();
  #disposed = false;

  constructor(deps: EnvironmentConnectionDependencies) {
    if (
      deps.timeoutMs !== undefined &&
      (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 120_000)
    )
      throw new RangeError("Invalid environment connection timeout.");
    this.#deps = deps;
    this.#scheduler = createFleetDialScheduler(deps.dialLimit ?? 4);
  }

  snapshots(): readonly EnvironmentConnectionSnapshot[] {
    return this.#deps.catalog.entries().map((entry) => {
      const remote = this.#remotes.get(entry.id);
      const daemon = this.#disposed
        ? null
        : entry.endpoint.kind === "local-canonical"
          ? this.#deps.localAuthority.state()
          : (remote?.authority?.state() ?? null);
      return {
        connectionId: entry.id,
        label: entry.label,
        kind: entry.endpoint.kind,
        daemon,
        phase: this.#disposed
          ? "disconnected"
          : daemon?.status === "connected"
            ? "ready"
            : remote?.phase === "ready"
              ? "disconnected"
              : (remote?.phase ?? "disconnected"),
        failure: remote?.failure ?? null,
      };
    });
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  capture(connectionId: string): EnvironmentAuthorityCapture | null {
    if (this.#disposed) return null;
    const entry = this.#deps.catalog.entry(connectionId);
    if (!entry) return null;
    if (entry.endpoint.kind === "local-canonical") {
      const authority = this.#deps.localAuthority;
      const identityIsCurrent = identityGuard(authority);
      return { connectionId, authority, isCurrent: () => !this.#disposed && identityIsCurrent() };
    }
    const remote = this.#remotes.get(connectionId);
    const authority = remote?.authority;
    if (!remote || !authority || remote.controller.signal.aborted) return null;
    const identityIsCurrent = identityGuard(authority);
    const streamUrl = new URL(remote.transport!.baseUrl);
    streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
    return {
      streamOrigin: streamUrl.origin,
      connectionId,
      authority,
      isCurrent: () =>
        !this.#disposed &&
        this.#remotes.get(connectionId) === remote &&
        remote.authority === authority &&
        !remote.controller.signal.aborted &&
        identityIsCurrent(),
    };
  }

  connect(connectionId: string): Promise<EnvironmentAuthorityCapture | null> {
    if (this.#disposed) return Promise.reject(new Error("Environment connections are disposed."));
    const entry = this.#deps.catalog.entry(connectionId);
    if (!entry) return Promise.reject(new Error("Unknown environment connection."));
    if (entry.endpoint.kind === "local-canonical")
      return this.#deps.localAuthority.refreshConnection().then(() => {
        this.#publish();
        return this.capture(connectionId);
      });
    const previous = this.#remotes.get(connectionId);
    if (previous?.flight) return previous.flight;
    if (previous?.authority?.state().status === "connected")
      return Promise.resolve(this.capture(connectionId));
    if (previous) this.#retire(previous);
    const remote: RemoteConnection = {
      entry,
      controller: new AbortController(),
      phase: "connecting",
      failure: null,
      authority: null,
      transport: null,
      flight: null,
    };
    this.#remotes.set(connectionId, remote);
    remote.flight = this.#dial(remote, entry.endpoint.alias);
    this.#publish();
    return remote.flight;
  }

  disconnect(connectionId: string): void {
    const remote = this.#remotes.get(connectionId);
    if (!remote) return;
    this.#remotes.delete(connectionId);
    this.#retire(remote);
    this.#publish();
  }

  releaseRenderer(): void {
    for (const authority of [
      this.#deps.localAuthority,
      ...[...this.#remotes.values()].map((remote) => remote.authority),
    ]) {
      try {
        authority?.releaseRenderer();
      } catch {
        /* Release every independent authority. */
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remote of this.#remotes.values()) this.#retire(remote);
    this.#remotes.clear();
    this.#listeners.clear();
    // The caller still owns the local supervisor and canonical daemon.
  }

  async #dial(
    remote: RemoteConnection,
    alias: string,
  ): Promise<EnvironmentAuthorityCapture | null> {
    const timeout = setTimeout(() => remote.controller.abort(), this.#deps.timeoutMs ?? 15_000);
    timeout.unref();
    try {
      const transport = await this.#scheduler.run(
        remote.entry.id,
        remote.controller.signal,
        () =>
          (this.#deps.openTransport ?? openSshDaemonTransport)({
            alias,
            signal: remote.controller.signal,
          }),
        (late) => late.dispose(),
      );
      if (
        this.#disposed ||
        this.#remotes.get(remote.entry.id) !== remote ||
        remote.controller.signal.aborted
      ) {
        transport.dispose();
        return null;
      }
      remote.transport = transport;
      remote.authority = (this.#deps.createRemoteAuthority ?? createSshEnvironmentAuthority)(
        transport,
      );
      if (remote.authority.state().status !== "connected")
        throw new Error("Remote authority unavailable.");
      remote.phase = "ready";
      if (transport.daemon.environmentId)
        this.#deps.catalog.reconcile(remote.entry.id, transport.daemon.environmentId);
      void transport.closed.then(
        () => this.#closed(remote),
        () => this.#closed(remote),
      );
      return this.capture(remote.entry.id);
    } catch (error) {
      if (this.#disposed || this.#remotes.get(remote.entry.id) !== remote) return null;
      this.#retire(remote);
      remote.failure = error instanceof SshConnectionError ? error.code : "unavailable";
      remote.phase = "needs-attention";
      return null;
    } finally {
      clearTimeout(timeout);
      remote.flight = null;
      if (!this.#disposed && this.#remotes.get(remote.entry.id) === remote) this.#publish();
    }
  }

  #closed(remote: RemoteConnection): void {
    if (
      this.#disposed ||
      this.#remotes.get(remote.entry.id) !== remote ||
      remote.controller.signal.aborted
    )
      return;
    this.#retire(remote);
    remote.phase = "disconnected";
    remote.failure = "unavailable";
    this.#publish();
  }

  #retire(remote: RemoteConnection): void {
    remote.controller.abort();
    const authority = remote.authority;
    const transport = remote.transport;
    remote.authority = null;
    remote.transport = null;
    try {
      authority?.dispose();
    } catch {
      /* Logical revocation precedes cleanup. */
    }
    try {
      transport?.dispose();
    } catch {
      /* A failed cleanup cannot retain authority. */
    }
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Independent observers cannot break cleanup. */
      }
    }
  }
}
