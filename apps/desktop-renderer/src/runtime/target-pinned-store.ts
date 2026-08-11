import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopApplicationShellTarget,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import {
  createPushResourceSession,
  type PushResourceSessionMetrics,
  type PushResourceSessionState,
} from "@tmux-ide/daemon-client/push-resource-session";
import {
  defaultGenerationBoundClock,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
} from "@tmux-ide/daemon-client/generation-bound-store";

import { daemonGenerationKey } from "./connection-state.ts";

/**
 * Thin renderer adapter over the daemon-client push resource session.
 *
 * Files, Preview, Changes and Diff supply only schema validation and host
 * fetches. Generation retirement, interest lifetime, subscription-before-read,
 * burst coalescing, aborts and stale retention live in daemon-client so DOM and
 * OpenTUI clients can share the exact policy.
 */

export type WorkspaceResourceTarget = DesktopApplicationShellTarget;
export type WorkspaceResourceClock = GenerationBoundClock;
export type TargetPinnedStoreMetrics = PushResourceSessionMetrics;
export const defaultWorkspaceResourceClock: WorkspaceResourceClock = defaultGenerationBoundClock;

export interface WorkspaceResourceSnapshot<TResource> {
  readonly resource: TResource;
  readonly updatedAt: number;
}

export type WorkspaceResourceSlot<TResource> =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly resource: TResource;
      readonly updatedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      readonly stale: WorkspaceResourceSnapshot<TResource> | null;
    };

export type WorkspaceResourceTargetValidation =
  | { readonly ok: true; readonly target: WorkspaceResourceTarget; readonly key: string }
  | { readonly ok: false; readonly reason: string };

export function validateWorkspaceResourceTarget(value: unknown): WorkspaceResourceTargetValidation {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "Workspace resource target is invalid." };
  if (!isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    return {
      ok: false,
      reason: `Daemon protocol ${parsed.data.daemon.protocolVersion} is not compatible with this renderer.`,
    };
  }
  return { ok: true, target: parsed.data, key: daemonGenerationKey(parsed.data) };
}

export function sameDaemonGeneration(
  expected: DaemonInstanceIdentity,
  actual: DaemonInstanceIdentity,
): boolean {
  return (
    actual.protocolVersion === expected.protocolVersion &&
    actual.productVersion === expected.productVersion &&
    actual.instanceId === expected.instanceId &&
    actual.startedAt === expected.startedAt
  );
}

export type TargetPinnedFetchResult<TResource> =
  | { readonly status: "ok"; readonly resource: TResource }
  | {
      readonly status: "failed";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    };

export interface TargetPinnedView<TResource> {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
  readonly slots: ReadonlyMap<string, WorkspaceResourceSlot<TResource>>;
  readonly targetError: { readonly reason: string } | null;
  readonly disposed: boolean;
}

export interface TargetPinnedAdapter<TResource, TState> {
  readonly host: Pick<HostCapabilities, "daemon">;
  fetch(
    target: WorkspaceResourceTarget,
    key: string,
    signal?: AbortSignal,
  ): Promise<TargetPinnedFetchResult<TResource>>;
  readonly eagerKey?: string;
  readonly singleSlot?: boolean;
  readonly invalidatesOn?: readonly DesktopDaemonEvent["type"][];
  /** Explicit daemon observer lifetime owned by this logical session. */
  readonly resourceInterest?: "workspace-files" | "workspace-changes" | "workspace-missions";
  project(view: TargetPinnedView<TResource>): TState;
}

export interface TargetPinnedStoreOptions {
  readonly clock?: WorkspaceResourceClock;
  readonly random?: () => number;
  readonly retry?: Partial<GenerationBoundRetryPolicy>;
  readonly queueMicrotask?: (callback: () => void) => void;
  readonly active?: boolean;
}

export interface TargetPinnedStore<TState> {
  getState(): TState;
  getMetrics(): TargetPinnedStoreMetrics;
  subscribe(listener: (state: TState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  load(key: string): void;
  drop(key: string): void;
  refresh(): void;
  dispose(): void;
}

interface Failure {
  readonly code: DesktopDaemonCapabilityErrorCode;
  readonly reason: string;
}

function transient(code: DesktopDaemonCapabilityErrorCode): boolean {
  return code === "request-timeout" || code === "request-failed" || code === "event-unavailable";
}

function projectView<TResource>(
  source: PushResourceSessionState<WorkspaceResourceTarget, string, TResource, Failure>,
): TargetPinnedView<TResource> {
  const slots = new Map<string, WorkspaceResourceSlot<TResource>>();
  for (const [key, slot] of source.slots) {
    if (slot.status !== "error") {
      slots.set(key, slot);
      continue;
    }
    slots.set(key, {
      status: "error",
      code: slot.failure.code,
      reason: slot.failure.reason,
      stale: slot.stale,
    });
  }
  return {
    generation: source.generation,
    target: source.target,
    slots,
    targetError: source.targetFailure ? { reason: source.targetFailure.reason } : null,
    disposed: source.disposed,
  };
}

export function createTargetPinnedStore<TResource, TState>(
  adapter: TargetPinnedAdapter<TResource, TState>,
  initialTarget: unknown,
  options: TargetPinnedStoreOptions = {},
): TargetPinnedStore<TState> {
  const invalidatesOn = new Set<DesktopDaemonEvent["type"]>(adapter.invalidatesOn ?? []);
  const session = createPushResourceSession<WorkspaceResourceTarget, string, TResource, Failure>(
    {
      validateTarget(value) {
        const validation = validateWorkspaceResourceTarget(value);
        return validation.ok
          ? validation
          : {
              ok: false,
              failure: { code: "invalid-request", reason: validation.reason },
            };
      },
      async fetch(target, key, signal) {
        const result = await adapter.fetch(target, key, signal);
        return result.status === "ok"
          ? result
          : {
              status: "failed",
              failure: { code: result.code, reason: result.reason },
            };
      },
      connect(target, _keys, handlers, signal) {
        if (invalidatesOn.size === 0) {
          return { status: "connected", close: () => undefined };
        }
        const subscribe = adapter.host.daemon.subscribe;
        if (typeof subscribe !== "function") return { status: "unavailable" };
        let installed = false;
        let unavailableBeforeInstall = false;
        try {
          return subscribe(
            {
              workspaceNames: adapter.resourceInterest ? [] : [target.workspaceName],
              ...(adapter.resourceInterest
                ? {
                    resourceInterests: [
                      { resource: adapter.resourceInterest, workspaceName: target.workspaceName },
                    ],
                  }
                : {}),
            },
            (event) => {
              if (invalidatesOn.has(event.type)) handlers.invalidate();
              if (event.type === "connection.changed" && event.state === "degraded") {
                if (installed) handlers.unavailable();
                else unavailableBeforeInstall = true;
              }
            },
            signal,
          ).then((result) => {
            if (result.status !== "subscribed") return { status: "unavailable" } as const;
            if (signal.aborted || unavailableBeforeInstall) {
              result.unsubscribe();
              return { status: "unavailable" } as const;
            }
            installed = true;
            return {
              status: "connected",
              close: () => {
                installed = false;
                result.unsubscribe();
              },
            } as const;
          });
        } catch {
          return { status: "unavailable" };
        }
      },
      rejectionFailure: () => ({
        code: "request-failed",
        reason: "The workspace resource request failed.",
      }),
      retryable: (failure) => transient(failure.code),
      // Directory/file/change ids are local slots. This store owns one daemon
      // resource interest, so expanding another directory does not replace the
      // logical event subscription.
      interestKey: () => adapter.resourceInterest ?? "workspace-resource",
    },
    initialTarget,
    options,
  );

  const releases = new Map<string, () => void>();
  const desiredKeys = new Set<string>();
  const listeners = new Set<(state: TState) => void>();
  let active = options.active ?? true;
  let disposed = false;
  let state = adapter.project(projectView(session.getState()));

  const notify = (listener: (next: TState) => void, next: TState): void => {
    try {
      listener(next);
    } catch {
      // Renderer observers are isolated from authority state and each other.
    }
  };
  const unsubscribeSession = session.subscribe((next) => {
    state = adapter.project(projectView(next));
    for (const listener of [...listeners]) notify(listener, state);
  });
  const activate = (key: string): void => {
    desiredKeys.add(key);
    if (!active) return;
    if (releases.has(key)) {
      session.refresh(key);
      return;
    }
    releases.set(key, session.activate(key));
  };
  if (adapter.eagerKey !== undefined) activate(adapter.eagerKey);

  return {
    getState: () => state,
    getMetrics: () => session.getMetrics(),
    subscribe(listener) {
      if (disposed) {
        notify(listener, state);
        return () => undefined;
      }
      listeners.add(listener);
      notify(listener, state);
      return () => listeners.delete(listener);
    },
    setTarget(next) {
      if (disposed) return;
      if (adapter.singleSlot === true && adapter.eagerKey === undefined) {
        for (const release of releases.values()) release();
        releases.clear();
        desiredKeys.clear();
      }
      session.setTarget(next);
    },
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        for (const release of releases.values()) release();
        releases.clear();
        return;
      }
      for (const key of desiredKeys) activate(key);
    },
    load(key) {
      if (disposed || typeof key !== "string" || key.length === 0) return;
      if (adapter.singleSlot === true) {
        for (const other of [...desiredKeys]) {
          if (other === key) continue;
          releases.get(other)?.();
          releases.delete(other);
          desiredKeys.delete(other);
        }
      }
      activate(key);
    },
    drop(key) {
      if (disposed) return;
      releases.get(key)?.();
      releases.delete(key);
      desiredKeys.delete(key);
    },
    refresh() {
      if (!disposed) session.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSession();
      releases.clear();
      desiredKeys.clear();
      session.dispose();
      state = adapter.project(projectView(session.getState()));
      const retired = [...listeners];
      listeners.clear();
      for (const listener of retired) notify(listener, state);
    },
  };
}
