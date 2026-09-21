import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import type {
  EnvironmentConnections,
  EnvironmentAuthorityCapture,
} from "./environment-connections.ts";
import { registerHostIpc, type HostIpcDependencies, type RegisteredHostIpc } from "./host-ipc.ts";

export type EnvironmentStreamHooks = Pick<
  HostIpcDependencies,
  "relayPaneStream" | "relayTerminalAttachment" | "rendererDidRelease"
>;

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
  readonly #streamHooks:
    | ((capture: EnvironmentAuthorityCapture, scope: string) => EnvironmentStreamHooks)
    | undefined;
  readonly #onRetireScope: ((scope: string) => void) | undefined;
  #window: BrowserWindow | null = null;
  #disposed = false;

  constructor(input: {
    connections: Pick<EnvironmentConnections, "connect" | "subscribe" | "snapshots">;
    host: Omit<HostIpcDependencies, "daemonResources" | "channelScope">;
    streamHooks?: (capture: EnvironmentAuthorityCapture, scope: string) => EnvironmentStreamHooks;
    onRetireScope?: (scope: string) => void;
  }) {
    this.#connections = input.connections;
    this.#host = input.host;
    this.#streamHooks = input.streamHooks;
    this.#onRetireScope = input.onRetireScope;
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
        this.#retire(binding);
      }
    }
  }

  #retire(binding: Binding): void {
    try {
      binding.registration.dispose();
    } finally {
      this.#onRetireScope?.(binding.scope);
    }
  }

  async open(connectionId: string): Promise<{ connectionId: string; scope: string }> {
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
      return { connectionId, scope: previous.scope };
    if (previous) {
      this.#bindings.delete(connectionId);
      this.#retire(previous);
    }
    const scope = randomUUID();
    const hooks = this.#streamHooks?.(capture, scope);
    const currentContext = (
      context: Parameters<NonNullable<HostIpcDependencies["relayPaneStream"]>>[1],
    ) => ({
      ...context,
      isCurrent: () =>
        !this.#disposed &&
        this.#bindings.get(connectionId)?.scope === scope &&
        capture.isCurrent() &&
        context.isCurrent(),
    });
    const registration = registerHostIpc({
      ...this.#host,
      ...hooks,
      ...(hooks?.relayPaneStream
        ? {
            relayPaneStream: (descriptor, context) => {
              const guarded = currentContext(context);
              if (!guarded.isCurrent()) throw new Error("Environment stream authority retired.");
              const result = hooks.relayPaneStream!(descriptor, guarded);
              if (!guarded.isCurrent()) throw new Error("Environment stream authority retired.");
              return result;
            },
          }
        : {}),
      ...(hooks?.relayTerminalAttachment
        ? {
            relayTerminalAttachment: (descriptor, context) => {
              const guarded = currentContext(context);
              if (!guarded.isCurrent()) throw new Error("Environment stream authority retired.");
              const result = hooks.relayTerminalAttachment!(descriptor, guarded);
              if (!guarded.isCurrent()) throw new Error("Environment stream authority retired.");
              return result;
            },
          }
        : {}),
      daemonResources: capture.authority,
      channelScope: scope,
    });
    const binding: Binding = { scope, capture, identity: { ...state.identity }, registration };
    const window = this.#window ?? this.#host.getWindow();
    try {
      if (window && !window.isDestroyed()) registration.bindWindow(window);
    } catch (error) {
      this.#retire(binding);
      throw error;
    }
    if (this.#disposed || !this.#isCurrent(binding)) {
      this.#retire(binding);
      throw new Error("Environment authority was retired during IPC binding.");
    }
    this.#bindings.set(connectionId, binding);
    return { connectionId, scope };
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
    for (const binding of this.#bindings.values()) this.#retire(binding);
    this.#bindings.clear();
    this.#window = null;
  }
}
