import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  getCanonicalDaemonInfoPath,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";

type Connection = Awaited<ReturnType<typeof openSshDaemonTransport>>;
type Listener = (generation: string | null) => void;
export interface ApplicationDaemonEndpoint {
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

/** One selected machine per TUI process. Remote loss can never select the local machine. */
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
  let controller: AbortController | null = null;
  let stopMonitor: (() => void) | null = null;
  let removeParentAbort: (() => void) | null = null;
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
  const retire = () => {
    stopMonitor?.();
    stopMonitor = null;
    const previous = connection;
    connection = null;
    descriptor = null;
    remote = null;
    state = "disconnected";
    epoch++;
    notify(null);
    previous?.dispose();
  };
  const dispose = () => {
    if (kind === "ssh" && controller === null && connection === null && state === "disconnected")
      return;
    controller?.abort();
    controller = null;
    removeParentAbort?.();
    removeParentAbort = null;
    if (kind === "ssh") retire();
  };
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  const install = (next: Connection, owner: AbortController, alias: string) => {
    if (owner.signal.aborted || controller !== owner) {
      next.dispose();
      return;
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
    notify(descriptor.instanceId);
    const lost = async () => {
      if (owner.signal.aborted || controller !== owner || connection !== next) return;
      retire();
      let attempts = 0;
      while (!owner.signal.aborted && controller === owner) {
        await pause(
          dependencies.retryDelayMs ?? Math.min(250 * 2 ** Math.min(attempts, 3), 2_000),
          owner.signal,
        );
        if (owner.signal.aborted || controller !== owner) return;
        state = "connecting";
        try {
          const reopened = await dependencies.connect({ alias, signal: owner.signal });
          install(reopened, owner, alias);
          return;
        } catch {
          state = "disconnected";
          attempts++;
        }
      }
    };
    void next.closed.then(lost);
    stopMonitor = monitorConnection(next, dependencies, () => void lost());
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
      });
    },
    async observe(listener: Listener): Promise<() => void> {
      if (kind === "local") return dependencies.observeLocal(listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async initialize(alias: string, parentSignal?: AbortSignal): Promise<void> {
      if (kind !== "local") throw new Error("Application machine authority is already selected");
      kind = "ssh";
      label = alias;
      state = "connecting";
      epoch++;
      const owner = new AbortController();
      controller = owner;
      const abort = () => dispose();
      parentSignal?.addEventListener("abort", abort, { once: true });
      removeParentAbort = () => parentSignal?.removeEventListener("abort", abort);
      if (parentSignal?.aborted) abort();
      try {
        if (owner.signal.aborted) throw new Error("SSH connection cancelled");
        const next = await dependencies.connect({ alias, signal: owner.signal });
        if (owner.signal.aborted || controller !== owner) {
          next.dispose();
          throw new Error("SSH connection cancelled");
        }
        install(next, owner, alias);
      } catch (error) {
        dispose();
        throw error;
      }
    },
    dispose,
  };
}
