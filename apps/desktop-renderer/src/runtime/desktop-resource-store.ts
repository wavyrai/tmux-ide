import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  createApplicationShellSession,
  type ApplicationShellEventHandlers,
  type ApplicationShellSession,
} from "@tmux-ide/daemon-client/application-shell-session";
import type {
  GenerationBoundClock,
  GenerationBoundRetryPolicy,
  GenerationBoundStoreMetrics,
} from "@tmux-ide/daemon-client/generation-bound-store";

import type { DesktopApplicationShellResourceState } from "./connection-state.ts";
import type { DesktopDaemonTransport } from "./daemon-transport.ts";

/** Desktop naming retained for source compatibility; policy is shared. */
export type DesktopResourceClock = GenerationBoundClock;
export type DesktopReconnectPolicy = GenerationBoundRetryPolicy;

export interface DesktopApplicationShellStoreOptions {
  readonly target: unknown;
  readonly transport: DesktopDaemonTransport;
  readonly clock?: DesktopResourceClock;
  readonly random?: () => number;
  readonly reconnect?: Partial<DesktopReconnectPolicy>;
  readonly onOperationAcknowledged?: ApplicationShellEventHandlers["onOperationAcknowledged"];
  readonly onInteractionReceipt?: ApplicationShellEventHandlers["onInteractionReceipt"];
}

export type DesktopResourceStateListener = (state: DesktopApplicationShellResourceState) => void;

export interface DesktopApplicationShellResourceStore {
  getState(): DesktopApplicationShellResourceState;
  subscribe(listener: DesktopResourceStateListener): () => void;
  setTarget(target: unknown): void;
  refresh(): void;
  getMetrics(): GenerationBoundStoreMetrics;
  dispose(): void;
}

export interface SolidDesktopApplicationShellResourceStore {
  readonly state: Accessor<DesktopApplicationShellResourceState>;
  setTarget(target: unknown): void;
  refresh(): void;
  getMetrics(): GenerationBoundStoreMetrics;
  dispose(): void;
}

/** GUI adapter over the renderer-neutral daemon-client session. */
export function createDesktopApplicationShellResourceStore(
  options: DesktopApplicationShellStoreOptions,
): DesktopApplicationShellResourceStore {
  const session: ApplicationShellSession = createApplicationShellSession(options);
  return session;
}

/** Solid lifecycle adapter; the session itself has no renderer dependency. */
export function createSolidDesktopApplicationShellResourceStore(
  options: DesktopApplicationShellStoreOptions,
): SolidDesktopApplicationShellResourceStore {
  const store = createDesktopApplicationShellResourceStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    setTarget: (target) => store.setTarget(target),
    refresh: () => store.refresh(),
    getMetrics: () => store.getMetrics(),
    dispose,
  };
}
