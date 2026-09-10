import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import type {
  EnvironmentConnections,
  EnvironmentAuthorityCapture,
} from "./environment-connections.ts";
import { registerHostIpc, type HostIpcDependencies, type RegisteredHostIpc } from "./host-ipc.ts";

interface Binding {
  readonly scope: string;
  readonly capture: EnvironmentAuthorityCapture;
  readonly identity: DaemonInstanceIdentity;
  readonly registration: RegisteredHostIpc;
}
function identityKey(identity: DaemonInstanceIdentity): string {
  return JSON.stringify([
    identity.protocolVersion,
    identity.productVersion,
    identity.instanceId,
    identity.startedAt,
    identity.environmentId ?? null,
  ]);
}

/**
 * Main-process binding owner only. The outer IPC handler MUST authenticate the
 * sender/frame and recheck its renderer generation after awaiting open(). Scope
 * strings are opaque authority-generation handles, not stable connection IDs.
 * This borrows the connection manager and never disposes its daemon lifetimes.
 */
export class EnvironmentHostIpc {
  readonly #connections: Pick<EnvironmentConnections, "connect" | "subscribe" | "snapshots">;
  readonly #host: Omit<HostIpcDependencies, "daemonResources" | "channelScope">;
  readonly #bindings = new Map<string, Binding>();
  readonly #unsubscribe: () => void;
  #window: BrowserWindow | null = null;
  #disposed = false;

  constructor(input: {
    connections: Pick<EnvironmentConnections, "connect" | "subscribe" | "snapshots">;
    host: Omit<HostIpcDependencies, "daemonResources" | "channelScope">;
  }) {
    this.#connections = input.connections;
    this.#host = input.host;
    this.#unsubscribe = input.connections.subscribe(() => this.#retireStale());
  }

  #isCurrent(binding: Binding): boolean {
    const state = binding.capture.authority.state();
    return (
      binding.capture.isCurrent() &&
      state.status === "connected" &&
      identityKey(state.identity) === identityKey(binding.identity)
    );
  }

  #retireStale(): void {
    for (const [id, binding] of this.#bindings) {
      if (!this.#isCurrent(binding)) {
        this.#bindings.delete(id);
        binding.registration.dispose();
      }
    }
  }

  async open(connectionId: string): Promise<{ scope: string }> {
    if (this.#disposed) throw new Error("Environment IPC bindings are disposed.");
    const entry = this.#connections.snapshots().find((item) => item.connectionId === connectionId);
    if (!entry || entry.kind !== "ssh")
      throw new Error(
        "Scoped environment IPC requires a known SSH connection; use the local host alias for local access.",
      );
    const capture = await this.#connections.connect(connectionId);
    if (this.#disposed) throw new Error("Environment IPC bindings are disposed.");
    this.#retireStale();
    const state = capture?.authority.state();
    if (!capture || !capture.isCurrent() || state?.status !== "connected")
      throw new Error("Environment authority was retired before IPC binding.");
    const previous = this.#bindings.get(connectionId);
    if (previous && previous.capture.authority === capture.authority && this.#isCurrent(previous))
      return { scope: previous.scope };
    if (previous) {
      this.#bindings.delete(connectionId);
      previous.registration.dispose();
    }
    const scope = randomUUID();
    const registration = registerHostIpc({
      ...this.#host,
      daemonResources: capture.authority,
      channelScope: scope,
    });
    const binding: Binding = { scope, capture, identity: { ...state.identity }, registration };
    const window = this.#window ?? this.#host.getWindow();
    try {
      if (window && !window.isDestroyed()) registration.bindWindow(window);
    } catch (error) {
      registration.dispose();
      throw error;
    }
    if (this.#disposed || !this.#isCurrent(binding)) {
      registration.dispose();
      throw new Error("Environment authority was retired during IPC binding.");
    }
    this.#bindings.set(connectionId, binding);
    return { scope };
  }

  bindWindow(window: BrowserWindow): void {
    if (this.#disposed) return;
    this.#window = window;
    this.#retireStale();
    for (const binding of this.#bindings.values()) binding.registration.bindWindow(window);
  }

  releaseRenderer(): void {
    for (const binding of this.#bindings.values()) binding.registration.releaseRenderer();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    for (const binding of this.#bindings.values()) binding.registration.dispose();
    this.#bindings.clear();
    this.#window = null;
  }
}
