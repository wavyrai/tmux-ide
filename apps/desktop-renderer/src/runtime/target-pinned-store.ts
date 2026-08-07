import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopApplicationShellTarget,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { daemonGenerationKey } from "./connection-state.ts";
import {
  boundedRetryDelay,
  defaultGenerationBoundClock,
  normalizedGenerationBoundRetry,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
} from "./generation-bound-store.ts";

/**
 * The ONE target-pinned slot engine behind the Files, Preview, Changes and
 * Diff read stores.
 *
 * Where {@link ./generation-bound-store.ts} tracks a single resource for a
 * daemon generation, this engine tracks a KEYED SET of them for one
 * {@link DesktopApplicationShellTarget} — a semantic workspace name plus a
 * non-secret daemon generation. A target change bumps the generation and any
 * response that resolves against a superseded generation is dropped rather than
 * trusted. The daemon endpoint, owner credential, and physical transport never
 * cross into this layer: reads go through the reviewed HostCapabilities facade
 * and every response is re-validated at the boundary before it reaches
 * application code.
 *
 * These four stores were copies of one file, and the copies had drifted away
 * from the generation-bound stores in four ways that this engine settles:
 *
 * - a failed read was terminal until the user pressed retry. Transient codes
 *   now run the same bounded ladder the generation-bound engine uses.
 * - a refresh blanked the resource to `loading` before the response landed,
 *   and a transient failure blanked it for good. The previous read is now
 *   RETAINED: a refresh publishes it with `refreshing`, and a failure publishes
 *   it as the error's `stale` companion.
 * - nothing invalidated these reads, so a workspace change left the panels
 *   showing the previous workspace's state until something else refetched.
 *   They now subscribe and refetch loaded slots on the invalidation events the
 *   wire actually carries.
 * - disposal did not notify, so an observer never learned the store was gone.
 *
 * One gap remains and is NOT invented here: the wire carries no git-write or
 * file-write signal. `workspaces.changed` is the only invalidation these reads
 * can honestly subscribe to, so a commit made outside the app still needs a
 * manual refresh to appear in Changes. Adding such an event is daemon work.
 */

export type WorkspaceResourceTarget = DesktopApplicationShellTarget;

export type WorkspaceResourceClock = GenerationBoundClock;

export const defaultWorkspaceResourceClock: WorkspaceResourceClock = defaultGenerationBoundClock;

export interface WorkspaceResourceSnapshot<TResource> {
  readonly resource: TResource;
  readonly updatedAt: number;
}

/** A resolved daemon-stamped read, its typed unavailability, or a transport error. */
export type WorkspaceResourceSlot<TResource> =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly resource: TResource;
      readonly updatedAt: number;
      /** A read is in flight that will replace this one; the content stands. */
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      /** The last good read, retained so a transient failure blanks nothing. */
      readonly stale: WorkspaceResourceSnapshot<TResource> | null;
    };

export type WorkspaceResourceTargetValidation =
  | { readonly ok: true; readonly target: WorkspaceResourceTarget; readonly key: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Strictly validate an untrusted store target. A path, credential, or
 * incompatible protocol is rejected here so it can never reach a request.
 */
export function validateWorkspaceResourceTarget(value: unknown): WorkspaceResourceTargetValidation {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: "Workspace resource target is invalid." };
  }
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
  /** Set once by an invalid target; the reason belongs on every slot's error. */
  readonly targetError: { readonly reason: string } | null;
  readonly disposed: boolean;
}

export interface TargetPinnedAdapter<TResource, TState> {
  readonly host: Pick<HostCapabilities, "daemon">;
  /**
   * Read one slot. The key is the store's own identifier for it — a directory
   * id, a file id, a change id, or the store's single fixed key.
   */
  fetch(target: WorkspaceResourceTarget, key: string): Promise<TargetPinnedFetchResult<TResource>>;
  /** Loaded automatically whenever a valid target is installed. */
  readonly eagerKey?: string;
  /** Loading a key retires every other slot (a single-selection surface). */
  readonly singleSlot?: boolean;
  /** Invalidation events that refetch every loaded slot. */
  readonly invalidatesOn?: readonly DesktopDaemonEvent["type"][];
  project(view: TargetPinnedView<TResource>): TState;
}

export interface TargetPinnedStoreOptions {
  readonly clock?: WorkspaceResourceClock;
  readonly random?: () => number;
  readonly retry?: Partial<GenerationBoundRetryPolicy>;
}

export interface TargetPinnedStore<TState> {
  getState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
  setTarget(target: unknown): void;
  load(key: string): void;
  drop(key: string): void;
  /** Reload every slot currently tracked. */
  refresh(): void;
  dispose(): void;
}

const DEFAULT_RETRY: GenerationBoundRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 4_000,
  maximumAttempts: 3,
  jitterRatio: 0,
  stabilityWindowMs: 0,
};

function transientCode(code: DesktopDaemonCapabilityErrorCode): boolean {
  return code === "request-timeout" || code === "request-failed" || code === "event-unavailable";
}

function retainedSnapshot<TResource>(
  slot: WorkspaceResourceSlot<TResource> | undefined,
): WorkspaceResourceSnapshot<TResource> | null {
  if (slot === undefined) return null;
  if (slot.status === "loaded") return { resource: slot.resource, updatedAt: slot.updatedAt };
  if (slot.status === "error") return slot.stale;
  return null;
}

export function createTargetPinnedStore<TResource, TState>(
  adapter: TargetPinnedAdapter<TResource, TState>,
  initialTarget: unknown,
  options: TargetPinnedStoreOptions = {},
): TargetPinnedStore<TState> {
  const clock = options.clock ?? defaultWorkspaceResourceClock;
  const random = options.random ?? Math.random;
  const retry = normalizedGenerationBoundRetry(options.retry, DEFAULT_RETRY);
  const invalidatesOn = new Set<DesktopDaemonEvent["type"]>(adapter.invalidatesOn ?? []);
  const listeners = new Set<(state: TState) => void>();

  let disposed = false;
  let generation = 0;
  let target: WorkspaceResourceTarget | null = null;
  let targetKey = "";
  let targetError: { readonly reason: string } | null = null;
  const slots = new Map<string, WorkspaceResourceSlot<TResource>>();
  const requestTokens = new Map<string, symbol>();
  const retryTimers = new Map<string, unknown>();
  const retryAttempts = new Map<string, number>();
  let closeSubscription: (() => void) | null = null;
  let subscriptionId = 0;
  let state: TState;

  const view = (): TargetPinnedView<TResource> => ({
    generation,
    target,
    slots: new Map(slots),
    targetError,
    disposed,
  });

  const notify = (listener: (next: TState) => void, next: TState): void => {
    try {
      listener(next);
    } catch {
      // Store observers are untrusted application code; one cannot break
      // another, nor interrupt state retirement or host cleanup.
    }
  };

  const publish = (): void => {
    state = adapter.project(view());
    const next = state;
    for (const listener of [...listeners]) {
      if (disposed) break;
      notify(listener, next);
    }
  };

  const emit = (): void => {
    if (disposed) return;
    publish();
  };

  const clearRetry = (key: string): void => {
    const handle = retryTimers.get(key);
    if (handle === undefined) return;
    retryTimers.delete(key);
    try {
      clock.clearTimeout(handle);
    } catch {
      // A host clock must not prevent retirement or disposal.
    }
  };

  const clearAllRetries = (): void => {
    for (const key of [...retryTimers.keys()]) clearRetry(key);
    retryAttempts.clear();
  };

  const retireSubscription = (): void => {
    subscriptionId += 1;
    const close = closeSubscription;
    closeSubscription = null;
    try {
      close?.();
    } catch {
      // Host teardown is best-effort; the logical generation is already retired.
    }
  };

  function fetchSlot(key: string, expectedGeneration: number): void {
    if (disposed || generation !== expectedGeneration || target === null) return;
    const expectedTarget = target;
    const token = Symbol(key);
    requestTokens.set(key, token);
    const retained = retainedSnapshot(slots.get(key));
    // A refresh keeps what is on screen; only a first read shows `loading`.
    slots.set(
      key,
      retained === null
        ? { status: "loading" }
        : {
            status: "loaded",
            resource: retained.resource,
            updatedAt: retained.updatedAt,
            refreshing: true,
          },
    );
    emit();
    void adapter
      .fetch(expectedTarget, key)
      .then((result) => {
        if (disposed || generation !== expectedGeneration || requestTokens.get(key) !== token) {
          return;
        }
        requestTokens.delete(key);
        if (result.status === "ok") {
          clearRetry(key);
          retryAttempts.delete(key);
          slots.set(key, {
            status: "loaded",
            resource: result.resource,
            updatedAt: clock.now(),
            refreshing: false,
          });
          emit();
          return;
        }
        slots.set(key, {
          status: "error",
          code: result.code,
          reason: result.reason,
          stale: retained,
        });
        emit();
        if (!transientCode(result.code)) return;
        const attempts = retryAttempts.get(key) ?? 0;
        if (attempts >= retry.maximumAttempts || retryTimers.has(key)) return;
        retryAttempts.set(key, attempts + 1);
        retryTimers.set(
          key,
          clock.setTimeout(
            () => {
              retryTimers.delete(key);
              fetchSlot(key, expectedGeneration);
            },
            boundedRetryDelay(attempts, retry, random),
          ),
        );
      })
      .catch(() => {
        if (disposed || generation !== expectedGeneration || requestTokens.get(key) !== token) {
          return;
        }
        requestTokens.delete(key);
        slots.set(key, {
          status: "error",
          code: "request-failed",
          reason: "The workspace resource request failed.",
          stale: retained,
        });
        emit();
      });
  }

  const connectEvents = (expectedGeneration: number): void => {
    if (invalidatesOn.size === 0 || target === null) return;
    const workspaceName = target.workspaceName;
    const activeSubscriptionId = ++subscriptionId;
    let operation;
    try {
      operation = adapter.host.daemon.subscribe({ workspaceNames: [workspaceName] }, (event) => {
        if (
          activeSubscriptionId !== subscriptionId ||
          disposed ||
          generation !== expectedGeneration ||
          !invalidatesOn.has(event.type)
        ) {
          return;
        }
        for (const key of [...slots.keys()]) fetchSlot(key, expectedGeneration);
      });
    } catch {
      // Invalidation is an optimisation over an explicit refresh; a host that
      // cannot subscribe leaves the reads manual rather than failing them.
      return;
    }
    void operation
      .then((result) => {
        if (result.status !== "subscribed") return;
        if (activeSubscriptionId !== subscriptionId || disposed) {
          try {
            result.unsubscribe();
          } catch {
            // This logical subscription was already retired.
          }
          return;
        }
        closeSubscription = result.unsubscribe;
      })
      .catch(() => {
        // Same as a synchronous refusal: the reads stay manual.
      });
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = validateWorkspaceResourceTarget(untrusted);
    if (validation.ok && target !== null && validation.key === targetKey) return;
    generation += 1;
    clearAllRetries();
    requestTokens.clear();
    slots.clear();
    retireSubscription();
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      targetError = { reason: validation.reason };
      emit();
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    targetError = null;
    const eagerKey = adapter.eagerKey;
    if (eagerKey !== undefined) {
      slots.set(eagerKey, { status: "loading" });
    }
    emit();
    connectEvents(generation);
    if (eagerKey !== undefined) fetchSlot(eagerKey, generation);
  };

  const store: TargetPinnedStore<TState> = {
    getState: () => state,
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
      startTarget(next);
    },
    load(key) {
      if (disposed || target === null || typeof key !== "string" || key === "") return;
      if (adapter.singleSlot === true) {
        for (const other of [...slots.keys()]) {
          if (other === key) continue;
          clearRetry(other);
          retryAttempts.delete(other);
          requestTokens.delete(other);
          slots.delete(other);
        }
      }
      fetchSlot(key, generation);
    },
    drop(key) {
      if (disposed || typeof key !== "string") return;
      clearRetry(key);
      retryAttempts.delete(key);
      requestTokens.delete(key);
      if (slots.delete(key)) emit();
    },
    refresh() {
      if (disposed || target === null) return;
      const keys = new Set(slots.keys());
      if (adapter.eagerKey !== undefined) keys.add(adapter.eagerKey);
      for (const key of keys) {
        clearRetry(key);
        retryAttempts.delete(key);
        fetchSlot(key, generation);
      }
    },
    dispose() {
      if (disposed) return;
      const retired = [...listeners];
      clearAllRetries();
      requestTokens.clear();
      retireSubscription();
      generation += 1;
      target = null;
      targetKey = `disposed:${generation}`;
      slots.clear();
      disposed = true;
      state = adapter.project(view());
      listeners.clear();
      for (const listener of retired) notify(listener, state);
    },
  };

  state = adapter.project(view());
  startTarget(initialTarget);
  return store;
}
