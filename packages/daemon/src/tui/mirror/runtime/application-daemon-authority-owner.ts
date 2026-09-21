import type { FleetConnectionStatus } from "@tmux-ide/daemon-client/fleet-connection-status";
import {
  createRuntimeConnectionSupervisor,
  type RuntimeConnectionSupervisor,
} from "@tmux-ide/daemon-client/connection-supervisor";
import {
  fleetReconnectBackoff,
  type FleetDialScheduler,
} from "@tmux-ide/daemon-client/fleet-dial-scheduler";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  getCanonicalDaemonInfoPath,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";
import {
  SshConnectionError,
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";

type Connection = Awaited<ReturnType<typeof openSshDaemonTransport>>;
type Listener = (generation: string | null) => void;
export interface ApplicationDaemonEndpoint {
  readonly diagnostic?: FleetConnectionStatus;
  readonly kind: "local" | "ssh";
  readonly label: string | null;
  readonly remote: Readonly<CanonicalDaemonInfo> | null;
  readonly localBaseUrl: string | null;
  readonly epoch: number;
  readonly state: "ready" | "connecting" | "disconnected";
}
export interface ApplicationDaemonAuthorityDependencies {
  readLocal(): CanonicalDaemonInfo | null;
  isLocalAlive(info: CanonicalDaemonInfo): Promise<boolean>;
  observeLocal(listener: Listener): Promise<() => void>;
  connect: typeof openSshDaemonTransport;
  /** Bounded backoff override for deterministic tests. */
  retryDelayMs?: number;
  verify?: typeof probeSshDaemonIdentity;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
}
const defaults: ApplicationDaemonAuthorityDependencies = {
  readLocal: readCanonicalDaemonInfo,
  isLocalAlive: isCanonicalDaemonAlive,
  async observeLocal(listener) {
    const path = getCanonicalDaemonInfoPath();
    let stopped = false;
    let queued = false;
    const watcher = watch(dirname(path), (_event, file) => {
      if (stopped || queued || (file !== null && file.toString() !== basename(path))) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const generation = readCanonicalDaemonInfo()?.instanceId;
        if (!stopped && generation) listener(generation);
      });
    });
    watcher.on("error", () => watcher.close());
    return () => {
      stopped = true;
      watcher.close();
    };
  },
  connect: openSshDaemonTransport,
  verify: probeSshDaemonIdentity,
};

function monitorConnection(
  connection: Connection,
  dependencies: ApplicationDaemonAuthorityDependencies,
  onLost: () => void,
): () => void {
  const verify = dependencies.verify;
  if (!verify) return () => {};
  let stopped = false;
  let failures = 0;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = async () => {
    if (stopped) return;
    const attempt = new AbortController();
    active = attempt;
    const deadline = setTimeout(() => attempt.abort(), dependencies.probeTimeoutMs ?? 1500);
    let valid = false;
    try {
      // fetch cancellation bounds response reading as well as establishing the socket.
      valid = await verify(connection.baseUrl, connection.daemon, attempt.signal);
    } catch {
      /* A transient network failure gets one further probe before retirement. */
    } finally {
      clearTimeout(deadline);
      active = null;
    }
    if (stopped) return;
    failures = valid && !attempt.signal.aborted ? 0 : failures + 1;
    if (failures >= 2) {
      stopped = true;
      onLost();
      return;
    }
    timer = setTimeout(() => void check(), dependencies.probeIntervalMs ?? 2000);
  };
  timer = setTimeout(() => void check(), dependencies.probeIntervalMs ?? 2000);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    active?.abort();
  };
}

/** Owns one machine's authority and its single initial/reconnect lifecycle. */
export function createApplicationDaemonAuthority(
  dependencies: ApplicationDaemonAuthorityDependencies = defaults,
) {
  let kind: "local" | "ssh" = "local";
  let label: string | null = null;
  let state: ApplicationDaemonEndpoint["state"] = "ready";
  let epoch = 0;
  let connection: Connection | null = null;
  let descriptor: CanonicalDaemonInfo | null = null;
  let remote: Readonly<CanonicalDaemonInfo> | null = null;
  let supervisor: RuntimeConnectionSupervisor<Connection> | null = null;
  let stopped = false;
  let paused = false;
  let controlRevision = 0;
  let diagnostic: FleetConnectionStatus = {
    phase: "ready",
    attempt: 0,
    nextRetryAt: null,
    failure: null,
  };
  const statusListeners = new Set<() => void>();
  const updateStatus = (next: FleetConnectionStatus) => {
    diagnostic = Object.freeze(next);
    for (const listener of statusListeners) {
      try {
        listener();
      } catch {
        /* UI observers do not own transport lifetime. */
      }
    }
  };
  let removeParentAbort: (() => void) | null = null;
  let rejectInitial: ((error: unknown) => void) | null = null;
  const listeners = new Set<Listener>();
  const notify = (generation: string | null) => {
    for (const listener of listeners) {
      try {
        listener(generation);
      } catch {
        /* Observers do not own transport lifetime. */
      }
    }
  };
  let releaseConnection: (() => void) | null = null;
  const retire = () => {
    const release = releaseConnection;
    releaseConnection = null;
    connection = null;
    descriptor = null;
    remote = null;
    state = "disconnected";
    epoch++;
    notify(null);
    release?.();
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    controlRevision++;
    removeParentAbort?.();
    removeParentAbort = null;
    rejectInitial?.(new Error("SSH connection cancelled"));
    rejectInitial = null;
    if (kind === "ssh") retire();
    void supervisor?.stop();
    updateStatus({ phase: "disconnected", attempt: 0, nextRetryAt: null, failure: null });
    statusListeners.clear();
  };
  return {
    read(): CanonicalDaemonInfo | null {
      return kind === "local" ? dependencies.readLocal() : descriptor;
    },
    async isAlive(info: CanonicalDaemonInfo): Promise<boolean> {
      if (kind === "local") return dependencies.isLocalAlive(info);
      return (
        state === "ready" &&
        descriptor !== null &&
        info.instanceId === descriptor.instanceId &&
        info.startedAt === descriptor.startedAt &&
        info.port === descriptor.port &&
        info.bindHostname === descriptor.bindHostname
      );
    },
    endpoint(): ApplicationDaemonEndpoint {
      return Object.freeze({
        kind,
        label,
        remote,
        localBaseUrl: connection?.baseUrl ?? null,
        epoch,
        state,
        diagnostic,
      });
    },
    async observe(listener: Listener): Promise<() => void> {
      if (kind === "local") return dependencies.observeLocal(listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observeConnection(listener: () => void): () => void {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    disconnect(): void {
      if (kind !== "ssh" || stopped) return;
      paused = true;
      controlRevision++;
      rejectInitial?.(new Error("SSH connection cancelled"));
      rejectInitial = null;
      retire();
      void supervisor?.stop();
      updateStatus({ phase: "disconnected", attempt: 0, nextRetryAt: null, failure: null });
    },
    async retry(): Promise<void> {
      if (kind !== "ssh" || stopped || !supervisor) return;
      const revision = ++controlRevision;
      paused = true;
      retire();
      await supervisor.stop();
      if (stopped || revision !== controlRevision) return;
      paused = false;
      supervisor.start();
    },
    async initialize(
      alias: string,
      parentSignal?: AbortSignal,
      options: {
        scheduler?: FleetDialScheduler;
        expectedEnvironmentId?: string;
        retryDelayMs?: number;
      } = {},
    ): Promise<void> {
      if (kind !== "local" || stopped)
        throw new Error("Application machine authority is already selected");
      kind = "ssh";
      label = alias;
      state = "connecting";
      epoch++;
      const initial = new Promise<void>((resolve, reject) => {
        rejectInitial = reject;
        supervisor = createRuntimeConnectionSupervisor<Connection>({
          retryable: (error) => !(error instanceof SshConnectionError) || error.retryable,
          backoffMs: (attempt) => {
            const delay =
              dependencies.retryDelayMs ?? options.retryDelayMs ?? fleetReconnectBackoff(attempt);
            if (!stopped && !paused)
              updateStatus({
                ...diagnostic,
                phase: "reconnecting",
                attempt,
                nextRetryAt: Date.now() + delay,
              });
            return delay;
          },
          connect: async ({ signal, attempt }) => {
            if (stopped || paused || signal.aborted) throw new Error("SSH connection cancelled");
            state = "connecting";
            updateStatus({ phase: "connecting", attempt, nextRetryAt: null, failure: null });
            let next: Connection;
            try {
              const connect = () => dependencies.connect({ alias, signal });
              next = options.scheduler
                ? await options.scheduler.run(alias, signal, connect, (late) => late.dispose())
                : await connect();
              if (
                options.expectedEnvironmentId &&
                next.daemon.environmentId !== options.expectedEnvironmentId
              ) {
                next.dispose();
                throw new SshConnectionError(
                  "Imported environment identity does not match the authenticated daemon",
                  "identity-mismatch",
                );
              }
            } catch (error) {
              if (!stopped && !paused) {
                state = "disconnected";
                updateStatus({
                  phase:
                    error instanceof SshConnectionError && !error.retryable
                      ? "needs-attention"
                      : "reconnecting",
                  attempt,
                  nextRetryAt: null,
                  failure: error instanceof SshConnectionError ? error.code : "unavailable",
                });
              }
              rejectInitial?.(error);
              rejectInitial = null;
              throw error;
            }
            if (stopped || paused || signal.aborted) {
              next.dispose();
              throw new Error("SSH connection cancelled");
            }
            const endpoint = new URL(next.baseUrl);
            remote = Object.freeze({ ...next.daemon });
            descriptor = Object.freeze({
              ...next.daemon,
              bindHostname: "127.0.0.1",
              port: Number(endpoint.port),
            });
            connection = next;
            state = "ready";
            epoch++;
            let close!: () => void;
            const closed = new Promise<void>((done) => {
              close = done;
            });
            let released = false;
            let stopMonitor: (() => void) | null = null;
            const release = () => {
              if (released) return;
              released = true;
              stopMonitor?.();
              next.dispose();
              close();
            };
            const lost = () => {
              if (!released && connection === next) retire();
            };
            releaseConnection = release;
            void next.closed.then(lost, lost);
            stopMonitor = monitorConnection(next, dependencies, lost);
            notify(descriptor.instanceId);
            if (!stopped && !paused)
              updateStatus({ phase: "ready", attempt: 0, nextRetryAt: null, failure: null });
            rejectInitial = null;
            resolve();
            return { value: next, closed, dispose: release };
          },
        });
      });
      const abort = () => dispose();
      parentSignal?.addEventListener("abort", abort, { once: true });
      removeParentAbort = () => parentSignal?.removeEventListener("abort", abort);
      if (parentSignal?.aborted) abort();
      if (!stopped) supervisor!.start();
      return initial;
    },
    dispose,
  };
}
